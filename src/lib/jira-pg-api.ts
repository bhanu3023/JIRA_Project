/**
 * jira-pg-api.ts
 * PostgreSQL-backed API handler replacing the in-memory jira-dev-mock for
 * heavy data routes (auth, users, spaces, issues).
 * All other routes (sprints, workflows, labels, automation, filters, etc.)
 * are delegated to handleJiraDevMock so existing features keep working.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { handleJiraDevMock } from '@/lib/jira-dev-mock';
import { getNextAgent, getDefaultDepartment, getRrConfig, saveRrConfig } from '@/lib/rr-service';
import { fireConnectorEvent, listConnectors, getConnector, createConnector, updateConnector, deleteConnector, getConnectorLogs } from '@/lib/connector-service';
import { pgPool as pool } from '@/lib/pg-pool';
import { isManager } from '@/lib/permissions';

// 60-second in-memory cache for user role lookups so every API request
// doesn't pay an extra DB round-trip just to check isAdmin.
const _userCache = new Map<string, { user: any; exp: number }>();
async function getCachedUser(userId: string) {
  const now = Date.now();
  const cached = _userCache.get(userId);
  if (cached && cached.exp > now) return cached.user;
  const user = await db.user.findUnique({ where: { id: userId } });
  _userCache.set(userId, { user, exp: now + 60_000 });
  return user;
}

// Ensure original_dept column exists
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS original_dept TEXT`).catch(() => {});
// User invite status: 'invited' | 'active' | 'inactive'
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`).catch(() => {});
// Backfill: invited users (isActive=false, no prior login) stay 'invited'; active users get 'active'
pool.query(`UPDATE users SET status='active' WHERE status IS NULL OR status='' OR (status='active' AND "isActive"=true)`).catch(() => {});
pool.query(`UPDATE users SET status='inactive' WHERE "isActive"=false AND status='active'`).catch(() => {});
pool.query(`WITH first_dept AS (SELECT DISTINCT ON (issue_id) issue_id, from_dept FROM issue_dept_transitions WHERE from_dept != '' ORDER BY issue_id, moved_at ASC) UPDATE issues i SET original_dept = COALESCE((SELECT fd.from_dept FROM first_dept fd WHERE fd.issue_id = i.id), i.current_department) WHERE i.original_dept IS NULL`).catch(() => {});

// Ensure queue_closed_tickets exists at startup (needed by Sent/Watching query)
pool.query(`CREATE TABLE IF NOT EXISTS queue_closed_tickets (id SERIAL PRIMARY KEY, space_id TEXT NOT NULL, dept_name TEXT NOT NULL, issue_id TEXT NOT NULL, closed_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(space_id, dept_name, issue_id))`).catch(() => {});

// Track dept transitions for accurate Sent/Watching
pool.query(`CREATE TABLE IF NOT EXISTS issue_dept_transitions (
  id SERIAL PRIMARY KEY,
  issue_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  from_dept TEXT NOT NULL,
  to_dept TEXT NOT NULL,
  moved_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(() => {});
// Records who moved a ticket out of a dept — the worked-on reconstruction on
// ticket close falls back to this when no assignee was ever set in that dept
// (e.g. people just changing status without formally "assigning" themselves).
// Code elsewhere had assumed this column existed for a while; every insert/select
// against it was silently failing (wrapped in a catch), so that fallback never
// actually worked and depts with no formal assignee dropped out of worked-on.
pool.query(`ALTER TABLE issue_dept_transitions ADD COLUMN IF NOT EXISTS moved_by TEXT`).catch(() => {});

// Track per-user worked-on history
pool.query(`CREATE TABLE IF NOT EXISTS user_worked_on_tickets (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  dept TEXT,
  reason TEXT NOT NULL DEFAULT 'passed',
  worked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, issue_id, dept)
)`).catch(() => {});

// Custom queues table (needed by custom-queues endpoint)
pool.query(`CREATE TABLE IF NOT EXISTS custom_queues (space_key TEXT PRIMARY KEY, queues JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});

// Ensure all issues columns exist at startup (avoids per-request ALTER TABLE locks)
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS current_department TEXT`).catch(() => {});
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS dept_sla_started_at TIMESTAMPTZ`).catch(() => {});
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS dept_assignees JSONB DEFAULT '{}'::jsonb`).catch(() => {});
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS dept_statuses JSONB DEFAULT '{}'::jsonb`).catch(() => {});
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS dept_sla_log JSONB DEFAULT '{}'::jsonb`).catch(() => {});
pool.query(`ALTER TABLE sla_definitions ADD COLUMN IF NOT EXISTS dept_name TEXT`).catch(() => {});
pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});
pool.query(`ALTER TABLE space_members ADD COLUMN IF NOT EXISTS department VARCHAR(100)`).catch(() => {});

// Indexes for hot query paths
pool.query(`CREATE INDEX IF NOT EXISTS idx_qct_space_dept ON queue_closed_tickets(space_id, LOWER(dept_name))`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_qct_issue_id ON queue_closed_tickets(issue_id)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_idt_issue_id ON issue_dept_transitions(issue_id)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_idt_space_from ON issue_dept_transitions(space_id, LOWER(from_dept))`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_issues_space ON issues("spaceId")`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_issues_current_dept ON issues(LOWER(current_department))`).catch(() => {});

import {
  notifyIssueCreated,
  notifyIssueAssigned,
  notifyStatusChanged,
  notifyCommentAdded,
  notifyIssueUpdated,
  notifyIssueDeleted,
  notifyMentioned,
  notifySLABreach,
} from '@/lib/notification-service';

// Ã¢â€â‚¬Ã¢â€â‚¬ Global safety net: prevent IMAP/socket uncaughtExceptions from killing the server Ã¢â€â‚¬Ã¢â€â‚¬
if (typeof process !== 'undefined') {
  const _handled = (process as any).__imap_crash_guard_installed;
  if (!_handled) {
    (process as any).__imap_crash_guard_installed = true;
    process.on('uncaughtException', (err: any) => {
      const msg = err?.message || String(err);
      // IMAP / socket errors Ã¢â‚¬â€ log and continue, do NOT crash
      if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('EPIPE') || msg.includes('imap') || msg.includes('ImapFlow')) {
        console.error('[SafetyNet] Caught IMAP/socket uncaughtException (server kept alive):', msg);
        return;
      }
      // All other uncaught exceptions: log and exit as normal
      console.error('[SafetyNet] Uncaught exception (fatal):', err);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason: any) => {
      const msg = reason?.message || String(reason);
      if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('EPIPE')) {
        console.error('[SafetyNet] Caught IMAP/socket unhandledRejection (server kept alive):', msg);
        return;
      }
      console.error('[SafetyNet] Unhandled rejection:', reason);
    });
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// Ã¢â€â‚¬Ã¢â€â‚¬ In-app notification helper Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function createNotification({
  userId, type, title, message, issueKey,
}: { userId: string; type: string; title: string; message?: string; issueKey?: string }) {
  if (!userId) return;
  try {
    await db.notification.create({ data: { userId, type, title, message: message ?? null, issueKey: issueKey ?? null } });
  } catch { /* fire-and-forget */ }
}

function defaultPrefs() {
  return { onAssigned: true, onCommented: true, onStatusChanged: true, onMentioned: true, onWatchedUpdated: true, onCreated: true, onUpdated: false };
}

// Check user's notification preference for a given type
async function userWantsNotif(userId: string, type: string): Promise<boolean> {
  try {
    const prefs: any = await (db as any).notificationPreference.findUnique({ where: { userId } }) ?? defaultPrefs();
    const map: Record<string, string> = {
      ASSIGNED: 'onAssigned', COMMENTED: 'onCommented', STATUS_CHANGED: 'onStatusChanged',
      MENTIONED: 'onMentioned', WATCHED: 'onWatchedUpdated', CREATED: 'onCreated', UPDATED: 'onUpdated',
      DUE_DATE: 'onAssigned', SLA_BREACH: 'onAssigned', DUPLICATE_ALERT: 'onCreated',
      SLA_PAUSED: 'onAssigned', SLA_RESUMED: 'onAssigned',
    };
    const prefKey = map[type];
    return prefKey ? (prefs[prefKey] ?? true) : true;
  } catch { return true; }
}

// Create notification for multiple users (dedup Ã¢â‚¬â€ don't notify the actor, respect preferences)
async function notifyUsers(userIds: (string | null | undefined)[], actorId: string | null | undefined, opts: { type: string; title: string; message?: string; issueKey?: string }) {
  const seen = new Set<string>();
  for (const uid of userIds) {
    if (!uid || uid === actorId || seen.has(uid)) continue;
    seen.add(uid);
    if (await userWantsNotif(uid, opts.type)) {
      await createNotification({ userId: uid, ...opts });
    }
  }
}

// Get all lead/shift_lead member userIds for a space
async function getSpaceLeadUserIds(spaceId: string, dept?: string | null): Promise<string[]> {
  try {
    const where: any = { spaceId, role: { in: ['lead', 'shift_lead'] } };
    // If dept provided, only return leads whose department matches (null dept = all-space leads)
    if (dept) {
      where.OR = [
        { department: { equals: dept, mode: 'insensitive' } },
        { department: null },
      ];
    }
    const members = await db.spaceMember.findMany({ where, select: { userId: true } });
    return members.map((m: any) => m.userId).filter(Boolean);
  } catch { return []; }
}

// Queue "Suspend" was a display-only badge — it toggled custom_queues.suspendedIds
// in the DB but nothing ever read that array to actually block access, so a
// suspended user could still view/create/comment on tickets in that queue.
// This is the actual enforcement: given a space + department/queue name, check
// whether the requesting user is in that queue's suspendedIds.
async function isUserSuspendedFromQueue(spaceKey: string, department: string | null | undefined, userId: string | null | undefined): Promise<boolean> {
  if (!department || !userId) return false;
  try {
    const row = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey.toUpperCase()]);
    const queues: any[] = row.rows[0]?.queues || [];
    const q = queues.find((qq: any) => String(qq.name || '').toLowerCase() === department.toLowerCase());
    return Array.isArray(q?.suspendedIds) && q.suspendedIds.includes(userId);
  } catch { return false; }
}

// Sent/Watching lets a department monitor a ticket after it moves to another
// queue, but that's monitoring, not managing: once a ticket has moved on, only
// the queue it currently sits in (or an admin) should be able to edit it —
// assignee, department, or any other field. Viewing and commenting stay open
// to everyone with access to the space; this only gates edits. Fails OPEN
// (returns true / "authorized") whenever the department doesn't map to a
// configured queue or on a lookup error, so this never blocks tickets outside
// the custom-queue/department-routing model.
async function isUserAuthorizedForDeptQueue(spaceKey: string, department: string | null | undefined, userId: string | null | undefined): Promise<boolean> {
  if (!department || !userId) return true;
  try {
    const row = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey.toUpperCase()]);
    const queues: any[] = row.rows[0]?.queues || [];
    const q = queues.find((qq: any) => String(qq.name || '').toLowerCase() === department.toLowerCase());
    if (!q) return true;
    const memberIds: string[] = Array.isArray(q.memberIds) ? q.memberIds : [];
    const suspendedIds: string[] = Array.isArray(q.suspendedIds) ? q.suspendedIds : [];
    return memberIds.includes(userId) && !suspendedIds.includes(userId);
  } catch { return true; }
}

// Find previously RESOLVED issues with a similar summary (to detect recurring issues)
async function findPreviouslyResolvedSimilar(spaceId: string, excludeId: string, summary: string): Promise<Array<{ key: string; cf_key: string; summary: string }>> {
  try {
    // Try pg_trgm similarity first (threshold 0.3) Ã¢â‚¬â€ only resolved/done tickets
    const res = await pool.query(
      `SELECT i.key, i.cf_key, i.summary
       FROM issues i
       INNER JOIN statuses s ON s.id = i."statusId"
       WHERE i."spaceId" = $1
         AND i.id != $2
         AND s.category = 'done'
         AND similarity(LOWER(i.summary), LOWER($3)) > 0.3
       ORDER BY similarity(LOWER(i.summary), LOWER($3)) DESC
       LIMIT 3`,
      [spaceId, excludeId, summary]
    );
    return res.rows;
  } catch {
    // Fallback: keyword matching if pg_trgm not available
    const words = summary.toLowerCase().split(/[\s,.:;!?()\-]+/).filter((w) => w.length > 4).slice(0, 6);
    if (words.length === 0) return [];
    const clauses = words.map((_, i) => `LOWER(i.summary) LIKE $${i + 4}`).join(' OR ');
    try {
      const res = await pool.query(
        `SELECT i.key, i.cf_key, i.summary
         FROM issues i
         INNER JOIN statuses s ON s.id = i."statusId"
         WHERE i."spaceId" = $1 AND i.id != $2
           AND s.category = 'done'
           AND (${clauses})
         LIMIT 3`,
        [spaceId, excludeId, ...words.map((w) => `%${w}%`)]
      );
      return res.rows;
    } catch { return []; }
  }
}

/**
 * Combined periodic scan: SLA breach warnings (30 min before), due-date-approaching
 * warnings (30 min before), and a duplicate-ticket scan over the last 24h of tickets.
 * Batches the SLA-policy lookup and the notification-dedup check per section (one query
 * for all candidate issues, not one per row) — the original version queried
 * sla_definitions and notifications inside a per-row loop over up to ~4200 rows, i.e.
 * several thousand sequential DB round trips per run.
 */
async function runMonitorAgentScan(): Promise<{ slaNotified: number; dueDateNotified: number; duplicatesFound: number }> {
  const results = { slaNotified: 0, dueDateNotified: 0, duplicatesFound: 0 };
  const warnMs = 30 * 60 * 1000;
  const oneHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  // 1. SLA breach warnings (30 min before)
  try {
    const activeIssues = await pool.query(
      `SELECT i.*, s.category AS status_category
       FROM issues i
       LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i.dept_sla_started_at IS NOT NULL
         AND (s.category IS NULL OR s.category != 'done')
       LIMIT 2000`
    );
    const rows = activeIssues.rows;
    const spaceIds = Array.from(new Set(rows.map((r: any) => r.spaceId).filter(Boolean)));
    const policiesBySpace: Record<string, any[]> = {};
    if (spaceIds.length) {
      const polRows = await pool.query(
        `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`,
        [spaceIds]
      );
      for (const p of polRows.rows) {
        if (!policiesBySpace[p.spaceId]) policiesBySpace[p.spaceId] = [];
        policiesBySpace[p.spaceId].push(p);
      }
    }

    const candidates: Array<{ row: any; policy: any; minsLeft: number }> = [];
    // Breach itself is a live/computed state (checked fresh on every read), not a
    // discrete stored event -- so History never showed the moment a ticket actually
    // crossed its due time, only the pre-breach warning notification. Collect that
    // moment here too, logged once per issue per department visit (guarded below).
    const justBreached: Array<{ row: any; policy: any }> = [];
    for (const row of rows) {
      const policies = policiesBySpace[row.spaceId] || [];
      if (!policies.length) continue;
      const priority = (row.priority || 'medium').toLowerCase();
      for (const policy of policies) {
        let durationMs = 8 * 60 * 60 * 1000;
        const goals: any[] = Array.isArray(policy.goals) ? policy.goals : [];
        for (const goal of goals) {
          if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
            const pr = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
            if (pr?.timeValue) {
              const val = parseFloat(pr.timeValue);
              const unit = (pr.timeUnit || 'hours').toLowerCase();
              durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
              break;
            }
          } else if (goal.timeValue) {
            const val = parseFloat(goal.timeValue);
            const unit = (goal.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        }
        const dueAt = new Date(row.dept_sla_started_at).getTime() + durationMs;
        const timeToBreachMs = dueAt - Date.now();
        if (timeToBreachMs > 0 && timeToBreachMs <= warnMs) {
          candidates.push({ row, policy, minsLeft: Math.ceil(timeToBreachMs / 60_000) });
        } else if (timeToBreachMs <= 0) {
          justBreached.push({ row, policy });
        }
      }
    }

    if (justBreached.length) {
      const byIssue = new Map<string, { row: any; policy: any }>();
      for (const c of justBreached) { if (!byIssue.has(c.row.id)) byIssue.set(c.row.id, c); }
      for (const { row, policy } of byIssue.values()) {
        const label = `SLA breached — ${row.current_department || ''}`.trim();
        try {
          const already = await (db as any).issueHistory.findFirst({ where: { issueId: row.id, field: 'sla', newValue: label } });
          if (already) continue;
          await logSlaHistory(null, row.id, label);
        } catch { /* non-fatal */ }
      }
    }

    if (candidates.length) {
      const keys = Array.from(new Set(candidates.map((c) => c.row.cf_key || c.row.key)));
      const existing = await (db as any).notification.findMany({
        where: { issueKey: { in: keys }, type: 'SLA_BREACH', createdAt: { gte: oneHourAgo() } },
        select: { issueKey: true },
      });
      const already = new Set(existing.map((e: any) => e.issueKey));
      for (const { row, policy, minsLeft } of candidates) {
        const key = row.cf_key || row.key;
        if (already.has(key)) continue;
        already.add(key); // don't double-notify if more than one policy triggers this run
        const leadIds = await getSpaceLeadUserIds(row.spaceId);
        await notifyUsers([row.assigneeId, row.reporterId, ...leadIds], null, {
          type: 'SLA_BREACH',
          title: `SLA breaching in ${minsLeft} min: ${key}`,
          message: `${policy.name || 'SLA'} will breach in ${minsLeft} minutes for: ${row.summary || key}`,
          issueKey: key,
        });
        try {
          const emailRecipients = row.assigneeId
            ? await db.user.findMany({ where: { id: row.assigneeId }, select: { email: true } })
            : [];
          const assigneeEmails = emailRecipients.map((u: any) => u.email).filter(Boolean);
          const spaceRow = await db.space.findUnique({ where: { id: row.spaceId }, select: { key: true, name: true } });
          if (assigneeEmails.length && spaceRow) {
            notifySLABreach({
              issueKey: key,
              issueSummary: row.summary || key,
              spaceKey: spaceRow.key,
              spaceName: spaceRow.name,
              slaName: policy.name || 'SLA',
              minsLeft,
              assigneeEmails,
            }).catch(() => {});
          }
        } catch { /* non-critical */ }
        results.slaNotified++;
      }
    }
  } catch (e: any) { console.error('[MonitorAgent:SLA]', e?.message); }

  // 1b. Due date approaching (30 min before) — separate from SLA breach; dueDate is a
  // field set directly on the ticket, unrelated to the SLA policy's own duration clock.
  try {
    const dueSoon = await pool.query(
      `SELECT i.*, s.category AS status_category
       FROM issues i
       LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i."dueDate" IS NOT NULL
         AND i."assigneeId" IS NOT NULL
         AND (s.category IS NULL OR s.category != 'done')
       LIMIT 2000`
    );
    const candidates = dueSoon.rows
      .map((row: any) => ({ row, timeToDueMs: new Date(row.dueDate).getTime() - Date.now() }))
      .filter((c: any) => c.timeToDueMs > 0 && c.timeToDueMs <= warnMs);

    if (candidates.length) {
      const keys = Array.from(new Set(candidates.map((c: any) => c.row.cf_key || c.row.key)));
      const existing = await (db as any).notification.findMany({
        where: { issueKey: { in: keys }, type: 'DUE_DATE', createdAt: { gte: oneHourAgo() } },
        select: { issueKey: true },
      });
      const already = new Set(existing.map((e: any) => e.issueKey));
      for (const { row, timeToDueMs } of candidates) {
        const key = row.cf_key || row.key;
        if (already.has(key)) continue;
        already.add(key);
        const minsLeft = Math.ceil(timeToDueMs / 60_000);
        await notifyUsers([row.assigneeId], null, {
          type: 'DUE_DATE',
          title: `Due in ${minsLeft} min: ${key}`,
          message: `"${row.summary || key}" is due in ${minsLeft} minutes.`,
          issueKey: key,
        });
        results.dueDateNotified++;
      }
    }
  } catch (e: any) { console.error('[MonitorAgent:DueDate]', e?.message); }

  // 2. Duplicate scan — tickets created in the last 24h
  try {
    const recentIssues = await pool.query(
      `SELECT i.id, i.key, i.cf_key, i.summary, i."spaceId", i."reporterId", i."assigneeId"
       FROM issues i
       WHERE i."createdAt" > NOW() - INTERVAL '24 hours'
         AND i.summary IS NOT NULL
       LIMIT 200`
    );
    const rows = recentIssues.rows;
    if (rows.length) {
      const keys = Array.from(new Set(rows.map((r: any) => r.cf_key || r.key)));
      const existing = await (db as any).notification.findMany({
        where: { issueKey: { in: keys }, type: 'DUPLICATE_ALERT', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        select: { issueKey: true },
      });
      const already = new Set(existing.map((e: any) => e.issueKey));
      for (const row of rows) {
        const newKey = row.cf_key || row.key;
        if (already.has(newKey)) continue;
        const prevResolved = await findPreviouslyResolvedSimilar(row.spaceId, row.id, row.summary);
        if (prevResolved.length > 0) {
          const refs = prevResolved.map((s: any) => `${s.cf_key || s.key} — ${s.summary.substring(0, 80)}`).join('\n• ');
          const leadIds = await getSpaceLeadUserIds(row.spaceId);
          await notifyUsers([row.reporterId, row.assigneeId, ...leadIds], null, {
            type: 'DUPLICATE_ALERT',
            title: `Recurring issue: ${newKey}`,
            message: `This issue was previously reported and resolved:\n• ${refs}\n\nPlease check if the fix is still in place.`,
            issueKey: newKey,
          });
          results.duplicatesFound++;
        }
      }
    }
  } catch (e: any) { console.error('[MonitorAgent:Dup]', e?.message); }

  return results;
}

declare global {
  // eslint-disable-next-line no-var
  var __monitorAgentInterval: ReturnType<typeof setInterval> | undefined;
}

// Server-side singleton scheduler. This used to be triggered from every open browser tab
// (Header.tsx polled it on mount, then every 5 minutes) — with N staff members having the
// app open at once, N copies of this scan ran concurrently every 5 minutes, each looping
// through up to ~4200 issues, competing for the same shared DB connection pool as every
// other request. That's a major contributor to "everything feels slow" across the whole
// app. Runs exactly once per server process now, regardless of how many tabs are open.
if (!globalThis.__monitorAgentInterval) {
  runMonitorAgentScan().catch((e) => console.error('[MonitorAgent] initial run failed:', e?.message));
  globalThis.__monitorAgentInterval = setInterval(() => {
    runMonitorAgentScan().catch((e) => console.error('[MonitorAgent] scheduled run failed:', e?.message));
  }, 5 * 60 * 1000);
}

// Notify all watchers of an issue (excluding actor)
async function notifyWatchers(issueKey: string, actorId: string | null | undefined, opts: { title: string; message?: string }) {
  try {
    const watches = await (db as any).issueWatch.findMany({ where: { issueKey }, select: { userId: true } });
    for (const w of watches) {
      if (w.userId === actorId) continue;
      if (await userWantsNotif(w.userId, 'WATCHED')) {
        await createNotification({ userId: w.userId, type: 'WATCHED', issueKey, ...opts });
      }
    }
  } catch { /* ignore */ }
}

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const t = await req.text();
    if (!t) return {};
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rid() {
  return `pg_${Math.random().toString(36).slice(2, 12)}`;
}

function nowIso() {
  return new Date().toISOString();
}

const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const SESSION_TTL_HOURS = 12;

/** Sign a secure JWT token using jsonwebtoken */
function encodeToken(userId: string, ip?: string, userAgent?: string): string {
  const jwt = require('jsonwebtoken');
  const payload = {
    sub: userId,
    ip: ip || '',
    ua: userAgent ? userAgent.slice(0, 100) : '',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_HOURS * 3600,
  };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  // Store session in DB (async, non-blocking)
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, ip || '', userAgent || '', expiresAt]
  ).catch(() => {});
  return token;
}

/** SHA-256 hash of a token for DB storage */
function hashToken(token: string): string {
  return require('crypto').createHash('sha256').update(token).digest('hex');
}

/** Generate a random API token string */
function generateApiToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 40; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return `nta_${result}`;
}

/** Resolve userId Ã¢â‚¬â€ verifies JWT signature + DB session, rejects forged tokens */
async function resolveUserId(auth: string | null, reqIp?: string): Promise<string | null> {
  if (!auth?.startsWith('Bearer ')) return null;
  const t = auth.slice(7).trim();

  // Legacy unsigned tokens (dev.) Ã¢â‚¬â€ still support during transition, but log warning
  if (t.startsWith('dev.')) {
    try {
      const payload = JSON.parse(Buffer.from(t.slice(4), 'base64url').toString('utf8')) as { sub: string };
      console.warn('[Security] Legacy unsigned token used — user should re-login');
      return payload.sub || null;
    } catch { return null; }
  }

  // Signed JWT tokens (new format Ã¢â‚¬â€ starts with eyJ)
  if (t.startsWith('eyJ')) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(t, JWT_SECRET, { algorithms: ['HS256'] }) as {
        sub: string; ip: string; ua: string; exp: number;
      };
      // Check token not expired
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

      // In development without a DB, trust the signed JWT directly
      if (process.env.NODE_ENV === 'development') {
        return payload.sub || null;
      }

      // Verify session exists in DB and is not revoked
      const tokenHash = hashToken(t);
      const session = await pool.query(
        `SELECT user_id, ip, is_revoked, expires_at FROM user_sessions WHERE token_hash = $1 LIMIT 1`,
        [tokenHash]
      );
      if (!session.rows.length) return null;
      const sess = session.rows[0];
      if (sess.is_revoked) return null;
      if (new Date(sess.expires_at) < new Date()) return null;

      return payload.sub || null;
    } catch (err: any) {
      // JWT signature invalid = token was forged
      console.warn('[Security] Invalid JWT token rejected:', err.message);
      return null;
    }
  }

  // Personal API token (nta_...)
  if (t.startsWith('nta_')) {
    try {
      const h = hashToken(t);
      const row = await pool.query(
        `SELECT "userId", "expiresAt" FROM api_tokens WHERE "tokenHash" = $1 LIMIT 1`,
        [h]
      );
      if (!row.rows.length) return null;
      const { userId, expiresAt } = row.rows[0];
      if (expiresAt && new Date(expiresAt) < new Date()) return null;
      pool.query(`UPDATE api_tokens SET "lastUsedAt" = NOW() WHERE "tokenHash" = $1`, [h]).catch(() => {});
      return userId;
    } catch { return null; }
  }
  return null;
}

// A data-URI avatar (a real uploaded photo, not a lightweight Gravatar link)
// gets re-embedded in FULL on every single API response that mentions that
// user — once per issue's assignee/reporter, once per comment author, once
// per row on a 100-row list page. One heavily-used account with a real photo
// (~4.5KB) turns an ordinary list page into hundreds of KB of pure repeated
// avatar bytes (confirmed in production: 500+ KB responses, 17-19s each,
// queuing other requests behind them on the browser's connection limit).
// This swaps a data-URI for a reference to the cached proxy endpoint below,
// so the browser fetches those bytes once and reuses them everywhere,
// instead of every response re-sending them. Lightweight external URLs
// (Gravatar, etc.) are left untouched — they're already cheap and cacheable.
function avatarRef(userId: string | null | undefined, avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  if (!userId || !avatarUrl.startsWith('data:')) return avatarUrl;
  return `/api/users/${userId}/avatar`;
}

/** Format a DB user record to the API shape the frontend expects */
function formatUser(u: {
  id: string; email: string; firstName: string; lastName: string;
  role: string; avatarUrl?: string | null; isActive: boolean; createdAt?: Date; status?: string;
}) {
  const status = (u as any).status || (u.isActive ? 'active' : 'inactive');
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: `${u.firstName} ${u.lastName}`.trim(),
    role: u.role,
    organizationId: 'org_demo',
    avatarUrl: avatarRef(u.id, u.avatarUrl),
    isActive: u.isActive,
    status,
    createdAt: u.createdAt?.toISOString() ?? nowIso(),
  };
}

/** Format a DB space record (with included relations) to the API shape */
function formatSpace(sp: any) {
  const statuses = (sp.statuses || []).map((st: any) => ({
    id: st.id,
    name: st.name,
    category: st.category,
    color: st.color,
    order: st.order,
    position: st.order,
  }));

  const members = (sp.members || []).map((m: any) => ({
    id: m.userId,
    userId: m.userId,
    email: m.user?.email ?? '',
    firstName: m.user?.firstName ?? '',
    lastName: m.user?.lastName ?? '',
    avatarUrl: avatarRef(m.userId, m.user?.avatarUrl),
    role: m.role,
    department: m.department ?? null,
  }));

  return {
    id: sp.id,
    key: sp.key,
    name: sp.name,
    description: sp.description ?? '',
    type: sp.type ?? 'scrum',
    icon: sp.icon ?? null,
    memberCount: sp.memberCount ?? members.length,
    issueCount: sp.issueCount ?? 0,
    members,
    statuses,
    createdAt: sp.createdAt?.toISOString() ?? nowIso(),
    updatedAt: sp.updatedAt?.toISOString() ?? nowIso(),
  };
}

// SLA lifecycle events (started/resumed/paused/resolved/breached) previously
// left no trace in an issue's History tab at all — only the side-effect they
// were attached to (a department change, a status change) showed up, with
// nothing calling out that the SLA clock itself had started, paused, or
// breached. Centralized here so every pauseDeptSLA/startDeptSLA call site
// (transfer, recall, handoff, close) gets a History entry for free.
async function logSlaHistory(issueKey: string | null, issueId: string | null, message: string): Promise<void> {
  try {
    const targetId = issueId || (issueKey
      ? (await pool.query(`SELECT id FROM issues WHERE key=$1`, [issueKey])).rows[0]?.id
      : null);
    if (!targetId) return;
    await (db as any).issueHistory.create({
      data: { id: rid(), issueId: targetId, field: 'sla', oldValue: null, newValue: message, authorName: 'System', createdAt: new Date() },
    });
  } catch { /* non-fatal */ }
}

/**
 * Pause the SLA for `dept` and store elapsed ms in dept_sla_log.
 * Call this just before resetting dept_sla_started_at to NOW().
 */
async function pauseDeptSLA(issueKey: string | null, issueId: string | null, dept: string, historyLabel: string = 'SLA paused'): Promise<void> {
  if (!dept) return;
  try {
    const row = await pool.query(
      `SELECT dept_sla_started_at, dept_sla_log FROM issues WHERE ${issueKey ? 'key=$1' : 'id=$1'}`,
      [issueKey || issueId]
    );
    if (!row.rows[0]) return;
    const startedAt: Date | null = row.rows[0].dept_sla_started_at;
    const log: Record<string, any> = row.rows[0].dept_sla_log || {};
    const nowTs = new Date();
    const existingElapsed: number = log[dept]?.elapsed_ms ?? 0;
    const newElapsed = startedAt
      ? existingElapsed + (nowTs.getTime() - new Date(startedAt).getTime())
      : existingElapsed;
    log[dept] = {
      ...(log[dept] || {}),
      started_at: startedAt?.toISOString() ?? nowTs.toISOString(),
      elapsed_ms: newElapsed,
      paused_at: nowTs.toISOString(),
      status: 'paused',
    };
    await pool.query(
      `UPDATE issues SET dept_sla_log=$1::jsonb WHERE ${issueKey ? 'key=$2' : 'id=$2'}`,
      [JSON.stringify(log), issueKey || issueId]
    );
    await logSlaHistory(issueKey, issueId, `${historyLabel} — ${dept}`);
  } catch { /* non-fatal */ }
}

/**
 * Mark a dept as "running" in dept_sla_log (called after dept_sla_started_at = NOW()).
 */
async function startDeptSLA(issueKey: string | null, issueId: string | null, dept: string): Promise<void> {
  if (!dept) return;
  try {
    const row = await pool.query(
      `SELECT dept_sla_log FROM issues WHERE ${issueKey ? 'key=$1' : 'id=$1'}`,
      [issueKey || issueId]
    );
    const log: Record<string, any> = row.rows[0]?.dept_sla_log || {};
    const wasStartedBefore = !!log[dept];
    const nowTs = new Date();
    log[dept] = {
      ...(log[dept] || {}),
      started_at: nowTs.toISOString(),
      elapsed_ms: log[dept]?.elapsed_ms ?? 0,
      status: 'running',
      paused_at: null,
    };
    await pool.query(
      `UPDATE issues SET dept_sla_log=$1::jsonb WHERE ${issueKey ? 'key=$2' : 'id=$2'}`,
      [JSON.stringify(log), issueKey || issueId]
    );
    await logSlaHistory(issueKey, issueId, `${wasStartedBefore ? 'SLA resumed' : 'SLA started'} — ${dept}`);
  } catch { /* non-fatal */ }
}

/**
 * Moves an issue to targetDept, exactly like the "Change Department" dropdown
 * does: saves the current assignee under the old dept, restores (or
 * round-robins) an assignee for the new dept, flips dept_statuses for both
 * sides, pauses/resumes the SLA clock, and records the transition + a
 * worked-on credit. Shared by both places a "Waiting for X" status is
 * meant to trigger an actual handoff, not just relabel the ticket: a real
 * global status of that name, and a queue-scoped one (picked from a
 * custom queue's own status list, which never has a real row in the
 * statuses table and so is sent as queueStatusId, not statusId).
 * Returns the dept the ticket was in before the move (may be '').
 * Throws on failure -- callers already wrap this in their own try/catch.
 */
async function performDeptHandoff(
  issueId: string,
  spaceId: string,
  productType: string | null,
  targetDept: string,
  waitingStatusLabel: string,
  fallbackStatusId: string | null,
  userId: string | null,
): Promise<string> {
  const existingMap = await pool.query(
    `SELECT dept_assignees, "assigneeId", current_department, dept_statuses FROM issues WHERE id=$1`, [issueId]
  );
  const oldDept: string = existingMap.rows[0]?.current_department || '';
  const deptAssignees: Record<string, any> = existingMap.rows[0]?.dept_assignees || {};
  const deptStatuses: Record<string, any>  = existingMap.rows[0]?.dept_statuses  || {};
  const curAssigneeId = existingMap.rows[0]?.assigneeId;

  if (oldDept && curAssigneeId) {
    const curAssignee = await db.user.findUnique({ where: { id: curAssigneeId }, select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } });
    if (curAssignee) {
      deptAssignees[oldDept] = { id: curAssignee.id, email: curAssignee.email, firstName: curAssignee.firstName, lastName: curAssignee.lastName, displayName: `${curAssignee.firstName} ${curAssignee.lastName}`.trim(), avatarUrl: avatarRef(curAssignee.id, curAssignee.avatarUrl) };
    }
  }
  // Restore whoever was saved for this dept from a previous visit (same
  // restore-or-round-robin rule the "Change Department" dropdown already
  // uses) instead of always landing unassigned.
  const savedForTarget = deptAssignees[targetDept];
  let handoffAssigneeId: string | null = null;
  if (savedForTarget?.id) {
    const stillExists = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [savedForTarget.id]);
    if (stillExists.rows.length) handoffAssigneeId = savedForTarget.id;
    else delete deptAssignees[targetDept];
  }
  if (!handoffAssigneeId) {
    try {
      const rrAgent = await getNextAgent(spaceId, targetDept, productType);
      if (rrAgent) {
        handoffAssigneeId = rrAgent.userId;
        deptAssignees[targetDept] = { id: rrAgent.userId, displayName: rrAgent.name };
      }
    } catch { /* non-critical — falls through to unassigned */ }
  }

  deptStatuses[oldDept] = { id: '', name: waitingStatusLabel, category: 'todo', color: '#F59E0B' };
  const inProgressSt = await db.status.findFirst({ where: { spaceId, category: 'in_progress' }, orderBy: { order: 'asc' } })
    || await db.status.findFirst({ where: { spaceId, name: { contains: 'progress', mode: 'insensitive' } }, orderBy: { order: 'asc' } });
  const inProgressStatusObj = inProgressSt
    ? { id: inProgressSt.id, name: inProgressSt.name, category: inProgressSt.category, color: inProgressSt.color }
    : { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' };
  deptStatuses[targetDept] = inProgressStatusObj;
  const targetStatusId = inProgressSt?.id || fallbackStatusId;

  await pauseDeptSLA(null, issueId, oldDept);
  await pool.query(
    `UPDATE issues SET current_department=$1, "assigneeId"=$6, dept_sla_started_at=NOW(), dept_assignees=$2::jsonb, dept_statuses=$3::jsonb, "statusId"=$4, "updatedAt"=NOW() WHERE id=$5`,
    [targetDept, JSON.stringify(deptAssignees), JSON.stringify(deptStatuses), targetStatusId, issueId, handoffAssigneeId]
  );
  await startDeptSLA(null, issueId, targetDept);

  if (oldDept) {
    pool.query(
      `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept, moved_by, moved_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT DO NOTHING`,
      [issueId, spaceId, oldDept, targetDept, userId]
    ).catch(() => {});
  }
  // Only fall back to crediting whoever performed the handoff when there's no
  // real assignee to credit instead, so this list stays personal and doesn't
  // fill up with tickets someone merely routed through the status dropdown.
  if (oldDept && curAssigneeId) {
    pool.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
      [curAssigneeId, issueId, oldDept]
    ).catch(() => {});
  } else if (oldDept && userId) {
    pool.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
      [userId, issueId, oldDept]
    ).catch(() => {});
  }
  return oldDept;
}

/**
 * Compute paused SLA state for a dept (used in Sent/Watching).
 * Returns elapsed_ms, goalDurationMs, isBreached, remainingMs, policyName.
 */
async function computePausedDeptSLA(
  issueRow: any,
  dept: string,
  slaPolicies: any[]
): Promise<{ elapsed_ms: number; goalDurationMs: number; isBreached: boolean; remainingMs: number; policyName: string; paused_at: string | null } | null> {
  try {
    const log: Record<string, any> = issueRow.dept_sla_log || {};
    const deptLog = log[dept];
    // Fallback: if no log entry but dept_sla_started_at exists, compute elapsed from that
    let elapsed_ms: number = 0;
    if (deptLog) {
      elapsed_ms = deptLog.elapsed_ms || 0;
    } else if (issueRow.dept_sla_started_at) {
      elapsed_ms = Math.max(0, Date.now() - new Date(issueRow.dept_sla_started_at).getTime());
    } else {
      return null;
    }
    if (!slaPolicies.length) return null;
    const priority = (issueRow.priority || 'medium').toLowerCase();
    // Prefer dept-specific SLA policy, fall back to space-wide
    const policy = slaPolicies.find((p: any) => p.dept_name?.toLowerCase() === dept.toLowerCase()) || slaPolicies[0];
    let goalDurationMs = 8 * 60 * 60 * 1000;
    const goals: any[] = Array.isArray(policy.goals) ? policy.goals : [];
    for (const goal of goals) {
      if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
        const row = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
        if (row?.timeValue) {
          const val = parseFloat(row.timeValue);
          const unit = (row.timeUnit || 'hours').toLowerCase();
          goalDurationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
          break;
        }
      } else if (goal.timeValue) {
        const val = parseFloat(goal.timeValue);
        const unit = (goal.timeUnit || 'hours').toLowerCase();
        goalDurationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
        break;
      }
    }
    // Paused SLAs are never breached — clock stopped, same rule as
    // computeIssueSLAsFromDb. This panel only renders once a ticket has
    // moved OUT of `dept` (Sent/Watching), so by definition the SLA clock
    // for `dept` is no longer running; flagging it "BREACHED" here was
    // judging a stopped clock as if it were still ticking, which read as
    // an active, urgent alarm for a department that no longer owns the
    // ticket.
    const isBreached = false;
    const remainingMs = Math.max(0, goalDurationMs - elapsed_ms);
    return { elapsed_ms, goalDurationMs, isBreached, remainingMs, policyName: policy.name || 'SLA', paused_at: deptLog?.paused_at || null };
  } catch { return null; }
}

/** Format a DB issue record to the API shape the frontend expects */
/** Compute live SLA instances for an issue from active DB SLA policies */
async function computeIssueSLAsFromDb(issue: any): Promise<any[]> {
  try {
    const spaceId = issue.spaceId ?? issue.space?.id;
    if (!spaceId) return [];
    // These don't depend on each other -- run together instead of one after
    // the other, same as the other independent queries on this page load.
    const [res, notifRes] = await Promise.all([
      pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]),
      pool.query(
        `SELECT id FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' LIMIT 1`,
        [issue.cf_key || issue.key]
      ).catch(() => ({ rows: [] as any[] })), // notifications table may not have issueKey column
    ]);
    const isNotified = notifRes.rows.length > 0;
    return computeSLAInstancesPure(issue, res.rows, isNotified);
  } catch { return []; }
}

// Pure computation half of computeIssueSLAsFromDb, split out so a caller that
// needs this for MANY issues at once (my-dashboard) can batch-fetch policies
// and notification flags ONCE per space/issue-set up front, instead of
// computeIssueSLAsFromDb's own two-query-per-issue fetch repeating the exact
// same "SLA policies for this space" lookup once per issue in that space.
function computeSLAInstancesPure(issue: any, allPolicies: any[], isNotified: boolean): any[] {
  try {
    if (!allPolicies.length) return [];

    // Only apply policies that target this issue's dept (or have no dept restriction)
    const issueDept = ((issue as any).current_department || '').trim().toLowerCase();
    const policies = allPolicies.filter((p: any) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === issueDept;
    });
    if (!policies.length) return [];

    const priority = (issue.priority || 'medium').toLowerCase();
    // The status badge shown to the user can come from EITHER the ticket's
    // global status OR its per-department dept_statuses snapshot (see
    // issueStat in the issue detail page) -- whichever one the UI is
    // currently reading from. Checking only the global status here let a
    // ticket that visibly shows "Resolved" (via dept_statuses, e.g. a
    // queue-scoped status whose done-ness never made it back to the real
    // statusId column) keep ticking its SLA overdue counter forever, even
    // though it plainly reads as resolved everywhere else in the UI.
    const deptStatuses: Record<string, any> = (issue as any).dept_statuses || {};
    const deptStatusKey = Object.keys(deptStatuses).find((k) => k.toLowerCase() === issueDept);
    const deptStatusCategory = deptStatusKey ? deptStatuses[deptStatusKey]?.category : undefined;
    const isResolved = issue.status?.category === 'done' || deptStatusCategory === 'done';
    const currentStatusName = (issue.status?.name || '').trim().toLowerCase();

    // dept_sla_started_at is reset to NOW() on every department handoff --
    // including a RETURN to a dept that already spent some of its SLA
    // budget before being paused (moved away) earlier. Computing dueTime as
    // "fresh start + the full goal duration" ignored that prior spend
    // entirely, handing every dept a brand-new full countdown each time it
    // got the ticket back -- the opposite of "continue," which is what a
    // dept's SLA is supposed to do across a pause/resume cycle. Credit
    // whatever this dept had already burned (dept_sla_log[dept].elapsed_ms,
    // the same bookkeeping pauseDeptSLA/startDeptSLA already maintain) so
    // the due time reflects the REMAINING budget, not a fresh one.
    const deptSlaLog: Record<string, any> = (issue as any).dept_sla_log || {};
    const deptLogKey = Object.keys(deptSlaLog).find((k) => k.toLowerCase() === issueDept);
    const priorElapsedMs: number = deptLogKey ? (deptSlaLog[deptLogKey]?.elapsed_ms || 0) : 0;

    return policies.map((policy: any) => {
      let durationMs = 8 * 60 * 60 * 1000; // default 8h
      const goals: any[] = Array.isArray(policy.goals) ? policy.goals : [];
      for (const goal of goals) {
        if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
          const row = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
          if (row?.timeValue) {
            const val = parseFloat(row.timeValue);
            const unit = (row.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        } else if (goal.timeValue) {
          const val = parseFloat(goal.timeValue);
          const unit = (goal.timeUnit || 'hours').toLowerCase();
          durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
          break;
        }
      }

      // Check if current status is a pause status for this policy
      const pauseStatuses: string[] = Array.isArray(policy.pauseStatuses)
        ? policy.pauseStatuses.map((s: string) => s.trim().toLowerCase())
        : [];
      const isPaused = !isResolved && pauseStatuses.includes(currentStatusName);

      const startedAt = (issue as any).dept_sla_started_at
        ? new Date((issue as any).dept_sla_started_at).toISOString()
        : (issue.createdAt ? new Date(issue.createdAt).toISOString() : new Date().toISOString());
      // Remaining budget = full goal minus whatever this dept already burned
      // across earlier visits, so resuming here continues the countdown
      // instead of restarting it at the full duration.
      const remainingBudgetMs = Math.max(0, durationMs - priorElapsedMs);
      const dueTime = new Date(new Date(startedAt).getTime() + remainingBudgetMs).toISOString();
      // Paused SLAs are never breached — clock stopped
      const isBreached = !isResolved && !isPaused && new Date(dueTime) < new Date();
      return {
        id: `sla_${policy.id}_${issue.key}`,
        policyId: policy.id,
        policyName: policy.name || 'SLA',
        deptName: policy.dept_name || null,
        dueTime,
        isBreached,
        isPaused,
        isCompleted: isResolved,
        startedAt,
        goalDurationMs: durationMs,
        isNotified,
      };
    });
  } catch { return []; }
}

function formatIssue(issue: any) {
  const statusObj = issue.status
    ? {
        id: issue.status.id,
        name: issue.status.name,
        category: issue.status.category,
        color: issue.status.color,
      }
    : { id: '', name: 'Open', category: 'todo', color: '#64748B' };

  const assignee = issue.assignee
    ? {
        id: issue.assignee.id,
        email: issue.assignee.email,
        firstName: issue.assignee.firstName,
        lastName: issue.assignee.lastName,
        displayName: `${issue.assignee.firstName} ${issue.assignee.lastName}`.trim(),
        avatarUrl: avatarRef(issue.assignee.id, issue.assignee.avatarUrl),
      }
    : issue.jira_assignee_name
    ? { id: null, email: null, firstName: issue.jira_assignee_name.split(' ')[0], lastName: issue.jira_assignee_name.split(' ').slice(1).join(' '), displayName: issue.jira_assignee_name, avatarUrl: null }
    : null;

  const reporter = issue.reporter
    ? {
        id: issue.reporter.id,
        email: issue.reporter.email,
        firstName: issue.reporter.firstName,
        lastName: issue.reporter.lastName,
        displayName: `${issue.reporter.firstName} ${issue.reporter.lastName}`.trim(),
        avatarUrl: avatarRef(issue.reporter.id, issue.reporter.avatarUrl),
      }
    : issue.jira_reporter_name
    ? { id: null, email: null, firstName: issue.jira_reporter_name.split(' ')[0], lastName: issue.jira_reporter_name.split(' ').slice(1).join(' '), displayName: issue.jira_reporter_name, avatarUrl: null }
    : null;

  const comments = (issue.comments || []).map((c: any) => ({
    id: c.id,
    body: c.body,
    isInternal: false,
    author: c.author
      ? { id: c.author.id, firstName: c.author.firstName, lastName: c.author.lastName, email: c.author.email }
      : { id: '', firstName: c.authorName ?? 'Unknown', lastName: '', email: c.authorEmail ?? '' },
    createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : (c.createdAt ?? nowIso()),
    updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : (c.updatedAt ?? nowIso()),
  }));

  const issueNum = parseInt(String(issue.key || '').split('-').pop() || '1', 10) || 1;

  // Normalize key: strip Jira sub-issue colon suffix (e.g. "L2B-12718:1" Ã¢â€ ' "L2B-12718")
  const normalizedKey = issue.key?.includes(':') ? issue.key.split(':')[0] : issue.key;

  return {
    id: issue.id,
    key: normalizedKey,
    cfKey: issue.cf_key ?? null,
    issueNumber: issueNum,
    summary: issue.summary,
    description: (() => {
      const raw = issue.description ?? '';
      if (!raw) return '';
      // If stored as ADF JSON string, convert to HTML
      if (raw.startsWith('{') && raw.includes('"type"')) {
        try { const adf = JSON.parse(raw); return adfNodeToHtml(adf); } catch { /* fall through */ }
      }
      return raw;
    })(),
    type: issue.type ?? 'task',
    workType: issue.workType ?? null,
    priority: issue.priority ?? 'medium',
    status: statusObj,
    spaceKey: issue.space?.key ?? '',
    spaceName: issue.space?.name ?? '',
    spaceId: issue.spaceId,
    assignee,
    reporter,
    parentKey: issue.parentKey ?? null,
    labels: issue.labels ?? [],
    productType: issue.productType ?? null,
    combination: issue.combination ?? null,
    rootCause: issue.rootCause ?? null,
    fixDescription: issue.fixDescription ?? null,
    manageClientName: issue.manageClientName ?? null,
    customerPlan: issue.customerPlan ?? null,
    testEnvironment: issue.testEnvironment ?? null,
    customerName: issue.customerName ?? null,
    clientName: issue.clientName ?? null,
    projectManager: issue.projectManager ?? null,
    comments,
    commentCount: comments.length,
    attachments: [],
    attachmentCount: 0,
    links: (issue._links || []).map((lnk: any) => {
      const sk = lnk.sourceKey?.includes(':') ? lnk.sourceKey.split(':')[0] : lnk.sourceKey;
      const tk = lnk.targetKey?.includes(':') ? lnk.targetKey.split(':')[0] : lnk.targetKey;
      return {
        id: lnk.id,
        type: lnk.linkType,
        source: { key: sk, summary: lnk._sourceSummary ?? sk, type: 'task' },
        target: { key: tk, summary: lnk._targetSummary ?? tk, type: 'task' },
      };
    }),
    children: [],
    activity: [],
    sla: [],
    storyPoints: issue.storyPoints ?? null,
    dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
    resolvedAt: issue.resolvedAt ? new Date(issue.resolvedAt).toISOString() : null,
    position: 0,
    current_department: issue.current_department ?? null,
    department_assignee_id: issue.department_assignee_id ?? null,
    dept_sla_started_at: (issue as any).dept_sla_started_at ? new Date((issue as any).dept_sla_started_at).toISOString() : null,
    dept_sla_log: (issue as any).dept_sla_log ?? {},
    dept_assignees: (issue as any).dept_assignees ?? {},
    dept_statuses: (issue as any).dept_statuses ?? {},
    createdAt: issue.createdAt?.toISOString() ?? nowIso(),
    updatedAt: issue.updatedAt?.toISOString() ?? nowIso(),
    sla_breached: issue.sla_breached ?? false,
    // Historical SLA-breach flag imported from Jira (L2B/L3B migration) --
    // the local SLA clock is scoped to time spent in THIS app's own
    // departments and never breaches once a ticket is resolved, so a ticket
    // that was already breached in Jira before migration would otherwise
    // show as "not breached" here forever. Null/false for every other
    // ticket, so this is a no-op everywhere the backfill hasn't run.
    jira_sla_breached: (issue as any).jira_sla_breached ?? false,
    jira_sla_due_at: (issue as any).jira_sla_due_at ? new Date((issue as any).jira_sla_due_at).toISOString() : null,
    jira_sla_start_at: (issue as any).jira_sla_start_at ? new Date((issue as any).jira_sla_start_at).toISOString() : null,
  };
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Date range parser (same logic as mock) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function parseDateRange(range: string): { from: Date; to: Date } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (range.startsWith('withinLast:')) {
    const [, ns, unit] = range.split(':');
    const n = parseInt(ns, 10) || 7;
    const f = new Date(now);
    if (unit === 'weeks') f.setDate(f.getDate() - n * 7);
    else if (unit === 'months') f.setMonth(f.getMonth() - n);
    else f.setDate(f.getDate() - n);
    return { from: f, to: now };
  }

  if (range.startsWith('moreThan:')) {
    const [, ns, unit] = range.split(':');
    const n = parseInt(ns, 10) || 7;
    const t = new Date(now);
    if (unit === 'weeks') t.setDate(t.getDate() - n * 7);
    else if (unit === 'months') t.setMonth(t.getMonth() - n);
    else t.setDate(t.getDate() - n);
    return { from: new Date(0), to: t };
  }

  switch (range) {
    case 'today': return { from: startOfToday, to: now };
    case 'yesterday': {
      const y = new Date(startOfToday); y.setDate(y.getDate() - 1);
      return { from: y, to: startOfToday };
    }
    case '7d': { const f = new Date(startOfToday); f.setDate(f.getDate() - 7); return { from: f, to: now }; }
    case '30d': { const f = new Date(startOfToday); f.setDate(f.getDate() - 30); return { from: f, to: now }; }
    case '90d': { const f = new Date(startOfToday); f.setDate(f.getDate() - 90); return { from: f, to: now }; }
    default: return { from: new Date(0), to: now };
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ On-demand Jira import Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net';
const JIRA_EMAIL    = process.env.JIRA_EMAIL    || 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN    = process.env.JIRA_TOKEN    || 'REDACTED_API_TOKEN';
const JIRA_AUTH_HDR = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// Lazily loaded Jira credentials from app_settings DB (set during import)
let _cachedJiraBase:  string | null = null;
let _cachedJiraEmail: string | null = null;
let _cachedJiraToken: string | null = null;
let _credCacheTime = 0;
async function getJiraCredentials(): Promise<{ base: string; email: string; token: string; authHdr: string }> {
  const now = Date.now();
  if (_cachedJiraToken && now - _credCacheTime < 5 * 60 * 1000) {
    return { base: _cachedJiraBase!, email: _cachedJiraEmail!, token: _cachedJiraToken!, authHdr: 'Basic ' + Buffer.from(`${_cachedJiraEmail}:${_cachedJiraToken}`).toString('base64') };
  }
  try {
    const rows = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
    const s: Record<string, string> = {};
    for (const r of rows.rows) s[r.key] = r.value;
    if (s.jira_token) {
      _cachedJiraBase  = s.jira_url   || JIRA_BASE_URL;
      _cachedJiraEmail = s.jira_email || JIRA_EMAIL;
      _cachedJiraToken = s.jira_token;
      _credCacheTime   = now;
      return { base: _cachedJiraBase, email: _cachedJiraEmail, token: _cachedJiraToken, authHdr: 'Basic ' + Buffer.from(`${_cachedJiraEmail}:${_cachedJiraToken}`).toString('base64') };
    }
  } catch { /* fall through */ }
  // Fallback to env/hardcoded
  return { base: JIRA_BASE_URL, email: JIRA_EMAIL, token: JIRA_TOKEN, authHdr: JIRA_AUTH_HDR };
}

// Map issue key prefix Ã¢â€ ' { jiraProject, spaceKey }
const PREFIX_TO_META: Record<string, { jiraProject: string; spaceKey: string }> = {
  L1BOAR:  { jiraProject: 'CFITS',  spaceKey: 'L1BOAR'   },
  L2B:     { jiraProject: 'L2B',    spaceKey: 'L2BOARD'  },
  L3B:     { jiraProject: 'L3B',    spaceKey: 'L3BOARD'  },
  PSM:     { jiraProject: 'PSM',    spaceKey: 'PSMBOARD' },
  CFM:     { jiraProject: 'CFM',    spaceKey: 'CFMBOARD' },
  IB:      { jiraProject: 'IB',     spaceKey: 'INFRABOARD'},
  MB:      { jiraProject: 'MB',     spaceKey: 'MBBOARD'  },
  EB:      { jiraProject: 'EB',     spaceKey: 'EBBOARD'  },
  CB:      { jiraProject: 'CB',     spaceKey: 'CBBOARD'  },
  SOPS:    { jiraProject: 'SOPS',   spaceKey: 'SOPSBOARD'},
  QABOAR:  { jiraProject: 'QABOAR', spaceKey: 'QABOAR'   },
};

const JIRA_CUSTOM_FIELDS = 'customfield_10401,customfield_10883,customfield_11380,customfield_10203,customfield_10236,customfield_11404,customfield_10016';

function extractJiraValue(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) {
    const vals = raw.map((v: any) => v?.value ?? v?.name ?? v?.displayName ?? String(v)).filter(Boolean);
    return vals.length ? vals.join(', ') : null;
  }
  return (raw.value ?? raw.name ?? raw.displayName ?? raw.emailAddress ?? null);
}

function adfNodeToHtml(node: any): string {
  if (!node) return '';
  if (node.type === 'doc') return (node.content || []).map(adfNodeToHtml).join('');
  if (node.type === 'paragraph') { const i = (node.content||[]).map(adfNodeToHtml).join(''); return i.trim() ? `<p>${i}</p>` : ''; }
  if (node.type === 'text') {
    let t = (node.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    for (const m of (node.marks || [])) {
      if (m.type === 'strong') t = `<strong>${t}</strong>`;
      else if (m.type === 'em') t = `<em>${t}</em>`;
      else if (m.type === 'underline') t = `<u>${t}</u>`;
      else if (m.type === 'strike') t = `<s>${t}</s>`;
      else if (m.type === 'code') t = `<code>${t}</code>`;
      else if (m.type === 'link') {
        const href = (m.attrs?.href || '#').replace(/"/g, '&quot;');
        t = `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      }
    }
    return t;
  }
  if (node.type === 'hardBreak') return '<br/>';
  if (node.type === 'rule') return '<hr/>';
  if (node.type === 'bulletList') return `<ul>${(node.content||[]).map(adfNodeToHtml).join('')}</ul>`;
  if (node.type === 'orderedList') return `<ol>${(node.content||[]).map(adfNodeToHtml).join('')}</ol>`;
  if (node.type === 'listItem') return `<li>${(node.content||[]).map(adfNodeToHtml).join('')}</li>`;
  if (node.type === 'heading') { const lvl = Math.min(Math.max(node.attrs?.level||2, 1), 6); return `<h${lvl}>${(node.content||[]).map(adfNodeToHtml).join('')}</h${lvl}>`; }
  if (node.type === 'codeBlock') return `<pre><code>${(node.content||[]).map((n:any) => (n.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('')}</code></pre>`;
  if (node.type === 'blockquote') return `<blockquote>${(node.content||[]).map(adfNodeToHtml).join('')}</blockquote>`;
  if (node.type === 'inlineCard' || node.type === 'blockCard') {
    const u = node.attrs?.url || '';
    return u ? `<a href="${u.replace(/"/g,'&quot;')}" target="_blank" rel="noopener noreferrer">${u}</a>` : '';
  }
  if (node.type === 'mediaSingle') {
    return `<div class="media-single">${(node.content||[]).map(adfNodeToHtml).join('')}</div>`;
  }
  if (node.type === 'media') {
    const id = node.attrs?.id;
    const directUrl = node.attrs?.url;
    if (id) return `<img src="/api/jira-image?id=${id}" style="max-width:100%;border-radius:4px;margin:4px 0;" loading="lazy" onerror="this.style.display='none'"/>`;
    if (directUrl) return `<img src="/api/jira-image?url=${encodeURIComponent(directUrl)}" style="max-width:100%;border-radius:4px;margin:4px 0;" loading="lazy" onerror="this.style.display='none'"/>`;
    return '';
  }
  if (node.type === 'table') return `<table style="border-collapse:collapse;width:100%;margin:8px 0;">${(node.content||[]).map(adfNodeToHtml).join('')}</table>`;
  if (node.type === 'tableRow') return `<tr>${(node.content||[]).map(adfNodeToHtml).join('')}</tr>`;
  if (node.type === 'tableHeader') return `<th style="border:1px solid #e5e7eb;padding:6px 10px;background:#f9fafb;text-align:left;font-weight:600;">${(node.content||[]).map(adfNodeToHtml).join('')}</th>`;
  if (node.type === 'tableCell') return `<td style="border:1px solid #e5e7eb;padding:6px 10px;vertical-align:top;">${(node.content||[]).map(adfNodeToHtml).join('')}</td>`;
  if (node.type === 'expand' || node.type === 'nestedExpand') return `<details><summary>${node.attrs?.title||'Details'}</summary>${(node.content||[]).map(adfNodeToHtml).join('')}</details>`;
  if (node.type === 'panel') return `<div style="padding:8px 12px;border-left:4px solid #3b82f6;background:#eff6ff;border-radius:0 4px 4px 0;margin:4px 0;">${(node.content||[]).map(adfNodeToHtml).join('')}</div>`;
  if (node.type === 'mention') return `<span style="color:#3b82f6;font-weight:500;">@${node.attrs?.text?.replace(/^@/,'') || node.attrs?.id || ''}</span>`;
  if (node.type === 'emoji') return node.attrs?.text || node.attrs?.shortName || '';
  return (node.content || []).map(adfNodeToHtml).join('');
}

async function importIssueFromJira(localKey: string): Promise<ReturnType<typeof formatIssue> | null> {
  try {
    const prefix = localKey.split('-')[0];
    const meta = PREFIX_TO_META[prefix];
    if (!meta) return null;

    // L1BOAR keys don't match CFITS keys Ã¢â‚¬â€ can't look up by key directly
    if (prefix === 'L1BOAR') return null;

    const jiraKey = localKey; // key prefix matches Jira project for all other boards

    const creds = await getJiraCredentials();
    const fields = `summary,description,issuetype,priority,status,assignee,reporter,parent,labels,comment,${JIRA_CUSTOM_FIELDS}`;
    const url = `${creds.base}/rest/api/3/issue/${jiraKey}?fields=${fields}&expand=changelog`;
    // This fetch had no timeout, so whenever an issue (very often a stale or
    // broken linked-ticket key) isn't found locally, GET /issues/:key would
    // fall in here and hang forever if Jira is slow, unreachable, or blocked
    // by a proxy -- the whole issue page spins on "Loading issue..." with no
    // way to resolve. Abort and fall through to a normal 404 instead.
    const res = await fetch(url, {
      headers: { Authorization: creds.authHdr, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    }).catch((e) => {
      console.error(`[importIssueFromJira] Fetch failed for ${jiraKey}:`, e?.message || e);
      return null;
    });
    if (!res) return null;
    console.log(`[importIssueFromJira] Fetching ${jiraKey} from Jira, status: ${res.status}`);
    if (!res.ok) return null;
    const ji: any = await res.json();
    const f = ji.fields || {};

    // Find the local space using the correct spaceKey
    const space = await db.space.findUnique({
      where: { key: meta.spaceKey },
      include: { statuses: true },
    });
    if (!space) return null;

    // Map Jira status Ã¢â€ ' local status
    const jiraStatusName: string = f.status?.name || 'Open';
    const localStatus = space.statuses.find(
      (s: any) => s.name.toLowerCase() === jiraStatusName.toLowerCase()
    ) ?? space.statuses[0] ?? null;

    // Resolve user by displayName (Jira Cloud doesn't expose emails)
    const resolveByDisplayName = async (jiraUser: any): Promise<string | null> => {
      if (!jiraUser?.displayName) return null;
      const name = jiraUser.displayName.trim();
      const parts = name.split(/\s+/);
      // Try full name match first
      const byFull = await db.user.findFirst({
        where: { firstName: { equals: parts[0], mode: 'insensitive' },
                  lastName: { equals: parts.slice(1).join(' '), mode: 'insensitive' } },
      });
      if (byFull) return byFull.id;
      // Try email match if available
      if (jiraUser.emailAddress) {
        const byEmail = await db.user.findFirst({ where: { email: { equals: jiraUser.emailAddress, mode: 'insensitive' } } });
        if (byEmail) return byEmail.id;
      }
      // Try first name only
      const byFirst = await db.user.findFirst({ where: { firstName: { equals: parts[0], mode: 'insensitive' } } });
      return byFirst?.id ?? null;
    };

    const [assigneeId, reporterId] = await Promise.all([
      resolveByDisplayName(f.assignee),
      resolveByDisplayName(f.reporter),
    ]);

    // Check if issue already exists (might have been created earlier without assignee)
    const existingIssue = await db.issue.findUnique({ where: { key: localKey } });
    let issueId: string;

    if (existingIssue) {
      // Update existing
      await db.issue.update({
        where: { key: localKey },
        data: {
          summary: f.summary || localKey,
          type: (f.issuetype?.name || 'task').toLowerCase(),
          priority: (f.priority?.name || 'medium').toLowerCase(),
          statusId: localStatus?.id ?? existingIssue.statusId,
          assigneeId: assigneeId ?? existingIssue.assigneeId,
          reporterId: reporterId ?? existingIssue.reporterId,
          parentKey: f.parent?.key ?? existingIssue.parentKey,
          labels: Array.isArray(f.labels) ? f.labels : existingIssue.labels,
          customerName:   extractJiraValue(f.customfield_10401) ?? existingIssue.customerName,
          clientName:     extractJiraValue(f.customfield_10883) ?? existingIssue.clientName,
          projectManager: extractJiraValue(f.customfield_11380) ?? existingIssue.projectManager,
          productType:    extractJiraValue(f.customfield_10203) ?? existingIssue.productType,
          combination:    extractJiraValue(f.customfield_10236) ?? existingIssue.combination,
        },
      });
      issueId = existingIssue.id;
    } else {
      const created = await db.issue.create({
        data: {
          id: rid(), key: localKey,
          summary: f.summary || localKey,
          description: f.description ? (typeof f.description === 'object' ? adfNodeToHtml(f.description) : f.description) : null,
          type: (f.issuetype?.name || 'task').toLowerCase(),
          priority: (f.priority?.name || 'medium').toLowerCase(),
          spaceId: space.id, statusId: localStatus?.id ?? null,
          assigneeId, reporterId,
          parentKey: f.parent?.key ?? null,
          labels: Array.isArray(f.labels) ? f.labels : [],
          customerName:   extractJiraValue(f.customfield_10401),
          clientName:     extractJiraValue(f.customfield_10883),
          projectManager: extractJiraValue(f.customfield_11380),
          productType:    extractJiraValue(f.customfield_10203),
          combination:    extractJiraValue(f.customfield_10236),
        },
      });
      issueId = created.id;
    }

    // Import comments
    const jiraComments: any[] = f.comment?.comments || [];
    if (jiraComments.length > 0) {
      await db.comment.deleteMany({ where: { issueId } });
      for (const jc of jiraComments) {
        const commentAuthorId = await resolveByDisplayName(jc.author);
        let body = typeof jc.body === 'object' ? adfNodeToHtml(jc.body) : (jc.body || '');
        await db.comment.create({
          data: {
            id: rid(), body: body || '(empty)', issueId,
            authorId: commentAuthorId,
            authorName: jc.author?.displayName ?? null,
            authorEmail: null,
            createdAt: new Date(jc.created),
            updatedAt: new Date(jc.updated || jc.created),
          },
        });
      }
    }

    // Import changelog as history
    const changelog: any[] = ji.changelog?.histories || [];
    if (changelog.length > 0) {
      await db.issueHistory.deleteMany({ where: { issueId } });
      const histRecs: any[] = [];
      for (const entry of changelog) {
        const authorId = await resolveByDisplayName(entry.author);
        const authorName = entry.author?.displayName ?? null;
        for (const item of entry.items || []) {
          histRecs.push({
            id: rid(), issueId, field: item.field?.toLowerCase() || '',
            oldValue: item.fromString ?? null, newValue: item.toString ?? null,
            authorName, authorEmail: null,
            createdAt: new Date(entry.created),
          });
        }
      }
      if (histRecs.length > 0) await db.issueHistory.createMany({ data: histRecs });
    }

    // Return the full issue
    const fullIssue = await db.issue.findUnique({
      where: { key: localKey },
      include: {
        status: true, assignee: true, reporter: true,
        space: { select: { key: true, name: true } },
        comments: { include: { author: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!fullIssue) return null;
    return formatIssue({ ...fullIssue, _links: [], attachments: [], history: [] });
  } catch (e) {
    console.error('[importIssueFromJira] error:', e);
    return null;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Main handler Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export async function handleJiraPgApi(
  req: NextRequest,
  segments: string[],
  method: string,
): Promise<NextResponse> {
  try {
    return await _handleJiraPgApi(req, segments, method);
  } catch (err: any) {
    const isDev = process.env.NODE_ENV === 'development';
    const isDbDown = err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('connect') || err?.message?.includes('prisma');
    if (isDev && isDbDown) {
      // Return empty array or object depending on what the endpoint normally returns
      const p = segments.join('/');
      const arrayPaths = ['spaces', 'users', 'issues', 'notifications', 'sprints', 'comments', 'labels', 'watchers', 'attachments', 'history', 'members', 'custom-fields'];
      const isArrayPath = arrayPaths.some(a => p === a || p.startsWith(a + '/') || p.endsWith('/' + a));
      return json(isArrayPath ? [] : { total: 0, data: [], dev_db_unavailable: true });
    }
    console.error('[API] Unhandled error:', err?.message || err, err?.stack);
    // Never echo the raw error (e.g. a pg driver message like "timeout exceeded
    // when trying to connect" during a deploy restart) to the client in prod —
    // it's an internal detail, not something callers should branch on or show.
    return json({ error: isDev ? (err?.message || 'Internal server error') : 'Internal server error' }, 500);
  }
}

// Extracted so it can be called directly (in-process) from src/instrumentation.ts's
// periodic scheduler, instead of that code making an HTTP fetch() back to this same
// server. A self-fetch here deadlocks: Next.js's internal request-preparation gates
// ALL request handling (including this server's own self-fetch) on instrumentation's
// register() finishing — but register() was waiting on this exact self-fetch to
// finish, which could never happen until prepare() unblocked it. Every real request
// queued up behind that same block until the fetch's own timeout eventually fired.
export async function runSlaBreachCheck(): Promise<number> {
  const warnMs = 30 * 60 * 1000; // 30 minutes
  let notified = 0;
  try {
    // Get all active issues with dept_sla_started_at set (not resolved)
    const activeIssues = await pool.query(
      `SELECT i.*, s.category AS status_category, s.name AS status_name
       FROM issues i
       LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i.dept_sla_started_at IS NOT NULL
         AND (s.category IS NULL OR s.category != 'done')
       LIMIT 2000`
    );
    // Batch-fetch every distinct space's policies once up front instead of one
    // query per issue (was up to 2000 sequential DB round-trips in one call).
    const activeSpaceIds = Array.from(new Set(activeIssues.rows.map((r: any) => r.spaceId).filter(Boolean)));
    const policiesBySpace: Record<string, any[]> = {};
    if (activeSpaceIds.length) {
      const policyRows = await pool.query(
        `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`,
        [activeSpaceIds]
      );
      for (const p of policyRows.rows) { (policiesBySpace[p.spaceId] ??= []).push(p); }
    }
    for (const row of activeIssues.rows) {
      const policies = { rows: (policiesBySpace[row.spaceId] || []).slice(0, 5) };
      if (!policies.rows.length) continue;
      const priority = (row.priority || 'medium').toLowerCase();
      for (const policy of policies.rows) {
        // Compute goal duration
        let durationMs = 8 * 60 * 60 * 1000;
        const goals: any[] = Array.isArray(policy.goals) ? policy.goals : [];
        for (const goal of goals) {
          if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
            const pr = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
            if (pr?.timeValue) {
              const val = parseFloat(pr.timeValue);
              const unit = (pr.timeUnit || 'hours').toLowerCase();
              durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
              break;
            }
          } else if (goal.timeValue) {
            const val = parseFloat(goal.timeValue);
            const unit = (goal.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        }
        const startedAt = new Date(row.dept_sla_started_at).getTime();
        const dueAt = startedAt + durationMs;
        const now = Date.now();
        const timeToBreachMs = dueAt - now;
        // Warn if breach within 30 min (and not already breached)
        if (timeToBreachMs > 0 && timeToBreachMs <= warnMs) {
          // Avoid duplicate notifications within 1 hour
          const already = await (db as any).notification.findFirst({
            where: { issueKey: row.key, type: 'SLA_BREACH',
              createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
          });
          if (already) continue;
          const leadIds = await getSpaceLeadUserIds(row.spaceId);
          const managerMembers = await db.spaceMember.findMany({
            where: { spaceId: row.spaceId, role: 'manager' },
            select: { userId: true },
          }).catch(() => []);
          const managerIds = managerMembers.map((m: any) => m.userId).filter(Boolean);
          const recipients = [row.assigneeId, row.reporterId, ...leadIds, ...managerIds].filter(Boolean);
          const minsLeft = Math.ceil(timeToBreachMs / 60_000);
          await notifyUsers(recipients, null, {
            type: 'SLA_BREACH',
            title: `SLA breaching in ${minsLeft} min: ${row.key}`,
            message: `${policy.name || 'SLA'} will breach in ${minsLeft} minutes. Issue: ${row.summary || row.key}`,
            issueKey: row.key,
          });
          // Also send email notification to assignee, shift leads, and managers
          const allEmailUserIds = [row.assigneeId, ...leadIds, ...managerIds].filter(Boolean);
          const uniqueEmailUserIds = [...new Set(allEmailUserIds)];
          const emailRecipients = await db.user.findMany({
            where: { id: { in: uniqueEmailUserIds } },
            select: { email: true },
          });
          const assigneeEmails = emailRecipients.map((u: any) => u.email).filter(Boolean);
          const spaceRow = await db.space.findUnique({ where: { id: row.spaceId }, select: { key: true, name: true } });
          if (assigneeEmails.length && spaceRow) {
            notifySLABreach({
              issueKey: row.key,
              issueSummary: row.summary || row.key,
              spaceKey: spaceRow.key,
              spaceName: spaceRow.name,
              slaName: policy.name || 'SLA',
              minsLeft,
              assigneeEmails,
            }).catch(() => {});
          }
          notified++;
        }
      }
    }
  } catch (e: any) { console.error('[SLA breach check]', e?.message); }
  return notified;
}

async function _handleJiraPgApi(
  req: NextRequest,
  segments: string[],
  method: string,
): Promise<NextResponse> {
  const auth = req.headers.get('authorization');
  // Get client IP for session binding
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('x-real-ip')
    || '0.0.0.0';
  const clientUA = req.headers.get('user-agent') || '';
  const userId = await resolveUserId(auth, clientIp);
  const url = new URL(req.url);
  const path = segments.join('/');

  // Ã¢â€â‚¬Ã¢â€â‚¬ Auth Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'auth/login' && method === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const user = await db.user.findUnique({ where: { email } });
    if (!user || user.password !== password) {
      return json({ error: 'Invalid email or password' }, 401);
    }
    // First login: activate invited user
    if (!user.isActive) {
      await db.user.update({ where: { id: user.id }, data: { isActive: true } });
      await pool.query(`UPDATE users SET status='active', "isActive"=true WHERE id=$1`, [user.id]).catch(() => {});
      user.isActive = true;
    }
    await pool.query(`UPDATE users SET status='active' WHERE id=$1 AND status='invited'`, [user.id]).catch(() => {});
    return json({
      token: encodeToken(user.id, clientIp, clientUA),
      user: { ...formatUser(user), status: 'active' },
    });
  }

  // Generic small-file upload for description images/attachments — returns a
  // static URL so the description payload stays tiny instead of carrying the
  // whole file as base64 (that was blowing past the reverse-proxy body-size
  // limit and making ticket creation slow to upload on the client).
  //
  // Stored under <cwd>/uploads (NOT public/) and served via the GET branch
  // below rather than Next's static /public handler: `next start` builds a
  // route manifest for /public at build time, so files written there after
  // the server has started 404 even though they exist on disk. Reading the
  // file from disk on every request sidesteps that entirely.
  if (path === 'uploads' && method === 'POST') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    try {
      const formData = await req.formData();
      const file = formData.get('file');
      if (!(file instanceof Blob)) return json({ error: 'No file provided' }, 400);
      const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
      if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'File too large (max 10GB)' }, 413);
      const { writeFile, mkdir } = await import('fs/promises');
      const nodePath = await import('path');
      const id = rid();
      const originalName = (file as any).name || 'file';
      const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'file';
      const dir = nodePath.join(process.cwd(), 'uploads', 'tmp', id);
      await mkdir(dir, { recursive: true });
      const buf = Buffer.from(await file.arrayBuffer());
      await writeFile(nodePath.join(dir, safeName), buf);
      return json({ url: `/api/uploads/tmp/${id}/${safeName}`, filename: safeName, size: file.size });
    } catch (e: any) {
      return json({ error: e?.message || 'Upload failed' }, 500);
    }
  }

  // Serve previously uploaded files by reading straight from disk (see note above).
  if (segments[0] === 'uploads' && method === 'GET') {
    try {
      const nodePath = await import('path');
      const { readFile, stat } = await import('fs/promises');
      const uploadsRoot = nodePath.join(process.cwd(), 'uploads');
      const safeSegments = segments.slice(1).map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_'));
      const filePath = nodePath.resolve(uploadsRoot, ...safeSegments);
      if (!filePath.startsWith(uploadsRoot)) return new NextResponse(null, { status: 400 });
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) return new NextResponse(null, { status: 404 });
      const buf = await readFile(filePath);
      const ext = (safeSegments[safeSegments.length - 1]?.split('.').pop() || '').toLowerCase();
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
      return new NextResponse(buf, {
        headers: {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return new NextResponse(null, { status: 500 });
    }
  }

  if (path === 'auth/register' && method === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').toLowerCase().trim();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) return json({ error: 'Email already registered' }, 400);
    const user = await db.user.create({
      data: {
        id: rid(),
        email,
        firstName: String(body.firstName || 'User'),
        lastName: String(body.lastName || ''),
        password: String(body.password || ''),
        role: 'developer',
        isActive: true,
      },
    });
    return json({ token: encodeToken(user.id, clientIp, clientUA), user: formatUser(user) });
  }

  if (path === 'auth/me' && method === 'GET') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    // Dev: skip DB entirely Ã¢â‚¬â€ decode real identity from JWT claims if present
    if (process.env.NODE_ENV === 'development') {
      try {
        const jwt = require('jsonwebtoken');
        const raw = auth!.slice(7).trim();
        const claims = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] }) as any;
        return json({
          id: userId,
          email: claims.email || 'dev@local',
          firstName: claims.firstName || 'Dev',
          lastName: claims.lastName || 'User',
          role: 'admin',
          isActive: true,
          avatarUrl: claims.avatarUrl || null,
        });
      } catch {
        return json({ id: userId, email: 'dev@local', firstName: 'Dev', lastName: 'User', role: 'admin', isActive: true, avatarUrl: null });
      }
    }
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return json({ error: 'Unauthorized' }, 401);
    return json(formatUser(user));
  }

  // Logout Ã¢â‚¬â€ revoke session in DB
  if (path === 'auth/logout' && method === 'POST') {
    const t = auth?.slice(7).trim();
    if (t?.startsWith('eyJ')) {
      const tokenHash = hashToken(t);
      await pool.query(
        `UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`,
        [tokenHash]
      ).catch(() => {});
    }
    return json({ ok: true });
  }

  // OAuth SSO login Ã¢â‚¬â€ called by OAuth callback to exchange email Ã¢â€ ' JWT token
  if (path === 'auth/oauth-token' && method === 'POST') {
    const body = await readJson(req);
    const rawEmail = String(body.email || '').toLowerCase().trim();
    if (!rawEmail) return json({ error: 'Email required' }, 400);

    // Try exact match first
    let user = await db.user.findUnique({ where: { email: rawEmail } });

    // Fallback: match by local part (before @) in case domain differs slightly
    if (!user) {
      const localPart = rawEmail.split('@')[0];
      const candidates = await db.user.findMany({
        where: { email: { startsWith: localPart + '@' } },
        take: 1,
      });
      user = candidates[0] ?? null;
    }

    if (!user) {
      // No user found Ã¢â‚¬â€ return generic error (don't expose email details)
      return json({ error: `No account found for ${rawEmail}. Please contact your administrator.` }, 404);
    }
    // Save Microsoft profile photo if provided and user doesn't have one yet
    if (body.avatarUrl && !user.avatarUrl) {
      try {
        user = await db.user.update({ where: { id: user.id }, data: { avatarUrl: String(body.avatarUrl) } });
      } catch { /* non-critical */ }
    }
    return json({ token: encodeToken(user.id), user: formatUser(user) });
  }

  // Public paths that don't require auth
  const isPublicPath =
    path.startsWith('auth/') ||
    path === 'email/receive' ||
    path.startsWith('email-logs/') ||
    path === 'stats' ||
    // Avatar bytes served through the proxy in avatarRef() above — must stay
    // reachable via a plain <img src>, which never sends an Authorization
    // header. Not sensitive: same visibility as any avatar shown in the app.
    /^users\/[^/]+\/avatar$/.test(path);

  // This is "not authenticated" (no valid session), not "authenticated but not
  // allowed" — those are semantically 401 and 403 respectively, and the client
  // only treats 401 specially: it clears the stale token and redirects to
  // /auth/login. Returning 403 here (an expired/revoked/invalid token — see
  // resolveUserId above) meant every fetch on the page just failed silently
  // with a generic "Forbidden" error, no redirect, no message — the page kept
  // rendering from cached client state as if still logged in, while every
  // list on it quietly came back empty with no indication why.
  if (!userId && !isPublicPath) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Load current user for role checks (cached 60s to avoid a DB round-trip on every request)
  const currentUser = userId ? await getCachedUser(userId) : null;
  const isAdmin = currentUser?.role === 'admin';

  // Ã¢â€â‚¬Ã¢â€â‚¬ Stats Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'stats' && method === 'GET') {
    const [totalTickets, totalAgents, totalBoards] = await Promise.all([
      db.issue.count(),
      db.user.count(),
      db.space.count(),
    ]);
    return json({ totalTickets, totalAgents, totalBoards });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Users Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // Serves a user's real uploaded photo (stored as a data-URI) as actual image
  // bytes with aggressive caching, so the browser fetches it once instead of
  // every API response re-embedding the full base64 blob (see avatarRef above).
  const userAvatarMatch = path.match(/^users\/([^/]+)\/avatar$/);
  if (userAvatarMatch && method === 'GET') {
    try {
      const u = await db.user.findUnique({ where: { id: userAvatarMatch[1] }, select: { avatarUrl: true } });
      const dataUri = u?.avatarUrl;
      if (!dataUri || !dataUri.startsWith('data:')) return new NextResponse(null, { status: 404 });
      const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return new NextResponse(null, { status: 404 });
      const [, contentType, base64Data] = match;
      return new NextResponse(Buffer.from(base64Data, 'base64'), {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch {
      return new NextResponse(null, { status: 500 });
    }
  }

  if (path === 'users' && method === 'GET') {
    // All authenticated users can list users (needed for queue member search)
    const [users, statusRows] = await Promise.all([
      db.user.findMany({ orderBy: { firstName: 'asc' } }),
      pool.query(`SELECT id, status FROM users`).catch(() => ({ rows: [] as any[] })),
    ]);
    const statusMap: Record<string, string> = {};
    for (const r of statusRows.rows) statusMap[r.id] = r.status;
    return json(users.map(u => ({ ...formatUser(u), status: statusMap[u.id] || (u.isActive ? 'active' : 'inactive') })));
  }

  if (path === 'users' && method === 'POST') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await readJson(req);
    const user = await db.user.create({
      data: {
        id: rid(),
        email: String(body.email || '').toLowerCase(),
        firstName: String(body.firstName || ''),
        lastName: String(body.lastName || ''),
        role: String(body.role || 'developer'),
        password: String(body.password || 'changeme'),
        isActive: false,
      },
    });
    // Mark as 'invited' via raw SQL (status column added via ALTER TABLE)
    await pool.query(`UPDATE users SET status='invited' WHERE id=$1`, [user.id]).catch(() => {});
    return json({ ...formatUser(user), status: 'invited' });
  }

  const userPatch = path.match(/^users\/([^/]+)$/);
  if (userPatch && method === 'PATCH') {
    // Users can update themselves; only admins can update others
    const id = userPatch[1];
    if (id !== userId && !isAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await readJson(req);
    const data: Record<string, unknown> = {};
    // Non-admins cannot change their own role
    if (body.role !== undefined && isAdmin) data.role = String(body.role);
    if (body.isActive !== undefined && isAdmin) {
      data.isActive = Boolean(body.isActive);
      // Sync status column: reactivating sets 'active', deactivating sets 'inactive'
      pool.query(
        `UPDATE users SET status=$1 WHERE id=$2`,
        [Boolean(body.isActive) ? 'active' : 'inactive', id]
      ).catch(() => {});
    }
    if (body.firstName !== undefined) data.firstName = String(body.firstName);
    if (body.lastName !== undefined) data.lastName = String(body.lastName);
    if (body.displayName !== undefined) data.displayName = String(body.displayName);
    if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl ? String(body.avatarUrl) : null;
    if (body.password !== undefined) data.password = String(body.password);
    try {
      const user = await db.user.update({ where: { id }, data });
      return json(formatUser(user));
    } catch {
      return json({ error: 'Not found' }, 404);
    }
  }

  const userDelete = path.match(/^users\/([^/]+)$/);
  if (userDelete && method === 'DELETE') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const id = userDelete[1];
    // Prevent self-deletion
    if (id === userId) return json({ error: 'Cannot delete your own account' }, 400);
    try {
      // Remove from all space members first
      await db.spaceMember.deleteMany({ where: { userId: id } });
      await db.user.delete({ where: { id } });
      return json({ ok: true });
    } catch {
      return json({ error: 'User not found' }, 404);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Spaces Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'spaces' && method === 'GET') {
    const spaces = await db.space.findMany({
      where: isAdmin ? {} : { members: { some: { userId: userId! } } },
      include: {
        statuses: { orderBy: { order: 'asc' } },
        members: { include: { user: true } },
      },
      orderBy: { name: 'asc' },
    });
    return json(spaces.map(formatSpace));
  }

  // Every space's key only — deliberately NOT membership-filtered like GET /spaces above.
  // Used by the issue detail page to find which space owns a department's workflow
  // (statuses/transitions) when resolving the status-change dropdown: a department's
  // workflow can live in a space the viewing user isn't a member of, and without this
  // the dropdown silently came up empty (no transitions) for anyone but an admin, since
  // admins are the only ones who see every space via GET /spaces. Just keys/names, no
  // membership or issue data, so exposing it to any authenticated user is fine.
  if (path === 'all-space-keys' && method === 'GET') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const rows = await db.space.findMany({ select: { key: true } });
    return json(rows.map((r) => r.key));
  }

  if (path === 'spaces' && method === 'POST') {
    const body = await readJson(req);
    const key = String(body.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!key) return json({ error: 'Invalid space key' }, 400);
    const existing = await db.space.findUnique({ where: { key } });
    if (existing) return json({ error: 'Duplicate space key' }, 400);

    const space = await db.space.create({
      data: {
        id: rid(),
        key,
        name: String(body.name || key),
        description: body.description ? String(body.description) : null,
        type: String(body.type || 'service_desk'),
        issueCount: 0,
        memberCount: 1,
        statuses: {
          create: [
            { name: 'To Do', category: 'todo', color: '#64748B', order: 0 },
            { name: 'In Progress', category: 'in_progress', color: '#3B82F6', order: 1 },
            { name: 'Done', category: 'done', color: '#10B981', order: 2 },
          ],
        },
        ...(userId
          ? {
              members: {
                create: [{ userId, role: 'admin' }],
              },
            }
          : {}),
      },
      include: {
        statuses: { orderBy: { order: 'asc' } },
        members: { include: { user: true } },
      },
    });
    return json(formatSpace(space));
  }

  const spaceKeyMatch = path.match(/^spaces\/([^/]+)$/);
  if (spaceKeyMatch && method === 'GET') {
    const key = spaceKeyMatch[1].toUpperCase();
    const sp = await db.space.findUnique({
      where: { key },
      include: {
        statuses: { orderBy: { order: 'asc' } },
        members: { include: { user: true } },
        workflowTransitions: true,
      },
    });
    if (!sp) return json({ error: 'Space not found' }, 404);
    const result = formatSpace(sp);
    result.transitions = (sp as any).workflowTransitions || [];
    // Merge raw department column (not in Prisma schema)
    try {
      const deptRows = await pool.query(`SELECT "userId", department FROM space_members WHERE "spaceId"=$1`, [sp.id]);
      const deptByUser: Record<string, string> = {};
      for (const r of deptRows.rows) deptByUser[r.userId] = r.department;
      result.members = result.members.map((m: any) => ({ ...m, department: deptByUser[m.userId] ?? null }));
    } catch {}
    return json(result);
  }

  // GET /spaces/:key/field-values?field=customerName  Ã¢â‚¬â€ distinct non-null values for a field
  const fieldValuesMatch = path.match(/^spaces\/([^/]+)\/field-values$/);
  if (fieldValuesMatch && method === 'GET') {
    const spaceKeyFv = fieldValuesMatch[1].toUpperCase();
    const field = url.searchParams.get('field') || '';
    const deptFv = url.searchParams.get('dept') || '';
    const ALLOWED = new Set(['workType','productType','combination','testEnvironment','rootCause',
      'fixDescription','customerName','clientName','projectManager','manageClientName','customerPlan']);
    if (!ALLOWED.has(field)) return json({ error: 'Invalid field' }, 400);
    const sp = await db.space.findUnique({ where: { key: spaceKeyFv }, select: { id: true } });
    if (!sp) return json([]);
    // Columns are camelCase in the DB (Prisma default)
    const col = field; // already camelCase e.g. customerName, testEnvironment
    // Scoped to dept when given — without it, this returns every value used ANYWHERE
    // in the space, so filtering within e.g. the "Dev" queue could offer a Product
    // Type value no Dev ticket has ever had, and selecting it would correctly (but
    // confusingly) always return zero results, looking like the filter is broken.
    const rows = deptFv
      ? await pool.query(
          `SELECT DISTINCT "${col}" AS val FROM issues WHERE "spaceId" = $1 AND LOWER(current_department) = LOWER($2) AND "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY val`,
          [sp.id, deptFv]
        )
      : await pool.query(
          `SELECT DISTINCT "${col}" AS val FROM issues WHERE "spaceId" = $1 AND "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY val`,
          [sp.id]
        );
    return json(rows.rows.map((r: any) => r.val));
  }

  // GET /field-values?field=projectManager — same as above but across every space,
  // for filter UIs (e.g. /filters) that aren't scoped to a single space.
  if (path === 'field-values' && method === 'GET') {
    const field = url.searchParams.get('field') || '';
    const ALLOWED = new Set(['workType','productType','combination','testEnvironment','rootCause',
      'fixDescription','customerName','clientName','projectManager','manageClientName','customerPlan']);
    if (!ALLOWED.has(field)) return json({ error: 'Invalid field' }, 400);
    const col = field;
    const rows = await pool.query(
      `SELECT DISTINCT "${col}" AS val FROM issues WHERE "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY val`
    );
    return json(rows.rows.map((r: any) => r.val));
  }

  if (spaceKeyMatch && method === 'PATCH') {
    const key = spaceKeyMatch[1].toUpperCase();
    const body = await readJson(req);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.description !== undefined) data.description = String(body.description);
    if (body.icon !== undefined) data.icon = body.icon === null ? null : String(body.icon);
    if (body.type !== undefined) data.type = String(body.type);
    try {
      const sp = await db.space.update({
        where: { key },
        data,
        include: {
          statuses: { orderBy: { order: 'asc' } },
          members: { include: { user: true } },
        },
      });
      return json(formatSpace(sp));
    } catch {
      return json({ error: 'Not found' }, 404);
    }
  }

  if (spaceKeyMatch && method === 'DELETE') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const key = spaceKeyMatch[1].toUpperCase();
    try {
      await db.space.delete({ where: { key } });
      // Record deleted space so it won't be recreated
      await db.deletedSpace.upsert({
        where: { key },
        create: { key },
        update: {},
      });
      return json({ ok: true });
    } catch {
      return json({ error: 'Not found' }, 404);
    }
  }

  const spaceMembers = path.match(/^spaces\/([^/]+)\/members$/);
  if (spaceMembers && method === 'POST') {
    const key = spaceMembers[1].toUpperCase();
    const sp = await db.space.findUnique({ where: { key }, include: { members: true } });
    if (!sp) return json({ error: 'Not found' }, 404);
    // Only global admin or space admin can add members
    const isSpaceAdmin = sp.members.some(m => m.userId === userId && m.role === 'admin');
    if (!isAdmin && !isSpaceAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await readJson(req);
    const uid = String(body.userId || '');
    const targetUser = await db.user.findUnique({ where: { id: uid } });
    if (!targetUser) return json({ error: 'User not found' }, 404);
    const memberDept = body.department ? String(body.department) : null;
    await db.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: sp.id, userId: uid } },
      create: { spaceId: sp.id, userId: uid, role: String(body.role || 'developer') },
      update: { role: String(body.role || 'developer') },
    });
    if (memberDept !== null) {
      await pool.query(`UPDATE space_members SET department=$1 WHERE "spaceId"=$2 AND "userId"=$3`, [memberDept, sp.id, uid]);
    }
    // Update memberCount
    const count = await db.spaceMember.count({ where: { spaceId: sp.id } });
    await db.space.update({ where: { id: sp.id }, data: { memberCount: count } });
    const updated = await db.space.findUnique({
      where: { key },
      include: { statuses: { orderBy: { order: 'asc' } }, members: { include: { user: true } } },
    });
    const result = formatSpace(updated);
    // Merge raw department column (not in Prisma schema) -- same as GET
    // /spaces/:key, otherwise the member just added always comes back with
    // department: null even when one was set, until the next full reload.
    try {
      const deptRows = await pool.query(`SELECT "userId", department FROM space_members WHERE "spaceId"=$1`, [sp.id]);
      const deptByUser: Record<string, string> = {};
      for (const r of deptRows.rows) deptByUser[r.userId] = r.department;
      result.members = result.members.map((m: any) => ({ ...m, department: deptByUser[m.userId] ?? null }));
    } catch {}
    return json(result);
  }

  // PATCH /spaces/{key}/members/{userId} Ã¢â‚¬â€ update role or department
  const spaceMemberPatch = path.match(/^spaces\/([^/]+)\/members\/([^/]+)$/);
  if (spaceMemberPatch && method === 'PATCH') {
    const key = spaceMemberPatch[1].toUpperCase();
    const memberUserId = spaceMemberPatch[2];
    const sp = await db.space.findUnique({ where: { key }, include: { members: true } });
    if (!sp) return json({ error: 'Not found' }, 404);
    const isPrivilegedGlobalPatch = ['admin', 'manager', 'lead', 'shift_lead'].includes(currentUser?.role || '');
    const isSpaceAdmin = sp.members.some(m => m.userId === userId && ['admin', 'lead', 'shift_lead'].includes(m.role));
    if (!isPrivilegedGlobalPatch && !isSpaceAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await readJson(req);
    if (body.role !== undefined) {
      await db.spaceMember.update({ where: { spaceId_userId: { spaceId: sp.id, userId: memberUserId } }, data: { role: String(body.role) } });
    }
    if (body.department !== undefined) {
      await pool.query(`UPDATE space_members SET department=$1 WHERE "spaceId"=$2 AND "userId"=$3`, [body.department || null, sp.id, memberUserId]);
    }
    const updated = await db.space.findUnique({ where: { key }, include: { statuses: { orderBy: { order: 'asc' } }, members: { include: { user: true } } } });
    // Re-fetch department values (raw column)
    const deptRows = await pool.query(`SELECT "userId", department FROM space_members WHERE "spaceId"=$1`, [sp.id]);
    const deptByUser: Record<string, string> = {};
    for (const r of deptRows.rows) deptByUser[r.userId] = r.department;
    const result = formatSpace(updated);
    result.members = result.members.map((m: any) => ({ ...m, department: deptByUser[m.userId] ?? null }));
    return json(result);
  }

  // DELETE /spaces/{key}/members/{userId}
  const spaceMemberDelete = path.match(/^spaces\/([^/]+)\/members\/([^/]+)$/);
  if (spaceMemberDelete && method === 'DELETE') {
    const key = spaceMemberDelete[1].toUpperCase();
    const memberUserId = spaceMemberDelete[2];
    const sp = await db.space.findUnique({ where: { key }, include: { members: true } });
    if (!sp) return json({ error: 'Not found' }, 404);
    // Any authenticated user can remove members from a space
    try {
      await db.spaceMember.delete({
        where: { spaceId_userId: { spaceId: sp.id, userId: memberUserId } },
      });
      const count = await db.spaceMember.count({ where: { spaceId: sp.id } });
      await db.space.update({ where: { id: sp.id }, data: { memberCount: count } });
    } catch { /* already removed */ }
    const updated = await db.space.findUnique({
      where: { key },
      include: { statuses: { orderBy: { order: 'asc' } }, members: { include: { user: true } } },
    });
    return json(formatSpace(updated));
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Round Robin Config Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const rrConfigMatch = path.match(/^spaces\/([^/]+)\/rr-config$/);
  if (rrConfigMatch && method === 'GET') {
    const spaceKey = rrConfigMatch[1].toUpperCase();
    const space = await db.space.findFirst({ where: { key: spaceKey } });
    if (!space) return json({ error: 'Not found' }, 404);
    const config = await getRrConfig(space.id);
    const subRow = await pool.query(`SELECT COALESCE(sub_board_keys, '{}') AS keys FROM spaces WHERE key = $1`, [spaceKey]);
    const subBoardKeys: string[] = subRow.rows[0]?.keys || [];
    return json({ config: { ...(config || { spaceId: space.id, departments: [] }), subBoardKeys }, subBoardKeys });
  }

  if (rrConfigMatch && method === 'POST') {
    const spaceKey = rrConfigMatch[1].toUpperCase();
    const space = await db.space.findFirst({ where: { key: spaceKey } });
    if (!space) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    await saveRrConfig(space.id, (body.departments as any) || []);
    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Sub-boards config Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const subBoardsMatch = path.match(/^spaces\/([^/]+)\/sub-boards$/);
  if (subBoardsMatch && method === 'POST') {
    const sk = subBoardsMatch[1].toUpperCase();
    const body = await readJson(req);
    const keys: string[] = (body.subBoardKeys || []).map((k: string) => k.toUpperCase());
    await pool.query(`UPDATE spaces SET sub_board_keys = $1::text[] WHERE key = $2`, [keys, sk]);
    return json({ ok: true });
  }
  if (subBoardsMatch && method === 'GET') {
    const sk = subBoardsMatch[1].toUpperCase();
    const row = await pool.query(`SELECT COALESCE(sub_board_keys, '{}') AS keys FROM spaces WHERE key = $1`, [sk]);
    return json({ subBoardKeys: row.rows[0]?.keys || [] });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Dept-Queue Closed Tickets Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const deptQueueClosedMatch = path.match(/^spaces\/([^/]+)\/dept-queue\/closed$/);
  if (deptQueueClosedMatch && method === 'GET') {
    const spaceKeyParam = deptQueueClosedMatch[1].toUpperCase();
    const dept = url.searchParams.get('dept') || '';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 50;
    // Admins can view another team member's worked-on list from the per-queue
    // Summary's "Per user" table (clicking a name there) -- everyone else only
    // ever sees their own, same as before.
    const viewUserParam = url.searchParams.get('viewUser');
    const targetUserId = (viewUserParam && isAdmin) ? viewUserParam : userId;

    const spaceRes = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKeyParam]);
    if (!spaceRes.rows[0]) return json({ error: 'Space not found' }, 404);
    const spaceId = spaceRes.rows[0].id;

    try {
      // "Worked on" is meant to be personal (tickets THIS viewer worked on in this
      // dept), but this previously showed every ticket ever closed in the dept for
      // every user — queue_closed_tickets only tracks the queue, not who worked it.
      // Join against user_worked_on_tickets (populated on transfer/close/handoff,
      // covering unassigned handoffs too) filtered to the authenticated viewer so
      // each person only sees their own worked-on tickets, not the whole team's.
      const rows = await pool.query(
        `SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.summary AS title, i.priority, i.type,
                i."createdAt", i."updatedAt", qct.closed_at, qct.dept_name,
                s.name AS status_name, s.color AS status_color, s.category AS status_category,
                i.dept_sla_log, i.dept_assignees,
                CONCAT(a."firstName",' ',a."lastName") AS assignee_name, a."avatarUrl" AS assignee_avatar,
                a.id AS assignee_id
         FROM queue_closed_tickets qct
         JOIN issues i ON i.id = qct.issue_id
         JOIN user_worked_on_tickets w ON w.issue_id = qct.issue_id AND LOWER(w.dept) = LOWER(qct.dept_name)
         LEFT JOIN statuses s ON i."statusId" = s.id
         LEFT JOIN users a ON i."assigneeId" = a.id
         WHERE qct.space_id = $1 AND LOWER(qct.dept_name) = LOWER($2) AND w.user_id = $5
         ORDER BY COALESCE(i."updatedAt", qct.closed_at) DESC LIMIT $3 OFFSET $4`,
        [spaceId, dept, limit, (page - 1) * limit, targetUserId]
      );
      const countRes = await pool.query(
        `SELECT COUNT(DISTINCT qct.issue_id) FROM queue_closed_tickets qct
         JOIN issues i ON i.id = qct.issue_id
         JOIN user_worked_on_tickets w ON w.issue_id = qct.issue_id AND LOWER(w.dept) = LOWER(qct.dept_name)
         WHERE qct.space_id = $1 AND LOWER(qct.dept_name) = LOWER($2) AND w.user_id = $3`,
        [spaceId, dept, targetUserId]
      );
      // "Worked on — Dev" showed the ticket's CURRENT global assignee, which is
      // whoever holds it now (possibly in a different dept after further
      // transfers) — not who was actually assigned while it sat in THIS dept.
      // A ticket someone worked in Dev before it moved on and got reassigned
      // elsewhere showed the new owner's name here instead of theirs. Prefer
      // the per-dept snapshot taken when the ticket left this dept.
      const issues = rows.rows.map((r: any) => {
        const deptAssignees: Record<string, any> = r.dept_assignees || {};
        const snapKey = Object.keys(deptAssignees).find((k) => k.toLowerCase() === String(r.dept_name || '').toLowerCase());
        const snap = snapKey ? deptAssignees[snapKey] : null;
        const { dept_assignees, ...rest } = r;
        if (snap && snap.id) {
          return { ...rest, assignee_id: snap.id, assignee_name: `${snap.firstName || ''} ${snap.lastName || ''}`.trim(), assignee_avatar: snap.avatarUrl || null };
        }
        return rest;
      });
      return json({ issues, total: parseInt(countRes.rows[0].count) });
    } catch (e: any) {
      return json({ issues: [], total: 0 });
    }
  }

  // ── Dept-Queue Summary (per-queue "Summary" sidebar link) ──
  // Admin-only, same restriction as the sidebar link and the page that calls
  // this -- this is aggregate data about a whole queue's team, not something
  // a regular agent should see just because they're a member of that queue.
  const deptQueueSummaryMatch = path.match(/^spaces\/([^/]+)\/dept-queue\/summary$/);
  if (deptQueueSummaryMatch && method === 'GET') {
    if (!isAdmin) return json({ error: 'You do not have access to this queue.' }, 403);
    const spaceKeyParam = deptQueueSummaryMatch[1].toUpperCase();
    const dept = url.searchParams.get('dept') || '';
    const rangeParam = url.searchParams.get('range') || 'all';
    const { from, to } = parseDateRange(rangeParam === 'all' ? '__all__' : rangeParam);

    const spaceRes = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKeyParam]);
    if (!spaceRes.rows[0]) return json({ error: 'Space not found' }, 404);
    const spaceId = spaceRes.rows[0].id;

    try {
      // Status/priority breakdown + total, scoped to this dept and the
      // selected range (by creation date) -- same shape the existing charts
      // already render, just now range-aware instead of always "all time".
      const deptIssuesRes = await pool.query(
        `SELECT i.id, i.priority, i."createdAt", i.jira_sla_breached, i."dueDate",
                s.name AS status_name, s.color AS status_color, s.category AS status_category
         FROM issues i
         LEFT JOIN statuses s ON i."statusId" = s.id
         WHERE i."spaceId" = $1 AND LOWER(i.current_department) = LOWER($2)
           AND i."createdAt" >= $3 AND i."createdAt" <= $4`,
        [spaceId, dept, from, to]
      );
      const statusMap: Record<string, { count: number; color: string; category: string }> = {};
      const priorityMap: Record<string, number> = { highest: 0, high: 0, medium: 0, low: 0, lowest: 0 };
      let slaBreachedCount = 0;
      for (const row of deptIssuesRes.rows) {
        const name = row.status_name || 'Unknown';
        if (!statusMap[name]) statusMap[name] = { count: 0, color: row.status_color || '#64748B', category: row.status_category || 'todo' };
        statusMap[name].count++;
        const p = (row.priority || 'medium').toLowerCase();
        if (p in priorityMap) priorityMap[p]++;
        // Same "prefer the imported historical flag, else a simple due-date
        // check" rule as the general issue list -- not the full per-policy
        // computation (that needs each ticket's own SLA policy/goal duration
        // and pause state), just a practical approximation for a team-wide
        // count. Good enough to spot a trend, not a substitute for the
        // per-ticket SLA panel's exact figure.
        const isDone = row.status_category === 'done';
        const dueBreach = !isDone && row.dueDate && new Date(row.dueDate).getTime() < Date.now();
        if (row.jira_sla_breached || dueBreach) slaBreachedCount++;
      }

      // Per-user breakdown -- every member of this queue, how many tickets
      // they worked in it (from user_worked_on_tickets, same source the
      // "Worked on" tab already uses) within the selected range, and how
      // many of those are breached by the same rule as above.
      let memberIds: string[] = [];
      try {
        const queueRows = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKeyParam]);
        for (const row of queueRows.rows) {
          const q = (row.queues || []).find((qq: any) => (qq.name || '').toLowerCase() === dept.toLowerCase());
          if (q?.memberIds?.length) { memberIds = q.memberIds; break; }
        }
      } catch { /* no custom queue config */ }

      let perUser: any[] = [];
      if (memberIds.length) {
        const workedRes = await pool.query(
          `SELECT w.user_id, i.id AS issue_id, i.jira_sla_breached, i."dueDate", s.category AS status_category,
                  u."firstName", u."lastName", u.email, u."avatarUrl"
           FROM user_worked_on_tickets w
           JOIN issues i ON i.id = w.issue_id
           LEFT JOIN statuses s ON i."statusId" = s.id
           LEFT JOIN users u ON u.id = w.user_id
           WHERE w.user_id = ANY($1::text[]) AND LOWER(w.dept) = LOWER($2)
             AND w.worked_at >= $3 AND w.worked_at <= $4`,
          [memberIds, dept, from, to]
        );
        const byUser: Record<string, any> = {};
        for (const r of workedRes.rows) {
          if (!byUser[r.user_id]) {
            byUser[r.user_id] = {
              userId: r.user_id, firstName: r.firstName, lastName: r.lastName, email: r.email,
              avatarUrl: avatarRef(r.user_id, r.avatarUrl), ticketIds: new Set<string>(), slaBreachedIds: new Set<string>(),
            };
          }
          byUser[r.user_id].ticketIds.add(r.issue_id);
          const isDone = r.status_category === 'done';
          const dueBreach = !isDone && r.dueDate && new Date(r.dueDate).getTime() < Date.now();
          if (r.jira_sla_breached || dueBreach) byUser[r.user_id].slaBreachedIds.add(r.issue_id);
        }
        // Include every queue member even with zero worked tickets in this
        // range, not just the ones with activity -- otherwise a member who
        // simply hasn't touched anything in the selected range silently
        // vanishes from the list instead of showing as 0.
        for (const uid of memberIds) {
          if (!byUser[uid]) {
            const u = await pool.query(`SELECT "firstName", "lastName", email, "avatarUrl" FROM users WHERE id = $1`, [uid]);
            if (!u.rows[0]) continue;
            byUser[uid] = { userId: uid, firstName: u.rows[0].firstName, lastName: u.rows[0].lastName, email: u.rows[0].email, avatarUrl: avatarRef(uid, u.rows[0].avatarUrl), ticketIds: new Set(), slaBreachedIds: new Set() };
          }
        }
        perUser = Object.values(byUser).map((u: any) => ({
          userId: u.userId, firstName: u.firstName, lastName: u.lastName, email: u.email, avatarUrl: u.avatarUrl,
          ticketsWorked: u.ticketIds.size, slaBreached: u.slaBreachedIds.size,
        })).sort((a: any, b: any) => b.ticketsWorked - a.ticketsWorked);
      }

      return json({
        range: { from: from.toISOString(), to: to.toISOString() },
        totalIssues: deptIssuesRes.rows.length,
        slaBreachedCount,
        statusBreakdown: Object.entries(statusMap).map(([name, v]) => ({ name, ...v })),
        priorityBreakdown: Object.entries(priorityMap).map(([priority, count]) => ({ priority, count })),
        perUser,
      });
    } catch (e: any) {
      console.error('[dept-queue summary ERROR]', e?.message || e);
      return json({ error: 'Failed to load summary' }, 500);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issues Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'issues' && method === 'GET') {
    const spaceKey  = url.searchParams.get('spaceKey');
    const spaceKeys = url.searchParams.get('spaceKeys');
    const typeParam     = url.searchParams.get('type');
    const statusParam   = url.searchParams.get('status');
    const priorityParam = url.searchParams.get('priority');
    const assignees     = url.searchParams.get('assignees') || url.searchParams.get('assignee');
    const unassignedOnly = url.searchParams.get('unassigned') === 'true';
    const reporters     = url.searchParams.get('reporters') || url.searchParams.get('reporter');
    const labelsParam   = url.searchParams.get('labels');
    const rawSearchQ    = url.searchParams.get('q');
    // Normalize CF key searches: "CF - 27210" -> "CF-27210". This used to run
    // unconditionally on every search, collapsing " - " anywhere in the query
    // -- which also fires on completely ordinary summary text that happens to
    // contain " - " as punctuation (e.g. searching "DME Capital - Permission"
    // for a ticket titled "DME Capital - Permission mapping" turned the query
    // into "DME Capital-Permission", which no longer substring-matches the
    // real summary's spaced-out hyphen and silently returned zero results).
    // Only collapse the spacing when the whole query already looks like a key
    // reference (letters/digits, a hyphen, digits) -- never for free text.
    const looksLikeKeyQuery = rawSearchQ ? /^[A-Za-z][A-Za-z0-9]*\s*-\s*\d+$/.test(rawSearchQ.trim()) : false;
    const searchQ       = rawSearchQ
      ? (looksLikeKeyQuery ? rawSearchQ.replace(/\s*-\s*/g, '-').trim() : rawSearchQ.trim())
      : rawSearchQ;
    const createdRange  = url.searchParams.get('createdRange');
    const updatedRange  = url.searchParams.get('updatedRange');
    const excludeDone   = url.searchParams.get('excludeDone') === 'true';
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));

    // Bulk fetch by specific keys (for Viewed tab Ã¢â‚¬â€ single request instead of N calls)
    const keysParam = url.searchParams.get('keys');
    if (keysParam) {
      const keyList = keysParam.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
      const issues = await db.issue.findMany({
        where: { key: { in: keyList } },
        include: { status: true, assignee: true, reporter: true, space: { select: { key: true, name: true } } },
      });
      return json({ issues: issues.map(formatIssue), total: issues.length });
    }

    // Custom text field filters (server-side)
    const customerNameParam   = url.searchParams.get('customerName');
    const clientNameParam     = url.searchParams.get('clientName');
    const projectManagerParam = url.searchParams.get('projectManager');
    const workTypeParam       = url.searchParams.get('workType');
    const productTypeParam    = url.searchParams.get('productType');
    const combinationParam    = url.searchParams.get('combination');
    const testEnvParam        = url.searchParams.get('testEnvironment');
    const rootCauseParam      = url.searchParams.get('rootCause');
    const fixDescParam        = url.searchParams.get('fixDescription');
    const manageClientParam   = url.searchParams.get('manageClientName');
    const customerPlanParam   = url.searchParams.get('customerPlan');

    // Build Prisma WHERE
    const where: Record<string, unknown> = {};

    // Space filter
    if (spaceKey) {
      const sp = await db.space.findUnique({ where: { key: spaceKey.toUpperCase() }, select: { id: true } });
      if (sp) where.spaceId = sp.id;
      else where.spaceId = 'none';
    } else if (spaceKeys) {
      const keys = spaceKeys.split(',').map((k) => k.trim().toUpperCase());
      const spaces = await db.space.findMany({ where: { key: { in: keys } }, select: { id: true } });
      where.spaceId = { in: spaces.map((s: any) => s.id) };
    }

    // Assignee filter Ã¢â‚¬â€ look up by ID or email
    if (unassignedOnly) {
      where.assigneeId = null;
    } else if (assignees) {
      const ids = assignees.split(',').map((x) => x.trim()).filter(Boolean);
      const userIds = await resolveUserIds(ids);
      where.assigneeId = userIds.length === 1 ? userIds[0] : { in: userIds };
    }

    // Reporter filter
    if (reporters) {
      const ids = reporters.split(',').map((x) => x.trim()).filter(Boolean);
      const userIds = await resolveUserIds(ids);
      where.reporterId = userIds.length === 1 ? userIds[0] : { in: userIds };
    }

    // Type filter
    if (typeParam) {
      const types = typeParam.split(',').map((t) => t.trim().toLowerCase());
      where.type = types.length === 1 ? types[0] : { in: types };
    }

    // Status category filter (e.g. 'done', 'in_progress', 'todo')
    const statusCategory = url.searchParams.get('statusCategory');
    if (statusCategory) {
      const catStatuses = await db.status.findMany({
        where: { category: { equals: statusCategory, mode: 'insensitive' } },
        select: { id: true },
      });
      where.statusId = { in: catStatuses.map((s) => s.id) };
    }

    // Status filter Ã¢â‚¬â€ look up status IDs by name
    if (statusParam) {
      const names = statusParam.split(',').map((s) => s.trim());
      const statusWhere: Record<string, unknown> = { name: { in: names, mode: 'insensitive' } };
      // Narrow to space if provided
      if (where.spaceId && typeof where.spaceId === 'string') {
        statusWhere.spaceId = where.spaceId;
      } else if (where.spaceId && (where.spaceId as any).in) {
        statusWhere.spaceId = { in: (where.spaceId as any).in };
      }
      const statuses = await db.status.findMany({ where: statusWhere as any, select: { id: true } });
      where.statusId = { in: statuses.map((s) => s.id) };
    }

    // Priority filter
    if (priorityParam) {
      const priorities = priorityParam.split(',').map((p) => p.trim().toLowerCase());
      where.priority = priorities.length === 1 ? priorities[0] : { in: priorities };
    }

    // Labels filter
    if (labelsParam) {
      const labels = labelsParam.split(',').map((l) => l.trim());
      // Postgres array contains any of the labels
      where.labels = { hasSome: labels };
    }

    // Text search
    if (searchQ) {
      const q = searchQ.trim();
      where.OR = [
        { summary: { contains: q, mode: 'insensitive' } },
        { key: { contains: q, mode: 'insensitive' } },
        { cf_key: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Date range filters
    if (createdRange) {
      const { from, to } = parseDateRange(createdRange);
      where.createdAt = { gte: from, lte: to };
    }
    if (updatedRange) {
      const { from, to } = parseDateRange(updatedRange);
      where.updatedAt = { gte: from, lte: to };
    }

    // Custom text field filters Ã¢â‚¬â€ support comma-separated multi-select values
    // Values come from DB dropdown so they match exactly (no case transform needed)
    const applyMultiField = (param: string | null, field: string) => {
      if (!param) return;
      const vals = param.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 0) return;
      // Single value: exact match; multiple values: IN clause (match any)
      (where as any)[field] = vals.length === 1 ? vals[0] : { in: vals };
    };
    applyMultiField(customerNameParam,   'customerName');
    applyMultiField(clientNameParam,     'clientName');
    // Project Manager filter checkboxes are individual people (the same fixed list
    // the ticket's own Project Manager field picks from), but a ticket's stored
    // value can be several of them joined together (e.g. "Abhishikth, Abhishek"
    // when both are picked) — so this has to be a "contains" match per selected
    // name, not an exact/IN match against the whole stored string, or picking
    // "Abhishek" alone would miss every ticket where he's one of several PMs.
    // Selections are joined with "|||" (not ",") since a name list can itself
    // contain a comma.
    if (projectManagerParam) {
      const vals = projectManagerParam.split('|||').map(v => v.trim()).filter(Boolean);
      if (vals.length) {
        const pmOr = vals.map((v) => ({ projectManager: { contains: v, mode: 'insensitive' as const } }));
        if (!where.AND) where.AND = [];
        (where.AND as any[]).push({ OR: pmOr });
      }
    }
    applyMultiField(workTypeParam,       'workType');
    applyMultiField(productTypeParam,    'productType');
    applyMultiField(combinationParam,    'combination');
    applyMultiField(testEnvParam,        'testEnvironment');
    applyMultiField(rootCauseParam,      'rootCause');
    applyMultiField(fixDescParam,        'fixDescription');
    applyMultiField(manageClientParam,   'manageClientName');
    applyMultiField(customerPlanParam,   'customerPlan');

    // Exclude done statuses Ã¢â‚¬â€ fetches done status IDs for the space and excludes them
    if (excludeDone) {
      const doneStatuses = await db.status.findMany({
        where: {
          category: 'done',
          ...(where.spaceId ? { spaceId: where.spaceId as any } : {}),
        },
        select: { id: true },
      });
      const doneIds = doneStatuses.map((s: any) => s.id);
      if (doneIds.length > 0) {
        where.statusId = { notIn: doneIds };
      }
    }

    // Count and paginate Ã¢â‚¬â€ sort descending by issue number (extracted from key suffix)
    // dept is a raw ALTER TABLE column the `where` object above can't filter
    // on -- when it's set, the block below re-queries via raw SQL and
    // completely discards whatever this section fetches, so skip these
    // queries (and the deptMap merge, which only annotates the rows this
    // section fetches) rather than running them just to throw the result
    // away. This was doubling every department-queue-view load (most list
    // views in this app) with a wasted count + fetch of the whole space.
    const deptParamEarly = url.searchParams.get('dept');
    let total = 0;
    let issues: any[] = [];
    let deptMap: Record<string, any> = {};
    if (!deptParamEarly) {
      [total, issues] = await Promise.all([
        db.issue.count({ where: where as any }),
        db.issue.findMany({
          where: where as any,
          include: {
            status: true,
            assignee: true,
            reporter: true,
            space: { select: { key: true, name: true } },
            },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      try {
        const issueKeys = issues.map((i: any) => i.key);
        if (issueKeys.length) {
          const deptRows = await pool.query(
            `SELECT key, current_department, department_assignee_id, dept_sla_started_at, dept_assignees, dept_statuses, cf_key, jira_assignee_name, jira_reporter_name, jira_sla_breached, jira_sla_due_at, jira_sla_start_at FROM issues WHERE key = ANY($1::text[])`,
            [issueKeys]
          );
          for (const row of deptRows.rows) {
            deptMap[row.key] = { current_department: row.current_department, department_assignee_id: row.department_assignee_id, dept_sla_started_at: row.dept_sla_started_at, dept_assignees: row.dept_assignees, dept_statuses: row.dept_statuses, cf_key: row.cf_key, jira_assignee_name: row.jira_assignee_name, jira_reporter_name: row.jira_reporter_name, jira_sla_breached: row.jira_sla_breached, jira_sla_due_at: row.jira_sla_due_at, jira_sla_start_at: row.jira_sla_start_at };
          }
        }
      } catch { /* ignore */ }
    }

    // sentDept filter Ã¢â‚¬â€ shows all tickets that MOVED OUT of this dept (to another dept)
    // Uses issue_dept_transitions (tracked moves) + queue_closed_tickets fallback for historical data
    const sentDeptParam = url.searchParams.get('sentDept');
    if (sentDeptParam) {
      try {
        let allSpaceIds: string[] = [];
        const spaceKeyForSent = spaceKey || (spaceKeys ? spaceKeys.split(',')[0].trim().toUpperCase() : '');
        if (spaceKeyForSent) {
          try {
            const spaceRow = await pool.query(
              `SELECT id, COALESCE(sub_board_keys, '{}') AS sub_board_keys FROM spaces WHERE key = $1`,
              [spaceKeyForSent]
            );
            if (spaceRow.rows[0]) {
              allSpaceIds.push(spaceRow.rows[0].id);
              const subKeys: string[] = spaceRow.rows[0].sub_board_keys || [];
              if (subKeys.length > 0) {
                const subRows = await pool.query(`SELECT id FROM spaces WHERE key = ANY($1::text[])`, [subKeys]);
                for (const sub of subRows.rows) allSpaceIds.push(sub.id);
              }
            }
          } catch {
            // sub_board_keys column may not exist yet — fall back to simple lookup
            try {
              const spaceRow = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKeyForSent]);
              if (spaceRow.rows[0]) allSpaceIds.push(spaceRow.rows[0].id);
            } catch { /* ignore */ }
          }
        }
        if (allSpaceIds.length === 0) {
          const spaceIdFallback = typeof where.spaceId === 'string' ? where.spaceId : null;
          if (spaceIdFallback) allSpaceIds = [spaceIdFallback];
        }

        if (allSpaceIds.length > 0) {
          // Sent/Watching: tickets that moved OUT of this dept.
          // Primary source: issue_dept_transitions (explicit move log).
          // Fallback source: queue_closed_tickets (ticket was in this dept's closed list)

          const sentExistsClause = `(
            EXISTS (
              SELECT 1 FROM queue_closed_tickets qct
              WHERE qct.issue_id = i.id
                AND LOWER(qct.dept_name) = LOWER($2)
                AND i."spaceId" = ANY($1::text[])
            )
            OR EXISTS (
              SELECT 1 FROM issue_dept_transitions t
              WHERE t.issue_id = i.id
                AND LOWER(t.from_dept) = LOWER($2)
                AND LOWER(t.to_dept) != LOWER($2)
            )
            OR (
              i.dept_statuses IS NOT NULL
              AND (
                jsonb_exists(i.dept_statuses, $2)
                OR jsonb_exists(i.dept_statuses, LOWER($2))
                OR jsonb_exists(i.dept_statuses, INITCAP(LOWER($2)))
              )
              AND LOWER(COALESCE(i.current_department,'')) != LOWER($2)
            )
            OR (
              LOWER(COALESCE(i.original_dept,'')) = LOWER($2)
              AND LOWER(COALESCE(i.current_department,'')) != LOWER($2)
            )
          )`;

          // Same active filters (assignee, type, priority, status, project manager,
          // the custom text fields like Product Type/Combination, and the
          // Created/Updated date range) that the dept-scoped "All Tickets" branch
          // applies — this Sent/Watching branch never applied any of them, so
          // picking a filter here silently had zero effect no matter the field.
          const sentExtraClauses: string[] = [];
          const sentExtraParams: any[] = [];
          let sentParamIdx = 3;
          // Free-text search (ticket key, CF key, summary, description) -- this
          // branch builds its own raw SQL instead of going through the shared
          // Prisma `where` above, so the `q` param (typing a ticket number into
          // the search box) was silently dropped no matter what was typed,
          // unlike every other queue view.
          if (searchQ) {
            sentExtraClauses.push(`(
              i.key ILIKE $${sentParamIdx}
              OR i.cf_key ILIKE $${sentParamIdx}
              OR i.summary ILIKE $${sentParamIdx}
              OR i.description ILIKE $${sentParamIdx}
            )`);
            sentExtraParams.push(`%${searchQ}%`);
            sentParamIdx++;
          }
          if (assignees) {
            const ids = assignees.split(',').map((x) => x.trim()).filter(Boolean);
            const resolvedIds = await resolveUserIds(ids);
            sentExtraClauses.push(resolvedIds.length ? `i."assigneeId" = ANY($${sentParamIdx}::text[])` : '1=0');
            if (resolvedIds.length) { sentExtraParams.push(resolvedIds); sentParamIdx++; }
          }
          if (reporters) {
            const ids = reporters.split(',').map((x) => x.trim()).filter(Boolean);
            const resolvedIds = await resolveUserIds(ids);
            sentExtraClauses.push(resolvedIds.length ? `i."reporterId" = ANY($${sentParamIdx}::text[])` : '1=0');
            if (resolvedIds.length) { sentExtraParams.push(resolvedIds); sentParamIdx++; }
          }
          if (typeParam) {
            sentExtraClauses.push(`LOWER(i.type) = ANY($${sentParamIdx}::text[])`);
            sentExtraParams.push(typeParam.split(',').map((t) => t.trim().toLowerCase()));
            sentParamIdx++;
          }
          if (priorityParam) {
            sentExtraClauses.push(`LOWER(i.priority) = ANY($${sentParamIdx}::text[])`);
            sentExtraParams.push(priorityParam.split(',').map((p) => p.trim().toLowerCase()));
            sentParamIdx++;
          }
          if (statusParam) {
            const names = statusParam.split(',').map((s2) => s2.trim().toLowerCase());
            sentExtraClauses.push(`i."statusId" IN (SELECT id FROM statuses WHERE LOWER(name) = ANY($${sentParamIdx}::text[]))`);
            sentExtraParams.push(names);
            sentParamIdx++;
          }
          if (projectManagerParam) {
            const pmVals = projectManagerParam.split('|||').map((v) => v.trim()).filter(Boolean);
            if (pmVals.length) {
              sentExtraClauses.push(`i."projectManager" ILIKE ANY($${sentParamIdx}::text[])`);
              sentExtraParams.push(pmVals.map((v) => `%${v}%`));
              sentParamIdx++;
            }
          }
          const sentSimpleTextFields: [string | null, string][] = [
            [productTypeParam, 'productType'],
            [combinationParam, 'combination'],
            [workTypeParam, 'workType'],
            [testEnvParam, 'testEnvironment'],
            [rootCauseParam, 'rootCause'],
            [fixDescParam, 'fixDescription'],
            [customerNameParam, 'customerName'],
            [clientNameParam, 'clientName'],
            [manageClientParam, 'manageClientName'],
            [customerPlanParam, 'customerPlan'],
          ];
          for (const [param, col] of sentSimpleTextFields) {
            if (!param) continue;
            const vals = param.split(',').map((v) => v.trim()).filter(Boolean);
            if (!vals.length) continue;
            sentExtraClauses.push(`i."${col}" = ANY($${sentParamIdx}::text[])`);
            sentExtraParams.push(vals);
            sentParamIdx++;
          }
          if (createdRange) {
            const { from, to } = parseDateRange(createdRange);
            sentExtraClauses.push(`i."createdAt" >= $${sentParamIdx} AND i."createdAt" <= $${sentParamIdx + 1}`);
            sentExtraParams.push(from, to);
            sentParamIdx += 2;
          }
          if (updatedRange) {
            const { from, to } = parseDateRange(updatedRange);
            sentExtraClauses.push(`i."updatedAt" >= $${sentParamIdx} AND i."updatedAt" <= $${sentParamIdx + 1}`);
            sentExtraParams.push(from, to);
            sentParamIdx += 2;
          }
          const sentExtraSql = sentExtraClauses.map((c) => `AND ${c}`).join('\n');

          let sentDeptTotal = 0;
          try {
            const countParams: any[] = [allSpaceIds, sentDeptParam, ...sentExtraParams];
            const countRow = await pool.query(
              `SELECT COUNT(DISTINCT i.id)::int AS cnt
               FROM issues i
               WHERE i."spaceId" = ANY($1::text[])
                 AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
                 AND ${sentExistsClause}
               ${sentExtraSql}`,
              countParams
            );
            sentDeptTotal = countRow.rows[0]?.cnt ?? 0;
          } catch (countErr: any) {
            console.error('[SENT-COUNT ERROR]', countErr?.message);
            throw countErr;
          }

          const rowParams: any[] = [allSpaceIds, sentDeptParam, ...sentExtraParams];
          const limitIdx = rowParams.length + 1;
          const offsetIdx = rowParams.length + 2;
          rowParams.push(limit, (page - 1) * limit);
          const rows = await pool.query(
            `SELECT DISTINCT ON (i.id) i.*, sp.key AS space_key,
                    s.name AS status_name, s.category AS status_category, s.color AS status_color,
                    a.id AS assignee_id, CONCAT(a."firstName",' ',a."lastName") AS assignee_name, a.email AS assignee_email, a."avatarUrl" AS assignee_avatar,
                    r.id AS reporter_id, CONCAT(r."firstName",' ',r."lastName") AS reporter_name, r.email AS reporter_email, r."avatarUrl" AS reporter_avatar
             FROM issues i
             LEFT JOIN spaces sp ON sp.id = i."spaceId"
             LEFT JOIN statuses s ON i."statusId" = s.id
             LEFT JOIN users a ON i."assigneeId" = a.id
             LEFT JOIN users r ON i."reporterId" = r.id
             WHERE i."spaceId" = ANY($1::text[])
               AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
               AND ${sentExistsClause}
             ${sentExtraSql}
             ORDER BY i.id, i."updatedAt" DESC, i."createdAt" DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            rowParams
          );
          // Load comments for all returned issues
          const issueIds = rows.rows.map((r: any) => r.id);
          const commentsMap: Record<string, any[]> = {};
          if (issueIds.length > 0) {
            const cRows = await pool.query(
              `SELECT c.*, u."firstName", u."lastName", u.email AS user_email, u."avatarUrl"
               FROM comments c
               LEFT JOIN users u ON u.id = c."authorId"
               WHERE c."issueId" = ANY($1::text[])
               ORDER BY c."createdAt" ASC`,
              [issueIds]
            );
            for (const c of cRows.rows) {
              if (!commentsMap[c.issueId]) commentsMap[c.issueId] = [];
              const toIso = (v: any) => { if (!v) return null; try { if (v instanceof Date) return v.toISOString(); const s = String(v); const adj = s.includes('+') || s.endsWith('Z') ? s : s + ' UTC'; const d = new Date(adj); return isNaN(d.getTime()) ? null : d.toISOString(); } catch { return null; } };
              commentsMap[c.issueId].push({
                id: c.id, body: c.body, createdAt: toIso(c.createdAt), updatedAt: toIso(c.updatedAt),
                author: c.authorId ? { id: c.authorId, firstName: c.firstName, lastName: c.lastName, email: c.user_email, avatarUrl: avatarRef(c.authorId, c.avatarUrl) } : null,
                authorName: c.authorName, authorEmail: c.authorEmail,
              });
            }
          }
          // Fetch SLA policies for this space once (for paused SLA computation)
          let slaPolicies: any[] = [];
          if (allSpaceIds.length > 0) {
            try {
              // Fetch both dept-specific and space-wide SLA policies
              const slaRes = await pool.query(
                `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active' ORDER BY (dept_name IS NOT NULL) DESC, "createdAt" ASC`,
                [allSpaceIds]
              );
              slaPolicies = slaRes.rows;
            } catch { /* no SLA definitions */ }
          }

          // Build sentEnriched with paused SLA state per issue
          const sentEnriched = (await Promise.all(rows.rows.map(async (row: any) => { try {
            // Truncated — same reasoning as the other two list branches: this
            // Sent/Watching list never renders description, but a legacy
            // base64-embedded image in it can balloon the response by tens of MB.
            const base = formatIssue({
              id: row.id, key: row.key, cf_key: row.cf_key, summary: row.summary, description: (row.description || '').slice(0, 500),
              priority: row.priority, type: row.type, labels: row.labels,
              createdAt: row.createdAt, updatedAt: row.updatedAt,
              workType: row.workType, productType: row.productType, combination: row.combination,
              testEnvironment: row.testEnvironment, rootCause: row.rootCause, fixDescription: row.fixDescription,
              customerName: row.customerName, clientName: row.clientName,
              manageClientName: row.manageClientName, customerPlan: row.customerPlan,
              projectManager: row.projectManager,
              current_department: row.current_department,
              original_dept: row.original_dept,
              dept_sla_log: row.dept_sla_log || {},
              dept_sla_started_at: row.dept_sla_started_at,
              dept_assignees: row.dept_assignees || {},
              dept_statuses: row.dept_statuses || {},
              comments: commentsMap[row.id] || [],
              status: row.status_name ? { id: row.statusId, name: row.status_name, category: row.status_category, color: row.status_color } : null,
              assignee: row.assignee_id ? { id: row.assignee_id, firstName: (row.assignee_name||'').split(' ')[0], lastName: (row.assignee_name||'').split(' ').slice(1).join(' '), email: row.assignee_email, avatarUrl: avatarRef(row.assignee_id, row.assignee_avatar) } : null,
              reporter: row.reporter_id ? { id: row.reporter_id, firstName: (row.reporter_name||'').split(' ')[0], lastName: (row.reporter_name||'').split(' ').slice(1).join(' '), email: row.reporter_email, avatarUrl: avatarRef(row.reporter_id, row.reporter_avatar) } : null,
              space: { key: row.space_key || spaceKeyForSent },
            });
            const pausedSla = await computePausedDeptSLA(row, sentDeptParam, slaPolicies);
            return { ...base, paused_sla: pausedSla };
          } catch { return null; } }))).filter(Boolean as any);
          return json({ issues: sentEnriched, total: sentDeptTotal, page, totalPages: Math.max(1, Math.ceil(sentDeptTotal / limit)) });
        }
      } catch (sentErr: any) { console.error('[SentWatching ERROR]', sentErr?.message || sentErr); return json({ issues: [], total: 0, page, totalPages: 1 }); }
    }

    // Filter by dept param if provided — use raw SQL count so total is accurate
    const deptParam = url.searchParams.get('dept');
    // "Assigned to me" under a department: without this, a ticket vanished from
    // that list the moment it was resolved (excludeDone) or handed to another
    // department (current_department no longer matches) — even though the user
    // was the one who actually worked it. When set, tickets this user has a
    // user_worked_on_tickets record for in this dept are included too, so a
    // resolved/moved-on ticket still shows here instead of disappearing without
    // a trace.
    const includeHistoryParam = url.searchParams.get('includeHistory') === 'true';
    const deptCallerIsPrivileged = isAdmin || isManager(currentUser?.role);
    if (deptParam && spaceKey && !deptCallerIsPrivileged && await isUserSuspendedFromQueue(spaceKey, deptParam, userId)) {
      return json({ error: 'Your access to this queue has been suspended.' }, 403);
    }
    // A user restricted to specific queues (via that queue's memberIds) could
    // previously still pull another queue's issues by requesting its dept
    // name directly — the switcher only hid the other queues in the UI, it
    // never stopped the API call itself. Same allow-list check the client
    // already applies when deciding what to show in the queue switcher, now
    // actually enforced here too.
    if (deptParam && spaceKey && !deptCallerIsPrivileged && !(await isUserAuthorizedForDeptQueue(spaceKey, deptParam, userId))) {
      return json({ error: 'You do not have access to this queue.' }, 403);
    }
    // Truncate description for list rows — the list UI never renders it (only the
    // single-issue detail page does), but Prisma's default findMany() returns every
    // scalar column including the full raw description. A legacy ticket with a
    // base64-embedded image in its description (from before uploads moved to
    // URL-based storage) could balloon this list response by tens of MB on its own.
    let enrichedIssues = issues.map((i: any) => formatIssue({ ...i, ...(deptMap[i.key] || {}), description: (i.description || '').slice(0, 500) }));
    let deptTotal = total;
    if (deptParam) {
      // Resolve all space IDs to query: current space + any configured sub-boards
      let allSpaceIds: string[] = [];
      let spaceKeyMap: Record<string, string> = {}; // spaceId Ã¢â€ ' spaceKey
      try {
        const spaceRow = await pool.query(
          `SELECT id, key, COALESCE(sub_board_keys, '{}') AS sub_board_keys FROM spaces WHERE key = $1`,
          [spaceKey]
        );
        if (spaceRow.rows[0]) {
          allSpaceIds.push(spaceRow.rows[0].id);
          spaceKeyMap[spaceRow.rows[0].id] = spaceRow.rows[0].key;
          const subKeys: string[] = spaceRow.rows[0].sub_board_keys || [];
          if (subKeys.length > 0) {
            const subRows = await pool.query(
              `SELECT id, key FROM spaces WHERE key = ANY($1::text[])`,
              [subKeys]
            );
            for (const sub of subRows.rows) {
              allSpaceIds.push(sub.id);
              spaceKeyMap[sub.id] = sub.key;
            }
          }
        }
      } catch { /* fallback: use only current space */ }

      if (allSpaceIds.length === 0) {
        const fallback = await db.space.findUnique({ where: { key: spaceKey }, select: { id: true } });
        if (fallback) { allSpaceIds = [fallback.id]; spaceKeyMap[fallback.id] = spaceKey; }
      }

      const deptExcludeDone = excludeDone;
      const deptSearchClause = searchQ
        ? `AND (LOWER(i.summary) LIKE LOWER($3) OR LOWER(i.key) LIKE LOWER($3) OR LOWER(COALESCE(i.cf_key,'')) LIKE LOWER($3))`
        : '';
      const deptSearchParam = searchQ ? `%${searchQ.trim()}%` : null;

      // This dept-scoped branch used to ignore every other active filter (assignee,
      // reporter, type, priority, status) — fine for the plain per-department queue
      // views it was built for, but wrong once a caller also filters by assignee/etc.
      // (e.g. the personal dashboard's "queue" deep-links). Layer those filters in too.
      const deptExtraClauses: string[] = [];
      const deptExtraParams: any[] = [];
      let deptParamIdx = deptSearchParam ? 4 : 3;
      // When includeHistoryParam is set, the assignee match is folded into
      // deptDeptMatchSql below (current dept OR ever-worked-on-in-this-dept)
      // instead of a plain required AND clause here — a moved-on ticket's
      // current assigneeId is no longer this user, so requiring it here would
      // filter the historical rows right back out.
      let historyAssigneeIdx: number | null = null;
      if (includeHistoryParam && assignees) {
        const ids = assignees.split(',').map((x) => x.trim()).filter(Boolean);
        const resolvedIds = await resolveUserIds(ids);
        if (resolvedIds.length) {
          historyAssigneeIdx = deptParamIdx;
          deptExtraParams.push(resolvedIds);
          deptParamIdx++;
        }
      } else if (assignees) {
        const ids = assignees.split(',').map((x) => x.trim()).filter(Boolean);
        const resolvedIds = await resolveUserIds(ids);
        deptExtraClauses.push(resolvedIds.length ? `i."assigneeId" = ANY($${deptParamIdx}::text[])` : '1=0');
        if (resolvedIds.length) { deptExtraParams.push(resolvedIds); deptParamIdx++; }
      }
      if (reporters) {
        const ids = reporters.split(',').map((x) => x.trim()).filter(Boolean);
        const resolvedIds = await resolveUserIds(ids);
        deptExtraClauses.push(resolvedIds.length ? `i."reporterId" = ANY($${deptParamIdx}::text[])` : '1=0');
        if (resolvedIds.length) { deptExtraParams.push(resolvedIds); deptParamIdx++; }
      }
      if (typeParam) {
        deptExtraClauses.push(`LOWER(i.type) = ANY($${deptParamIdx}::text[])`);
        deptExtraParams.push(typeParam.split(',').map((t) => t.trim().toLowerCase()));
        deptParamIdx++;
      }
      if (priorityParam) {
        deptExtraClauses.push(`LOWER(i.priority) = ANY($${deptParamIdx}::text[])`);
        deptExtraParams.push(priorityParam.split(',').map((p) => p.trim().toLowerCase()));
        deptParamIdx++;
      }
      if (statusParam) {
        deptExtraClauses.push(`LOWER(s.name) = ANY($${deptParamIdx}::text[])`);
        deptExtraParams.push(statusParam.split(',').map((s2) => s2.trim().toLowerCase()));
        deptParamIdx++;
      }
      if (projectManagerParam) {
        // Same "contains any selected name" match as the general branch — a ticket's
        // stored value can be several names joined together.
        const pmVals = projectManagerParam.split('|||').map((v) => v.trim()).filter(Boolean);
        if (pmVals.length) {
          deptExtraClauses.push(`i."projectManager" ILIKE ANY($${deptParamIdx}::text[])`);
          deptExtraParams.push(pmVals.map((v) => `%${v}%`));
          deptParamIdx++;
        }
      }
      // The custom text-field filters (Product Type, Combination, etc.) were never
      // layered into this dept-scoped branch at all — every per-department queue view
      // (Dev, Migration, QA, Infra, ...) runs through here, so selecting any of these
      // filters while viewing a department queue silently had zero effect on the
      // results, no matter which value was picked. Exact/IN match, same as
      // applyMultiField in the general (non-dept) branch — these values come from a
      // DB-driven dropdown so they match exactly.
      const deptSimpleTextFields: [string | null, string][] = [
        [productTypeParam, 'productType'],
        [combinationParam, 'combination'],
        [workTypeParam, 'workType'],
        [testEnvParam, 'testEnvironment'],
        [rootCauseParam, 'rootCause'],
        [fixDescParam, 'fixDescription'],
        [customerNameParam, 'customerName'],
        [clientNameParam, 'clientName'],
        [manageClientParam, 'manageClientName'],
        [customerPlanParam, 'customerPlan'],
      ];
      for (const [param, col] of deptSimpleTextFields) {
        if (!param) continue;
        const vals = param.split(',').map((v) => v.trim()).filter(Boolean);
        if (!vals.length) continue;
        deptExtraClauses.push(`i."${col}" = ANY($${deptParamIdx}::text[])`);
        deptExtraParams.push(vals);
        deptParamIdx++;
      }
      // Created/Updated date-range filters (Filter > Created: Today/Last 7 days/...)
      // were likewise only ever wired into the general Prisma branch — picking any
      // of these while viewing a department queue showed "0 issues" even for tickets
      // created that same day.
      if (createdRange) {
        const { from, to } = parseDateRange(createdRange);
        deptExtraClauses.push(`i."createdAt" >= $${deptParamIdx} AND i."createdAt" <= $${deptParamIdx + 1}`);
        deptExtraParams.push(from, to);
        deptParamIdx += 2;
      }
      if (updatedRange) {
        const { from, to } = parseDateRange(updatedRange);
        deptExtraClauses.push(`i."updatedAt" >= $${deptParamIdx} AND i."updatedAt" <= $${deptParamIdx + 1}`);
        deptExtraParams.push(from, to);
        deptParamIdx += 2;
      }
      const deptExtraSql = deptExtraClauses.map((c) => `AND ${c}`).join('\n');

      const deptDoneClause = deptExcludeDone ? `AND (s.category IS NULL OR s.category != 'done')` : '';
      // Plain case: ticket must currently be in this dept (and, if requested,
      // currently open). History case: ALSO match if this user has ever been
      // credited with working this ticket while it was in this dept — covers
      // it having since been resolved or handed to another department.
      const deptDeptMatchSql = historyAssigneeIdx
        ? `(
            (LOWER(i.current_department) = LOWER($2) AND i."assigneeId" = ANY($${historyAssigneeIdx}::text[]) ${deptDoneClause})
            OR EXISTS (
              SELECT 1 FROM user_worked_on_tickets w
              WHERE w.issue_id = i.id AND w.user_id = ANY($${historyAssigneeIdx}::text[]) AND LOWER(w.dept) = LOWER($2)
            )
          )`
        : `LOWER(i.current_department) = LOWER($2) ${deptDoneClause}`;

      try {
        const countParams: any[] = [allSpaceIds, deptParam];
        if (deptSearchParam) countParams.push(deptSearchParam);
        countParams.push(...deptExtraParams);
        const countRow = await pool.query(
          `SELECT COUNT(*)::int AS cnt
           FROM issues i
           LEFT JOIN statuses s ON i."statusId" = s.id
           WHERE i."spaceId" = ANY($1::text[])
             AND ${deptDeptMatchSql}
           ${deptSearchClause}
           ${deptExtraSql}`,
          countParams
        );
        deptTotal = countRow.rows[0]?.cnt ?? 0;
      } catch (err) { console.error('[dept count query failed]', err); deptTotal = 0; }

      try {
        const rowParams: any[] = [allSpaceIds, deptParam];
        if (deptSearchParam) rowParams.push(deptSearchParam);
        rowParams.push(...deptExtraParams);
        const limitIdx = rowParams.length + 1;
        const offsetIdx = rowParams.length + 2;
        rowParams.push(limit, (page - 1) * limit);
        // Sorting by updatedAt made an old ticket jump to page 1 the moment anyone
        // so much as commented on it, potentially bumping a genuinely new ticket
        // off the page -- pagination should be a stable "50 newest by creation
        // date" list, not one that reshuffles on unrelated activity. The general
        // (non-dept) branch above already orders by createdAt only; this dept-
        // scoped branch (used by every department queue view: All Tickets,
        // Unassigned, Assigned to me) was the one still sorting by updatedAt first.
        const rows = await pool.query(
          `SELECT i.*, sp.key AS space_key,
                  s.name AS status_name, s.category AS status_category, s.color AS status_color,
                  a.id AS assignee_id, CONCAT(a."firstName",' ',a."lastName") AS assignee_name, a.email AS assignee_email, a."avatarUrl" AS assignee_avatar,
                  r.id AS reporter_id, CONCAT(r."firstName",' ',r."lastName") AS reporter_name, r.email AS reporter_email, r."avatarUrl" AS reporter_avatar,
                  i.jira_assignee_name, i.jira_reporter_name
           FROM issues i
           LEFT JOIN spaces sp ON sp.id = i."spaceId"
           LEFT JOIN statuses s ON i."statusId" = s.id
           LEFT JOIN users a ON i."assigneeId" = a.id
           LEFT JOIN users r ON i."reporterId" = r.id
           WHERE i."spaceId" = ANY($1::text[])
             AND ${deptDeptMatchSql}
           ${deptSearchClause}
           ${deptExtraSql}
           ORDER BY i."createdAt" DESC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          rowParams
        );
        enrichedIssues = rows.rows.map((row: any) => formatIssue({
          // Truncated — see comment above the other formatIssue list call site.
          // This branch's SELECT i.* pulls the full raw description for every
          // row; a single legacy ticket with a base64-embedded image in it can
          // balloon this response by tens of MB on its own.
          id: row.id, key: row.key, cf_key: row.cf_key, summary: row.summary, description: (row.description || '').slice(0, 500),
          priority: row.priority, type: row.type, labels: row.labels,
          createdAt: row.createdAt, updatedAt: row.updatedAt,
          spaceId: row.spaceId, dueDate: row.dueDate,
          workType: row.workType, productType: row.productType, combination: row.combination,
          testEnvironment: row.testEnvironment, rootCause: row.rootCause, fixDescription: row.fixDescription,
          customerName: row.customerName, clientName: row.clientName,
          manageClientName: row.manageClientName, customerPlan: row.customerPlan,
          projectManager: row.projectManager,
          current_department: row.current_department,
          dept_statuses: row.dept_statuses || {},
          dept_assignees: row.dept_assignees || {},
          dept_sla_started_at: row.dept_sla_started_at,
          dept_sla_log: row.dept_sla_log,
          jira_sla_breached: row.jira_sla_breached,
          jira_sla_due_at: row.jira_sla_due_at,
          jira_sla_start_at: row.jira_sla_start_at,
          status: row.status_name ? { id: row.statusId, name: row.status_name, category: row.status_category, color: row.status_color } : null,
          assignee: row.assignee_id ? { id: row.assignee_id, firstName: (row.assignee_name||'').split(' ')[0], lastName: (row.assignee_name||'').split(' ').slice(1).join(' '), email: row.assignee_email, avatarUrl: avatarRef(row.assignee_id, row.assignee_avatar) } : null,
          reporter: row.reporter_id ? { id: row.reporter_id, firstName: (row.reporter_name||'').split(' ')[0], lastName: (row.reporter_name||'').split(' ').slice(1).join(' '), email: row.reporter_email, avatarUrl: avatarRef(row.reporter_id, row.reporter_avatar) } : null,
          jira_assignee_name: row.jira_assignee_name || null,
          jira_reporter_name: row.jira_reporter_name || null,
          space: { key: row.space_key || spaceKey },
        }));
      } catch { /* keep Prisma results as fallback */ }
    }

    // Breached field — live Yes/No: No by default (just created, nothing overdue),
    // flips to Yes once the ticket's due date has passed OR its department SLA goal
    // has been exceeded. Previously this only checked whether an SLA_BREACH warning
    // notification had ever been sent — stayed "No" forever if that cron missed a
    // ticket, never looked at the due date at all, and never cleared once resolved.
    const slaBreachedParam = url.searchParams.get('slaBreached'); // 'yes' | 'no' | null
    try {
      const distinctSpaceIds = Array.from(new Set(enrichedIssues.map((i: any) => i.spaceId).filter(Boolean)));
      const policiesBySpace: Record<string, any[]> = {};
      if (distinctSpaceIds.length) {
        const polRows = await pool.query(
          `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`,
          [distinctSpaceIds]
        );
        for (const p of polRows.rows) {
          if (!policiesBySpace[p.spaceId]) policiesBySpace[p.spaceId] = [];
          policiesBySpace[p.spaceId].push(p);
        }
      }
      const nowMs = Date.now();
      enrichedIssues = enrichedIssues.map((i: any) => {
        const isResolved = i.status?.category === 'done';
        // Historical breach imported from Jira (L2B/L3B) always counts, even
        // for a ticket that's since been resolved here -- the checks below
        // all force `breached` back to false once resolved, which is right
        // for this app's OWN SLA clock (no point alarming on a stopped
        // clock), but would erase the fact that Jira already recorded a
        // real breach before the ticket ever got resolved.
        let breached = !!i.jira_sla_breached;
        if (!breached && !isResolved) {
          if (i.dueDate && new Date(i.dueDate).getTime() < nowMs) breached = true;
          // Same fallback as computeIssueSLAsFromDb: tickets never routed through a
          // department transfer have no dept_sla_started_at, so measure from creation.
          const slaStartedAt = i.dept_sla_started_at || i.createdAt;
          if (!breached && slaStartedAt) {
            const dept = (i.current_department || '').trim().toLowerCase();
            const priority = (i.priority || 'medium').toLowerCase();
            const currentStatusName = (i.status?.name || '').trim().toLowerCase();
            const policies = (policiesBySpace[i.spaceId] || []).filter((p: any) => {
              const pDept = (p.dept_name || '').trim().toLowerCase();
              return !pDept || pDept === dept;
            });
            for (const policy of policies) {
              const pauseStatuses: string[] = Array.isArray(policy.pauseStatuses)
                ? policy.pauseStatuses.map((s: string) => s.trim().toLowerCase())
                : [];
              if (pauseStatuses.includes(currentStatusName)) continue; // paused — clock stopped
              let durationMs = 8 * 60 * 60 * 1000; // default 8h, same fallback as computeIssueSLAsFromDb
              for (const goal of (policy.goals || [])) {
                if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
                  const row = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
                  if (row?.timeValue) {
                    const val = parseFloat(row.timeValue);
                    const unit = (row.timeUnit || 'hours').toLowerCase();
                    durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
                    break;
                  }
                } else if (goal.timeValue) {
                  const val = parseFloat(goal.timeValue);
                  const unit = (goal.timeUnit || 'hours').toLowerCase();
                  durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
                  break;
                }
              }
              if (new Date(slaStartedAt).getTime() + durationMs < nowMs) { breached = true; break; }
            }
          }
        }
        return { ...i, sla_breached: breached };
      });
      if (slaBreachedParam === 'yes' || slaBreachedParam === 'no') {
        enrichedIssues = enrichedIssues.filter((i: any) => slaBreachedParam === 'yes' ? i.sla_breached : !i.sla_breached);
        deptTotal = enrichedIssues.length;
      }
    } catch { /* sla breach is best-effort */ }

    return json({
      issues: enrichedIssues,
      total: deptTotal,
      page,
      totalPages: Math.max(1, Math.ceil(deptTotal / limit)),
    });
  }

  if (path === 'issues' && method === 'POST') {
    const body = await readJson(req);
    const sk = String(body.spaceKey || '').toUpperCase();
    const sp = await db.space.findUnique({
      where: { key: sk },
      include: { statuses: { orderBy: { order: 'asc' } } },
    });
    if (!sp) return json({ error: 'Space not found' }, 404);
    if (body.department && !isAdmin && await isUserSuspendedFromQueue(sk, String(body.department), userId)) {
      return json({ error: 'Your access to this queue has been suspended.' }, 403);
    }

    // Fetch max key number and a sample of recent keys for prefix detection.
    const [maxRow, prefixRow] = await Promise.all([
      pool.query<{ maxnum: string }>(
        `SELECT COALESCE(MAX(
          CASE WHEN SPLIT_PART(key, '-', ARRAY_LENGTH(STRING_TO_ARRAY(key, '-'), 1)) ~ '^[0-9]+$'
               THEN CAST(SPLIT_PART(key, '-', ARRAY_LENGTH(STRING_TO_ARRAY(key, '-'), 1)) AS INTEGER)
               ELSE 0 END
        ), 0) AS maxnum FROM issues WHERE "spaceId" = $1 OR key LIKE $2`,
        [sp.id, `${sk}-%`]
      ),
      pool.query<{ key: string }>(
        `SELECT key FROM issues WHERE ("spaceId" = $1 OR key LIKE $2) ORDER BY "createdAt" DESC LIMIT 100`,
        [sp.id, `${sk}-%`]
      ),
    ]);
    let maxNum = parseInt(maxRow.rows[0]?.maxnum || '0', 10);
    if (isNaN(maxNum)) maxNum = 0;
    const nums = prefixRow.rows;

    // Determine key prefix: subtask = inherit from parent; otherwise use dominant prefix.
    let keyPrefix = sk;
    if (body.parentKey) {
      const parentKeyStr = String(body.parentKey).toUpperCase();
      const parentIssue = await db.issue.findUnique({ where: { key: parentKeyStr }, select: { key: true } });
      if (parentIssue) {
        const parts = parentIssue.key.split('-');
        parts.pop();
        keyPrefix = parts.join('-');
      }
    } else if (nums.length > 0) {
      const prefixCounts: Record<string, number> = {};
      for (const i of nums) {
        const p = i.key.split('-').slice(0, -1).join('-');
        if (p) prefixCounts[p] = (prefixCounts[p] || 0) + 1;
      }
      const dominant = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0];
      if (dominant) keyPrefix = dominant[0];
    }

    // issueKey is determined inside the retry loop below (race-condition safe)

    // Resolve status
    const stId = String(body.statusId || '');
    const st = stId
      ? sp.statuses.find((x) => x.id === stId) || sp.statuses[0]
      : sp.statuses[0];

    // Resolve reporter and assignee from email in parallel
    const [reporterByEmail, assigneeByEmail] = await Promise.all([
      body.reporterEmail ? db.user.findFirst({ where: { email: { equals: String(body.reporterEmail), mode: 'insensitive' } } }) : Promise.resolve(null),
      (!body.assigneeId && body.assigneeEmail) ? db.user.findFirst({ where: { email: { equals: String(body.assigneeEmail), mode: 'insensitive' } } }) : Promise.resolve(null),
    ]);
    let resolvedReporterId: string | null = reporterByEmail?.id ?? null;
    if (!resolvedReporterId && userId) {
      const reporterUser = await db.user.findUnique({ where: { id: userId } });
      resolvedReporterId = reporterUser?.id ?? null;
    }
    let resolvedAssigneeId: string | null = body.assigneeId ? String(body.assigneeId) : (assigneeByEmail?.id ?? null);
    // Assignment logic:
    // 1. Manual creation (userId present, not from email) Ã¢â€ ' assign to creator
    // 2. Email ticket or queue-transfer Ã¢â€ ' round-robin for the department
    let rrDepartment: string | null = null;
    if (!resolvedAssigneeId) {
      const isEmailCreated = !userId || body.fromEmail === true || !!body.reporterEmail;
      const requestedDept = body.department ? String(body.department) : null;

      try {
        if (!isEmailCreated && !requestedDept) {
          // Manual creation with no explicit dept -- leave unassigned (RR only triggers on email or dept selection)
          resolvedAssigneeId = null;
        } else if (requestedDept) {
          // Ticket with an explicit queue/department Ã¢â€ ' RR for that dept
          rrDepartment = requestedDept;
          const nextAgent = await getNextAgent(sp.id, requestedDept, body.productType ? String(body.productType) : null);
          if (nextAgent) resolvedAssigneeId = nextAgent.userId;
        } else if (isEmailCreated) {
          // Email ticket with no dept Ã¢â€ ' use the default department RR
          const defaultDept = await getDefaultDepartment(sp.id);
          if (defaultDept) {
            rrDepartment = defaultDept;
            const nextAgent = await getNextAgent(sp.id, defaultDept, body.productType ? String(body.productType) : null);
            if (nextAgent) resolvedAssigneeId = nextAgent.userId;
          }
        }
      } catch { /* non-critical */ }
    }

    // If jiraKey provided: try to update existing issue instead of creating a duplicate
    if (body.jiraKey) {
      const existingKey = String(body.jiraKey).toUpperCase();
      const existing = await db.issue.findUnique({ where: { key: existingKey } });
      if (existing) {
        const updated = await db.issue.update({
          where: { key: existingKey },
          data: {
            assigneeId: resolvedAssigneeId ?? existing.assigneeId,
            reporterId: resolvedReporterId ?? existing.reporterId,
          },
          include: { status: true, assignee: true, reporter: true, space: { select: { key: true, name: true } } },
        });
        return json(formatIssue(updated));
      }
    }

    // For subtasks: always use the first (Open) status regardless of what parent has
    const openStatus = sp.statuses.find(s => s.category === 'todo') || sp.statuses[0];
    const finalStatus = body.parentKey ? openStatus : st;

    // Retry loop: handles race condition where two concurrent creates pick the same key number.
    let issue: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      const issueKey = `${keyPrefix}-${maxNum + 1 + attempt}`;
      try {
        issue = await db.issue.create({
      data: {
        id: rid(),
        key: issueKey,
        summary: String(body.summary || 'Untitled'),
        description: body.description ? String(body.description) : null,
        type: String(body.type || 'task'),
        priority: String(body.priority || 'medium'),
        spaceId: sp.id,
        statusId: finalStatus?.id ?? openStatus?.id ?? null,
        assigneeId: resolvedAssigneeId,
        reporterId: resolvedReporterId,
        parentKey: body.parentKey ? String(body.parentKey).toUpperCase() : null,
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
        ...(body.storyPoints !== undefined && body.storyPoints !== '' && { storyPoints: Number(body.storyPoints) }),
        ...(body.dueDate ? { dueDate: new Date(String(body.dueDate)) } : {}),
        ...(body.productType !== undefined && { productType: body.productType ? String(body.productType) : null }),
        ...(body.combination !== undefined && { combination: body.combination ? String(body.combination) : null }),
        ...(body.customerName !== undefined && { customerName: body.customerName ? String(body.customerName) : null }),
        ...(body.clientName !== undefined && { clientName: body.clientName ? String(body.clientName) : null }),
        ...(body.projectManager !== undefined && { projectManager: body.projectManager ? String(body.projectManager) : null }),
      },
      include: {
        status: true,
        assignee: true,
        reporter: true,
        space: { select: { key: true, name: true } },
      },
        });
        break; // success -- exit retry loop
      } catch (err: any) {
        const isUniqueViolation = err?.code === 'P2002' || err?.message?.includes('Unique constraint');
        if (!isUniqueViolation || attempt === 4) throw err;
        // Key collision (race condition) -- try next number
      }
    }
    if (!issue) return json({ error: 'Failed to generate unique issue key' }, 500);

    // Set original_dept and assign next CF key at creation time
    try {
      if (issue?.id) {
        // current_department is a raw ALTER TABLE column -- Prisma doesn't know it, so set via raw SQL
        const deptToSet = body.department ? String(body.department) : (rrDepartment || null);
        if (deptToSet) {
          // Seed dept_statuses with the QUEUE's own configured "open" status (same
          // lookup the department-transfer path uses below) rather than the space's
          // generic status list -- otherwise a freshly created ticket shows "To Do"
          // even when the queue's workflow has no such status (e.g. it only has
          // Open/Inprogress/Waiting For Dev/...), and the status pill disagrees with
          // the dropdown options (which ARE queue-aware).
          let queueStatuses: any[] = [];
          try {
            const allQueueRows = await pool.query(`SELECT queues FROM custom_queues`);
            for (const row of allQueueRows.rows) {
              const queues: any[] = row.queues || [];
              const matchedQ = queues.find((q: any) => (q.name || '').toLowerCase() === deptToSet.toLowerCase());
              if (matchedQ?.queueStatuses?.length) { queueStatuses = matchedQ.queueStatuses; break; }
            }
          } catch {}
          const queueOpenStatus = queueStatuses.find((s: any) => s.category === 'todo') || queueStatuses[0];
          const initStatus = queueOpenStatus || openStatus || sp.statuses[0];
          const initDeptStatuses = initStatus
            ? JSON.stringify({ [deptToSet]: { id: initStatus.id, name: initStatus.name, color: initStatus.color, category: initStatus.category } })
            : '{}';
          await pool.query(
            `UPDATE issues SET current_department=$1, original_dept=$1, dept_statuses=$2::jsonb, dept_sla_started_at=NOW() WHERE id=$3`,
            [deptToSet, initDeptStatuses, issue.id]
          );
          await startDeptSLA(null, issue.id, deptToSet);
        } else {
          await pool.query(
            `UPDATE issues SET original_dept = current_department WHERE id = $1 AND original_dept IS NULL`,
            [issue.id]
          );
        }
        // Assign next sequential CF key
        const maxRow = await pool.query(`SELECT MAX(CAST(SUBSTRING(cf_key FROM 4) AS INTEGER)) AS mx FROM issues WHERE cf_key LIKE 'CF-%'`);
        const nextNum = (maxRow.rows[0]?.mx ?? 0) + 1;
        const cfKey = `CF-${nextNum}`;
        await pool.query(`UPDATE issues SET cf_key = $1 WHERE id = $2`, [cfKey, issue.id]);
        (issue as any).cf_key = cfKey;
      }
    } catch {}

    // Everything below is a side effect the client doesn't need to wait on —
    // email/in-app notifications, connector events, history logging, and
    // recurring-issue detection (which runs a similarity/keyword scan over
    // every resolved ticket in the space). None of it was needed to answer
    // "was the ticket created," so it was making every single create wait on
    // a scan of potentially tens of thousands of rows before the client ever
    // saw a response. Fire it all in the background and respond immediately.
    (async () => {
      try {
    // Update space issue count
    await db.space.update({
      where: { id: sp.id },
      data: { issueCount: { increment: 1 } },
    });

    // Send email notification (fire-and-forget)
    notifyIssueCreated({
      key: issue.key, cfKey: (issue as any).cf_key || null, summary: issue.summary,
      type: issue.type, priority: issue.priority,
      spaceKey: issue.space?.key ?? sk,
      spaceName: issue.space?.name ?? sk,
      status: { name: issue.status?.name ?? 'Open', category: issue.status?.category ?? 'todo' },
      assignee: issue.assignee, reporter: issue.reporter,
    }).catch(() => {});

    // If ticket has no assignee, email leads + shift leads so they can pick it up
    const issueDept = (issue as any).current_department || null;
    if (!issue.assigneeId) {
      try {
        const { notifyUnassignedTicket } = await import('@/lib/notification-service');
        const leadIds = await getSpaceLeadUserIds(sp.id, issueDept);
        if (leadIds.length) {
          const leadUsers = await db.user.findMany({ where: { id: { in: leadIds } }, select: { email: true } });
          const leadEmails = leadUsers.map((u: any) => u.email).filter(Boolean);
          notifyUnassignedTicket({
            issueKey: issue.key,
            issueSummary: issue.summary,
            spaceKey: issue.space?.key ?? sk,
            spaceName: issue.space?.name ?? sk,
            department: issueDept,
            reporter: issue.reporter,
            leadEmails,
          }).catch(() => {});
        }
      } catch { /* non-critical */ }
    }

    // In-app notification: notify assignee + leads/shift leads for this dept (reporter created it, so skip them)
    const createdLeadIds = await getSpaceLeadUserIds(sp.id, issueDept);
    await notifyUsers(
      [issue.assigneeId, ...createdLeadIds],
      issue.reporterId,
      { type: 'CREATED', title: `New issue: ${issue.key}`, message: issue.summary, issueKey: issue.key }
    );

    // Recurring issue detection: notify if this issue was previously resolved
    try {
      const prevResolved = await findPreviouslyResolvedSimilar(sp.id, issue.id, issue.summary);
      if (prevResolved.length > 0) {
        const newKey = (issue as any).cf_key || issue.key;
        const refs = prevResolved.map((s) => `${s.cf_key || s.key} — ${s.summary.substring(0, 80)}`).join('\n• ');
        const leadIds = await getSpaceLeadUserIds(sp.id, issueDept);
        const recipients = [issue.reporterId, issue.assigneeId, ...leadIds];
        await notifyUsers(recipients, null, {
          type: 'DUPLICATE_ALERT',
          title: `Recurring issue: ${newKey}`,
          message: `This issue was previously reported and resolved:\n• ${refs}\n\nPlease check if the fix is still in place.`,
          issueKey: newKey,
        });
      }
    } catch (e: any) { console.error('[RecurringCheck]', e?.message); }

    // History: record issue creation
    try {
      const creatorUser = userId ? await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }) : null;
      const creatorName = creatorUser
        ? `${creatorUser.firstName} ${creatorUser.lastName}`.trim() || creatorUser.email
        : 'System';
      await (db as any).issueHistory.create({
        data: {
          id: rid(),
          issueId: issue.id,
          field: 'created',
          oldValue: null,
          newValue: `Issue created by ${creatorName}`,
          authorName: creatorName,
          authorEmail: creatorUser?.email ?? null,
          createdAt: new Date(),
        },
      });
    } catch { /* non-critical */ }

    // Fire connector event: issue created
    fireConnectorEvent({
      event: 'issue.created',
      timestamp: new Date().toISOString(),
      issue: {
        key: issue.key, cf_key: (issue as any).cf_key,
        summary: issue.summary, type: issue.type, priority: issue.priority,
        status: issue.status?.name, spaceKey: issue.space?.key ?? sk, spaceName: issue.space?.name,
        assignee: issue.assignee ? `${(issue.assignee as any).firstName} ${(issue.assignee as any).lastName}`.trim() : undefined,
        reporter: issue.reporter ? `${(issue.reporter as any).firstName} ${(issue.reporter as any).lastName}`.trim() : undefined,
        url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/issues/${issue.key}`,
      },
    }).catch(() => {});

      } catch (err: any) {
        console.error('[Issue creation background tasks] Failed:', err?.message || err);
      }
    })();

    return json(formatIssue(issue));
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Department Change (COPY / PASS) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Original ticket stays untouched on source board.
  // A NEW ticket is created on the target board with same content, new key, RR assignee, reset status.
  // History entry is added to the original ticket.
  const issueDeptMatch = path.match(/^issues\/([^/]+)\/department$/);
  if (issueDeptMatch && method === 'PATCH') {
    let key = issueDeptMatch[1].toUpperCase();
    // Resolve CF-key Ã¢â€ ' Prisma key
    if (key.startsWith('CF-')) {
      const cfRow = await pool.query(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
      if (cfRow.rows[0]) key = cfRow.rows[0].key;
    }
    const body = await readJson(req);
    const newDept = String(body.department || '');
    // targetBoard may be comma-separated (multi-board mapping) Ã¢â‚¬â€ use the first board
    const fromDeptBody = String(body.fromDept || '');
    const rawTargetBoard = String(body.targetBoard || '');
    const targetBoardKey = rawTargetBoard.split(',')[0].trim().toUpperCase();

    // Load source issue
    const issue = await db.issue.findUnique({
      where: { key },
      include: { space: true, assignee: true, status: true, reporter: true }
    });
    if (!issue) return json({ error: 'Not found' }, 404);

    // Only the department that currently owns this ticket (or an admin) can
    // move it elsewhere — a dept just monitoring it via Sent/Watching shouldn't
    // be able to transfer a ticket it no longer manages.
    if (!isAdmin) {
      try {
        const deptRow = await pool.query(`SELECT current_department FROM issues WHERE key=$1 LIMIT 1`, [key]);
        const currentDept: string | null = deptRow.rows[0]?.current_department || null;
        if (currentDept && issue.space?.key) {
          const authorized = await isUserAuthorizedForDeptQueue(issue.space.key, currentDept, userId);
          if (!authorized) {
            return json({ error: `You can view and comment on this ticket, but it has moved to ${currentDept} — only that queue can move it.` }, 403);
          }
        }
      } catch { /* fail open on lookup errors */ }
    }

    //Ã¢â€â‚¬Ã¢â€â‚¬ Single-board mode: no targetBoard or same board as source Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    if (!targetBoardKey || targetBoardKey === issue.space?.key?.toUpperCase()) {
      // This used to unconditionally force BOTH the global statusId and the
      // arriving dept's status to "Waiting for <newDept>" (creating a virtual
      // one if no real status of that name existed) -- regardless of what the
      // ticket's actual status was. A ticket that had just been marked
      // Resolved and was then handed off to another dept for final review
      // got its status silently flipped back to "Waiting for Migration" (or
      // "Open"/"To Do" for a first arrival), making finished work look
      // unfinished again in every view that reads the real status. A
      // Resolved/Closed ticket keeps its exact status across a transfer now;
      // only a still-open ticket gets the normal Open/In-Progress treatment
      // dept_statuses below already computes.
      const isDoneNow = issue.status?.category === 'done';
      const oldDeptStatusObj = issue.status
        ? { id: issue.status.id, name: issue.status.name, category: issue.status.category, color: issue.status.color }
        : { id: '', name: 'Unknown', category: 'todo', color: '#6B7280' };

      // Build per-dept assignee map: save current assignee under old dept, clear new dept
      // Fetch current_department from raw SQL Ã¢â‚¬â€ Prisma doesn't return raw ALTER TABLE columns
      const existingMap = await pool.query(`SELECT dept_assignees, current_department, dept_statuses, original_dept FROM issues WHERE key=$1`, [key]);
      let oldDept: string = existingMap.rows[0]?.current_department || fromDeptBody || '';
      if (!oldDept) {
        const dsKeys = Object.keys(existingMap.rows[0]?.dept_statuses || {}).filter((k: string) => k.toLowerCase() !== newDept.toLowerCase());
        if (dsKeys.length === 1) { oldDept = dsKeys[0]; }
        else if (dsKeys.length > 1) {
          const activeKey = dsKeys.find((k: string) => (existingMap.rows[0]?.dept_statuses[k]?.category || '') !== 'done');
          if (activeKey) { oldDept = activeKey; }
        }
      }
      const deptAssignees: Record<string, any> = existingMap.rows[0]?.dept_assignees || {};
      if (oldDept && issue.assignee) {
        deptAssignees[oldDept] = {
          id: issue.assignee.id,
          email: (issue.assignee as any).email,
          firstName: (issue.assignee as any).firstName,
          lastName: (issue.assignee as any).lastName,
          displayName: `${(issue.assignee as any).firstName} ${(issue.assignee as any).lastName}`.trim(),
          avatarUrl: avatarRef(issue.assignee.id, (issue.assignee as any).avatarUrl),
        };
      }
      // Deliberately NOT resetting deptAssignees[newDept] here. It already
      // holds whatever was saved from the LAST time this ticket was in
      // newDept (if ever) — wiping it right before the restore-or-assign
      // check below made that check always see null, so a ticket bouncing
      // Queue2 -> Queue1 -> Queue2 always got a fresh round-robin pick in
      // Queue2 instead of going back to the same person who had it there
      // the first time. Leaving it untouched lets that check actually see
      // prior history; a dept that's never been visited is simply absent
      // from the map (undefined), which the check below already treats the
      // same as null.

      // Per-dept statuses
      const existingStatuses = await pool.query(`SELECT dept_statuses FROM issues WHERE key=$1`, [key]);
      const deptStatuses: Record<string, any> = existingStatuses.rows[0]?.dept_statuses || {};
      // Returning ticket (dept visited before) => In Progress; first arrival => Waiting for newDept
      const isReturningToDept = deptStatuses[newDept] != null;

      let newDeptQueueStatuses: any[] = [];
      try {
        const allQueueRows = await pool.query(`SELECT queues FROM custom_queues`);
        for (const row of allQueueRows.rows) {
          const queues: any[] = row.queues || [];
          const matchedQ = queues.find((q: any) => (q.name || '').toLowerCase() === newDept.toLowerCase());
          if (matchedQ?.queueStatuses?.length) { newDeptQueueStatuses = matchedQ.queueStatuses; break; }
        }
      } catch {}

      let newDeptStatusObj: any;
      if (isDoneNow) {
        // Already Resolved/Closed -- being routed on for review or final
        // closure isn't "new work arriving," so don't reopen it by resetting
        // to Open/In-Progress. Same done status carries straight through.
        newDeptStatusObj = oldDeptStatusObj;
      } else if (isReturningToDept) {
        const inProgressSt = newDeptQueueStatuses.find((s: any) => s.category === 'in_progress')
          || newDeptQueueStatuses.find((s: any) => (s.name || '').toLowerCase().includes('progress'))
          || newDeptQueueStatuses.find((s: any) => s.category === 'todo')
          || newDeptQueueStatuses[0];
        newDeptStatusObj = inProgressSt || { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' };
      } else {
        // First arrival in this dept — default to an Open/To-do status, never the
        // "Waiting for <newDept>" marker (that belongs to the OLD dept's record,
        // shown while the ticket is in transit, not once it has actually landed).
        const firstTodoSt = newDeptQueueStatuses.find((s: any) => s.category === 'todo') || newDeptQueueStatuses[0];
        newDeptStatusObj = firstTodoSt || { id: '', name: 'Open', category: 'todo', color: '#6366F1' };
      }

      // newDeptStatusObj can carry a queue-scoped virtual id (qst_...) that
      // isn't a real row in the statuses table, so it can't be written to
      // issues.statusId directly (that's a real foreign key) -- same
      // constraint the queueStatusId PATCH path above already works around.
      // Resolve the equivalent REAL status by name for the global column;
      // if none exists, leave statusId exactly as it was rather than writing
      // something invalid or defaulting to a status that doesn't match what
      // dept_statuses now shows.
      let newStatusId = issue.statusId;
      if (isDoneNow) {
        newStatusId = issue.statusId;
      } else {
        const realMatch = await db.status.findFirst({
          where: { spaceId: issue.spaceId, name: { equals: newDeptStatusObj.name, mode: 'insensitive' } },
          orderBy: { order: 'asc' },
        });
        if (realMatch) newStatusId = realMatch.id;
      }

      // Record the OLD dept's status exactly as it was right before the transfer —
      // not the "Waiting for <newDept>" transit marker, which discarded that info
      // (Sent/Watching needs to show what it was actually at before leaving).
      if (oldDept) {
        deptStatuses[oldDept] = issue.status
          ? { id: issue.status.id, name: issue.status.name, category: issue.status.category, color: issue.status.color }
          : oldDeptStatusObj;
      }
      deptStatuses[newDept] = newDeptStatusObj;

      // Restore previously saved assignee for this dept, or round-robin to a new one
      let rrAssigneeId: string | null = null;
      let rrAgentName: string | null = null;
      const savedAssigneeForNewDept = deptAssignees[newDept];
      // dept_assignees is a point-in-time snapshot that can outlive the user it
      // points to -- if that account was since deleted (a real hard delete via
      // Settings > User Management, e.g. an offboarded employee), restoring it
      // here violates issues.assigneeId's foreign key and the whole department
      // transfer fails with no useful error shown to the user. Verify the user
      // still exists first; if not, fall through to round robin below instead
      // (same as if this dept had never been visited before), and drop the
      // stale reference so this ticket doesn't keep hitting it on every future
      // visit to this dept.
      let savedAssigneeStillExists = false;
      if (savedAssigneeForNewDept?.id) {
        const stillExists = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [savedAssigneeForNewDept.id]);
        savedAssigneeStillExists = stillExists.rows.length > 0;
        if (!savedAssigneeStillExists) delete deptAssignees[newDept];
      }
      if (savedAssigneeForNewDept?.id && savedAssigneeStillExists) {
        // Dept was visited before -- restore the saved assignee
        rrAssigneeId = savedAssigneeForNewDept.id;
        rrAgentName = savedAssigneeForNewDept.displayName || null;
      } else {
        try {
          const rrAgent = await getNextAgent(issue.spaceId, newDept, (issue as any).productType || null);
          if (rrAgent) {
            rrAssigneeId = rrAgent.userId;
            rrAgentName = rrAgent.name;
            deptAssignees[newDept] = { id: rrAgent.userId, displayName: rrAgent.name };
          }
        } catch { /* non-critical */ }
      }

      // Pause old dept SLA (save elapsed), then reset timer for new dept
      await pauseDeptSLA(key, null, oldDept);
      await pool.query(
        `UPDATE issues SET current_department=$1, "assigneeId"=$2, "statusId"=$3, dept_sla_started_at=NOW(), dept_assignees=$4::jsonb, dept_statuses=$5::jsonb, original_dept=COALESCE(original_dept,$7), "updatedAt"=NOW() WHERE key=$6`,
        [newDept, rrAssigneeId, newStatusId, JSON.stringify(deptAssignees), JSON.stringify(deptStatuses), key, oldDept || null]
      );
      await startDeptSLA(key, null, newDept);

      // Track ticket in closed list for old dept and log transition for Sent/Watching
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS queue_closed_tickets (id SERIAL PRIMARY KEY, space_id TEXT NOT NULL, dept_name TEXT NOT NULL, issue_id TEXT NOT NULL, closed_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(space_id, dept_name, issue_id))`);
        if (oldDept) {
          await pool.query(`INSERT INTO queue_closed_tickets (space_id, dept_name, issue_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [issue.spaceId, oldDept, issue.id]);
        }
        // Always log transition (from_dept = '' means ticket had no prior dept)
        await pool.query(
          `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept, moved_by) VALUES ($1, $2, $3, $4, $5)`,
          [issue.id, issue.spaceId, oldDept || '', newDept, userId || null]
        );
        // Record worked-on for whoever handled this ticket in oldDept — the
        // formal assignee if there is one. This used to ALSO credit whoever
        // performed the transfer even when a real assignee already existed
        // (only meant as a fallback for the rare unassigned-ticket case, but
        // written unconditionally) -- an admin doing routine department
        // management, or anyone else moving a ticket that was never really
        // theirs, got it added to their own personal "Worked on" list next
        // to tickets they had nothing to do with. Only fall back to
        // crediting the mover when there's no assignee to credit instead.
        if (oldDept && issue.assigneeId) {
          pool.query(
            `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
            [issue.assigneeId, issue.id, oldDept]
          ).catch(() => {});
        } else if (oldDept && userId) {
          pool.query(
            `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'passed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='passed', worked_at=NOW()`,
            [userId, issue.id, oldDept]
          ).catch(() => {});
        }
        // When ticket returns to Dev (or any dept that has a saved assignee), also record worked-on for that dept
        const devAssignee = deptAssignees[newDept];
        if (devAssignee?.id) {
          pool.query(
            `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'returned') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='returned', worked_at=NOW()`,
            [devAssignee.id, issue.id, newDept]
          ).catch(() => {});
        }
      } catch {}

      // Notifications on dept change — fire-and-forget. This used to await three
      // sequential notifyUsers calls (each with its own per-recipient DB lookups)
      // plus a spaceMember query and a lead lookup, all before the response went
      // back — so confirming a transfer was only as fast as the whole
      // notification pipeline. The transfer itself has already fully committed
      // above; notifications reaching people doesn't need to block confirming
      // that to the user who just moved it.
      (async () => {
        try {
          // Notify reporter that ticket was sent to new dept
          if (issue.reporterId) {
            await notifyUsers(
              [issue.reporterId],
              userId,
              { type: 'DEPT_CHANGE', title: `Ticket ${key} sent to ${newDept}`, message: `Your ticket "${issue.summary}" has been transferred to ${newDept}.`, issueKey: key }
            );
          }
          // Notify the RR-assigned agent
          if (rrAssigneeId) {
            await notifyUsers(
              [rrAssigneeId],
              userId,
              { type: 'ASSIGNED', title: `Ticket assigned to you: ${key}`, message: `You have been assigned to "${issue.summary}" in the ${newDept} queue.`, issueKey: key }
            );
          }
          // Notify space members of the target dept (agents + leads/shift_leads in that dept)
          const spaceMembers = await db.spaceMember.findMany({
            where: { spaceId: issue.spaceId },
            include: { user: { select: { id: true } } }
          });
          const targetDeptMemberIds = spaceMembers
            .filter((m: any) => (m as any).department?.toLowerCase() === newDept.toLowerCase())
            .map((m: any) => m.user?.id)
            .filter((id: any) => id && id !== rrAssigneeId); // skip already-notified assignee
          // Also include leads/shift_leads for this dept (those with matching dept or no dept set)
          const deptLeadIds = await getSpaceLeadUserIds(issue.spaceId, newDept);
          const allDeptIds = [...new Set([...targetDeptMemberIds, ...deptLeadIds])].filter((id) => id !== rrAssigneeId);
          if (allDeptIds.length > 0) {
            await notifyUsers(
              allDeptIds,
              userId,
              { type: 'DEPT_ASSIGNED', title: `New ticket in ${newDept}: ${key}`, message: `Ticket "${issue.summary}" has arrived in the ${newDept} queue.`, issueKey: key }
            );
          }
          // SLA pause/resume — distinct from the DEPT_CHANGE/ASSIGNED notices
          // above, which announce the handoff itself, not the SLA clock state.
          // Tell whoever was actively working oldDept that their clock just
          // stopped (pauseDeptSLA already ran above), and tell newDept's
          // assignee their clock just started (startDeptSLA already ran too).
          if (oldDept && issue.assignee?.id) {
            await notifyUsers(
              [issue.assignee.id],
              userId,
              { type: 'SLA_PAUSED', title: `SLA paused for ${key}`, message: `Ticket "${issue.summary}" moved out of ${oldDept} — its SLA clock has been paused.`, issueKey: key }
            );
          }
          if (rrAssigneeId) {
            await notifyUsers(
              [rrAssigneeId],
              userId,
              { type: 'SLA_RESUMED', title: `SLA running for ${key}`, message: `Ticket "${issue.summary}" has arrived in ${newDept} — its SLA clock is now running.`, issueKey: key }
            );
          }
        } catch { /* ignore notification errors */ }
      })();

      // History entry (non-critical)
      try {
        const authorUser2 = userId
          ? await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
          : null;
        const authorName2 = authorUser2 ? `${authorUser2.firstName} ${authorUser2.lastName}` : 'System';
        await (db as any).issueHistory.create({
          data: {
            id: rid(), issueId: issue.id, field: 'department',
            oldValue: oldDept || 'None',
            newValue: `Transferred to ${newDept}`,
            authorName: authorName2, createdAt: new Date(),
          },
        });
      } catch { /* non-critical */ }

      const updatedIssue = await db.issue.findUnique({
        where: { key },
        include: { status: true, assignee: true, reporter: true, space: { select: { key: true, name: true } } }
      });
      let extraCols: any = {};
      try {
        const r = await pool.query(`SELECT current_department, dept_assignees, dept_sla_started_at, dept_statuses, dept_sla_log, cf_key FROM issues WHERE key=$1 LIMIT 1`, [key]);
        if (r.rows[0]) extraCols = r.rows[0];
      } catch {}
      const newStatusName = newDeptStatusObj?.name || 'Open';
      // Email the reporter and the (possibly new) assignee about the department
      // transfer — the in-app notifications above don't reach anyone's inbox,
      // and a department move is exactly the kind of change both of them need
      // to know about (e.g. reporter's Migration ticket moving to Dev).
      if (updatedIssue) {
        notifyIssueUpdated({
          key: updatedIssue.key, summary: updatedIssue.summary, priority: updatedIssue.priority,
          spaceKey: updatedIssue.space?.key ?? '', spaceName: updatedIssue.space?.name ?? '',
          status: { name: updatedIssue.status?.name ?? newStatusName, category: updatedIssue.status?.category ?? 'todo' },
          assignee: updatedIssue.assignee, reporter: updatedIssue.reporter,
          updatedBy: userId ? await db.user.findUnique({ where: { id: userId } }) : null,
          changes: [{ field: 'Department', from: oldDept || 'None', to: newDept }],
        }).catch(() => {});
      }
      fireConnectorEvent({
        event: 'issue.department_changed', timestamp: new Date().toISOString(),
        issue: {
          key, summary: issue.summary, type: issue.type, priority: issue.priority,
          status: newStatusName, spaceKey: issue.space?.key ?? '', spaceName: (issue.space as any)?.name,
          department: newDept,
          url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/issues/${key}`,
        },
        change: { field: 'Department', from: (issue as any).current_department || 'None', to: newDept },
      }).catch(() => {});
      return json({ ok: true, department: newDept, sameBoard: true, newStatus: newStatusName, assigneeName: rrAgentName, boardKey: issue.space?.key || '', issue: updatedIssue ? formatIssue({ ...updatedIssue, ...extraCols }) : null });
    }
    // Ã¢â€â‚¬Ã¢â€â‚¬ Multi-board mode continues below Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    // Resolve target space
    let targetSpace = issue.space;
    if (targetBoardKey && targetBoardKey !== issue.space?.key?.toUpperCase()) {
      const found = await db.space.findFirst({ where: { key: { equals: targetBoardKey, mode: 'insensitive' } } });
      if (found) targetSpace = found as any;
    }
    const targetSpaceId = targetSpace.id;

    // First status of target board
    const firstStatus = await db.status.findFirst({
      where: { spaceId: targetSpaceId },
      orderBy: { order: 'asc' },
    });
    const newStatusId = firstStatus?.id || issue.statusId;
    const newStatusName = firstStatus?.name || 'Open';

    // Round Robin assignee from source space RR config (where depts are configured), fallback target
    const rrAgent = await getNextAgent(issue.spaceId, newDept, (issue as any).productType || null)
      || await getNextAgent(targetSpaceId, newDept, (issue as any).productType || null);

    // Generate next key for target board
    // Use the SAME number from the source key (e.g. L1BOAR-5618 Ã¢â€ ' L2BOARD-5618)
    const sourceNum = key.split('-').pop() || '1';
    const newKey = `${targetSpace.key}-${sourceNum}`;
    const newId = rid();

    // If a ticket with this key already exists on target board, just update it
    const existingOnTarget = await pool.query(`SELECT id FROM issues WHERE key = $1`, [newKey]);
    if (existingOnTarget.rows[0]) {
      // Already passed before Ã¢â‚¬â€ update assignee + status
      await pool.query(
        `UPDATE issues SET "assigneeId"=$1,"statusId"=$2,current_department=$3,"updatedAt"=NOW() WHERE key=$4`,
        [rrAgent?.userId || issue.assigneeId, newStatusId, newDept, newKey]
      );
    } else {
      // Copy ticket to target board with same number, RR assignee, reset status
      await pool.query(
        `INSERT INTO issues (
          id, key, summary, description, type, priority,
          "spaceId", "statusId", "assigneeId", "reporterId",
          current_department, "createdAt", "updatedAt"
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
        [
          newId, newKey, issue.summary, issue.description || '', issue.type || 'task',
          issue.priority || 'medium', targetSpaceId, newStatusId,
          rrAgent?.userId || issue.assigneeId, issue.reporterId,
          newDept,
        ]
      );
    }

    // Copy custom field values to new ticket
    try {
      await pool.query(
        `INSERT INTO issue_custom_field_values (id, "issueId", "fieldId", value, "createdAt", "updatedAt")
         SELECT $1 || gen_random_uuid()::text, $2, "fieldId", value, NOW(), NOW()
         FROM issue_custom_field_values WHERE "issueId" = $3`,
        ['cf_', newId, issue.id]
      );
    } catch (_) { /* custom fields table may not exist */ }

    // Author for history
    const authorUser = userId
      ? await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
      : null;
    const authorName = authorUser ? `${authorUser.firstName} ${authorUser.lastName}` : 'System';
    const assigneeName = rrAgent?.name || 'Unassigned';

    // Update original ticket's department field so it shows "Dev" on L1-Board
    await pool.query(
      `UPDATE issues SET current_department=$1, "updatedAt"=NOW() WHERE key=$2`,
      [newDept, key]
    );
    // Log transition for Sent/Watching
    try {
      const oldDeptForTrans = (issue as any).current_department || '';
      if (oldDeptForTrans) {
        await pool.query(
          `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept) VALUES ($1, $2, $3, $4)`,
          [issue.id, issue.spaceId, oldDeptForTrans, newDept]
        );
        await pool.query(
          `INSERT INTO queue_closed_tickets (space_id, dept_name, issue_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [issue.spaceId, oldDeptForTrans, issue.id]
        );
      }
    } catch {}

    // Link original Ã¢â€ â€ new ticket as partners so comments are shared between them
    await pool.query(`UPDATE issues SET "partnerKey"=$1 WHERE key=$2`, [newKey, key]);
    await pool.query(`UPDATE issues SET "partnerKey"=$1 WHERE key=$2`, [key, newKey]);

    // History on ORIGINAL ticket: "Passed to Dev Ã¢â€ ' L2BOARD (new ticket: L2BOARD-5618)"
    await (db as any).issueHistory.create({
      data: {
        id: rid(), issueId: issue.id, field: 'department',
        oldValue: (issue as any).current_department || 'None',
        newValue: `Passed to ${newDept} → ${targetSpace.key} (${newKey})`,
        authorName, createdAt: new Date(),
      },
    });

    // History on NEW ticket: created by department pass
    await (db as any).issueHistory.create({
      data: {
        id: rid(), issueId: newId, field: 'department',
        oldValue: 'Created',
        newValue: `Passed from ${issue.space?.key || ''} (${key}) Ã‚Â· Assignee: ${assigneeName} (Round Robin)`,
        authorName: 'System', createdAt: new Date(),
      },
    });

    return json({ ok: true, department: newDept, newKey, targetBoardKey: targetSpace.key, assignee: rrAgent, newStatus: newStatusName });
  }

  const issueKeyMatch = path.match(/^issues\/([^/]+)$/);
  if (issueKeyMatch && method === 'GET') {
    const rawKey = issueKeyMatch[1].toUpperCase();
    // Normalize key: strip Jira sub-issue colon suffix (e.g. "L2B-12718:1" Ã¢â€ ' "L2B-12718")
    let key = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
    // Resolve CF key to actual Jira key (e.g. "CF-1" Ã¢â€ ' "L2B-5112")
    if (key.startsWith('CF-')) {
      try {
        const cfRow = await pool.query(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
        if (cfRow.rows[0]) key = cfRow.rows[0].key;
      } catch { /* fallback to original key */ }
    }
    const issue = await db.issue.findUnique({
      where: { key },
      include: {
        status: true,
        assignee: true,
        reporter: true,
        space: { select: { key: true, name: true } },
        comments: {
          include: { author: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!issue) {
      // Try to import from Jira on-demand
      const imported = await importIssueFromJira(key);
      if (imported) return json(imported);
      return json({ error: 'Issue not found' }, 404);
    }

    // Auto-refresh custom fields from Jira if all 5 are null (never synced).
    // Fire-and-forget: this hits a real external Jira Cloud API with no timeout
    // on the fetch calls, so awaiting it here could hang the whole issue page
    // indefinitely if Jira is slow, unreachable, or rate-limiting. Running it
    // in the background means this load won't show the freshly-synced fields,
    // but the next load will, and the page never hangs waiting on Jira.
    if (
      issue.customerName === null && issue.clientName === null &&
      issue.projectManager === null && issue.productType === null && issue.combination === null
    ) {
      (async () => {
        try {
          const prefix = key.split('-')[0];
          const meta = PREFIX_TO_META[prefix];
          if (meta) {
            const creds = await getJiraCredentials();
            const jiraKey = prefix === 'L1BOAR' ? null : key;
            let jiraFields: Record<string, string | null> | null = null;

            if (jiraKey) {
              // Direct lookup by key for L2B / L3B
              const cfRes = await fetch(
                `${creds.base}/rest/api/3/issue/${jiraKey}?fields=${JIRA_CUSTOM_FIELDS}`,
                { headers: { Authorization: creds.authHdr, Accept: 'application/json' } }
              );
              if (cfRes.ok) {
                const d = await cfRes.json();
                const f = d.fields || {};
                jiraFields = {
                  customerName:   extractJiraValue(f.customfield_10401),
                  clientName:     extractJiraValue(f.customfield_10883),
                  projectManager: extractJiraValue(f.customfield_11380),
                  productType:    extractJiraValue(f.customfield_10203),
                  combination:    extractJiraValue(f.customfield_10236),
                };
              }
            } else if (issue.summary) {
              // Title-based search in CFITS for L1BOAR tickets
              const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
              const jql = encodeURIComponent(`project=CFITS AND summary ~ "${issue.summary.replace(/"/g, ' ').slice(0, 80)}" ORDER BY updated DESC`);
              const srRes = await fetch(
                `${creds.base}/rest/api/3/search/jql?jql=${jql}&maxResults=5&fields=summary,${JIRA_CUSTOM_FIELDS}`,
                { headers: { Authorization: creds.authHdr, Accept: 'application/json' } }
              );
              if (srRes.ok) {
                const srData = await srRes.json();
                const localNorm = norm(issue.summary);
                const match = (srData.issues || []).find((ji: any) => {
                  const jNorm = norm(ji.fields?.summary || '');
                  return jNorm === localNorm || (jNorm.length >= 15 && (jNorm.includes(localNorm.slice(0, 60)) || localNorm.includes(jNorm.slice(0, 60))));
                });
                if (match) {
                  const f = match.fields || {};
                  jiraFields = {
                    customerName:   extractJiraValue(f.customfield_10401),
                    clientName:     extractJiraValue(f.customfield_10883),
                    projectManager: extractJiraValue(f.customfield_11380),
                    productType:    extractJiraValue(f.customfield_10203),
                    combination:    extractJiraValue(f.customfield_10236),
                  };
                }
              }
            }

            if (jiraFields) {
              const updateData: Record<string, string | null> = {};
              for (const [k, v] of Object.entries(jiraFields)) {
                if (v !== null && v !== '') updateData[k] = v;
              }
              if (Object.keys(updateData).length > 0) {
                await db.issue.update({ where: { id: issue.id }, data: updateData });
                Object.assign(issue, updateData);
              }
            }
          }
        } catch { /* non-fatal */ }
      })().catch(() => {});
    }

    // Load the suspension-check row, attachments, history, and links (both
    // directions) + children all together -- these were previously five
    // sequential round trips to the DB, each adding its own latency to every
    // ticket-open, even though none of them depend on each other's results.
    const [deptRow, dbAttachments, dbHistory, outLinksRaw, inLinksRaw, childIssues, rawDeptRow, partnerRows] = await Promise.all([
      (!isAdmin && issue.space?.key)
        ? pool.query(`SELECT current_department FROM issues WHERE id = $1`, [issue.id]).catch(() => null)
        : Promise.resolve(null),
      (db as any).attachment.findMany({
        where: { issueId: issue.id },
        orderBy: { createdAt: 'asc' },
      }),
      (db as any).issueHistory.findMany({
        where: { issueId: issue.id },
        orderBy: { createdAt: 'desc' },
      }),
      db.issueLink.findMany({ where: { sourceKey: key } }),
      db.issueLink.findMany({ where: { targetKey: key } }),
      db.issue.findMany({
        where: { parentKey: key },
        include: { status: true, assignee: true, space: { select: { key: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      // Raw columns Prisma's schema doesn't know about -- only needs `key`,
      // so it can run alongside everything else instead of after it.
      pool.query(
        `SELECT current_department, department_assignee_id, dept_sla_started_at, dept_assignees, dept_statuses, dept_sla_log, cf_key, "partnerKey" FROM issues WHERE key = $1 LIMIT 1`,
        [key]
      ).catch(() => ({ rows: [] as any[] })),
      // Partner-ticket comment merge lookup -- also only needs `key`.
      pool.query(
        `SELECT i.id FROM issues i WHERE i."partnerKey" = $1`,
        [key]
      ).catch(() => ({ rows: [] as any[] })),
    ]);

    if (!isAdmin && issue.space?.key && deptRow) {
      try {
        const issueDept = deptRow.rows[0]?.current_department;
        if (issueDept && await isUserSuspendedFromQueue(issue.space.key, issueDept, userId)) {
          return json({ error: 'Your access to this queue has been suspended.' }, 403);
        }
      } catch { /* non-critical — don't block ticket viewing on this lookup failing */ }
    }

    // Normalize colon-suffix keys in link records (e.g. "L2B-12718:1" Ã¢â€ ' "L2B-12718")
    const normalizeKey = (k: string) => k?.includes(':') ? k.split(':')[0] : k;
    const outLinks = outLinksRaw.map(l => ({ ...l, targetKey: normalizeKey(l.targetKey), sourceKey: normalizeKey(l.sourceKey) }));
    const inLinks  = inLinksRaw.map(l => ({ ...l, targetKey: normalizeKey(l.targetKey), sourceKey: normalizeKey(l.sourceKey) }));

    // Deduplicate: if both an outLink and inLink exist for the same pair, keep only the outLink
    const seenPairs = new Set<string>();
    const deduped: typeof outLinks = [];
    for (const l of [...outLinks, ...inLinks]) {
      const pairKey = [l.linkType, ...[l.sourceKey, l.targetKey].sort()].join('|');
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        deduped.push(l);
      }
    }

    // Fetch summaries for linked issues
    const linkedKeys = deduped.map(l => l.sourceKey === key ? l.targetKey : l.sourceKey);
    const linkedIssues = linkedKeys.length
      ? await db.issue.findMany({ where: { key: { in: linkedKeys } }, select: { key: true, summary: true, type: true } })
      : [];
    const summaryMap = new Map(linkedIssues.map(i => [i.key, i]));

    const allLinks = deduped.map(l => {
      const otherKey = l.sourceKey === key ? l.targetKey : l.sourceKey;
      const otherSummary = summaryMap.get(otherKey)?.summary ?? otherKey;
      return {
        id: l.id, linkType: l.linkType, sourceKey: l.sourceKey, targetKey: l.targetKey,
        _sourceSummary: l.sourceKey === key ? issue.summary : otherSummary,
        _targetSummary: l.targetKey === key ? issue.summary : otherSummary,
      };
    });

    // cf_key is a raw ALTER TABLE column Prisma doesn't know about, so
    // db.issue.findMany above never returns it for children -- fetch it
    // separately so subtasks show their CF-#### key like every other issue,
    // instead of falling back to the raw space-prefixed key.
    const childCfKeys = childIssues.length
      ? await pool.query<{ id: string; cf_key: string | null }>(
          `SELECT id, cf_key FROM issues WHERE id = ANY($1::text[])`,
          [childIssues.map(c => c.id)]
        )
      : { rows: [] as { id: string; cf_key: string | null }[] };
    const childCfKeyMap = new Map(childCfKeys.rows.map(r => [r.id, r.cf_key]));

    // Format children
    const children = childIssues.map(c => ({
      id: c.id,
      key: c.key,
      cfKey: childCfKeyMap.get(c.id) ?? null,
      summary: c.summary,
      type: c.type ?? 'subtask',
      priority: c.priority ?? 'medium',
      status: c.status
        ? { id: c.status.id, name: c.status.name, color: c.status.color, category: c.status.category }
        : { id: '', name: 'Open', color: '#6b7280', category: 'todo' },
      assignee: c.assignee
        ? { id: c.assignee.id, firstName: c.assignee.firstName, lastName: c.assignee.lastName ?? '', avatarUrl: avatarRef(c.assignee.id, c.assignee.avatarUrl) }
        : null,
      parentKey: key,
    }));

    const attachments = dbAttachments.map((a: any) => ({
      id: a.id,
      url: a.url,
      originalName: a.filename,
      mimeType: a.mimeType ?? '',
      size: a.size ?? 0,
      uploader: { firstName: '', lastName: '' },
      createdAt: a.createdAt?.toISOString() ?? nowIso(),
    }));

    const activity = dbHistory.map((h: any) => {
      const field: string = (h.field || '').toLowerCase();
      let action = 'updated';
      if (field === 'status')      action = 'changed status';
      else if (field === 'assignee') action = 'changed assignee';
      else if (field === 'priority') action = 'changed priority';
      else if (field === 'issuetype') action = 'changed type';
      else if (field === 'comment')  action = 'commented';
      else if (field === 'summary')  action = 'updated summary';
      else if (field === 'description') action = 'updated description';
      else if (field === 'labels')   action = 'updated labels';
      else if (field === 'parent')   action = 'changed parent';
      else action = `updated ${h.field || 'field'}`;
      return {
        id: h.id,
        field: h.field,
        action,
        oldValue: h.oldValue ?? null,
        newValue: h.newValue ?? null,
        user: { firstName: h.authorName ?? 'Unknown', lastName: '', email: h.authorEmail ?? '' },
        createdAt: h.createdAt?.toISOString() ?? nowIso(),
      };
    });

    // Raw columns not in Prisma schema -- fetched in the Promise.all above
    const rawDeptData: any = rawDeptRow.rows[0] || {};

    // Merge comments from partner tickets Ã¢â‚¬â€ only tickets explicitly linked via partnerKey
    // (set during department pass). This prevents accidentally merging comments from
    // unrelated tickets that happen to share the same number suffix.
    let allComments = [...(issue.comments || [])];
    try {
      for (const pr of partnerRows.rows) {
        const partnerComments = await db.comment.findMany({
          where: { issueId: pr.id },
          include: { author: true },
          orderBy: { createdAt: 'asc' },
        });
        allComments = [...allComments, ...partnerComments];
      }
      // Deduplicate by id and sort by createdAt
      const seen = new Set<string>();
      allComments = allComments.filter((c: any) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
      allComments.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch { /* ignore */ }

    const mergedIssue = { ...issue, comments: allComments, _links: allLinks, ...rawDeptData };
    const slaInstances = await computeIssueSLAsFromDb(mergedIssue);
    return json({ ...formatIssue(mergedIssue as any), attachments, attachmentCount: attachments.length, children, activity, sla: slaInstances, customFieldValues: {} });
  }

  if (issueKeyMatch && method === 'PATCH') {
    const rawKey = issueKeyMatch[1].toUpperCase();
    let key = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
    if (key.startsWith('CF-')) {
      try {
        const cfRow = await pool.query(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
        if (cfRow.rows[0]) key = cfRow.rows[0].key;
      } catch { /* fallback */ }
    }
    const body = await readJson(req);

    // Handle recall Ã¢â‚¬â€ return ticket to Migration dept
    if (body.recall === true) {
      try {
      // Fetch full state BEFORE modifying anything
      const recallRow = await pool.query(
        `SELECT i.current_department, i.dept_assignees, i."reporterId", i.summary, i."assigneeId"
         FROM issues i WHERE i.key=$1 LIMIT 1`, [key]
      );
      if (!recallRow.rows[0]) return json({ error: 'Ticket not found' }, 404);
      const recallDept: string = recallRow.rows[0]?.current_department || '';
      const savedDeptAssignees: Record<string, any> = recallRow.rows[0]?.dept_assignees || {};
      const savedMigrationAssignee = savedDeptAssignees['Migration'];
      let restoreAssigneeId: string | null = savedMigrationAssignee?.id || null;
      // dept_assignees is a point-in-time snapshot that can outlive the user it
      // points to — if that account was since deleted (e.g. an offboarded
      // employee via Settings > User Management, a real hard delete), restoring
      // it here violates issues.assigneeId's foreign key and the whole recall
      // fails with no useful error shown to the user. Verify the user still
      // exists first; if not, leave it unassigned instead of failing outright.
      if (restoreAssigneeId) {
        const stillExists = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [restoreAssigneeId]);
        if (!stillExists.rows.length) {
          restoreAssigneeId = null;
          delete savedDeptAssignees['Migration'];
        }
      }

      await pauseDeptSLA(key, null, recallDept);
      // Restore the saved Migration assignee if available
      await pool.query(
        `UPDATE issues SET current_department='Migration', "assigneeId"=$2, dept_sla_started_at=NOW(), dept_assignees=$3::jsonb, "updatedAt"=NOW() WHERE key=$1`,
        [key, restoreAssigneeId, JSON.stringify(savedDeptAssignees)]
      );
      await startDeptSLA(key, null, 'Migration');

      // Ticket returned to Migration -- remove 'passed' worked-on entries since work continues
      pool.query(
        `DELETE FROM user_worked_on_tickets WHERE issue_id=(SELECT id FROM issues WHERE key=$1) AND reason='passed'`,
        [key]
      ).catch(() => {});

      // Notify: restored Migration assignee + reporter
      try {
        const recallIssue = await db.issue.findUnique({ where: { key }, select: { reporterId: true, summary: true } });
        const summary = recallIssue?.summary || key;
        const notifyIds = [recallIssue?.reporterId, restoreAssigneeId].filter(Boolean) as string[];
        if (notifyIds.length) {
          await notifyUsers(notifyIds, userId, {
            type: 'DEPT_CHANGE',
            title: `Ticket ${key} returned to Migration`,
            message: `Ticket "${summary}" has been returned to the Migration queue. SLA has resumed.`,
            issueKey: key
          });
        }
        // Also notify all Migration dept members
        const spMembers = await db.spaceMember.findMany({ where: { spaceId: (await db.issue.findUnique({ where: { key }, select: { spaceId: true } }))?.spaceId }, include: { user: { select: { id: true } } } });
        const migrationMemberIds = spMembers
          .filter((m: any) => (m as any).department?.toLowerCase() === 'migration')
          .map((m: any) => m.user?.id)
          .filter((id: any) => id && !notifyIds.includes(id));
        if (migrationMemberIds.length > 0) {
          await notifyUsers(migrationMemberIds, userId, {
            type: 'DEPT_ASSIGNED',
            title: `Ticket ${key} back in Migration`,
            message: `Ticket "${summary}" has returned to Migration queue. SLA is running.`,
            issueKey: key
          });
        }
      } catch { /* non-critical */ }
      return NextResponse.json({ success: true, recalled: true, key });
      } catch (recallErr: any) {
        console.error('[Recall ERROR]', recallErr?.message || recallErr);
        return json({ error: recallErr?.message || 'Recall failed' }, 500);
      }
    }

    // Resolve issue + assignee email + reporter email in parallel
    const assigneeEmailToLookup = body.assigneeEmail ? String(body.assigneeEmail) : (body.assignee as any)?.email ?? null;
    const [issue, resolvedAssigneePatch, resolvedReporterPatch] = await Promise.all([
      db.issue.findUnique({ where: { key }, include: { space: { include: { statuses: true } } } }),
      assigneeEmailToLookup
        ? db.user.findFirst({ where: { email: { equals: assigneeEmailToLookup, mode: 'insensitive' } } })
        : Promise.resolve(null),
      body.reporterEmail
        ? db.user.findFirst({ where: { email: { equals: String(body.reporterEmail), mode: 'insensitive' } } })
        : Promise.resolve(null),
    ]);
    if (!issue) return json({ error: 'Not found' }, 404);

    const data: Record<string, unknown> = {};
    if (body.summary !== undefined) data.summary = String(body.summary);
    if (body.description !== undefined) data.description = body.description === null ? null : String(body.description);
    if (body.type !== undefined) data.type = String(body.type);
    if (body.priority !== undefined) data.priority = String(body.priority);
    if (body.labels !== undefined) data.labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
    if (body.parentKey !== undefined) data.parentKey = body.parentKey === null ? null : String(body.parentKey);
    if (body.productType !== undefined) data.productType = body.productType === null ? null : String(body.productType);
    if (body.combination !== undefined) data.combination = body.combination === null ? null : String(body.combination);
    if (body.rootCause !== undefined) data.rootCause = body.rootCause === null ? null : String(body.rootCause);
    if (body.fixDescription !== undefined) data.fixDescription = body.fixDescription === null ? null : String(body.fixDescription);
    if (body.manageClientName !== undefined) data.manageClientName = body.manageClientName === null ? null : String(body.manageClientName);
    if (body.customerPlan !== undefined) data.customerPlan = body.customerPlan === null ? null : String(body.customerPlan);
    if (body.testEnvironment !== undefined) data.testEnvironment = body.testEnvironment === null ? null : String(body.testEnvironment);
    if (body.customerName !== undefined) data.customerName = body.customerName === null ? null : String(body.customerName);
    if (body.clientName !== undefined) data.clientName = body.clientName === null ? null : String(body.clientName);
    if (body.projectManager !== undefined) data.projectManager = body.projectManager === null ? null : String(body.projectManager);

    // Assignee Ã¢â‚¬â€ accept assigneeId, assignee object, or assigneeEmail
    // Assignee -- accept assigneeId, assignee object, or assigneeEmail (email pre-resolved above in parallel)
    if (body.assigneeId !== undefined) {
      data.assigneeId = body.assigneeId === null ? null : String(body.assigneeId);
    } else if (body.assignee === null) {
      data.assigneeId = null;
    } else if (resolvedAssigneePatch) {
      data.assigneeId = resolvedAssigneePatch.id;
    }

    // Reporter -- accept reporterId, reporter object, or reporterEmail
    // (email pre-resolved above in parallel). reporterId lets the UI set a
    // reporter directly from the space member list, same as assigneeId --
    // needed for tickets migrated or created without one ever being picked.
    if (body.reporterId !== undefined) {
      data.reporterId = body.reporterId === null ? null : String(body.reporterId);
    } else if (body.reporter === null) {
      data.reporterId = null;
    } else if (resolvedReporterPatch) {
      data.reporterId = resolvedReporterPatch.id;
    }
    // Custom queue status (qst_...) — stored in dept_statuses, not a real row in
    // the statuses table, so it can't be written to issue.statusId directly.
    // When it represents "done" (the dept is closing/resolving the ticket),
    // also point the issue's real global statusId at a matching done-category
    // status — otherwise every view that reads the global status instead of
    // dept_statuses (My Assigned Tickets, the dashboard's Open/Resolved counts,
    // excludeDone filters) keeps treating the ticket as open forever, even
    // though the department that owns it just closed it.
    let queueStatusSyncedDone = false;
    if (body.queueStatusId) {
      try {
        const qRow = await pool.query(`SELECT current_department, dept_statuses FROM issues WHERE key=$1 LIMIT 1`, [key]);
        const dept: string = qRow.rows[0]?.current_department;
        if (dept) {
          const deptStatuses: Record<string, any> = qRow.rows[0]?.dept_statuses || {};
          const oldQueueStatusName = deptStatuses[dept]?.name || 'Unknown';
          const oldQueueStatusCategory = deptStatuses[dept]?.category || 'todo';
          deptStatuses[dept] = {
            id: String(body.queueStatusId),
            name: String(body.queueStatusName || ''),
            color: String(body.queueStatusColor || '#64748B'),
            category: String(body.queueStatusCategory || 'todo'),
          };
          await pool.query(`UPDATE issues SET dept_statuses=$1::jsonb, "updatedAt"=NOW() WHERE key=$2`, [JSON.stringify(deptStatuses), key]);

          // Reopening -- the dept's OLD status was done (Resolved/Closed/etc.)
          // and the newly picked one isn't. Resuming the SLA clock (not
          // restarting it -- startDeptSLA preserves already-logged elapsed_ms
          // and just marks it running again) is the mirror image of the
          // pause that happens on close; without this, a resolved ticket's
          // SLA stayed paused forever even after being reopened. Also syncs
          // the global statusId to a real not-done status for the same
          // reason the "done" sync below exists: dashboards, "excludeDone"
          // filters, etc. all read the global column, not dept_statuses.
          let queueStatusSyncedReopen = false;
          if (oldQueueStatusCategory === 'done' && String(body.queueStatusCategory || 'todo') !== 'done') {
            try {
              const realStatuses = (issue.space as any)?.statuses || [];
              const queueStName = String(body.queueStatusName || '').trim();
              let matchedReal = realStatuses.find((s: any) => s.category !== 'done' && s.name.toLowerCase() === queueStName.toLowerCase());
              if (!matchedReal && queueStName) {
                const maxOrder = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS m FROM statuses WHERE "spaceId"=$1`, [issue.spaceId]);
                const newRealStatusId = rid();
                await pool.query(
                  `INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES ($1,$2,$3,$4,$5,$6)`,
                  [newRealStatusId, queueStName, String(body.queueStatusCategory || 'todo'), String(body.queueStatusColor || '#64748B'), (maxOrder.rows[0]?.m ?? 0) + 1, issue.spaceId]
                );
                matchedReal = { id: newRealStatusId };
              }
              matchedReal = matchedReal || realStatuses.find((s: any) => s.category !== 'done');
              if (matchedReal) {
                data.statusId = matchedReal.id;
                queueStatusSyncedReopen = true;
              }
              await startDeptSLA(null, issue.id, dept);
              console.log(`[SLA Resume] ${issue.key}: reopened in ${dept}`);
              // This branch (like the "done" sync below) skips the early-return
              // status-history insert further down, and never reaches the
              // generic "Status (resolve names)" history block past this
              // function either (both are gated on body.statusId, which stays
              // undefined for a queue-scoped status) -- write it here instead,
              // same shape as the early-return branch's own status entry.
              const reopenChanger = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
              pool.query(
                `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                [rid(), issue.id, 'status', oldQueueStatusName, String(body.queueStatusName || ''), reopenChanger ? `${reopenChanger.firstName} ${reopenChanger.lastName}`.trim() : 'Unknown', reopenChanger?.email || null]
              ).catch(() => {});
              notifyStatusChanged({
                key: issue.key, summary: issue.summary, priority: issue.priority,
                spaceKey: issue.space?.key ?? '', spaceName: issue.space?.name ?? '',
                oldStatus: { name: oldQueueStatusName, category: 'done' },
                newStatus: { name: String(body.queueStatusName || ''), category: String(body.queueStatusCategory || 'todo') },
                assignee: issue.assignee, reporter: issue.reporter,
                changedBy: reopenChanger,
              }).catch(() => {});
            } catch (e: any) { console.error('[SLA resume on reopen failed]', issue.key, e?.message || e); }
          }

          if (String(body.queueStatusCategory || '') === 'done') {
            const realStatuses = (issue.space as any)?.statuses || [];
            const queueStName = String(body.queueStatusName || '').trim();
            let matchedReal = realStatuses.find((s: any) => s.category === 'done' && s.name.toLowerCase() === queueStName.toLowerCase());
            // No status of this exact name exists yet for the space — falling back
            // to some unrelated done-category status (e.g. a generic "Done") made
            // the list view show a different name than the ticket detail page
            // (which reads dept_statuses and shows the dept's own name, e.g.
            // "Resolved"). Create a real status matching it instead, so both
            // views agree on the name.
            if (!matchedReal && queueStName) {
              const maxOrder = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS m FROM statuses WHERE "spaceId"=$1`, [issue.spaceId]);
              const newStatusId = rid();
              await pool.query(
                `INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES ($1,$2,'done',$3,$4,$5)`,
                [newStatusId, queueStName, String(body.queueStatusColor || '#64748B'), (maxOrder.rows[0]?.m ?? 0) + 1, issue.spaceId]
              );
              matchedReal = { id: newStatusId };
            }
            matchedReal = matchedReal || realStatuses.find((s: any) => s.category === 'done');
            if (matchedReal) {
              data.statusId = matchedReal.id;
              queueStatusSyncedDone = true;
            }
          }

          if (!queueStatusSyncedDone && !queueStatusSyncedReopen) {
            // A queue-scoped "Waiting for X" status (e.g. picked from this
            // dept's own custom-queue status list) means the same thing as a
            // real global status of that name: hand the ticket to dept X, not
            // just relabel it. Without this, picking "Waiting for Dev" from a
            // queue's own dropdown updated the visible status text but left
            // current_department untouched -- the ticket never actually moved.
            let queueHandoffOldDept = '';
            let queueHandoffTargetDept = '';
            let queueHandoffDone = false;
            const waitMatchQueue = String(body.queueStatusName || '').match(/^waiting\s+for\s+(.+)$/i);
            if (waitMatchQueue) {
              queueHandoffTargetDept = waitMatchQueue[1].trim();
              try {
                queueHandoffOldDept = await performDeptHandoff(
                  issue.id, issue.spaceId, (issue as any).productType || null,
                  queueHandoffTargetDept, String(body.queueStatusName || ''), null, userId,
                );
                queueHandoffDone = true;
                console.log(`[DeptHandoff] ${issue.key}: ${queueHandoffOldDept} → ${queueHandoffTargetDept} (via queue status)`);
              } catch (handoffErr: any) {
                console.error(`[DeptHandoff ERROR - queueStatus] ${issue.key}:`, handoffErr?.message || handoffErr);
              }
            }

            // Re-fetch AFTER the handoff (if any) so the response and the
            // notification below reflect the corrected department/status,
            // not the queue-scoped label that was just superseded.
            const refreshed = await db.issue.findUnique({ where: { key }, include: { status: true, assignee: true, reporter: true, space: { select: { key: true, name: true } } } });
            // This path returns early right after updating dept_statuses, so
            // it never reached the "Status changed?" notification block
            // further below (that only fires for a real global statusId
            // change) -- a queue-scoped status like "Waiting for Migration"
            // sent no email to anyone, even though it's exactly the kind of
            // handoff the reporter needs to know about.
            if (refreshed) {
              const changer = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
              // This path returns right after updating dept_statuses, before
              // ever reaching the "Auto-record history for every changed
              // field" block further below -- a queue-scoped status change
              // (picking anything from a queue's own status dropdown that
              // isn't a done-category status) updated what's visibly shown
              // but left no trace at all in the History tab, no matter who
              // changed it or when.
              pool.query(
                `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                [rid(), issue.id, 'status', oldQueueStatusName, String(body.queueStatusName || ''), changer ? `${changer.firstName} ${changer.lastName}`.trim() : 'Unknown', changer?.email || null]
              ).catch(() => {});
              if (queueHandoffDone) {
                pool.query(
                  `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                  [rid(), issue.id, 'department', queueHandoffOldDept || 'None', `Handed to ${queueHandoffTargetDept} — SLA started`, changer ? `${changer.firstName} ${changer.lastName}`.trim() : 'Unknown', changer?.email || null]
                ).catch(() => {});
              }
              notifyStatusChanged({
                key: refreshed.key, summary: refreshed.summary, priority: refreshed.priority,
                spaceKey: refreshed.space?.key ?? '', spaceName: refreshed.space?.name ?? '',
                oldStatus: { name: oldQueueStatusName, category: 'todo' },
                newStatus: { name: String(body.queueStatusName || ''), category: String(body.queueStatusCategory || 'todo') },
                assignee: refreshed.assignee, reporter: refreshed.reporter,
                changedBy: changer,
              }).catch(() => {});
              // current_department/dept_statuses/etc. are raw-SQL columns, not
              // part of the Prisma schema -- db.issue.findUnique above never
              // returns them, so without this merge the response would still
              // show the OLD department even though the handoff already
              // committed it (same merge the "Change Department" endpoint uses).
              let queueExtraCols: any = {};
              try {
                const r = await pool.query(`SELECT current_department, dept_assignees, dept_sla_started_at, dept_statuses, dept_sla_log, cf_key FROM issues WHERE key=$1 LIMIT 1`, [key]);
                if (r.rows[0]) queueExtraCols = r.rows[0];
              } catch {}
              return json(formatIssue({ ...refreshed, ...queueExtraCols }));
            }
          }
          // else: fall through into the normal statusId update path below, so
          // the usual close-time side effects (worked-on recording,
          // notifications, SLA, history) run exactly as for a plain status change.
        }
      } catch (e) { console.error('[queueStatus update failed]', e); }
    }

    // Status
    if (body.statusId !== undefined) {
      data.statusId = body.statusId === null ? null : String(body.statusId);
    }

    data.updatedAt = new Date();

    // When assignee changes, keep dept_assignees[current_dept] in sync
    if (data.assigneeId !== undefined) {
      try {
        const rawIssue = await pool.query(
          `SELECT current_department, dept_assignees FROM issues WHERE key=$1 LIMIT 1`, [key]
        );
        const currentDept = rawIssue.rows[0]?.current_department;
        if (currentDept) {
          const deptAssignees: Record<string, any> = rawIssue.rows[0]?.dept_assignees || {};
          if (data.assigneeId === null) {
            deptAssignees[currentDept] = null;
          } else {
            const newAssignee = await db.user.findUnique({ where: { id: data.assigneeId as string }, select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } });
            if (newAssignee) {
              deptAssignees[currentDept] = { id: newAssignee.id, email: newAssignee.email, firstName: newAssignee.firstName, lastName: newAssignee.lastName, displayName: `${newAssignee.firstName} ${newAssignee.lastName}`.trim(), avatarUrl: avatarRef(newAssignee.id, newAssignee.avatarUrl) };
            }
          }
          await pool.query(`UPDATE issues SET dept_assignees=$1::jsonb WHERE key=$2`, [JSON.stringify(deptAssignees), key]);
        }
      } catch {}
    }

    const updated = await db.issue.update({
      where: { key },
      data: data as any,
      include: {
        status: true,
        assignee: true,
        reporter: true,
        space: { select: { key: true, name: true } },
      },
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Auto-record history for every changed field Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // ── Dept handoff on "Waiting for [Dept]" status change ──────────────
    // Extracted from history try-catch so errors are logged and not silently swallowed.
    let deptHandoffDone = false;
    let handoffTargetDept = '';
    let handoffOldDept = '';
    if (body.statusId !== undefined && issue.statusId !== data.statusId) {
      // A department's "Waiting for X" status can be defined under a different
      // workflow space than the ticket's own (the status dropdown itself loads
      // options from matchedQueue.workflowSpaceKey, not necessarily issue.spaceKey
      // — see loadStatusesForSpace on the issue detail page). Searching only
      // issue.space.statuses missed it whenever the two differed: the status
      // itself still got applied (statusId is a plain column, not space-scoped),
      // but the handoff that's supposed to move current_department right along
      // with it never ran, leaving the ticket showing e.g. "Waiting for
      // Migration" while current_department stayed on the OLD department.
      // Status ids are globally unique, so look this one up directly instead
      // of assuming it lives in the ticket's own space.
      const newStForHandoff = data.statusId
        ? await db.status.findUnique({ where: { id: String(data.statusId) } })
        : null;
      const newStatusNameForHandoff = (newStForHandoff?.name || '').trim();
      const waitMatchHandoff = newStatusNameForHandoff.match(/^waiting\s+for\s+(.+)$/i);
      if (waitMatchHandoff) {
        handoffTargetDept = waitMatchHandoff[1].trim();
        try {
          handoffOldDept = await performDeptHandoff(
            issue.id, issue.spaceId, (issue as any).productType || null,
            handoffTargetDept, newStatusNameForHandoff, data.statusId as string | null, userId,
          );
          deptHandoffDone = true;
          console.log(`[DeptHandoff] ${issue.key}: ${handoffOldDept} → ${handoffTargetDept}`);
        } catch (handoffErr: any) {
          console.error(`[DeptHandoff ERROR] ${issue.key}:`, handoffErr?.message || handoffErr);
        }
      }
    }

    // ── When ticket is closed (status → done), record worked-on for all depts ──
    if ((body.statusId !== undefined || queueStatusSyncedDone) && issue.statusId !== data.statusId && !deptHandoffDone) {
      const newStForClose = (issue.space?.statuses ?? []).find((s: any) => s.id === data.statusId) as any;
      if (newStForClose?.category === 'done') {
        try {
          const closeData = await pool.query(
            `SELECT dept_assignees, current_department FROM issues WHERE id=$1`, [issue.id]
          );
          const savedDeptAssignees: Record<string, any> = closeData.rows[0]?.dept_assignees || {};
          const closingDept: string = closeData.rows[0]?.current_department || '';

          // Pause current dept SLA so elapsed time is finalized
          await pauseDeptSLA(null, issue.id, closingDept, 'SLA resolved');

          // Collect all user→dept pairs to record; use a Map to deduplicate
          const workedOnMap = new Map<string, string>(); // userId → dept

          // 1. Current assignee in closing dept -- only fall back to crediting
          // whoever closed it when there's no real assignee. This used to
          // credit BOTH unconditionally, so whoever clicked resolve (often
          // an admin) got added to their own Worked-on list right alongside
          // the person the ticket was actually assigned to.
          if (issue.assigneeId && closingDept) {
            workedOnMap.set(`${issue.assigneeId}::${closingDept}`, `${issue.assigneeId}|${closingDept}`);
          } else if (userId && closingDept) {
            workedOnMap.set(`${userId}::${closingDept}`, `${userId}|${closingDept}`);
          }

          // 2. Saved assignees from dept_assignees JSONB (assignees at handoff time)
          for (const [dept, assigneeInfo] of Object.entries(savedDeptAssignees)) {
            if (assigneeInfo && (assigneeInfo as any).id) {
              workedOnMap.set(`${(assigneeInfo as any).id}::${dept}`, `${(assigneeInfo as any).id}|${dept}`);
            }
          }

          // 3. moved_by users from issue_dept_transitions -- same fallback
          // rule as above: only credit whoever moved a ticket OUT of a dept
          // when that dept has no real assignee on record (covers a
          // genuinely unassigned handoff); otherwise this double-credited
          // the actual mover for a dept someone else really worked.
          try {
            const transRows = await pool.query(
              `SELECT from_dept, to_dept, moved_by FROM issue_dept_transitions WHERE issue_id=$1 AND moved_by IS NOT NULL`,
              [issue.id]
            );
            for (const t of transRows.rows) {
              if (t.moved_by && t.from_dept && !savedDeptAssignees[t.from_dept]?.id) {
                workedOnMap.set(`${t.moved_by}::${t.from_dept}`, `${t.moved_by}|${t.from_dept}`);
              }
            }
          } catch { /* non-critical */ }

          // Insert all collected worked-on records (user_worked_on_tickets)
          for (const val of workedOnMap.values()) {
            const [uid, dept] = val.split('|');
            if (uid && dept) {
              pool.query(
                `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'closed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='closed', worked_at=NOW()`,
                [uid, issue.id, dept]
              ).catch(() => {});
            }
          }

          // Also insert into queue_closed_tickets for each previous dept so
          // the sidebar "Worked on" (queue=dept_closed) shows the ticket
          const allDepts = new Set([...workedOnMap.values()].map(v => v.split('|')[1]).filter(Boolean));
          if (issue.spaceId) {
            for (const dept of allDepts) {
              pool.query(
                `INSERT INTO queue_closed_tickets (space_id, dept_name, issue_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [issue.spaceId, dept, issue.id]
              ).catch(() => {});
            }
          }

          const deptList = [...allDepts].join(', ');
          console.log(`[TicketClosed] ${issue.key}: worked-on recorded for depts: ${deptList}`);
        } catch (closeErr: any) {
          console.error(`[TicketClosed ERROR] ${issue.key}:`, closeErr?.message || closeErr);
        }
      }
    }

    try {
      const authorName = currentUser
        ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
        : 'Unknown';
      const authorEmail = currentUser?.email ?? null;
      const now = new Date();
      const histRecs: Array<{
        issueId: string; field: string;
        oldValue: string | null; newValue: string | null;
        authorName: string; authorEmail: string | null; createdAt: Date;
      }> = [];

      // Helper to push a record when values differ
      const track = (field: string, oldVal: string | null | undefined, newVal: string | null | undefined) => {
        const o = oldVal ?? null; const n = newVal ?? null;
        if (o !== n) histRecs.push({ issueId: issue.id, field, oldValue: o, newValue: n, authorName, authorEmail, createdAt: now });
      };

      // Simple text / enum fields
      if (body.summary !== undefined)          track('summary',           issue.summary,           data.summary as string);
      if (body.description !== undefined)      track('description',       issue.description,       data.description as string);
      if (body.type !== undefined)             track('issuetype',         issue.type,              data.type as string);
      if (body.priority !== undefined)         track('priority',          issue.priority,          data.priority as string);
      if (body.parentKey !== undefined)        track('parent',            issue.parentKey,         data.parentKey as string);
      if (body.productType !== undefined)      track('product type',      (issue as any).productType,      data.productType as string);
      if (body.combination !== undefined)      track('combination',       (issue as any).combination,      data.combination as string);
      if (body.rootCause !== undefined)        track('root cause',        (issue as any).rootCause,        data.rootCause as string);
      if (body.fixDescription !== undefined)   track('fix description',   (issue as any).fixDescription,   data.fixDescription as string);
      if (body.manageClientName !== undefined) track('manage client name',(issue as any).manageClientName, data.manageClientName as string);
      if (body.customerPlan !== undefined)     track('customer plan',     (issue as any).customerPlan,     data.customerPlan as string);
      if (body.testEnvironment !== undefined)  track('test environment',  (issue as any).testEnvironment,  data.testEnvironment as string);
      if (body.customerName !== undefined)     track('customer name',     (issue as any).customerName,     data.customerName as string);
      if (body.clientName !== undefined)       track('client name',       (issue as any).clientName,       data.clientName as string);
      if (body.projectManager !== undefined)   track('project manager',   (issue as any).projectManager,   data.projectManager as string);

      // Labels (array Ã¢â€ ' comma string)
      if (body.labels !== undefined) {
        const oldL = ((issue.labels ?? []) as string[]).join(', ');
        const newL = ((data.labels ?? []) as string[]).join(', ');
        if (oldL !== newL) histRecs.push({ issueId: issue.id, field: 'labels', oldValue: oldL || null, newValue: newL || null, authorName, authorEmail, createdAt: now });
      }

      // Status (resolve names)
      if (body.statusId !== undefined && issue.statusId !== data.statusId) {
        const statuses = issue.space?.statuses ?? [];
        const oldSt = (statuses as any[]).find((s: any) => s.id === issue.statusId);
        const newSt = (statuses as any[]).find((s: any) => s.id === data.statusId);
        histRecs.push({ issueId: issue.id, field: 'status', oldValue: oldSt?.name ?? null, newValue: newSt?.name ?? null, authorName, authorEmail, createdAt: now });
        // Record dept handoff in history if it ran
        if (deptHandoffDone && handoffOldDept) {
          histRecs.push({ issueId: issue.id, field: 'department', oldValue: handoffOldDept, newValue: `Handed to ${handoffTargetDept} — SLA started`, authorName, authorEmail, createdAt: now });
        }
      }

      // Assignee (resolve display names)
      if (data.assigneeId !== undefined && issue.assigneeId !== data.assigneeId) {
        const oldA = issue.assigneeId ? await db.user.findUnique({ where: { id: issue.assigneeId } }) : null;
        const newA = data.assigneeId ? await db.user.findUnique({ where: { id: data.assigneeId as string } }) : null;
        const oldN = oldA ? (`${oldA.firstName ?? ''} ${oldA.lastName ?? ''}`.trim() || oldA.email) : null;
        const newN = newA ? (`${newA.firstName ?? ''} ${newA.lastName ?? ''}`.trim() || newA.email) : null;
        histRecs.push({ issueId: issue.id, field: 'assignee', oldValue: oldN, newValue: newN, authorName, authorEmail, createdAt: now });
      }

      if (histRecs.length > 0) {
        await (db as any).issueHistory.createMany({ data: histRecs });
      }
    } catch (_e) { /* history tracking should never break the main response */ }
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    // Send notifications (fire-and-forget)
    const spaceKey = updated.space?.key ?? '';
    const spaceName = updated.space?.name ?? '';
    const issueForNotif = {
      key: updated.key, summary: updated.summary, priority: updated.priority,
      spaceKey, spaceName,
      status: { name: updated.status?.name ?? 'Open', category: updated.status?.category ?? 'todo' },
      assignee: updated.assignee, reporter: updated.reporter,
    };

    // Status changed?
    if (body.statusId !== undefined && issue.statusId !== data.statusId) {
      // If status moved to 'done' category, record worked-on for current assignee
      const newStRec = (issue.space?.statuses ?? []).find((s: any) => s.id === data.statusId);
      if (newStRec?.category === 'done' && updated.assigneeId) {
        pool.query(
          `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'closed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='closed', worked_at=NOW()`,
          [updated.assigneeId, issue.id, null]
        ).catch(() => {});
      }

      const oldStatusRec = issue.space?.statuses?.find((s: any) => s.id === issue.statusId);
      const changer = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
      notifyStatusChanged({
        ...issueForNotif,
        oldStatus: { name: oldStatusRec?.name ?? 'Unknown', category: oldStatusRec?.category ?? 'todo' },
        newStatus: issueForNotif.status,
        changedBy: changer,
      }).catch(() => {});
      // In-app: notify assignee + reporter (not the person who changed it)
      await notifyUsers(
        [updated.assigneeId, updated.reporterId],
        userId,
        { type: 'STATUS_CHANGED', title: `${updated.key} status → ${issueForNotif.status.name}`, message: updated.summary, issueKey: updated.key }
      );
      await notifyWatchers(updated.key, userId, { title: `${updated.key} status → ${issueForNotif.status.name}`, message: updated.summary });
    }
    // Assignee changed?
    else if (body.assigneeId !== undefined && issue.assigneeId !== data.assigneeId) {
      const prevAssignee = issue.assigneeId ? await db.user.findUnique({ where: { id: issue.assigneeId } }) : null;
      notifyIssueAssigned({ ...issueForNotif, previousAssignee: prevAssignee }).catch(() => {});
      // In-app: notify new assignee + reporter
      await notifyUsers(
        [updated.assigneeId, updated.reporterId],
        userId,
        { type: 'ASSIGNED', title: `${updated.key} assigned to you`, message: updated.summary, issueKey: updated.key }
      );
    }
    // General update (summary, description, priority, etc.)
    else if (Object.keys(data).some(k => ['summary','description','priority','type','labels'].includes(k))) {
      const changes: Array<{ field: string; from: string; to: string }> = [];
      if (body.summary !== undefined && body.summary !== issue.summary)
        changes.push({ field: 'Summary', from: String(issue.summary), to: String(body.summary) });
      if (body.priority !== undefined && body.priority !== issue.priority)
        changes.push({ field: 'Priority', from: String(issue.priority), to: String(body.priority) });
      if (body.type !== undefined && body.type !== issue.type)
        changes.push({ field: 'Type', from: String(issue.type), to: String(body.type) });
      if (changes.length > 0) {
        notifyIssueUpdated({
          ...issueForNotif,
          updatedBy: userId ? await db.user.findUnique({ where: { id: userId } }) : null,
          changes,
        }).catch(() => {});
        // In-app: notify assignee + reporter + watchers
        await notifyUsers(
          [updated.assigneeId, updated.reporterId],
          userId,
          { type: 'UPDATED', title: `${updated.key} updated`, message: changes.map(c => `${c.field}: ${c.to}`).join(', '), issueKey: updated.key }
        );
        await notifyWatchers(updated.key, userId, { title: `${updated.key} updated`, message: changes.map(c => `${c.field}: ${c.to}`).join(', ') });
      }
    }

    const slaInstances = await computeIssueSLAsFromDb(updated);

    // Fire connector events (fire-and-forget)
    const _issueUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/issues/${updated.key}`;
    const _issueBase = {
      key: updated.key, cf_key: (updated as any).cf_key,
      summary: updated.summary, type: updated.type, priority: updated.priority,
      status: updated.status?.name, spaceKey: updated.space?.key ?? '', spaceName: updated.space?.name,
      assignee: updated.assignee ? `${(updated.assignee as any).firstName} ${(updated.assignee as any).lastName}`.trim() : undefined,
      reporter: updated.reporter ? `${(updated.reporter as any).firstName} ${(updated.reporter as any).lastName}`.trim() : undefined,
      url: _issueUrl,
    };
    if (body.statusId !== undefined && issue.statusId !== data.statusId) {
      const oldSt = (issue.space as any)?.statuses?.find((s: any) => s.id === issue.statusId);
      fireConnectorEvent({ event: 'issue.status_changed', timestamp: new Date().toISOString(), issue: _issueBase,
        change: { field: 'Status', from: oldSt?.name, to: updated.status?.name } }).catch(() => {});
    } else if (body.assigneeId !== undefined && issue.assigneeId !== data.assigneeId) {
      fireConnectorEvent({ event: 'issue.assigned', timestamp: new Date().toISOString(), issue: _issueBase }).catch(() => {});
    } else {
      fireConnectorEvent({ event: 'issue.updated', timestamp: new Date().toISOString(), issue: _issueBase }).catch(() => {});
    }

    return json({ ...formatIssue(updated), sla: slaInstances, customFieldValues: {} });
  }

  if (issueKeyMatch && method === 'DELETE') {
    const rawKey = issueKeyMatch[1].toUpperCase();
    let key = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
    // CF-xxxxx is the cf_key (raw SQL column) Ã¢â‚¬â€ resolve to the Prisma key first
    if (key.startsWith('CF-')) {
      const cfRow = await pool.query(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
      if (cfRow.rows[0]) key = cfRow.rows[0].key;
    }
    const issue = await db.issue.findUnique({
      where: { key },
      include: { assignee: true, reporter: true, space: { select: { key: true, name: true } } },
    });
    if (!issue) return json({ error: 'Not found' }, 404);

    // Before deleting: save emailthreadid to processed_emails so this email is NEVER re-processed
    // even after the ticket is deleted (survives server restarts and re-polls)
    try {
      const emailRow = await pool.query(`SELECT "emailthreadid" FROM issues WHERE key = $1`, [key]);
      const emailThreadId = emailRow.rows[0]?.emailthreadid;
      if (emailThreadId) {
        await pool.query(
          `INSERT INTO processed_emails (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING`,
          [emailThreadId]
        );
        const processedIds: Set<string> = (globalThis as any).__processedMsgIds || new Set();
        processedIds.add(emailThreadId);
        (globalThis as any).__processedMsgIds = processedIds;
      }
    } catch { /* non-critical */ }

    await db.issue.delete({ where: { key } });
    await db.space.update({ where: { id: issue.spaceId }, data: { issueCount: { decrement: 1 } } });

    // Notify
    notifyIssueDeleted({
      key: issue.key, summary: issue.summary,
      spaceKey: issue.space?.key ?? '', spaceName: issue.space?.name ?? '',
      assignee: issue.assignee, reporter: issue.reporter,
      deletedBy: userId ? await db.user.findUnique({ where: { id: userId } }) : null,
    }).catch(() => {});

    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issue Links Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const issueLinksPost = path.match(/^issues\/([^/]+)\/links$/);
  if (issueLinksPost && method === 'POST') {
    const sourceKey = issueLinksPost[1].toUpperCase();
    const body = await readJson(req);
    const targetKey = String(body.targetKey || '').toUpperCase();
    if (!targetKey) return json({ error: 'targetKey required' }, 400);

    // Upsert so duplicate calls are safe
    const link = await db.issueLink.upsert({
      where: { sourceKey_targetKey_linkType: { sourceKey, targetKey, linkType: String(body.linkType || 'relates') } },
      create: { id: rid(), sourceKey, targetKey, linkType: String(body.linkType || 'relates') },
      update: {},
    });
    return json(link);
  }

  const issueLinkDel = path.match(/^issues\/links\/([^/]+)$/);
  if (issueLinkDel && method === 'DELETE') {
    const id = issueLinkDel[1];
    try {
      await db.issueLink.delete({ where: { id } });
    } catch {
      // already deleted
    }
    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issue Comments Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const issueComments = path.match(/^issues\/([^/]+)\/comments$/);
  if (issueComments && method === 'POST') {
    let key = issueComments[1].toUpperCase();
    // Resolve CF-key Ã¢â€ ' Prisma key
    if (key.startsWith('CF-')) {
      const cfRow = await pool.query(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
      if (cfRow.rows[0]) key = cfRow.rows[0].key;
    }
    const issue = await db.issue.findUnique({
      where: { key },
      include: {
        status: true, assignee: true, reporter: true,
        space: { select: { key: true, name: true } },
      },
    });
    if (!issue) return json({ error: 'Not found' }, 404);
    if (!isAdmin && issue.space?.key) {
      try {
        const deptRow = await pool.query(`SELECT current_department FROM issues WHERE id = $1`, [issue.id]);
        const issueDept = deptRow.rows[0]?.current_department;
        if (issueDept && await isUserSuspendedFromQueue(issue.space.key, issueDept, userId)) {
          return json({ error: 'Your access to this queue has been suspended.' }, 403);
        }
      } catch { /* non-critical */ }
    }
    const body = await readJson(req);
    const authorUser = userId ? await getCachedUser(userId) : null;
    // Dedup guard: reject if identical comment from same author exists within last 5 seconds
    const dupCheck = await pool.query(
      `SELECT id FROM comments WHERE "issueId" = $1 AND body = $2 AND "authorId" IS NOT DISTINCT FROM $3 AND "createdAt" > NOW() - INTERVAL '5 seconds' LIMIT 1`,
      [issue.id, String(body.body || ''), authorUser?.id ?? null]
    );
    if (dupCheck.rows.length > 0) return json({ error: 'Duplicate comment', duplicate: true }, 409);
    const comment = await db.comment.create({
      data: {
        id: rid(),
        body: String(body.body || ''),
        issueId: issue.id,
        authorId: authorUser?.id ?? null,
        authorName: authorUser ? `${authorUser.firstName} ${authorUser.lastName}`.trim() : null,
        authorEmail: authorUser?.email ?? null,
      },
      include: { author: true },
    });
    // Update issue updatedAt
    await db.issue.update({ where: { key }, data: { updatedAt: new Date() } });

    // Mirror comment to all partner tickets (only explicitly linked via partnerKey)
    try {
      const issueForPartner = await pool.query(`SELECT "partnerKey" FROM issues WHERE key = $1 LIMIT 1`, [key]);
      const myPartnerKey = (issueForPartner.rows[0]?.partnerKey || '').trim();
      if (myPartnerKey && myPartnerKey !== key) {
        const partnerRowsPost = await pool.query(
          `SELECT id FROM issues WHERE key = $1 AND id != $2`,
          [myPartnerKey, issue.id]
        );
        for (const pr of partnerRowsPost.rows) {
          // Dedup: skip if identical comment from same author already exists within last 10 seconds
          const recentCheck = await pool.query(
            `SELECT id FROM comments WHERE "issueId" = $1 AND body = $2 AND "authorId" IS NOT DISTINCT FROM $3 AND "createdAt" > NOW() - INTERVAL '10 seconds' LIMIT 1`,
            [pr.id, String(body.body || ''), authorUser?.id ?? null]
          );
          if (recentCheck.rows.length > 0) continue;
          await db.comment.create({
            data: {
              id: rid(),
              body: String(body.body || ''),
              issueId: pr.id,
              authorId: authorUser?.id ?? null,
              authorName: authorUser ? `${authorUser.firstName} ${authorUser.lastName}`.trim() : null,
              authorEmail: authorUser?.email ?? null,
            },
          });
        }
      }
    } catch { /* ignore mirror failures */ }
    // Track in history
    try {
      const aName = authorUser ? (`${authorUser.firstName ?? ''} ${authorUser.lastName ?? ''}`.trim() || authorUser.email) : 'Unknown';
      await (db as any).issueHistory.create({ data: { issueId: issue.id, field: 'comment', oldValue: null, newValue: comment.body.slice(0, 500), authorName: aName, authorEmail: authorUser?.email ?? null, createdAt: new Date() } });
    } catch (_e) {}


    // Email: notify assignee + reporter (not the commenter)
    notifyCommentAdded({
      key: issue.key, summary: issue.summary,
      spaceKey: issue.space?.key ?? '', spaceName: issue.space?.name ?? '',
      status: { name: issue.status?.name ?? 'Open', category: issue.status?.category ?? 'todo' },
      assignee: issue.assignee, reporter: issue.reporter,
      comment: {
        body: comment.body,
        author: comment.author ?? (authorUser ? { email: authorUser.email, firstName: authorUser.firstName, lastName: authorUser.lastName } : null),
      },
    }).catch((err: any) => console.error('[Comment Email] Failed to send:', err?.message || err));

    // In-app: notify assignee + reporter + leads/shift leads + watchers (not the commenter)
    const commenterName = authorUser ? `${authorUser.firstName} ${authorUser.lastName}`.trim() : 'Someone';
    // Same entity-decode as mentionPreview below — stripping tags alone leaves
    // literal "&nbsp;"/"&amp;" etc. visible in the plain-text preview.
    const commentBodyPreview = comment.body
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const commentPreview = `${commenterName}: ${commentBodyPreview}`;
    // Fire-and-forget from here down — this used to be awaited inline (lead lookup,
    // notifyUsers, notifyWatchers, then a per-mention user lookup + createNotification),
    // which held the HTTP response open for the whole chain, so the client's "Saving…"
    // button never got a response and looked permanently stuck. Same fix as the
    // department-transfer endpoint's notification block: save the comment and respond
    // immediately, let notifications land in the background.
    (async () => { try {
    const commentLeadIds = await getSpaceLeadUserIds(issue.spaceId);
    await notifyUsers(
      [issue.assigneeId, issue.reporterId, ...commentLeadIds],
      userId,
      { type: 'COMMENTED', title: `New comment on ${issue.key}`, message: commentPreview, issueKey: issue.key }
    );
    await notifyWatchers(issue.key, userId, { title: `New comment on ${issue.key}`, message: commentPreview });

    // Detect @mentions Ã¢â‚¬â€ extract data-userid from mention spans (most reliable)
    // Falls back to regex on plain text for non-rich-text comments
    const mentionedUserIds = new Set<string>();
    // 1. Extract from <span data-userid="..."> HTML mentions
    const dataUserMatches = comment.body.matchAll(/data-userid="([^"]+)"/g);
    for (const m of dataUserMatches) { if (m[1]) mentionedUserIds.add(m[1]); }
    // 2. Fallback: regex on text for plain @name mentions (single word)
    if (mentionedUserIds.size === 0) {
      const textMatches = comment.body.replace(/<[^>]+>/g, '').match(/@([^\s@,]+)/g) || [];
      for (const mention of textMatches) {
        const username = mention.slice(1);
        const found = await db.user.findFirst({
          where: { OR: [{ email: { contains: username, mode: 'insensitive' } }, { firstName: { equals: username, mode: 'insensitive' } }] }
        });
        if (found) mentionedUserIds.add(found.id);
      }
    }
    // Send in-app + email notification to each mentioned user
    // Stripping tags alone leaves entities like the literal "&nbsp;" the rich
    // text editor inserts right after a mention span (to guarantee a following
    // space) sitting in the plain-text preview as visible "&nbsp;" characters.
    // Same decode used for comment previews elsewhere (spaces/[spaceKey]/page.tsx).
    const mentionPreview = comment.body
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    for (const mentionedId of mentionedUserIds) {
      if (mentionedId === userId) continue; // don't notify self
      const mentionedUser = await db.user.findUnique({ where: { id: mentionedId } });
      if (!mentionedUser) continue;
      // In-app notification
      await createNotification({
        userId: mentionedId, type: 'MENTIONED',
        title: `${commenterName} mentioned you in ${issue.key}`,
        message: mentionPreview, issueKey: issue.key,
      });
      // Email notification
      if (mentionedUser.email) {
        notifyMentioned({
          mentionedEmail: mentionedUser.email,
          mentionedName: `${mentionedUser.firstName} ${mentionedUser.lastName}`.trim(),
          mentionedBy: commenterName,
          issueKey: issue.key,
          issueSummary: issue.summary,
          spaceKey: issue.space?.key ?? '',
          spaceName: issue.space?.name ?? '',
          commentPreview,
        }).catch((err: any) => console.error('[Mention Email] Failed:', err?.message));
      }
    }
    } catch (err: any) { console.error('[Comment notifications] Failed:', err?.message || err); } })();

    return json({
      id: comment.id,
      body: comment.body,
      isInternal: false,
      author: comment.author
        ? { id: comment.author.id, firstName: comment.author.firstName, lastName: comment.author.lastName, email: comment.author.email }
        : { id: '', firstName: comment.authorName ?? 'Unknown', lastName: '', email: comment.authorEmail ?? '' },
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Comment Update / Delete Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const commentById = path.match(/^comments\/([^/]+)$/);
  if (commentById) {
    const commentId = commentById[1];
    if (method === 'PATCH') {
      const body = await readJson(req);
      const updated = await db.comment.update({
        where: { id: commentId },
        data: { body: String(body.body || ''), updatedAt: new Date() },
        include: { author: true },
      });
      return json({
        id: updated.id, body: updated.body,
        author: updated.author
          ? { id: updated.author.id, firstName: updated.author.firstName, lastName: updated.author.lastName, email: updated.author.email }
          : { id: '', firstName: updated.authorName ?? 'Unknown', lastName: '', email: updated.authorEmail ?? '' },
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    }
    if (method === 'DELETE') {
      await db.comment.delete({ where: { id: commentId } });
      return json({ ok: true });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Search Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'search' && method === 'POST') {
    const body = await readJson(req);
    const q = String(body.jql || '').trim();
    if (!q) return json({ issues: [], total: 0, page: 1, totalPages: 1 });

    const includeFields = {
      status: true,
      assignee: true,
      reporter: true,
      space: { select: { key: true, name: true } },
    };

    // Step 1: fetch exact + startsWith matches for CF key first (guaranteed to be in results)
    const exactMatches = await db.issue.findMany({
      where: {
        OR: [
          { cf_key: { equals: q, mode: 'insensitive' } },
          { key: { equals: q, mode: 'insensitive' } },
        ],
      },
      include: includeFields,
      take: 5,
    });

    // Typing a ticket number (e.g. "CF-1234") should feel instant -- an exact
    // key match is unambiguous, so return it right away instead of also
    // waiting on startsWith + the full-text `contains` scan across
    // summary/description on every issue in the space, which is the slow
    // part of this endpoint and pointless once the exact ticket is found.
    if (exactMatches.length > 0) {
      return json({ issues: exactMatches.map(formatIssue), total: exactMatches.length, page: 1, totalPages: 1 });
    }

    const startsWithMatches = await db.issue.findMany({
      where: {
        OR: [
          { cf_key: { startsWith: q, mode: 'insensitive' } },
          { key: { startsWith: q, mode: 'insensitive' } },
        ],
      },
      include: includeFields,
      take: 20,
      orderBy: { updatedAt: 'desc' },
    });

    // Step 2: fill remaining slots with general contains results
    const exactIds = new Set([...exactMatches, ...startsWithMatches].map((i: any) => i.id));
    const containsMatches = await db.issue.findMany({
      where: {
        id: { notIn: Array.from(exactIds) as string[] },
        OR: [
          { summary: { contains: q, mode: 'insensitive' } },
          { key: { contains: q, mode: 'insensitive' } },
          { cf_key: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: includeFields,
      take: 30,
      orderBy: { updatedAt: 'desc' },
    });

    // Combine: exact Ã¢â€ ' startsWith Ã¢â€ ' contains, deduplicated
    const seen = new Set<string>();
    const issues: any[] = [];
    for (const issue of [...exactMatches, ...startsWithMatches, ...containsMatches]) {
      if (!seen.has(issue.id)) { seen.add(issue.id); issues.push(issue); }
    }
    const sorted = issues;

    return json({ issues: sorted.slice(0, 20).map(formatIssue), total: issues.length, page: 1, totalPages: 1 });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Reports Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'reports/dashboard' && method === 'GET') {
    const totalIssues = await db.issue.count();
    return json({
      totalIssues,
      byStatus: [],
      byPriority: [],
      byType: [],
      byAssignee: [],
      slaBreaches: 0,
      trend: [],
      recentActivity: [],
    });
  }

  if (path === 'reports/burndown' && method === 'GET') {
    const spaceKey  = url.searchParams.get('spaceKey') || url.searchParams.get('sprintId');
    const dateFrom  = url.searchParams.get('dateFrom');
    const dateTo    = url.searchParams.get('dateTo');
    if (!spaceKey) return json({ totalPoints: 0, dailyProgress: [] });

    const space = await db.space.findFirst({ where: { key: { equals: spaceKey, mode: 'insensitive' } } });
    if (!space) return json({ totalPoints: 0, dailyProgress: [] });

    // When a date range is given, split it into 8 equal segments; otherwise last 8 weeks
    const rangeStart = dateFrom ? new Date(dateFrom) : (() => { const d = new Date(); d.setDate(d.getDate() - 56); return d; })();
    const rangeEnd   = dateTo   ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : new Date();
    const totalMs    = rangeEnd.getTime() - rangeStart.getTime();
    const segMs      = totalMs / 8;

    const weeks: { week: string; open: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const cutoff = new Date(rangeStart.getTime() + segMs * (i + 1));
      const segStart = new Date(rangeStart.getTime() + segMs * i);
      const label = cutoff.toLocaleDateString('en', { month: 'short', day: 'numeric' });
      const open = await db.issue.count({
        where: {
          spaceId: space.id,
          createdAt: { gte: segStart, lte: cutoff },
          status: { category: { not: 'done' } },
        },
      });
      weeks.push({ week: label, open });
    }
    return json({ totalPoints: weeks.reduce((s, w) => s + w.open, 0), dailyProgress: weeks });
  }

  if (path === 'reports/velocity' && method === 'GET') {
    const spaceKey = url.searchParams.get('spaceKey');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo   = url.searchParams.get('dateTo');
    if (!spaceKey) return json([]);

    const space = await db.space.findFirst({ where: { key: { equals: spaceKey, mode: 'insensitive' } } });
    if (!space) return json([]);

    const months: { sprintName: string; committedPoints: number; completedPoints: number }[] = [];

    if (dateFrom || dateTo) {
      // Custom range: split into monthly buckets between the two dates
      const start = dateFrom ? new Date(dateFrom) : new Date(new Date().setMonth(new Date().getMonth() - 5));
      const end   = dateTo   ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : new Date();
      const cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const bucketEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        const label = cur.toLocaleString('default', { month: 'short', year: '2-digit' });
        const [created, resolved] = await Promise.all([
          db.issue.count({ where: { spaceId: space.id, createdAt: { gte: cur, lt: bucketEnd } } }),
          db.issue.count({ where: { spaceId: space.id, status: { category: 'done' }, updatedAt: { gte: cur, lt: bucketEnd } } }),
        ]);
        months.push({ sprintName: label, committedPoints: created, completedPoints: resolved });
        cur.setMonth(cur.getMonth() + 1);
      }
    } else {
      // Default: last 6 months
      const now = new Date();
      for (let m = 5; m >= 0; m--) {
        const bucketStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
        const bucketEnd   = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
        const label = bucketStart.toLocaleString('default', { month: 'short', year: '2-digit' });
        const [created, resolved] = await Promise.all([
          db.issue.count({ where: { spaceId: space.id, createdAt: { gte: bucketStart, lt: bucketEnd } } }),
          db.issue.count({ where: { spaceId: space.id, status: { category: 'done' }, updatedAt: { gte: bucketStart, lt: bucketEnd } } }),
        ]);
        months.push({ sprintName: label, committedPoints: created, completedPoints: resolved });
      }
    }
    return json(months);
  }

  if (path === 'reports/user-performance' && method === 'GET') {
    if (!isAdmin && currentUser?.role !== 'manager') return json({ error: 'Forbidden' }, 403);
    const spaceKey  = url.searchParams.get('spaceKey');
    const dateFrom  = url.searchParams.get('dateFrom');
    const dateTo    = url.searchParams.get('dateTo');

    const dateFilter = (dateFrom || dateTo) ? {
      createdAt: {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo   ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
      }
    } : {};

    // Build space filter
    const spaceFilter = spaceKey
      ? { space: { key: { equals: spaceKey, mode: 'insensitive' as const } } }
      : {};

    // Step 1: get all distinct assigneeIds from issues matching filters (no user-table limit)
    const issueGroups = await (db as any).$queryRawUnsafe(`
      SELECT DISTINCT i."assigneeId"
      FROM issues i
      ${spaceKey ? `JOIN spaces s ON s.id = i."spaceId" AND LOWER(s.key) = LOWER('${spaceKey.replace(/'/g, "''")}')` : ''}
      WHERE i."assigneeId" IS NOT NULL
      ${dateFrom ? `AND i."createdAt" >= '${new Date(dateFrom).toISOString()}'` : ''}
      ${dateTo   ? `AND i."createdAt" <= '${new Date(new Date(dateTo).setHours(23,59,59,999)).toISOString()}'` : ''}
    `);

    const assigneeIds: string[] = (issueGroups as any[]).map((r: any) => r.assigneeId).filter(Boolean);
    if (assigneeIds.length === 0) return json([]);

    // Step 2: load those users (no isActive filter Ã¢â‚¬â€ include everyone who has tickets)
    const users = await db.user.findMany({
      where: { id: { in: assigneeIds } },
      orderBy: { firstName: 'asc' },
    });

    const results = await Promise.all(users.map(async (u) => {
      const [totalAssigned, completed, inProgress, resolvedIssues] = await Promise.all([
        db.issue.count({ where: { assigneeId: u.id, ...spaceFilter, ...dateFilter } }),
        db.issue.count({ where: { assigneeId: u.id, status: { category: 'done' }, ...spaceFilter, ...dateFilter } }),
        db.issue.count({ where: { assigneeId: u.id, status: { category: 'in_progress' }, ...spaceFilter, ...dateFilter } }),
        db.issue.findMany({
          where: { assigneeId: u.id, status: { category: 'done' }, ...spaceFilter, ...dateFilter },
          select: { createdAt: true, updatedAt: true },
          take: 200,
        }),
      ]);

      let avgResolutionHours = 0;
      if (resolvedIssues.length > 0) {
        const total = resolvedIssues.reduce((sum, i) =>
          sum + (new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime()), 0);
        avgResolutionHours = Math.round((total / resolvedIssues.length) / 3_600_000);
      }

      return {
        id: u.id,
        name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email,
        email: u.email,
        role: u.role,
        totalAssigned,
        completed,
        inProgress,
        avgResolutionHours,
        completionRate: totalAssigned > 0 ? Math.round((completed / totalAssigned) * 100) : 0,
      };
    }));

    return json(results);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Workflow Routes (DB-backed) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // GET /workflows?spaceKey=XXX  Ã¢â€ ' return "virtual" workflow for the space
  if (path === 'workflows' && method === 'GET') {
    const sk = url.searchParams.get('spaceKey')?.toUpperCase();
    if (!sk) return json([]);
    const space = await db.space.findUnique({ where: { key: sk } });
    if (!space) return json([]);
    return json([{ id: `wf_${sk.toLowerCase()}`, name: `${space.name} Workflow`, spaceKey: sk }]);
  }

  // GET /workflows/:id/statuses  Ã¢â€ ' real statuses + transitions from DB
  const wfStatuses = path.match(/^workflows\/([^/]+)\/statuses$/);
  if (wfStatuses && method === 'GET') {
    const wfId = wfStatuses[1];
    // wfId = 'wf_psmboard' Ã¢â€ ' spaceKey = 'PSMBOARD'
    const sk = wfId.replace(/^wf_/, '').toUpperCase();
    const space = await db.space.findUnique({ where: { key: sk } });
    if (!space) return json({ statuses: [], transitions: [] });
    const statuses = await db.status.findMany({
      where: { spaceId: space.id },
      orderBy: { order: 'asc' },
    });
    const transitions = await (db as any).workflowTransition.findMany({
      where: { spaceId: space.id },
    });
    return json({ statuses, transitions });
  }

  // POST /workflows/:id/statuses  Ã¢â€ ' add a new status to the space
  if (wfStatuses && method === 'POST') {
    const wfId = wfStatuses[1];
    const sk = wfId.replace(/^wf_/, '').toUpperCase();
    const space = await db.space.findUnique({ where: { key: sk } });
    if (!space) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const maxOrder = await db.status.aggregate({ where: { spaceId: space.id }, _max: { order: true } });
    const st = await db.status.create({
      data: {
        name: String(body.name || 'Status'),
        category: String(body.category || 'todo'),
        color: String(body.color || '#6B7280'),
        order: (maxOrder._max.order ?? -1) + 1,
        spaceId: space.id,
      },
    });
    return json(st);
  }

  // PATCH /workflows/:wfId/statuses/:statusId
  const wfStatusPatch = path.match(/^workflows\/([^/]+)\/statuses\/([^/]+)$/);
  if (wfStatusPatch && method === 'PATCH') {
    const [, , statusId] = wfStatusPatch;
    const body = await readJson(req);
    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.category !== undefined) data.category = body.category;
    if (body.color !== undefined) data.color = body.color;
    const updated = await db.status.update({ where: { id: statusId }, data });
    return json(updated);
  }

  // DELETE /workflows/:wfId/statuses/:statusId
  if (wfStatusPatch && method === 'DELETE') {
    const [, , statusId] = wfStatusPatch;
    // Delete transitions first (cascade not guaranteed for status FK)
    await (db as any).workflowTransition.deleteMany({
      where: { OR: [{ fromStatusId: statusId }, { toStatusId: statusId }] },
    });
    await db.status.delete({ where: { id: statusId } });
    return json({ ok: true });
  }

  // PUT /workflows/:id/statuses/reorder
  const wfReorder = path.match(/^workflows\/([^/]+)\/statuses\/reorder$/);
  if (wfReorder && method === 'PUT') {
    const body = await readJson(req);
    const statusIds: string[] = Array.isArray(body.statusIds) ? body.statusIds : [];
    for (let i = 0; i < statusIds.length; i++) {
      await db.status.update({ where: { id: statusIds[i] }, data: { order: i } });
    }
    return json({ ok: true });
  }

  // POST /workflows/:id/transitions
  const wfTransPost = path.match(/^workflows\/([^/]+)\/transitions$/);
  if (wfTransPost && method === 'POST') {
    const wfId = wfTransPost[1];
    const sk = wfId.replace(/^wf_/, '').toUpperCase();
    const space = await db.space.findUnique({ where: { key: sk } });
    if (!space) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const tr = await (db as any).workflowTransition.upsert({
      where: { spaceId_fromStatusId_toStatusId: { spaceId: space.id, fromStatusId: body.fromStatusId, toStatusId: body.toStatusId } },
      create: { spaceId: space.id, fromStatusId: body.fromStatusId, toStatusId: body.toStatusId, name: body.name || '' },
      update: { name: body.name || '' },
    });
    return json(tr);
  }

  // DELETE /workflows/:id/transitions/:transId
  const wfTransDel = path.match(/^workflows\/([^/]+)\/transitions\/([^/]+)$/);
  if (wfTransDel && method === 'DELETE') {
    const [, , transId] = wfTransDel;
    await (db as any).workflowTransition.delete({ where: { id: transId } });
    return json({ ok: true });
  }

  // POST /workflows/:id/transitions/defaults  Ã¢â€ ' create all Ã¢â€ ' all transitions
  const wfDefaults = path.match(/^workflows\/([^/]+)\/transitions\/defaults$/);
  if (wfDefaults && method === 'POST') {
    const wfId = wfDefaults[1];
    const sk = wfId.replace(/^wf_/, '').toUpperCase();
    const space = await db.space.findUnique({ where: { key: sk } });
    if (!space) return json({ error: 'Not found' }, 404);
    const statuses = await db.status.findMany({ where: { spaceId: space.id } });
    let created = 0;
    for (const from of statuses) {
      for (const to of statuses) {
        if (from.id === to.id) continue;
        try {
          await (db as any).workflowTransition.upsert({
            where: { spaceId_fromStatusId_toStatusId: { spaceId: space.id, fromStatusId: from.id, toStatusId: to.id } },
            create: { spaceId: space.id, fromStatusId: from.id, toStatusId: to.id, name: `→ ${to.name}` },
            update: {},
          });
          created++;
        } catch { /* skip */ }
      }
    }
    return json({ ok: true, created });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ API Tokens Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (path === 'api-tokens' && method === 'GET') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const rows = await pool.query(
      `SELECT id, name, prefix, "createdAt", "lastUsedAt", "expiresAt" FROM api_tokens WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [userId]
    );
    return json(rows.rows);
  }

  if (path === 'api-tokens' && method === 'POST') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'Token name is required' }, 400);
    const token = generateApiToken();
    const tokenHash = hashToken(token);
    const prefix = token.slice(0, 12); // "nta_" + first 8 chars
    const id = rid();
    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    await pool.query(
      `INSERT INTO api_tokens (id, "userId", name, "tokenHash", prefix, "expiresAt") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, userId, name, tokenHash, prefix, expiresAt]
    );
    // Return full token ONCE Ã¢â‚¬â€ it will never be shown again
    return json({ id, name, prefix, token, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: expiresAt?.toISOString() ?? null }, 201);
  }

  const apiTokenDelete = path.match(/^api-tokens\/([^/]+)$/);
  if (apiTokenDelete && method === 'DELETE') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const tokenId = apiTokenDelete[1];
    const existing = await pool.query(
      `SELECT id FROM api_tokens WHERE id = $1 AND "userId" = $2`,
      [tokenId, userId]
    );
    if (!existing.rows.length) return json({ error: 'Token not found' }, 404);
    await pool.query(`DELETE FROM api_tokens WHERE id = $1`, [tokenId]);
    return json({ success: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Worked-on tickets Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // GET /worked-on — tickets the user passed to another dept or closed.
  // Optional dept filter (e.g. ?dept=Migration) scopes to just that queue's
  // hand-off/close events, since a ticket that moved through several
  // departments can show up once per dept it was actually worked in.
  if (path === 'worked-on' && method === 'GET') {
    if (!userId) return json({ issues: [] });
    const targetUserId = url.searchParams.get('userId') || userId;
    const deptFilter = (url.searchParams.get('dept') || '').trim();
    const params: any[] = [targetUserId];
    let deptClause = '';
    if (deptFilter) {
      params.push(deptFilter);
      deptClause = `AND LOWER(w.dept) = LOWER($${params.length})`;
    }
    const rows = await pool.query(
      `SELECT w.issue_id, w.dept, w.reason, w.worked_at,
              i.key, i.summary, i.type, i.priority, i."statusId",
              s.name AS status_name, s.category AS status_category, s.color AS status_color,
              sp.key AS space_key, sp.name AS space_name
       FROM user_worked_on_tickets w
       JOIN issues i ON i.id = w.issue_id
       LEFT JOIN statuses s ON s.id = i."statusId"
       LEFT JOIN spaces sp ON sp.id = i."spaceId"
       WHERE w.user_id = $1 ${deptClause}
       ORDER BY w.worked_at DESC
       LIMIT 100`,
      params
    );
    const issues = rows.rows.map((r: any) => ({
      id: r.issue_id,
      key: r.key,
      summary: r.summary,
      type: r.type,
      priority: r.priority,
      dept: r.dept,
      reason: r.reason,
      workedAt: r.worked_at,
      status: r.status_name ? { id: r.statusId, name: r.status_name, category: r.status_category, color: r.status_color } : null,
      space: { key: r.space_key, name: r.space_name },
    }));
    return json({ issues });
  }

  // GET /my-dashboard — personal analytics, for the logged-in user's own tickets
  // by default. Admins may pass ?userId=<id> to view any other user's dashboard;
  // non-admins requesting another user's id are silently redirected to their own.
  // SLA "running/near-breach/breaching-soon/breached" buckets are not defined
  // anywhere else in the codebase (only a 30-minute pre-breach warning threshold
  // exists, reused here for "breaching soon"); these thresholds are this
  // endpoint's own reasonable defaults, not existing business rules.
  if (path === 'my-dashboard' && method === 'GET') {
    if (!userId) return json({ error: 'Forbidden' }, 403);
    const requestedUserId = url.searchParams.get('userId');
    const targetUserId = (requestedUserId && isAdmin) ? requestedUserId : userId;

    const now = new Date();
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const rangeFrom = fromParam ? new Date(fromParam) : new Date(now.getTime() - 7 * 86_400_000);
    const rangeTo = toParam ? new Date(toParam) : now;

    const [myIssuesRes, allSpacesRes] = await Promise.all([
      pool.query(
        `SELECT i.*, s.name AS status_name, s.category AS status_category, s.color AS status_color
         FROM issues i
         LEFT JOIN statuses s ON s.id = i."statusId"
         WHERE i."assigneeId" = $1`,
        [targetUserId]
      ),
      pool.query(`SELECT id, key FROM spaces`),
    ]);
    const myIssues = myIssuesRes.rows;
    const spaceKeyById: Record<string, string> = Object.fromEntries(allSpacesRes.rows.map((s: any) => [s.id, s.key]));

    const isDone = (r: any) => r.status_category === 'done';
    const isWaiting = (r: any) => /wait|hold/i.test(r.status_name || '');
    const isInProgress = (r: any) => r.status_category === 'in_progress' && !isWaiting(r);
    const isTodo = (r: any) => r.status_category === 'todo' && !isWaiting(r);
    const statusNamesOf = (rows: any[]) => Array.from(new Set(rows.map((r: any) => r.status_name).filter(Boolean)));

    const openIssues = myIssues.filter((r: any) => !isDone(r));
    const inProgressIssues = openIssues.filter(isInProgress);
    const waitingIssues = openIssues.filter(isWaiting);
    const todoIssues = openIssues.filter(isTodo);
    const doneIssues = myIssues.filter(isDone);

    // My tickets by status (all-time, mine) — drives the "by status" donut
    const byStatusMap: Record<string, { count: number; color: string }> = {};
    for (const r of myIssues) {
      const name = r.status_name || 'Unknown';
      if (!byStatusMap[name]) byStatusMap[name] = { count: 0, color: r.status_color || '#94A3B8' };
      byStatusMap[name].count++;
    }
    const byStatus = Object.entries(byStatusMap).map(([name, v]) => ({ name, count: v.count, color: v.color }));

    // My tickets by priority (all-time, mine) — normalize case since priority values
    // are inconsistently cased across migrated data ("Medium" vs "medium").
    const byPriorityMap: Record<string, number> = {};
    for (const r of myIssues) {
      const p = (r.priority || 'medium').toLowerCase();
      byPriorityMap[p] = (byPriorityMap[p] || 0) + 1;
    }
    const byPriority = Object.entries(byPriorityMap).map(([name, count]) => ({ name, count }));

    // My current open tickets by source (original) department — spaceKey included so
    // the frontend can deep-link to that exact board's queue even when two boards
    // happen to share a department name.
    const bySourceDeptMap: Record<string, { dept: string; spaceKey: string | null; count: number }> = {};
    for (const r of openIssues) {
      const dept = r.original_dept || r.current_department || 'Unassigned';
      const spaceKey = spaceKeyById[r.spaceId] || null;
      const bucketKey = `${dept}::${spaceKey}`;
      if (!bySourceDeptMap[bucketKey]) bySourceDeptMap[bucketKey] = { dept, spaceKey, count: 0 };
      bySourceDeptMap[bucketKey].count++;
    }
    const bySourceDept = Object.values(bySourceDeptMap);

    // Ticket journey — open tickets grouped by current department + rough stage
    const journeyMap: Record<string, { dept: string; spaceKey: string | null; total: number; created: number; inProgress: number; waiting: number; completed: number }> = {};
    for (const r of openIssues) {
      const dept = r.current_department || 'Unassigned';
      const spaceKey = spaceKeyById[r.spaceId] || null;
      const bucketKey = `${dept}::${spaceKey}`;
      if (!journeyMap[bucketKey]) journeyMap[bucketKey] = { dept, spaceKey, total: 0, created: 0, inProgress: 0, waiting: 0, completed: 0 };
      const j = journeyMap[bucketKey];
      j.total++;
      if (isWaiting(r)) j.waiting++;
      else if (r.status_category === 'in_progress') j.inProgress++;
      else if (r.status_category === 'done') j.completed++;
      else j.created++;
    }
    const journey = Object.values(journeyMap);

    // SLA: reuse computeIssueSLAsFromDb — the SAME function the issue detail page uses
    // to show its "SLA Breached" state. An earlier version of this endpoint used
    // computePausedDeptSLA instead, which reads dept_sla_log[dept].elapsed_ms as a
    // frozen snapshot from whenever a department was last entered/left — for a ticket
    // that's been sitting in one department for a while, that snapshot never advances,
    // so breaches were silently undercounted here even though the ticket page itself
    // correctly showed them as breached. computeIssueSLAsFromDb instead compares
    // dept_sla_started_at directly against "now" on every call, so it can't go stale.
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    let slaRunning = 0;
    let slaBreachingSoon = 0;
    let slaTrackedCount = 0;
    let slaBreachedCount = 0;
    const slaStatus = { withinSla: 0, nearBreach: 0, breachingSoon: 0, breached: 0 };
    // Batch what computeIssueSLAsFromDb would otherwise fetch once PER ISSUE —
    // for a user with dozens of open tickets (almost always concentrated in
    // a small handful of spaces) that was dozens of sequential round trips
    // for policies that turn out identical within each space, plus one more
    // per issue for its notification flag. Two queries total instead.
    const openSpaceIds = Array.from(new Set(openIssues.map((r: any) => r.spaceId).filter(Boolean)));
    const policiesBySpace: Record<string, any[]> = {};
    if (openSpaceIds.length) {
      const policyRows = await pool.query(
        `SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`,
        [openSpaceIds]
      );
      for (const p of policyRows.rows) {
        (policiesBySpace[p.spaceId] ??= []).push(p);
      }
    }
    const openIssueKeys = openIssues.map((r: any) => r.cf_key || r.key).filter(Boolean);
    const notifiedKeys = new Set<string>();
    if (openIssueKeys.length) {
      try {
        const notifRows = await pool.query(
          `SELECT DISTINCT "issueKey" FROM notifications WHERE "issueKey" = ANY($1::text[]) AND type = 'SLA_BREACH'`,
          [openIssueKeys]
        );
        for (const nr of notifRows.rows) notifiedKeys.add(nr.issueKey);
      } catch { /* notifications table may not have issueKey column */ }
    }
    for (const r of openIssues) {
      const instances = computeSLAInstancesPure(
        { ...r, status: { name: r.status_name, category: r.status_category } },
        policiesBySpace[r.spaceId] || [],
        notifiedKeys.has(r.cf_key || r.key),
      );
      if (!instances.length) continue;
      // Most urgent applicable policy: an already-breached one first, else the soonest due.
      const primary = instances.slice().sort((a: any, b: any) => {
        if (a.isBreached !== b.isBreached) return a.isBreached ? -1 : 1;
        return new Date(a.dueTime).getTime() - new Date(b.dueTime).getTime();
      })[0];
      if (primary.isPaused) continue;
      slaTrackedCount++;
      if (primary.isBreached) {
        slaBreachedCount++;
        slaStatus.breached++;
        continue;
      }
      slaRunning++;
      const remainingMs = new Date(primary.dueTime).getTime() - now.getTime();
      const elapsedMs = now.getTime() - new Date(primary.startedAt).getTime();
      if (remainingMs <= THIRTY_MIN_MS) {
        slaBreachingSoon++;
        slaStatus.breachingSoon++;
      } else if (elapsedMs / primary.goalDurationMs >= 0.75) {
        slaStatus.nearBreach++;
      } else {
        slaStatus.withinSla++;
      }
    }
    const slaCompliancePct = slaTrackedCount > 0
      ? Math.round(((slaTrackedCount - slaBreachedCount) / slaTrackedCount) * 100)
      : 100;

    // Moved to other departments by me (date-ranged) — 'passed' rows, destination
    // recovered from the matching issue_dept_transitions row (closest in time).
    const movedRes = await pool.query(
      `SELECT dt.to_dept AS dept, dt.space_id AS "spaceId", COUNT(*)::int AS cnt
       FROM user_worked_on_tickets w
       JOIN LATERAL (
         SELECT to_dept, space_id FROM issue_dept_transitions dt
         WHERE dt.issue_id = w.issue_id AND dt.from_dept = w.dept
         ORDER BY ABS(EXTRACT(EPOCH FROM (dt.moved_at - w.worked_at))) ASC
         LIMIT 1
       ) dt ON true
       WHERE w.user_id = $1 AND w.reason = 'passed' AND w.worked_at BETWEEN $2 AND $3
       GROUP BY dt.to_dept, dt.space_id
       ORDER BY cnt DESC`,
      [targetUserId, rangeFrom, rangeTo]
    );

    // Received from other departments (date-ranged) — 'returned' rows, source dept.
    // Note: only covers handoffs into a department that already had a saved assignee;
    // a fresh round-robin assignment isn't recorded as a "received" event anywhere.
    const receivedRes = await pool.query(
      `SELECT dt.from_dept AS dept, dt.space_id AS "spaceId", COUNT(*)::int AS cnt
       FROM user_worked_on_tickets w
       JOIN LATERAL (
         SELECT from_dept, space_id FROM issue_dept_transitions dt
         WHERE dt.issue_id = w.issue_id AND dt.to_dept = w.dept
         ORDER BY ABS(EXTRACT(EPOCH FROM (dt.moved_at - w.worked_at))) ASC
         LIMIT 1
       ) dt ON true
       WHERE w.user_id = $1 AND w.reason = 'returned' AND w.worked_at BETWEEN $2 AND $3
       GROUP BY dt.from_dept, dt.space_id
       ORDER BY cnt DESC`,
      [targetUserId, rangeFrom, rangeTo]
    );

    const reportedByMeTotal = await db.issue.count({ where: { reporterId: targetUserId } });

    return json({
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
      viewedUserId: targetUserId,
      cards: {
        myOpenTickets: todoIssues.length,
        inProgress: inProgressIssues.length,
        waitingOrOnHold: waitingIssues.length,
        resolvedByMe: doneIssues.length,
        reportedByMe: reportedByMeTotal,
        slaRunning,
        slaBreachingSoon,
      },
      // Exact status names behind each top-card bucket, so the frontend can deep-link
      // to a Filters view scoped to precisely the tickets counted in that card.
      cardStatuses: {
        myOpenTickets: statusNamesOf(todoIssues),
        inProgress: statusNamesOf(inProgressIssues),
        waitingOrOnHold: statusNamesOf(waitingIssues),
        resolvedByMe: statusNamesOf(doneIssues),
      },
      byStatus,
      byPriority,
      bySourceDept,
      journey,
      slaStatus,
      slaCompliancePct,
      slaTrackedCount,
      movedByMe: movedRes.rows.map((r: any) => ({ dept: r.dept, spaceKey: spaceKeyById[r.spaceId] || null, cnt: r.cnt })),
      receivedByMe: receivedRes.rows.map((r: any) => ({ dept: r.dept, spaceKey: spaceKeyById[r.spaceId] || null, cnt: r.cnt })),
    });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Notifications (DB-backed) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // GET /notifications Ã¢â‚¬â€ list for current user
  if (path === 'notifications' && method === 'GET') {
    if (!userId) return json({ notifications: [], unreadCount: 0 });
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
    const where: any = { userId, ...(unreadOnly ? { isRead: false } : {}) };
    const [notifs, unreadCount] = await Promise.all([
      (db as any).notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      (db as any).notification.count({ where: { userId, isRead: false } }),
    ]);
    return json({ notifications: notifs, unreadCount });
  }

  // PATCH /notifications/:id/read Ã¢â‚¬â€ mark single as read
  const notifReadMatch = path.match(/^notifications\/([^/]+)\/read$/);
  if (notifReadMatch && method === 'PATCH') {
    const id = notifReadMatch[1];
    await (db as any).notification.updateMany({ where: { id, userId }, data: { isRead: true, readAt: new Date() } });
    return json({ ok: true });
  }

  // POST /notifications/read-all Ã¢â‚¬â€ mark all as read for current user
  if (path === 'notifications/read-all' && method === 'POST') {
    if (userId) {
      await (db as any).notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
    }
    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issue Watch / Unwatch Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // POST /issues/:key/watch  Ã¢â‚¬â€ start watching
  const watchMatch = path.match(/^issues\/([^/]+)\/watch$/);
  if (watchMatch && method === 'POST') {
    const key = watchMatch[1].toUpperCase();
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    await (db as any).issueWatch.upsert({
      where: { issueKey_userId: { issueKey: key, userId } },
      create: { issueKey: key, userId },
      update: {},
    });
    return json({ watching: true });
  }

  // DELETE /issues/:key/watch  Ã¢â‚¬â€ stop watching
  const unwatchMatch = path.match(/^issues\/([^/]+)\/watch$/);
  if (unwatchMatch && method === 'DELETE') {
    const key = unwatchMatch[1].toUpperCase();
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    await (db as any).issueWatch.deleteMany({ where: { issueKey: key, userId } });
    return json({ watching: false });
  }

  // GET /issues/:key/watch  Ã¢â‚¬â€ check if watching
  const watchCheckMatch = path.match(/^issues\/([^/]+)\/watch$/);
  if (watchCheckMatch && method === 'GET') {
    const key = watchCheckMatch[1].toUpperCase();
    if (!userId) return json({ watching: false, count: 0 });
    const [watch, count] = await Promise.all([
      (db as any).issueWatch.findUnique({ where: { issueKey_userId: { issueKey: key, userId } } }),
      (db as any).issueWatch.count({ where: { issueKey: key } }),
    ]);
    return json({ watching: !!watch, count });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Notification Preferences Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // GET /notification-preferences  Ã¢â‚¬â€ get current user prefs
  if (path === 'notification-preferences' && method === 'GET') {
    if (!userId) return json(defaultPrefs());
    const prefs = await (db as any).notificationPreference.findUnique({ where: { userId } });
    return json(prefs ?? { ...defaultPrefs(), userId });
  }

  // PATCH /notification-preferences  Ã¢â‚¬â€ update prefs
  if (path === 'notification-preferences' && method === 'PATCH') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const body = await readJson(req);
    const allowed = ['onAssigned','onCommented','onStatusChanged','onMentioned','onWatchedUpdated','onCreated','onUpdated'];
    const data: Record<string, boolean> = {};
    for (const k of allowed) if (typeof body[k] === 'boolean') data[k] = body[k];
    const prefs = await (db as any).notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return json(prefs);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Due Date Reminder Check (manual trigger) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // POST /due-date-check  Ã¢â‚¬â€ check overdue/due-today issues and create notifications
  if (path === 'due-date-check' && method === 'POST') {
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const overdue = await db.issue.findMany({
      where: { dueDate: { lt: now }, assigneeId: { not: null } },
      include: { assignee: true },
      take: 100,
    });
    const dueToday = await db.issue.findMany({
      where: { dueDate: { gte: now, lt: tomorrow }, assigneeId: { not: null } },
      include: { assignee: true },
      take: 100,
    });
    let count = 0;
    for (const issue of overdue) {
      if (!issue.assigneeId) continue;
      const already = await (db as any).notification.findFirst({
        where: { userId: issue.assigneeId, issueKey: issue.key, type: 'DUE_DATE',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (!already) {
        await createNotification({ userId: issue.assigneeId, type: 'DUE_DATE',
          title: `Overdue: ${issue.key}`, message: issue.summary, issueKey: issue.key });
        count++;
      }
    }
    for (const issue of dueToday) {
      if (!issue.assigneeId) continue;
      const already = await (db as any).notification.findFirst({
        where: { userId: issue.assigneeId, issueKey: issue.key, type: 'DUE_DATE',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (!already) {
        await createNotification({ userId: issue.assigneeId, type: 'DUE_DATE',
          title: `Due today: ${issue.key}`, message: issue.summary, issueKey: issue.key });
        count++;
      }
    }
    return json({ sent: count });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ SLA Breach Warning Check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // POST /monitor-agent Ã¢â‚¬â€ combined: SLA breach warnings + duplicate scan on recent tickets
  if (path === 'monitor-agent' && method === 'POST') {
    return json(await runMonitorAgentScan());
  }
  // GET /app-settings Ã¢â‚¬â€ return all key/value app settings
  // PUT /app-settings Ã¢â‚¬â€ upsert a key/value setting
  if (path === 'app-settings') {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`
    );
    if (method === 'GET') {
      const rows = await pool.query(`SELECT key, value FROM app_settings`);
      const settings: Record<string, string> = {};
      for (const r of rows.rows) settings[r.key] = r.value;
      return json(settings);
    }
    if (method === 'PUT') {
      const body = await req.json();
      for (const [key, value] of Object.entries(body)) {
        await pool.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, String(value)]
        );
      }
      return json({ ok: true });
    }
  }

  // GET /migration-reporters -- every distinct reporter with at least one
  // ticket currently sitting in the "Migration" department, across every
  // space, for the Migration Manager's Home dashboard section. This reaches
  // across boards the caller may not otherwise have access to, so it's
  // gated here server-side rather than just hidden in the UI.
  if (path === 'migration-reporters' && method === 'GET') {
    if (!isAdmin && currentUser?.role !== 'migration_manager') {
      return json({ error: 'Forbidden' }, 403);
    }
    const rows = await pool.query(`
      SELECT
        MAX(r.id) AS reporter_id,
        MAX(r."firstName") AS first_name,
        MAX(r."lastName") AS last_name,
        MAX(r.email) AS email,
        MAX(i.jira_reporter_name) AS jira_reporter_name,
        COUNT(*)::int AS ticket_count,
        MAX(i."updatedAt") AS last_activity
      FROM issues i
      LEFT JOIN users r ON r.id = i."reporterId"
      WHERE LOWER(i.current_department) = 'migration'
      GROUP BY COALESCE(r.id, i.jira_reporter_name)
      ORDER BY ticket_count DESC
    `);
    const reporters = rows.rows
      .map((row: any) => ({
        id: row.reporter_id || null,
        name: row.reporter_id
          ? `${row.first_name || ''} ${row.last_name || ''}`.trim()
          : (row.jira_reporter_name || ''),
        email: row.email || null,
        ticketCount: row.ticket_count,
        lastActivity: row.last_activity,
      }))
      .filter((r: any) => r.name);
    return json({ reporters });
  }

  // GET /department-queue?dept=<name> -- find which space's custom queue matches
  // a department name, in one query across every space's custom_queues row,
  // instead of the caller fetching all-space-keys then firing one
  // custom-queues/:spaceKey request PER SPACE to find the same thing (which is
  // what the issue detail page used to do on every single ticket open).
  if (path === 'department-queue' && method === 'GET') {
    const dept = (url.searchParams.get('dept') || '').trim();
    if (!dept) return json({ spaceKey: null, queue: null });
    const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
    for (const row of rows.rows) {
      const queues: any[] = row.queues || [];
      const matched = queues.find((q: any) => (q.name || '').toLowerCase() === dept.toLowerCase());
      if (matched) return json({ spaceKey: row.space_key, queue: matched });
    }
    return json({ spaceKey: null, queue: null });
  }

  // GET /custom-queues/:spaceKey -- load queues from DB
  // PUT /custom-queues/:spaceKey -- save queues to DB
  if (path.startsWith('custom-queues/')) {
    const spaceKey = path.split('/')[1];
    if (method === 'GET') {
      const row = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey]);
      const allQueues: any[] = row.rows[0]?.queues || [];
      // A regular member sees (and can call the API for) only the queues
      // they're explicitly assigned to — admins/managers see every queue.
      // This used to return the full unfiltered list to any caller, relying
      // on the client (Sidebar/board page) to hide the rest; that meant a
      // restricted user's browser could still fetch every other queue's
      // metadata (including their memberIds) and, since nothing server-side
      // gated it, could call the issues API for queues they were never
      // granted access to. Filtering here closes that gap and also means a
      // restricted user's queue switcher has exactly one entry to call.
      const visibleQueues = isAdmin || isManager(currentUser?.role)
        ? allQueues
        : allQueues.filter((q: any) => Array.isArray(q.memberIds) && q.memberIds.includes(userId));
      return json(visibleQueues);
    }
    if (method === 'PUT') {
      const queues = await req.json();
      await pool.query(
        `INSERT INTO custom_queues (space_key, queues, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (space_key) DO UPDATE SET queues = EXCLUDED.queues, updated_at = NOW()`,
        [spaceKey, JSON.stringify(queues)]
      );
      return json({ ok: true });
    }
  }

  // PATCH /custom-queues/:spaceKey/:queueId — replace ONE queue's object within
  // the space's stored array, entirely server-side.
  //
  // The GET above deliberately filters to only the caller's own queues for
  // non-admins/managers (a member of "Dev" gets back just [Dev], not all 10).
  // Two callers (the per-queue settings page and its workflow page) used to
  // GET that list, replace their one queue's entry in it, and PUT the WHOLE
  // thing back — for a plain member acting on their own queue, that GET had
  // already filtered out every other queue, so the PUT permanently deleted
  // them from the space's stored array. This endpoint never round-trips the
  // filtered client view: it reads the full array straight from the DB, finds
  // the one queue by id, and only ever writes that one queue back — no other
  // queue's data ever passes through a permission-filtered response.
  const customQueueItemMatch = path.match(/^custom-queues\/([^/]+)\/([^/]+)$/);
  if (customQueueItemMatch && method === 'PATCH') {
    const spaceKey = customQueueItemMatch[1];
    const queueId = customQueueItemMatch[2];
    const row = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey]);
    const allQueues: any[] = row.rows[0]?.queues || [];
    const target = allQueues.find((q: any) => q.id === queueId);
    if (!target) return json({ error: 'Queue not found' }, 404);
    const isMemberOfQueue = Array.isArray(target.memberIds) && !!userId && target.memberIds.includes(userId);
    if (!isAdmin && !isManager(currentUser?.role) && !isMemberOfQueue) {
      return json({ error: 'You do not have access to this queue.' }, 403);
    }
    const updated = await req.json();
    const nextQueues = allQueues.map((q: any) => q.id === queueId ? updated : q);
    await pool.query(
      `INSERT INTO custom_queues (space_key, queues, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (space_key) DO UPDATE SET queues = EXCLUDED.queues, updated_at = NOW()`,
      [spaceKey, JSON.stringify(nextQueues)]
    );
    return json({ ok: true, queue: updated });
  }

  // POST /sla-breach-check Ã¢â‚¬â€ notify assignee, reporter, leads/shift leads 30 min before breach
  if (path === 'sla-breach-check' && method === 'POST') {
    const notified = await runSlaBreachCheck();
    return json({ notified });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ SLA routes Ã¢â‚¬â€ persisted to PostgreSQL via raw pg (avoids Prisma cache issues) Ã¢â€â‚¬
  const slaListMatch = path.match(/^sla\/([^/]+)$/);
  if (slaListMatch) {
    const spKey = slaListMatch[1].toUpperCase();
    try {
      const spRow = await pool.query(`SELECT id FROM spaces WHERE key = $1 LIMIT 1`, [spKey]);
      if (!spRow.rows[0]) return json({ error: 'Space not found' }, 404);
      const spaceId = spRow.rows[0].id;

      if (method === 'GET') {
        const deptFilter = url.searchParams.get('dept');
        const rows = deptFilter
          ? await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND dept_name = $2 ORDER BY "createdAt" ASC`, [spaceId, deptFilter])
          : await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = $1 ORDER BY "createdAt" ASC`, [spaceId]);
        return json(rows.rows);
      }

      if (method === 'POST') {
        const body = await readJson(req);
        const id = rid();
        const result = await pool.query(
          `INSERT INTO sla_definitions (id, "spaceId", name, status, "startCondition", "pauseStatuses", "stopCondition", goals, dept_name, "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,NOW(),NOW()) RETURNING *`,
          [
            id, spaceId,
            String(body.name || 'New SLA'),
            String(body.status || 'active'),
            body.startCondition ? String(body.startCondition) : null,
            JSON.stringify(Array.isArray(body.pauseStatuses) ? body.pauseStatuses : []),
            body.stopCondition ? String(body.stopCondition) : null,
            JSON.stringify(Array.isArray(body.goals) ? body.goals : []),
            body.dept_name ? String(body.dept_name) : null,
          ]
        );
        return json(result.rows[0]);
      }
    } catch (e) {
      console.error('[SLA] Error:', e);
      return json({ error: 'SLA operation failed' }, 500);
    }
  }

  const slaItemMatch = path.match(/^sla\/([^/]+)\/([^/]+)$/);
  if (slaItemMatch) {
    const slaId = slaItemMatch[2];
    try {
      if (method === 'PATCH') {
        const body = await readJson(req);
        const sets: string[] = ['"updatedAt"=NOW()'];
        const vals: any[] = [];
        let idx = 1;
        if (body.name           !== undefined) { sets.push(`name=$${idx++}`);                vals.push(String(body.name)); }
        if (body.status         !== undefined) { sets.push(`status=$${idx++}`);              vals.push(String(body.status)); }
        if (body.startCondition !== undefined) { sets.push(`"startCondition"=$${idx++}`);   vals.push(body.startCondition ? String(body.startCondition) : null); }
        if (body.pauseStatuses  !== undefined) { sets.push(`"pauseStatuses"=$${idx++}::jsonb`); vals.push(JSON.stringify(Array.isArray(body.pauseStatuses) ? body.pauseStatuses : [])); }
        if (body.stopCondition  !== undefined) { sets.push(`"stopCondition"=$${idx++}`);    vals.push(body.stopCondition ? String(body.stopCondition) : null); }
        if (body.goals          !== undefined) { sets.push(`goals=$${idx++}::jsonb`);       vals.push(JSON.stringify(Array.isArray(body.goals) ? body.goals : [])); }
        if (body.dept_name      !== undefined) { sets.push(`dept_name=$${idx++}`);          vals.push(body.dept_name ? String(body.dept_name) : null); }
        vals.push(slaId);
        const result = await pool.query(
          `UPDATE sla_definitions SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`, vals
        );
        return json(result.rows[0] || { id: slaId, ok: true });
      }

      if (method === 'DELETE') {
        await pool.query(`DELETE FROM sla_definitions WHERE id=$1`, [slaId]);
        return json({ ok: true });
      }
    } catch (e) {
      console.error('[SLA] Error:', e);
      return json({ error: 'SLA operation failed' }, 500);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Connectors Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  if (path === 'connectors' && method === 'GET') {
    const rows = await listConnectors();
    return json(rows);
  }
  if (path === 'connectors' && method === 'POST') {
    const body = await readJson(req);
    const connector = await createConnector({
      name: String(body.name || 'Untitled'),
      type: body.type || 'webhook',
      config: body.config || {},
      events: Array.isArray(body.events) ? body.events : [],
      space_ids: Array.isArray(body.space_ids) ? body.space_ids : [],
      enabled: body.enabled !== false,
    });
    return json(connector);
  }
  const connectorMatch = path.match(/^connectors\/([^/]+)$/);
  if (connectorMatch) {
    const connId = connectorMatch[1];
    if (method === 'GET') {
      const c = await getConnector(connId);
      return c ? json(c) : json({ error: 'Not found' }, 404);
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      const updated = await updateConnector(connId, body);
      return updated ? json(updated) : json({ error: 'Not found' }, 404);
    }
    if (method === 'DELETE') {
      await deleteConnector(connId);
      return json({ ok: true });
    }
  }
  // Connector test endpoint
  const connectorTestMatch = path.match(/^connectors\/([^/]+)\/test$/);
  if (connectorTestMatch && method === 'POST') {
    const connId = connectorTestMatch[1];
    const c = await getConnector(connId);
    if (!c) return json({ error: 'Not found' }, 404);
    const baseUrl = req.headers.get('origin') || 'http://localhost:3000';
    const testPayload = {
      event: 'issue.created' as const,
      timestamp: new Date().toISOString(),
      issue: {
        key: 'TEST-1',
        summary: 'Test connector event from Neutara',
        type: 'task',
        priority: 'medium',
        status: 'Open',
        assignee: 'Test User',
        reporter: 'Admin',
        spaceKey: 'TEST',
        spaceName: 'Test Space',
        url: `${baseUrl}/issues/TEST-1`,
      },
    };
    try {
      await fireConnectorEvent(testPayload);
      return json({ ok: true, message: 'Test event sent' });
    } catch (e: any) {
      return json({ ok: false, error: e?.message }, 500);
    }
  }
  // Connector logs
  const connectorLogsMatch = path.match(/^connectors\/([^/]+)\/logs$/);
  if (connectorLogsMatch && method === 'GET') {
    const connId = connectorLogsMatch[1];
    const logs = await getConnectorLogs(connId, 50);
    return json(logs);
  }

  // Attachments: POST /issues/{issueKey}/attachments  GET /issues/{issueKey}/attachments
  const attachMatch = path.match(/^issues\/([^/]+)\/attachments$/);
  if (attachMatch) {
    const issueKey = attachMatch[1].toUpperCase();
    if (method === 'POST') {
      try {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        if (!file) return json({ error: 'No file provided' }, 400);
        // Same cap as /api/uploads (used by the description/comment editor) —
        // this endpoint had no size check at all, so a ticket's dedicated
        // Attachments section enforced a different (unlimited) limit than
        // everywhere else attachments get uploaded from.
        const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;
        if (file.size > MAX_ATTACHMENT_BYTES) return json({ error: 'File too large (max 10GB)' }, 413);
        const issueRow = await pool.query(`SELECT id FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`, [issueKey]);
        if (!issueRow.rows[0]) return json({ error: 'Issue not found' }, 404);
        const issueId = issueRow.rows[0].id;
        const { writeFile, mkdir } = await import('fs/promises');
        const { join, extname } = await import('path');
        const uploadDir = join(process.cwd(), 'public', 'uploads');
        await mkdir(uploadDir, { recursive: true });
        const ext = extname(file.name) || '';
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const filePath = join(uploadDir, uniqueName);
        const buffer = Buffer.from(await file.arrayBuffer());
        await writeFile(filePath, buffer);
        const url = `/uploads/${uniqueName}`;
        const att = await (db as any).attachment.create({
          data: { issueId, filename: file.name, url, mimeType: file.type || null, size: file.size || null },
        });
        return json({ id: att.id, url: att.url, originalName: att.filename, mimeType: att.mimeType, size: att.size, createdAt: att.createdAt });
      } catch (e: any) {
        console.error('[attachments] upload error:', e);
        return json({ error: 'Upload failed', detail: e?.message }, 500);
      }
    }
    if (method === 'GET') {
      try {
        const issueRow = await pool.query(`SELECT id FROM issues WHERE key = $1 OR cf_key = $1 LIMIT 1`, [issueKey]);
        if (!issueRow.rows[0]) return json([]);
        const atts = await (db as any).attachment.findMany({ where: { issueId: issueRow.rows[0].id }, orderBy: { createdAt: 'asc' } });
        return json(atts.map((a: any) => ({ id: a.id, url: a.url, originalName: a.filename, mimeType: a.mimeType, size: a.size, createdAt: a.createdAt })));
      } catch { return json([]); }
    }
  }


  // ── email-addresses/:spaceKey  ─────────────────────────────────────────────
  const emailAddrList = path.match(/^email-addresses\/([^/]+)$/);
  if (emailAddrList) {
    const sk = emailAddrList[1].toUpperCase();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_configs (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        space_key TEXT NOT NULL, address TEXT NOT NULL,
        imap_host TEXT NOT NULL DEFAULT 'outlook.office365.com', imap_port INT NOT NULL DEFAULT 993,
        smtp_host TEXT NOT NULL DEFAULT 'smtp.office365.com',   smtp_port INT NOT NULL DEFAULT 587,
        password_enc TEXT, auto_reply BOOLEAN DEFAULT true,
        auto_reply_text TEXT, department TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(space_key, address)
      )
    `);
    if (method === 'GET') {
      const rows = await pool.query(
        `SELECT id, address, imap_host, smtp_host, auto_reply, department, created_at FROM email_configs WHERE space_key = $1 ORDER BY created_at`,
        [sk]
      );
      return json(rows.rows.map((r: any) => ({
        id: r.id, address: r.address,
        imapHost: r.imap_host, smtpHost: r.smtp_host,
        autoReply: r.auto_reply, department: r.department,
        requestType: 'Emailed request',
        createdAt: r.created_at,
      })));
    }

    if (method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const addr = (body.address || '').toLowerCase().trim();
      if (!addr) return json({ error: 'address required' }, 400);
      const res = await pool.query(
        `INSERT INTO email_configs (space_key, address, department)
         VALUES ($1,$2,$3)
         ON CONFLICT (space_key, address) DO UPDATE SET department=EXCLUDED.department
         RETURNING id, address, department`,
        [sk, addr, body.department || null]
      );
      return json({ id: res.rows[0].id, address: res.rows[0].address, department: res.rows[0].department, requestType: 'Emailed request' });
    }
  }

  const emailAddrItem = path.match(/^email-addresses\/([^/]+)\/([^/]+)$/);
  if (emailAddrItem) {
    const sk = emailAddrItem[1].toUpperCase();
    const id = emailAddrItem[2];

    if (method === 'PATCH') {
      const body = await req.json().catch(() => ({}));
      const updates: string[] = [];
      const params: any[] = [];
      if ('department' in body)  { params.push(body.department ?? null); updates.push(`department=$${params.length}`); }
      if ('autoReply' in body)   { params.push(body.autoReply);          updates.push(`auto_reply=$${params.length}`); }
      if (updates.length === 0)  return json({ ok: true });
      params.push(id);
      await pool.query(`UPDATE email_configs SET ${updates.join(',')} WHERE id=$${params.length}`, params);
      const row = await pool.query(`SELECT id, address, auto_reply, department FROM email_configs WHERE id=$1`, [id]);
      return json(row.rows[0] ? { id: row.rows[0].id, address: row.rows[0].address, department: row.rows[0].department, requestType: 'Emailed request' } : { ok: true });
    }

    if (method === 'DELETE') {
      const row = await pool.query(`SELECT address FROM email_configs WHERE id=$1`, [id]);
      if (row.rows[0]) {
        await pool.query(`DELETE FROM email_configs WHERE id=$1`, [id]);
        try {
          const { stopImapPollerForEmail } = await import('@/lib/email-service');
          stopImapPollerForEmail(row.rows[0].address);
        } catch {}
      }
      return json({ ok: true });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ All other routes Ã¢â€ ' delegate to in-memory mock Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // (sprints, labels, automation, filters, custom-fields, email, etc.)
  return handleJiraDevMock(req, segments, method);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: resolve user IDs from a list of email/name/id strings Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async function resolveUserIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];

  // First try direct DB id lookup
  const byId = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const foundIds = new Set(byId.map((u) => u.id));

  // Remaining: try email lookup
  const remaining = ids.filter((id) => !foundIds.has(id));
  if (remaining.length) {
    const byEmail = await db.user.findMany({
      where: { OR: remaining.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })) },
      select: { id: true },
    });
    byEmail.forEach((u) => foundIds.add(u.id));
  }

  // Any still unresolved: try name lookup (firstName + lastName)
  const stillMissing = ids.filter(
    (id) => !foundIds.has(id) && !ids.some((i) => i.toLowerCase() === id.toLowerCase()),
  );
  if (stillMissing.length) {
    // Try full name: "John Doe"
    for (const name of stillMissing) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        const users = await db.user.findMany({
          where: {
            firstName: { equals: parts[0], mode: 'insensitive' },
            lastName: { equals: parts.slice(1).join(' '), mode: 'insensitive' },
          },
          select: { id: true },
        });
        users.forEach((u) => foundIds.add(u.id));
      }
    }
  }

  return Array.from(foundIds);
}
