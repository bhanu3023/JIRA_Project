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
import { INTERNAL_JOB_SECRET } from '@/lib/internal-job-secret';

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
// deploy.sh never runs `prisma migrate deploy` (only `prisma generate` in the
// Docker build), so a column added only via a Prisma migration file never
// actually lands on the production table -- mirror it here so it reaches
// prod on the next deploy regardless.
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS "productionTicket" TEXT`).catch(() => {});
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3)`).catch(() => {});

// Deleted-ticket trash: DELETE /issues/:key used to be a genuine hard
// delete with no way to get a ticket back -- a production ticket got
// deleted and there was nothing to recover it from. Rather than turn
// every single existing issue-listing query in this file into a
// "WHERE deletedAt IS NULL" filter (this file has dozens of raw-SQL reads
// against `issues`, and missing even one would leak a "deleted" ticket
// back into a live view), deletion instead snapshots the full issue
// (including comments/attachments/history, which cascade-delete with it)
// into this table before the real delete, and restoring re-inserts from
// that snapshot. Every other existing query is untouched and can't
// possibly see a deleted ticket, since it's genuinely gone from `issues`
// until restored.
pool.query(`CREATE TABLE IF NOT EXISTS deleted_issues (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  cf_key TEXT,
  space_key TEXT,
  summary TEXT,
  data JSONB NOT NULL,
  deleted_by_id TEXT,
  deleted_by_name TEXT,
  deleted_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(() => {});

// Jira's admin User Management shows when each user was last active. Update
// at most once every 5 minutes per user (an in-memory throttle, not a DB
// read-then-write) so this doesn't turn every single authenticated request
// into an extra write.
const _lastSeenThrottle = new Map<string, number>();
function touchLastSeen(userId: string | null) {
  if (!userId) return;
  const now = Date.now();
  const last = _lastSeenThrottle.get(userId) || 0;
  if (now - last < 5 * 60 * 1000) return;
  _lastSeenThrottle.set(userId, now);
  pool.query(`UPDATE users SET "lastSeenAt" = NOW() WHERE id = $1`, [userId]).catch(() => {});
}
// POST /search's exact-match branch looks up an issue's subtasks by
// parentKey (added alongside its linked-work-items lookup) -- that column
// had no index at all, so on a large production issues table every search
// hit for an exact ticket number/key triggered a full table scan just to
// find its subtasks, not something the smaller local dataset this was
// built and tested against ever surfaced.
pool.query(`CREATE INDEX IF NOT EXISTS idx_issues_parentkey ON issues("parentKey")`).catch(() => {});
// User invite status: 'invited' | 'active' | 'inactive'
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`).catch(() => {});
// Backfill: invited users (isActive=false, no prior login) stay 'invited'; active users get 'active'
pool.query(`UPDATE users SET status='active' WHERE status IS NULL OR status='' OR (status='active' AND "isActive"=true)`).catch(() => {});
pool.query(`UPDATE users SET status='inactive' WHERE "isActive"=false AND status='active'`).catch(() => {});
pool.query(`WITH first_dept AS (SELECT DISTINCT ON (issue_id) issue_id, from_dept FROM issue_dept_transitions WHERE from_dept != '' ORDER BY issue_id, moved_at ASC) UPDATE issues i SET original_dept = COALESCE((SELECT fd.from_dept FROM first_dept fd WHERE fd.issue_id = i.id), i.current_department) WHERE i.original_dept IS NULL`).catch(() => {});
// Backfill: existing notification rows created before every call site was
// fixed to use cf_key still show the internal key (e.g. "L1BOAR-15259") in
// their title/message/issueKey -- new notifications are correct going
// forward, but this one-time pass corrects what's already stored. Runs
// every startup but is a no-op once caught up (the WHERE clause only
// matches rows still on the internal key).
pool.query(`
  UPDATE notifications n
  SET "issueKey" = i.cf_key,
      title = REPLACE(n.title, n."issueKey", i.cf_key),
      message = CASE WHEN n.message IS NOT NULL THEN REPLACE(n.message, n."issueKey", i.cf_key) ELSE n.message END
  FROM issues i
  WHERE i.key = n."issueKey" AND i.cf_key IS NOT NULL AND i.cf_key <> '' AND n."issueKey" IS DISTINCT FROM i.cf_key
`).catch(() => {});

// One-time correction for the "Time to resolution" SLA policy: it was
// created pointing at a spaceId that doesn't match any real space in this
// database, so it silently never applied to a single real ticket. The user
// confirmed the real per-priority hours from the live Jira instance's Dev
// queue (L2B/L3B) -- repoint it at the real space (TESTIN) and scope it to
// Dev specifically, since Migration/QA/etc. have their own separate SLA
// policies and there's no confirmed evidence their "Time to resolution"
// targets are the same numbers. Guarded on dept_name IS NULL so this is a
// no-op once applied (an admin could since retarget/rename it deliberately).
pool.query(`
  UPDATE sla_definitions
  SET "spaceId" = 'pg_92q07qtnlz',
      dept_name = 'Dev',
      goals = '[
        {"id":"1780317563879_g","jql":"type in (Task, Bug)","calendar":"24/7 Calendar (Default)","timeUnit":"hours","timeValue":"","isPriorityGroup":true,
         "priorityRows":[
           {"calendar":"24/7 Calendar (Default)","priority":"highest","timeUnit":"hours","timeValue":"6"},
           {"calendar":"24/7 Calendar (Default)","priority":"high","timeUnit":"hours","timeValue":"8"},
           {"calendar":"24/7 Calendar (Default)","priority":"medium","timeUnit":"hours","timeValue":"24"},
           {"calendar":"24/7 Calendar (Default)","priority":"low","timeUnit":"hours","timeValue":"48"},
           {"calendar":"24/7 Calendar (Default)","priority":"lowest","timeUnit":"hours","timeValue":"48"}
         ]},
        {"id":"1780317563879_g2","jql":"All remaining work items","calendar":"24/7 Calendar (Default)","timeUnit":"hours","timeValue":"80","isPriorityGroup":false}
      ]'::jsonb,
      "updatedAt" = NOW()
  WHERE id = 'pg_athlc8237e' AND dept_name IS NULL
`).catch(() => {});

// One-time correction of jira_sla_breached for Dev (L2B/L3B) and Migration
// (L1BOARD, matched via jira_source_key -> the real CFITS project) tickets,
// reconciled directly against the real Jira Cloud instance. Two different
// custom fields turned out to carry this per project -- customfield_10917
// ("SLA Breached", the field Dev/L2B/L3B mostly uses) and customfield_10849
// ("Resolution SLA Breach", the field Migration/CFITS mostly uses) -- and
// neither is exclusive to one department, so both were checked together
// (breached if EITHER field says "Yes") across every ticket in both
// departments rather than assuming a fixed field-per-department split.
// This list is exactly the set of issue ids confirmed via that live fetch
// to be "Yes" in real Jira; guarded to only ever SET true (never flips a
// genuinely-correct false), so it's safe to run again.
const JIRA_CONFIRMED_BREACHED_ISSUE_IDS: string[] = require('./jira-sla-breach-backfill-ids.json');
pool.query(
  `UPDATE issues SET jira_sla_breached = true WHERE id = ANY($1::text[]) AND jira_sla_breached IS DISTINCT FROM true`,
  [JIRA_CONFIRMED_BREACHED_ISSUE_IDS]
).catch(() => {});

// One-time cleanup: every space had multiple separate "To Do" status ROWS
// (e.g. status_to_do, status_qa_todo, and a bare-UUID one all named "To Do"
// in the same space) alongside a single "Open" status -- almost certainly
// accidental duplicates from re-running setup/import at different times
// rather than an intentional per-queue distinction, since tickets on them
// were scattered across departments with no clean pattern. Requested fix:
// no ticket should ever show "To Do" -- new tickets, and any already
// sitting on one of these duplicates, should read "Open" instead.
// Retargets in order (issues, then workflow transitions, then the status
// rows themselves) so nothing is left dangling: WorkflowTransition's FK to
// Status cascades on delete, so a transition still pointing at a "To Do"
// row when it's dropped would silently vanish instead of continuing to
// work from "Open". The NOT EXISTS guards avoid the unique
// (spaceId, fromStatusId, toStatusId) constraint when Open already has an
// equivalent transition. Matches by name, not hardcoded ids, so it applies
// per-space generically and is a no-op once there's no "To Do" left to fix.
pool.query(`
  DO $$
  DECLARE
    rec RECORD;
    open_id TEXT;
  BEGIN
    FOR rec IN SELECT DISTINCT "spaceId" FROM statuses WHERE LOWER(name) = 'to do' LOOP
      SELECT id INTO open_id FROM statuses WHERE "spaceId" = rec."spaceId" AND LOWER(name) = 'open' ORDER BY id LIMIT 1;
      IF open_id IS NOT NULL THEN
        UPDATE issues SET "statusId" = open_id
          WHERE "statusId" IN (SELECT id FROM statuses WHERE "spaceId" = rec."spaceId" AND LOWER(name) = 'to do');

        UPDATE workflow_transitions wt SET "fromStatusId" = open_id
          WHERE wt."spaceId" = rec."spaceId"
            AND wt."fromStatusId" IN (SELECT id FROM statuses WHERE "spaceId" = rec."spaceId" AND LOWER(name) = 'to do')
            AND NOT EXISTS (
              SELECT 1 FROM workflow_transitions wt2
              WHERE wt2."spaceId" = wt."spaceId" AND wt2."fromStatusId" = open_id AND wt2."toStatusId" = wt."toStatusId"
            );

        UPDATE workflow_transitions wt SET "toStatusId" = open_id
          WHERE wt."spaceId" = rec."spaceId"
            AND wt."toStatusId" IN (SELECT id FROM statuses WHERE "spaceId" = rec."spaceId" AND LOWER(name) = 'to do')
            AND NOT EXISTS (
              SELECT 1 FROM workflow_transitions wt2
              WHERE wt2."spaceId" = wt."spaceId" AND wt2."toStatusId" = open_id AND wt2."fromStatusId" = wt."fromStatusId"
            );

        DELETE FROM statuses WHERE "spaceId" = rec."spaceId" AND LOWER(name) = 'to do';
      END IF;
    END LOOP;
  END $$;
`).catch(() => {});

// Same "To Do" cleanup as above, but for the handful of tickets carrying a
// "To Do" entry inside their OWN dept_statuses snapshot (the per-department
// status memory restored when a ticket returns to a queue it left) --
// display code that reads this snapshot (getEffectiveIssueStatus and the
// dept-scoped issue list) still showed "To Do" on those specific tickets
// even after the shared statuses rows above were removed, since this is a
// separate per-ticket JSONB copy, not a foreign key into the statuses
// table. dept_statuses is keyed by arbitrary department name (not a fixed
// column), so this has to walk each affected row's keys in JS rather than
// a single SQL statement; resolves each ticket's own space's real "Open"
// status rather than hardcoding one id, so it stays correct if a
// different space's "Open" status has a different id/color.
(async () => {
  try {
    const affected = await pool.query(`SELECT id, "spaceId", dept_statuses FROM issues WHERE dept_statuses::text ILIKE '%"To Do"%'`);
    const openBySpace: Record<string, { id: string; name: string; color: string; category: string } | null> = {};
    for (const row of affected.rows) {
      if (!(row.spaceId in openBySpace)) {
        const os = await pool.query(`SELECT id, name, color, category FROM statuses WHERE "spaceId" = $1 AND LOWER(name) = 'open' ORDER BY id LIMIT 1`, [row.spaceId]);
        openBySpace[row.spaceId] = os.rows[0] || null;
      }
      const openStatus = openBySpace[row.spaceId];
      if (!openStatus) continue;
      const deptStatuses: Record<string, any> = row.dept_statuses || {};
      let changed = false;
      for (const dept of Object.keys(deptStatuses)) {
        if (deptStatuses[dept]?.name === 'To Do') {
          deptStatuses[dept] = { id: openStatus.id, name: openStatus.name, color: openStatus.color, category: openStatus.category };
          changed = true;
        }
      }
      if (changed) {
        await pool.query(`UPDATE issues SET dept_statuses = $1::jsonb WHERE id = $2`, [JSON.stringify(deptStatuses), row.id]);
      }
    }
  } catch { /* best-effort */ }
})();

// One-time backfill for the same root cause the fix above (in the PATCH
// /issues/:key handler) now prevents going forward: dept_statuses[current
// department] was only ever refreshed on a department CHANGE (handoff /
// manual Change Department / the custom-queue-status flow) -- a ticket
// whose status changed via the ordinary status dropdown while staying in
// the SAME department (e.g. resolved without ever leaving Dev) kept that
// snapshot stuck at whatever it was before, even though the ticket's real
// current status had moved on. Anywhere that snapshot is preferred over
// the live status (the detail page's getEffectiveIssueStatus, and the
// "Worked on" queue list) then showed that stale value. Detects staleness
// by comparing the snapshot's remembered category against the live
// status's actual category for that same department -- a mismatch there
// can only mean the snapshot never got updated after the real status
// changed.
(async () => {
  try {
    const affected = await pool.query(`
      SELECT i.id, i.current_department, i.dept_statuses,
             s.id AS live_id, s.name AS live_name, s.color AS live_color, s.category AS live_category
      FROM issues i
      LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE i.dept_statuses IS NOT NULL AND i.dept_statuses::text != '{}'
        AND i.current_department IS NOT NULL AND s.id IS NOT NULL
    `);
    for (const row of affected.rows) {
      const deptStatuses: Record<string, any> = row.dept_statuses || {};
      const key = Object.keys(deptStatuses).find((k) => k.toLowerCase() === String(row.current_department || '').toLowerCase());
      if (!key) continue;
      const snap = deptStatuses[key];
      if (snap && snap.category !== row.live_category) {
        deptStatuses[key] = { id: row.live_id, name: row.live_name, color: row.live_color, category: row.live_category };
        await pool.query(`UPDATE issues SET dept_statuses = $1::jsonb WHERE id = $2`, [JSON.stringify(deptStatuses), row.id]);
      }
    }
  } catch { /* best-effort */ }
})();

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
// Referenced throughout the codebase (formatIssue, the SLA breach check, the
// ticket detail page's "Resolved ·" timestamp) as if it already existed, but
// no migration ever actually created it -- every read of issue.resolvedAt
// was silently undefined for every ticket that's ever existed in this app.
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ`).catch(() => {});
// Lets an admin waive a specific SLA policy's breach on a specific ticket
// (e.g. it was resolved late for a reason outside anyone's control) so it
// stops reading as breached, instead of the breach being a permanent,
// unremovable fact of the ticket's stored dates. Keyed by policy id since a
// ticket can be tracked against more than one SLA policy at once.
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS sla_waivers JSONB DEFAULT '{}'::jsonb`).catch(() => {});
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
// 30 days -- a short-lived session forced users to re-authenticate with
// Microsoft constantly (once every 12h) even though they never explicitly
// logged out, unlike Jira which keeps a session alive for weeks.
const SESSION_TTL_HOURS = 24 * 30;

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
  lastSeenAt?: Date | null;
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
    lastSeenAt: (u as any).lastSeenAt ? (u as any).lastSeenAt.toISOString() : null,
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

// dept_assignees/dept_statuses are keyed by department name, but the
// queueStatusId-triggered handoff below derives its targetDept by
// regex-parsing a free-text "Waiting for X" status label a queue admin typed
// into a plain text input (src/app/spaces/[spaceKey]/queue/[queueId]/
// workflow/page.tsx) -- never validated against the canonical department
// name list. A snapshot saved as deptAssignees["Dev"] (from the manual
// Change Department dropdown, which always uses the canonical name) was
// invisible to a later restore attempt keyed by "waiting for dev" -> "dev"
// from a queue status typed in different casing, since plain object-key
// access is case-sensitive -- the restore silently missed and fell through
// to a fresh round-robin pick instead of the person who'd actually had it.
// These helpers do a case-insensitive lookup for reads, and for writes reuse
// whichever casing already exists for that department in THIS ticket's own
// snapshot map (falling back to the given string only when the department
// has never been recorded here at all), so a ticket's history stays
// internally consistent regardless of which of the two casings triggered
// the write.
function deptMapGet(map: Record<string, any>, dept: string): any {
  const key = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  return key ? map[key] : undefined;
}
function deptMapSet(map: Record<string, any>, dept: string, value: any): void {
  const existingKey = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  map[existingKey || dept] = value;
}
function deptMapDelete(map: Record<string, any>, dept: string): void {
  const existingKey = Object.keys(map).find((k) => k.toLowerCase() === dept.trim().toLowerCase());
  if (existingKey) delete map[existingKey];
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
  // The ticket's status as it was right before THIS handoff -- must come from
  // the caller's own pre-update fetch, not a fresh DB read done here. The
  // direct-statusId caller already writes the new "Waiting for X" status to
  // the row via db.issue.update() before this function ever runs, so a
  // same-function re-query would only ever see that just-written transit
  // status (category 'todo'/'in_progress'), never whatever the ticket
  // actually was — permanently blinding the isDoneNow check below to a
  // ticket that had just been resolved moments earlier in the same handoff.
  priorStatus: { id: string; name: string; category: string; color: string } | null,
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
      deptMapSet(deptAssignees, oldDept, { id: curAssignee.id, email: curAssignee.email, firstName: curAssignee.firstName, lastName: curAssignee.lastName, displayName: `${curAssignee.firstName} ${curAssignee.lastName}`.trim(), avatarUrl: avatarRef(curAssignee.id, curAssignee.avatarUrl) });
    }
  }
  // Restore whoever was saved for this dept from a previous visit (same
  // restore-or-round-robin rule the "Change Department" dropdown already
  // uses) instead of always landing unassigned.
  const savedForTarget = deptMapGet(deptAssignees, targetDept);
  let handoffAssigneeId: string | null = null;
  let handoffAssigneeName: string | null = null;
  if (savedForTarget?.id) {
    const stillExists = await pool.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [savedForTarget.id]);
    if (stillExists.rows.length) { handoffAssigneeId = savedForTarget.id; handoffAssigneeName = savedForTarget.displayName || null; }
    else deptMapDelete(deptAssignees, targetDept);
  }
  if (!handoffAssigneeId) {
    try {
      const rrAgent = await getNextAgent(spaceId, targetDept, productType);
      if (rrAgent) {
        handoffAssigneeId = rrAgent.userId;
        handoffAssigneeName = rrAgent.name;
        deptMapSet(deptAssignees, targetDept, { id: rrAgent.userId, displayName: rrAgent.name });
      }
    } catch { /* non-critical — falls through to unassigned */ }
  }

  // A ticket already marked done (e.g. resolved via this dept's own "Resolved"
  // queue status) that then gets handed onward via a "Waiting for X" pick used
  // to have its done state clobbered here: the OLD dept's record got a
  // synthetic "Waiting for <targetDept>" label instead of its real status
  // (discarding that it had been resolved), and the TARGET dept was always
  // forced to "In Progress" no matter what -- so a ticket resolved in Dev and
  // routed to Migration either showed Dev's raw "Resolved" (if Migration had
  // no prior record) or a stale "Waiting for X" leftover from an earlier
  // visit (if it did), never Migration's own actual status. Mirror the same
  // isDoneNow/restoringOwnSnapshot rule the manual "Change Department"
  // endpoint already uses: restore the target dept's own last-known status if
  // it has one, or carry the done status straight through on a first
  // arrival -- only defaulting to "In Progress" when the ticket isn't done.
  const isDoneNow = priorStatus?.category === 'done';
  const oldDeptStatusObj = priorStatus
    ? { id: priorStatus.id, name: priorStatus.name, category: priorStatus.category, color: priorStatus.color }
    : { id: '', name: 'Unknown', category: 'todo', color: '#6B7280' };

  // Record the OLD dept's status exactly as it was right before the handoff --
  // not the "Waiting for <targetDept>" transit marker, which discarded that
  // info (same fix already applied to the manual endpoint's own oldDept
  // recording, for the same "Sent/Watching needs to show what it actually
  // was" reason).
  deptMapSet(deptStatuses, oldDept, oldDeptStatusObj);

  const restoringOwnSnapshot = isDoneNow && deptMapGet(deptStatuses, targetDept) != null;
  let newDeptStatusObj: any;
  let targetStatusId: string | null;
  if (restoringOwnSnapshot) {
    newDeptStatusObj = deptMapGet(deptStatuses, targetDept);
    const realMatch = await db.status.findFirst({ where: { spaceId, name: { equals: newDeptStatusObj.name, mode: 'insensitive' } }, orderBy: { order: 'asc' } });
    targetStatusId = realMatch?.id || priorStatus?.id || null;
  } else {
    // Every department tracks its own status independently -- a status like
    // Resolved belongs to whichever dept actually resolved it, not to a dept
    // that's only now receiving the ticket. A dept the ticket has already
    // visited before (isReturningToDept), OR a done ticket landing somewhere
    // new (isDoneNow), both mean "this dept needs to actually start working
    // it," so both get "In Progress" -- only a still-open ticket arriving at a
    // dept for the very first time gets the untouched "Open" default.
    const isReturningToDept = deptMapGet(deptStatuses, targetDept) != null;
    let targetQueueStatuses: any[] = [];
    try {
      const allQueueRows = await pool.query(`SELECT queues FROM custom_queues`);
      for (const row of allQueueRows.rows) {
        const queues: any[] = row.queues || [];
        const matchedQ = queues.find((q: any) => (q.name || '').toLowerCase() === targetDept.toLowerCase());
        if (matchedQ?.queueStatuses?.length) { targetQueueStatuses = matchedQ.queueStatuses; break; }
      }
    } catch {}
    if (isDoneNow || isReturningToDept) {
      const inProgressSt = targetQueueStatuses.find((s: any) => s.category === 'in_progress')
        || targetQueueStatuses.find((s: any) => (s.name || '').toLowerCase().includes('progress'));
      newDeptStatusObj = inProgressSt
        ? { id: inProgressSt.id, name: inProgressSt.name, category: inProgressSt.category, color: inProgressSt.color }
        : { id: '', name: 'In Progress', category: 'in_progress', color: '#3B82F6' };
    } else {
      const firstTodoSt = targetQueueStatuses.find((s: any) => s.category === 'todo') || targetQueueStatuses[0];
      newDeptStatusObj = firstTodoSt
        ? { id: firstTodoSt.id, name: firstTodoSt.name, category: firstTodoSt.category, color: firstTodoSt.color }
        : { id: '', name: 'Open', category: 'todo', color: '#6366F1' };
    }
    // newDeptStatusObj can carry a queue-scoped virtual id (qst_...) that isn't
    // a real row in the statuses table -- resolve the equivalent real status by
    // name for the global column, same as the restoringOwnSnapshot branch above.
    const realMatch = await db.status.findFirst({ where: { spaceId, name: { equals: newDeptStatusObj.name, mode: 'insensitive' } }, orderBy: { order: 'asc' } });
    targetStatusId = realMatch?.id || fallbackStatusId;
  }
  deptMapSet(deptStatuses, targetDept, newDeptStatusObj);

  await pauseDeptSLA(null, issueId, oldDept);
  await pool.query(
    `UPDATE issues SET current_department=$1, "assigneeId"=$6, dept_sla_started_at=NOW(), dept_assignees=$2::jsonb, dept_statuses=$3::jsonb, "statusId"=$4, "updatedAt"=NOW() WHERE id=$5`,
    [targetDept, JSON.stringify(deptAssignees), JSON.stringify(deptStatuses), targetStatusId, issueId, handoffAssigneeId]
  );
  await startDeptSLA(null, issueId, targetDept);

  // Callers already log their own "status changed to Waiting for X" /
  // "handed to Y" entries for the picking dept's own action -- accurate, but
  // silent on what actually happened to the ticket's real status once it
  // landed (restoring targetDept's own snapshot, or reopening into "In
  // Progress"), same gap the manual "Change Department" endpoint had for its
  // own equivalent silent statusId change. Only worth a separate
  // entry when the ticket was actually done -- the plain "In Progress" arrival
  // for a not-done ticket is already what the caller's own entry implies.
  if (isDoneNow) {
    try {
      const historyChanger = userId ? await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }) : null;
      pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [rid(), issueId, 'status', oldDeptStatusObj.name, newDeptStatusObj.name, historyChanger ? `${historyChanger.firstName} ${historyChanger.lastName}`.trim() : 'System', historyChanger?.email || null]
      ).catch(() => {});
    } catch { /* non-critical */ }
  }

  // The restore-or-round-robin assignee logic above (lines ~893-911) silently
  // changes issues.assigneeId on every handoff -- restoring whoever the target
  // dept had before, or round-robining a new agent -- but nothing ever logged
  // it, unlike a plain assignee-dropdown change (the only other place in this
  // file that writes field:'assignee'). A ticket bouncing Migration -> Dev ->
  // Migration correctly restored the right person under the hood (verified
  // directly against real data), but its History tab showed no record of it
  // ever happening in either direction -- exactly this gap, mirrored from the
  // 'status' fix just above.
  if (curAssigneeId !== handoffAssigneeId) {
    try {
      const historyChanger = userId ? await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }) : null;
      const oldDeptSnapshot = oldDept ? deptMapGet(deptAssignees, oldDept) : null;
      const oldAssigneeName = (curAssigneeId && oldDeptSnapshot?.id === curAssigneeId)
        ? oldDeptSnapshot.displayName
        : null;
      pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [rid(), issueId, 'assignee', oldAssigneeName, handoffAssigneeName, historyChanger ? `${historyChanger.firstName} ${historyChanger.lastName}`.trim() : 'System', historyChanger?.email || null]
      ).catch(() => {});
    } catch { /* non-critical */ }
  }

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

// A resolved/breached SLA badge previously had no way to show WHO actually
// resolved the ticket, or that MULTIPLE people may have resolved it at
// different times (e.g. resolved on time, reopened, then resolved again
// later by someone else after the due time) -- only the issue's current
// Assignee field was visible nearby, and the ticket's single shared
// resolvedAt/breach flag only ever reflects the LAST such event, silently
// erasing that an earlier, on-time resolution by a different person ever
// happened. issue_history already records every status change with who
// made it and when; walk it to reconstruct every time this ticket was
// actually moved into a "done" status, and whether THAT SPECIFIC event was
// late against the due time this policy is currently using -- accurate as
// long as the department (and so the due time) didn't change in between,
// which covers the common "resolved, reopened, resolved again in the same
// queue" case this exists for.
// Was 2-3 sequential round trips (statuses, then spaces, then custom_queues) --
// every GET /issues/:key request pays this cost when the ticket is resolved,
// so a slow/loaded DB connection turns into real added latency on the ticket
// page. The space-key lookup is folded into a single join with custom_queues
// instead of a separate round trip, and it runs in parallel with the
// statuses query rather than after it.
async function getDoneStatusNames(spaceId: string | null | undefined, currentDept: string | null | undefined): Promise<Set<string>> {
  const doneNames = new Set<string>(['resolved', 'closed', 'done']);
  if (!spaceId) return doneNames;
  const [statusRows, queueRows] = await Promise.all([
    pool.query(`SELECT name FROM statuses WHERE "spaceId" = $1 AND category = 'done'`, [spaceId]).catch(() => ({ rows: [] as any[] })),
    currentDept
      ? pool.query(
          `SELECT cq.queues FROM custom_queues cq JOIN spaces sp ON sp.key = cq.space_key WHERE sp.id = $1`,
          [spaceId]
        ).catch(() => ({ rows: [] as any[] }))
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  for (const row of statusRows.rows) doneNames.add((row.name || '').trim().toLowerCase());
  if (currentDept) {
    const queues: any[] = queueRows.rows[0]?.queues || [];
    const q = queues.find((qq: any) => String(qq.name || '').toLowerCase() === currentDept.toLowerCase());
    for (const qs of (q?.queueStatuses || [])) {
      if ((qs.category || '') === 'done') doneNames.add((qs.name || '').trim().toLowerCase());
    }
  }
  return doneNames;
}

// getLastStatusChangeAuthor and getResolutionHistoryEvents used to each run
// their own separate query against the exact same issue_history rows (one
// DESC LIMIT 1, one ASC) -- fetched once here and reused for both.
async function getStatusHistoryRows(issueId: string): Promise<Array<{ authorName: string | null; newValue: string | null; createdAt: any }>> {
  try {
    const r = await pool.query(
      `SELECT "authorName", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [issueId]
    );
    return r.rows;
  } catch { return []; }
}

// Attaches resolvedByName + a full per-event `history` to every completed SLA
// entry, so the frontend can show who resolved it and, when it was resolved
// more than once, every attempt with its own date and on-time/late verdict --
// instead of one unattributed badge that only reflects whichever attempt
// happened last. The two independent lookups (status history, done-status
// names) run in parallel rather than one function awaiting the other.
async function enrichSlaWithResolver(
  issueId: string, slaInstances: any[], spaceId?: string | null, currentDept?: string | null
): Promise<any[]> {
  if (!slaInstances.some((s: any) => s.isCompleted)) return slaInstances;
  const [statusHistory, doneNames] = await Promise.all([
    getStatusHistoryRows(issueId),
    getDoneStatusNames(spaceId, currentDept),
  ]);
  const resolvedByName = statusHistory.length ? (statusHistory[statusHistory.length - 1].authorName || null) : null;
  const events = statusHistory
    .filter((row) => doneNames.has((row.newValue || '').trim().toLowerCase()))
    .map((row) => ({ resolvedByName: row.authorName || 'Unknown', resolvedAt: row.createdAt?.toISOString?.() || row.createdAt }));
  return slaInstances.map((s: any) => {
    if (!s.isCompleted) return s;
    const dueMs = new Date(s.dueTime).getTime();
    const history = events.map((e) => ({ ...e, wasBreached: new Date(e.resolvedAt).getTime() > dueMs }));
    return { ...s, resolvedByName: resolvedByName || s.resolvedByName, history };
  });
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

    // When a department-specific policy shares its name with a space-wide
    // one (dept_name null) -- e.g. both literally called "Time to
    // resolution" -- prefer the department-specific one instead of
    // returning both as separate instances. Without this, adding a
    // department override for an existing space-wide metric silently
    // doubled that metric's SLA badge on every ticket in that department.
    // Mirrors the "prefer dept-specific policy, fall back to space-wide"
    // rule computePausedDeptSLA already uses above, generalized to every
    // name instead of picking one policy for the whole issue.
    const policyByName = new Map<string, any>();
    for (const p of policies) {
      const key = (p.name || '').trim().toLowerCase();
      const current = policyByName.get(key);
      if (!current || (!!(p.dept_name || '').trim() && !(current.dept_name || '').trim())) {
        policyByName.set(key, p);
      }
    }
    const dedupedPolicies = Array.from(policyByName.values());

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
    const deptLogEntry = deptLogKey ? deptSlaLog[deptLogKey] : null;
    // pauseDeptSLA always copies the CURRENT dept_sla_started_at into the log
    // entry's own started_at at the moment it pauses -- so after pausing (or
    // resolving) WITHOUT the ticket ever actually leaving this dept, the log
    // entry's started_at exactly matches dept_sla_started_at, because it's a
    // snapshot of the very same still-ongoing stint, not a separate earlier
    // visit. Crediting its elapsed_ms as "prior debt" in that case double-
    // counted the same elapsed time (once via startedAt itself, again as
    // extra debt subtracted from durationMs), pulling the due time hours
    // earlier than it really is -- a ticket resolved cleanly within its goal
    // could read as breached. Only credit it when the log's started_at is
    // genuinely different, i.e. from an earlier stint that a later dept
    // re-entry (which DOES reset dept_sla_started_at) has since superseded.
    const currentStartedRaw = (issue as any).dept_sla_started_at;
    const isSameStint = deptLogEntry?.started_at && currentStartedRaw
      && new Date(deptLogEntry.started_at).getTime() === new Date(currentStartedRaw).getTime();
    const priorElapsedMs: number = (deptLogEntry && !isSameStint) ? (deptLogEntry.elapsed_ms || 0) : 0;

    return dedupedPolicies.map((policy: any) => {
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
      // Paused SLAs are never breached — clock stopped. A resolved ticket is
      // breached if it was ALREADY overdue at the moment it got resolved
      // (resolvedAt is stamped on every done transition -- see the PATCH
      // handler) -- not simply "never breached because it's done now". That
      // used to erase every late resolution's breach entirely: mark a
      // ticket Resolved 3 days after it was due and it read as a clean,
      // on-time completion with no trace it had ever breached.
      const resolvedAt = (issue as any).resolvedAt ? new Date((issue as any).resolvedAt) : null;
      const rawIsBreached = isResolved
        ? (resolvedAt !== null && new Date(dueTime) < resolvedAt)
        : (!isPaused && new Date(dueTime) < new Date());

      // An admin can waive this specific policy's breach on this specific
      // ticket (e.g. it was resolved late for a reason outside anyone's
      // control) -- the breach itself isn't erased from history, but it no
      // longer counts against this ticket for as long as the waiver stands.
      const waivers: Record<string, any> = (issue as any).sla_waivers || {};
      const waiver = waivers[policy.id] || null;
      const isBreached = waiver ? false : rawIsBreached;

      return {
        id: `sla_${policy.id}_${issue.key}`,
        policyId: policy.id,
        policyName: policy.name || 'SLA',
        deptName: policy.dept_name || null,
        dueTime,
        isBreached,
        isPaused,
        isCompleted: isResolved,
        // So the frontend can freeze the elapsed/progress display at the
        // actual resolution moment instead of continuing to count up against
        // "now" forever after the ticket is already done.
        resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
        startedAt,
        goalDurationMs: durationMs,
        isNotified,
        waived: !!waiver,
        waivedByName: waiver?.waivedByName || null,
        waivedAt: waiver?.waivedAt || null,
        waivedReason: waiver?.reason || null,
      };
    });
  } catch { return []; }
}

// Shared data loader for the Team Analytics tab (ported from the standalone
// "Reports-" app -- see the route handlers below for context). Every
// sub-tab's endpoint calls this once and shapes the same enriched issue list
// differently, instead of each re-running its own fetch+history-index pass.
async function loadTeamAnalyticsScope(url: URL) {
  const deptParam = url.searchParams.get('dept') || '';
  const depts = deptParam && deptParam.toLowerCase() !== 'all'
    ? deptParam.split(',').map((d) => d.trim()).filter(Boolean)
    : null;
  const dateType = url.searchParams.get('dateType') || 'created'; // 'created' | 'updated' | 'worked' | 'none'
  const dateFrom = url.searchParams.get('dateFrom') || '';
  const dateTo = url.searchParams.get('dateTo') || '';
  const productTypeParam = url.searchParams.get('productType') || '';

  const whereClauses: string[] = [`i.current_department IS NOT NULL`];
  const params: any[] = [];
  let idx = 1;
  // "worked" scopes by department through user_worked_on_tickets below instead
  // of the plain current_department match -- a ticket someone worked while it
  // sat in Dev, then handed off elsewhere, should still count as "Dev worked
  // this" for that historical window even though current_department has since
  // moved on.
  if (depts && depts.length && dateType !== 'worked') { whereClauses.push(`i.current_department = ANY($${idx++}::text[])`); params.push(depts); }
  if (productTypeParam) { whereClauses.push(`i."productType" = $${idx++}`); params.push(productTypeParam); }

  // Queue-membership map (custom_queues.queues[].name -> memberIds), matched
  // case-insensitively against current_department. Selecting a department
  // should only surface tickets belonging to people who actually have access
  // to that queue, not every ticket carrying the department label -- checked
  // against real data and found MOST department labels (Infra, QA, Pre-Sales,
  // SalesOps, etc.) have no configured queue at all, so those keep the old
  // department-only match; only a department with a real queue config gets
  // the additional assignee-membership restriction below. Not needed for
  // "worked" -- that dateType already scopes by real recorded activity, not
  // configured membership.
  let deptMemberSets: Record<string, Set<string>> | null = null;
  if (depts && depts.length && dateType !== 'worked') {
    const cq = await pool.query(`SELECT queues FROM custom_queues`);
    const sets: Record<string, Set<string>> = {};
    for (const row of cq.rows) {
      const queues = Array.isArray(row.queues) ? row.queues : [];
      for (const q of queues) {
        const name = String(q?.name || '').trim().toLowerCase();
        if (!name) continue;
        const members: string[] = Array.isArray(q?.memberIds) ? q.memberIds : [];
        const set = (sets[name] ??= new Set<string>());
        for (const m of members) set.add(m);
      }
    }
    deptMemberSets = sets;
  }

  const toEnd = dateTo ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : null;
  const fromStart = dateFrom ? new Date(dateFrom) : null;
  if (dateType === 'none') {
    // "Open tickets that existed on or before `to`" -- mirrors the reference
    // app's "None (open tickets)" date-type option; `from` doesn't apply to
    // an open-ended snapshot like this.
    whereClauses.push(`s.category != 'done'`);
    if (toEnd) { whereClauses.push(`i."createdAt" <= $${idx++}`); params.push(toEnd); }
  } else if (dateType === 'worked') {
    // "Actually worked" -- backed by user_worked_on_tickets, the same table
    // the per-queue Summary view uses, written only on a real pass/return/
    // close event (see the comment above that endpoint). Unlike created/
    // updated, this can't be satisfied by a ticket merely sitting untouched
    // in someone's queue since it was filed.
    let workedClause = `EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id`;
    if (fromStart) { workedClause += ` AND w.worked_at >= $${idx++}`; params.push(fromStart); }
    if (toEnd) { workedClause += ` AND w.worked_at <= $${idx++}`; params.push(toEnd); }
    if (depts && depts.length) {
      workedClause += ` AND LOWER(w.dept) = ANY($${idx++}::text[])`;
      params.push(depts.map((d) => d.toLowerCase()));
      // Only count work by someone who currently has access to that specific
      // queue -- e.g. selecting "Dev" shouldn't credit a ticket to Dev's
      // worked-count just because SOME person touched it while it briefly
      // carried that department label; it must have been a real Dev-access
      // person who did the work. Built as a dept(lowercased) -> memberIds
      // jsonb map so each selected department is checked against its own
      // configured list -- a department with no queue config at all (most
      // of them; see the comment on deptMemberSets above) imposes no
      // restriction, same "no config = no restriction" rule used elsewhere.
      const cqW = await pool.query(`SELECT queues FROM custom_queues`);
      const memberMap: Record<string, string[]> = {};
      for (const row of cqW.rows) {
        const queuesW = Array.isArray(row.queues) ? row.queues : [];
        for (const q of queuesW) {
          const name = String(q?.name || '').trim().toLowerCase();
          if (!name) continue;
          const members: string[] = Array.isArray(q?.memberIds) ? q.memberIds : [];
          (memberMap[name] ??= []).push(...members);
        }
      }
      workedClause += ` AND (NOT ($${idx}::jsonb ? LOWER(w.dept)) OR ($${idx}::jsonb -> LOWER(w.dept)) @> to_jsonb(w.user_id))`;
      params.push(JSON.stringify(memberMap));
      idx++;
    }
    workedClause += `)`;
    whereClauses.push(workedClause);
  } else {
    const dateCol = dateType === 'updated' ? `i."updatedAt"` : `i."createdAt"`;
    if (fromStart) { whereClauses.push(`${dateCol} >= $${idx++}`); params.push(fromStart); }
    if (toEnd) { whereClauses.push(`${dateCol} <= $${idx++}`); params.push(toEnd); }
  }

  const rows = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i.summary, i.priority, i.type, i."productType",
            i."customerName", i."clientName", i."projectManager", i.current_department,
            i."assigneeId", i."reporterId", i."spaceId", i."createdAt", i."updatedAt", i."resolvedAt",
            i."dueDate", i.jira_sla_breached,
            s.name AS status_name, s.category AS status_category,
            a."firstName" AS assignee_first, a."lastName" AS assignee_last, a.email AS assignee_email
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     LEFT JOIN users a ON a.id = i."assigneeId"
     WHERE ${whereClauses.join(' AND ')}
     LIMIT 100000`,
    params
  );
  const issues = deptMemberSets
    ? rows.rows.filter((r: any) => {
        const deptKey = String(r.current_department || '').trim().toLowerCase();
        const memberSet = deptMemberSets![deptKey];
        if (!memberSet || !memberSet.size) return true; // no configured queue for this dept -- keep department-only match
        return !!r.assigneeId && memberSet.has(r.assigneeId);
      })
    : rows.rows;
  const issueIds = issues.map((r: any) => r.id);

  const historyRows = issueIds.length
    ? await pool.query(
        `SELECT "issueId", field, "oldValue", "newValue", "authorName", "createdAt"
         FROM issue_history
         WHERE "issueId" = ANY($1::text[]) AND field = ANY($2::text[])
         ORDER BY "issueId", "createdAt" ASC`,
        [issueIds, ['status', 'assignee', 'sla']]
      )
    : { rows: [] as any[] };

  const statusHistByIssue: Record<string, any[]> = {};
  const assigneeHistByIssue: Record<string, any[]> = {};
  const slaBreachEventsByIssue: Record<string, any[]> = {};
  for (const h of historyRows.rows) {
    if (h.field === 'status') (statusHistByIssue[h.issueId] ??= []).push(h);
    else if (h.field === 'assignee') (assigneeHistByIssue[h.issueId] ??= []).push(h);
    // Logged by the periodic SLA monitor (runSlaBreachCheck) the first time
    // it observes a ticket past its due time -- see line ~364 above. Poll-
    // interval granularity, not to-the-second, but the only real breach-
    // moment marker this app records.
    else if (h.field === 'sla' && /breached/i.test(String(h.newValue || ''))) (slaBreachEventsByIssue[h.issueId] ??= []).push(h);
  }

  const spaceIds = Array.from(new Set(issues.map((r: any) => r.spaceId).filter(Boolean)));
  const policiesBySpace: Record<string, any[]> = {};
  if (spaceIds.length) {
    const polRows = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`, [spaceIds]);
    for (const p of polRows.rows) (policiesBySpace[p.spaceId] ??= []).push(p);
  }

  const now = Date.now();
  const enriched = issues.map((row: any) => {
    const statusHist = statusHistByIssue[row.id] || [];
    const assigneeHist = assigneeHistByIssue[row.id] || [];
    const createdMs = new Date(row.createdAt).getTime();
    const isDone = row.status_category === 'done';

    const firstAssigned = assigneeHist.find((h: any) => h.newValue);
    const assignedTime = firstAssigned ? new Date(firstAssigned.createdAt) : null;
    const firstInProgressEntry = statusHist.find((h: any) => h.newValue === 'In Progress');
    const firstInProgress = firstInProgressEntry ? new Date(firstInProgressEntry.createdAt) : null;

    const { inProgressHrs } = computeInProgressHours(statusHist, row.createdAt, isDone, row.resolvedAt, row.status_name);

    // resolvedAt only gets stamped by this app's own PATCH handler -- a
    // ticket resolved via the original Jira migration import never had one
    // written (same gap documented in the resolution-sla endpoint above).
    // Fall back to the first done-category status transition in history for
    // those, so historical tickets still get a resolution time instead of
    // being silently dropped from every resolution-time metric.
    let resolvedAtComputed: Date | null = row.resolvedAt ? new Date(row.resolvedAt) : null;
    if (!resolvedAtComputed && isDone) {
      const firstDoneEntry = statusHist.find((h: any) => DONE_STATUS_NAME_HINTS.has(String(h.newValue || '').trim().toLowerCase()));
      if (firstDoneEntry) resolvedAtComputed = new Date(firstDoneEntry.createdAt);
    }
    const resolvedHrs = resolvedAtComputed ? Math.max(0, (resolvedAtComputed.getTime() - createdMs) / 3_600_000) : null;

    // Breach flag: the live computeSLAInstancesPure check when this ticket
    // has a real resolvedAt and an applicable policy (same rule as the
    // resolution-sla endpoint); otherwise fall back to the historical
    // Jira-imported breach flag; otherwise unknown (excluded from breach%).
    let isBreached: boolean | null = null;
    if (row.resolvedAt) {
      const policies = policiesBySpace[row.spaceId] || [];
      const instances = computeSLAInstancesPure({ ...row, status: { name: row.status_name, category: row.status_category } }, policies, false);
      if (instances.length) isBreached = instances.some((x: any) => x.isBreached);
      else if (typeof row.jira_sla_breached === 'boolean') isBreached = row.jira_sla_breached;
    } else if (typeof row.jira_sla_breached === 'boolean') {
      isBreached = row.jira_sla_breached;
    }

    const assigneeName = row.assignee_first || row.assignee_last
      ? `${row.assignee_first || ''} ${row.assignee_last || ''}`.trim()
      : (row.assignee_email || null);

    return {
      ...row, isDone, assigneeName,
      statusHist, assigneeHist,
      assignedTime, firstInProgress,
      resolvedAtComputed, resolvedHrs, isBreached, inProgressHrs,
      slaBreachEvents: slaBreachEventsByIssue[row.id] || [],
    };
  });

  return { issues: enriched, depts, dateType, dateFrom, dateTo, productType: productTypeParam };
}

// Status names seen across real (mostly Jira-migrated) data that this app's
// own catalog doesn't classify as category:'done' but that clearly ARE
// terminal -- used only as a fallback when a ticket has no real resolvedAt.
const DONE_STATUS_NAME_HINTS = new Set(['done', 'resolved', 'closed', 'approved', 'complete', 'completed', 'cancelled', 'canceled', 'rejected']);

// See the inProgressHrs comment above for why this is a name allowlist, not
// a category check.
const IN_PROGRESS_STATUS_NAMES = new Set(['in progress', 'work in progress']);

// Hours actually spent in an "In Progress"-type status, NOT total wall-clock
// age or resolution time -- see the IN_PROGRESS_STATUS_NAMES comment above
// for why this matches literal status names rather than the category field.
// Walks the sorted status_history transition list (field:'status' rows,
// oldest first); the open tail (still in the current status) counts up to
// resolvedAt for a done ticket, or up to now for one still open. Shared by
// Team Analytics' Time Spent view and GET /issues (opt-in via
// includeTimeSpent) so both compute this identically.
function computeInProgressHours(
  statusHist: Array<{ oldValue: string | null; newValue: string; createdAt: Date | string }>,
  createdAt: Date | string,
  isDone: boolean,
  resolvedAt: Date | string | null,
  currentStatusName: string | null,
): { inProgressHrs: number; noHistory: boolean } {
  const createdMs = new Date(createdAt).getTime();
  const statusTotals: Record<string, number> = {};
  let cursor = createdMs;
  let cursorStatus = statusHist[0]?.oldValue || currentStatusName || 'Unknown';
  for (const h of statusHist) {
    const t = new Date(h.createdAt).getTime();
    const hrs = (t - cursor) / 3_600_000;
    if (hrs > 0 && cursorStatus) statusTotals[cursorStatus] = (statusTotals[cursorStatus] || 0) + hrs;
    cursor = t;
    cursorStatus = h.newValue;
  }
  const tailEnd = isDone && resolvedAt ? new Date(resolvedAt).getTime() : Date.now();
  const tailHrs = (tailEnd - cursor) / 3_600_000;
  if (tailHrs > 0 && cursorStatus) statusTotals[cursorStatus] = (statusTotals[cursorStatus] || 0) + tailHrs;
  const inProgressHrs = Math.round(
    Object.entries(statusTotals).reduce((sum, [name, hrs]) => sum + (IN_PROGRESS_STATUS_NAMES.has(name.trim().toLowerCase()) ? hrs : 0), 0) * 10
  ) / 10;
  return { inProgressHrs, noHistory: statusHist.length === 0 };
}

function buildTeamAnalyticsOverview(scope: Awaited<ReturnType<typeof loadTeamAnalyticsScope>>) {
  const { issues } = scope;
  const byStatus = taGroupByCount(issues, (r) => r.status_name);
  const byPriority = taGroupByCount(issues, (r) => r.priority);
  const byProductType = taGroupByCount(issues, (r) => r.productType);
  const byDept = taGroupByCount(issues, (r) => r.current_department);

  const byMonth: Record<string, number> = {};
  for (const r of issues) {
    const d = new Date(r.createdAt);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[label] = (byMonth[label] || 0) + 1;
  }

  const resolved = issues.filter((r: any) => r.isDone);
  const slaTracked = resolved.filter((r: any) => r.isBreached !== null);
  const breached = slaTracked.filter((r: any) => r.isBreached);

  const byMember: Record<string, any> = {};
  for (const r of issues) {
    if (!r.assigneeId) continue;
    const m = (byMember[r.assigneeId] ??= {
      id: r.assigneeId, name: r.assigneeName || 'Unknown', email: r.assignee_email || '',
      ticketCount: 0, resolvedCount: 0, totalResolutionHrs: 0, resolutionSamples: 0,
      slaTracked: 0, breached: 0,
    });
    m.ticketCount++;
    if (r.isDone) {
      m.resolvedCount++;
      if (r.resolvedHrs !== null) { m.totalResolutionHrs += r.resolvedHrs; m.resolutionSamples++; }
      if (r.isBreached !== null) { m.slaTracked++; if (r.isBreached) m.breached++; }
    }
  }
  const memberPerformance = Object.values(byMember).map((m: any) => ({
    id: m.id, name: m.name, email: m.email,
    ticketCount: m.ticketCount, resolvedCount: m.resolvedCount,
    avgResolutionHrs: m.resolutionSamples ? Math.round((m.totalResolutionHrs / m.resolutionSamples) * 10) / 10 : null,
    slaBreachPct: m.slaTracked ? Math.round((m.breached / m.slaTracked) * 1000) / 10 : null,
  })).sort((a: any, b: any) => b.ticketCount - a.ticketCount);

  return {
    totalTickets: issues.length,
    resolvedCount: resolved.length,
    openCount: issues.length - resolved.length,
    slaBreachPct: slaTracked.length ? Math.round((breached.length / slaTracked.length) * 1000) / 10 : null,
    slaTrackedCount: slaTracked.length,
    byStatus, byPriority, byProductType, byDept, byMonth,
    memberPerformance,
    depts: Array.from(new Set(issues.map((r: any) => r.current_department).filter(Boolean))).sort(),
    productTypes: Array.from(new Set(issues.map((r: any) => r.productType).filter(Boolean))).sort(),
  };
}

function buildTeamAnalyticsAging(scope: Awaited<ReturnType<typeof loadTeamAnalyticsScope>>) {
  const open = scope.issues.filter((r: any) => !r.isDone);
  const now = Date.now();
  const BUCKETS = [
    { key: 'le1', label: '<= 1 day', max: 1 },
    { key: 'd2to5', label: '2-5 days', max: 5 },
    { key: 'gt5', label: '> 5 days', max: Infinity },
  ];
  const bucketOf = (ageDays: number) => BUCKETS.find((b) => ageDays <= b.max)!.key;

  const counts: Record<string, number> = { le1: 0, d2to5: 0, gt5: 0 };
  const byMember: Record<string, any> = {};
  const tickets: any[] = [];
  for (const r of open) {
    const ageDays = (now - new Date(r.createdAt).getTime()) / 86_400_000;
    const bucket = bucketOf(ageDays);
    counts[bucket]++;
    tickets.push({
      id: r.id, key: r.key, cfKey: r.cf_key, summary: r.summary, priority: r.priority,
      status: r.status_name, assignee: r.assigneeName, department: r.current_department,
      createdAt: r.createdAt, ageDays: Math.round(ageDays * 10) / 10, bucket,
    });
    if (r.assigneeId) {
      const m = (byMember[r.assigneeId] ??= { id: r.assigneeId, name: r.assigneeName || 'Unknown', le1: 0, d2to5: 0, gt5: 0, total: 0 });
      m[bucket]++; m.total++;
    }
  }

  return {
    totalOpen: open.length,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] })),
    byMember: Object.values(byMember).sort((a: any, b: any) => b.total - a.total),
    tickets: tickets.sort((a, b) => b.ageDays - a.ageDays),
  };
}

// Per-ticket time-spent list -- assignee x department x productType x hours
// actually spent In Progress (see the inProgressHrs comment in
// loadTeamAnalyticsScope for why this isn't just total resolution time).
// Flat, not aggregated, so a real ticket's number can be checked directly
// against its own history instead of trusting a rolled-up total.
const TA_TIME_SPENT_CAP = 5000;
function buildTeamAnalyticsTimeSpent(scope: Awaited<ReturnType<typeof loadTeamAnalyticsScope>>, q?: string) {
  // A text search is applied BEFORE the cap below, not after -- otherwise a
  // specific low-hours ticket (most of them, by definition) could never be
  // found once the in-scope count exceeds the cap, since it would already
  // have been dropped before the caller's search term ever got applied.
  const query = (q || '').trim().toLowerCase();
  const base = query
    ? scope.issues.filter((r: any) =>
        (r.cf_key || '').toLowerCase().includes(query) ||
        (r.key || '').toLowerCase().includes(query) ||
        (r.summary || '').toLowerCase().includes(query) ||
        (r.assigneeName || '').toLowerCase().includes(query))
    : scope.issues;
  const sorted = [...base].sort((a: any, b: any) => b.inProgressHrs - a.inProgressHrs);
  const truncated = sorted.length > TA_TIME_SPENT_CAP;
  const tickets = sorted.slice(0, TA_TIME_SPENT_CAP).map((r: any) => ({
    id: r.id, key: r.key, cfKey: r.cf_key, summary: r.summary, priority: r.priority,
    status: r.status_name, isDone: r.isDone,
    assigneeId: r.assigneeId, assignee: r.assigneeName || 'Unassigned',
    department: r.current_department, productType: r.productType || null,
    inProgressHrs: r.inProgressHrs, createdAt: r.createdAt,
    isBreached: r.isBreached,
    // A ticket with zero logged status transitions (mostly Jira-migrated
    // tickets that arrived already in their current status, with no
    // transition ever recorded in this app) has no way to know when it
    // actually entered its current status -- its ENTIRE age gets counted,
    // which can read as an extreme outlier (checked against real data:
    // the #1 ticket by this metric has 0 history rows and is simply 269
    // days old, sitting in "In Progress" since creation). Flagged so the UI
    // can tell that apart from a ticket with real, tracked in-progress time.
    noHistory: r.statusHist.length === 0,
  }));
  return { totalTickets: scope.issues.length, totalMatched: base.length, truncated, cap: TA_TIME_SPENT_CAP, tickets };
}

function taGroupByCount(rows: any[], getKey: (r: any) => string | null | undefined) {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const k = (getKey(r) || '').trim() || '(none)';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
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
    productionTicket: issue.productionTicket ?? null,
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
        source: { key: sk, cfKey: lnk._sourceCfKey ?? null, summary: lnk._sourceSummary ?? sk, type: 'task' },
        target: { key: tk, cfKey: lnk._targetCfKey ?? null, summary: lnk._targetSummary ?? tk, type: 'task' },
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

  // "Between" (custom from/to date picker) was never handled here -- it fell
  // through every branch above and landed on the catch-all default below,
  // which silently returns the full all-time range. Selecting specific dates
  // and clicking Update looked like it worked (the filter chip showed the
  // dates) but never actually narrowed the results at all.
  if (range.startsWith('between:')) {
    const [, fromStr, toStr] = range.split(':');
    // A bare "YYYY-MM-DDTHH:mm:ss" string with no offset is parsed in
    // whatever timezone the NODE PROCESS happens to be running in -- fine on
    // a dev machine set to IST, but this app's actual users (and whoever's
    // querying this endpoint from an external reporting tool) operate in
    // IST regardless of where the server itself is deployed. A Docker
    // container defaults to UTC unless explicitly configured otherwise, and
    // this one has no TZ set -- so "to 2026-07-31" was silently cut off at
    // 2026-07-31 00:00 UTC, which is 2026-07-31 05:30 IST, quietly dropping
    // the rest of that IST calendar day's tickets from the range (and,
    // depending on server TZ, potentially the START boundary shifting the
    // same way). Anchoring explicitly to IST (+05:30) makes the calendar-day
    // boundary match what a human picking these dates actually means,
    // independent of whatever timezone the server process happens to run in.
    const f = fromStr ? new Date(`${fromStr}T00:00:00+05:30`) : new Date(0);
    const t = toStr ? new Date(`${toStr}T23:59:59.999+05:30`) : now;
    return { from: f, to: t };
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

// Map issue key prefix -> { jiraProject, spaceKey }
// spaceKey used to point at per-board spaces (L2BOARD, L3BOARD, ...) from an
// older multi-space layout that was later consolidated into a single space --
// every one of these prefixes' issues actually lives under 'TESTIN' now
// (confirmed: issues for every prefix below all join to space key TESTIN).
// Looking up the old spaceKey silently found no space and returned null,
// which means importIssueFromJira has been unable to import ANY issue for
// ANY prefix -- the on-demand "open a not-yet-synced ticket by URL" fallback
// has simply been a dead 404 for every board this whole time.
const PREFIX_TO_META: Record<string, { jiraProject: string; spaceKey: string }> = {
  L1BOAR:  { jiraProject: 'CFITS',  spaceKey: 'TESTIN' },
  L2B:     { jiraProject: 'L2B',    spaceKey: 'TESTIN' },
  L3B:     { jiraProject: 'L3B',    spaceKey: 'TESTIN' },
  PSM:     { jiraProject: 'PSM',    spaceKey: 'TESTIN' },
  CFM:     { jiraProject: 'CFM',    spaceKey: 'TESTIN' },
  IB:      { jiraProject: 'IB',     spaceKey: 'TESTIN' },
  MB:      { jiraProject: 'MB',     spaceKey: 'TESTIN' },
  EB:      { jiraProject: 'EB',     spaceKey: 'TESTIN' },
  CB:      { jiraProject: 'CB',     spaceKey: 'TESTIN' },
  SOPS:    { jiraProject: 'SOPS',   spaceKey: 'TESTIN' },
  QABOAR:  { jiraProject: 'QABOAR', spaceKey: 'TESTIN' },
};

const JIRA_CUSTOM_FIELDS = 'customfield_10401,customfield_10883,customfield_11380,customfield_10203,customfield_10236,customfield_11404,customfield_10016,customfield_10665';

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

async function importIssueFromJira(localKey: string, opts?: { defaultDepartment?: string }): Promise<ReturnType<typeof formatIssue> | null> {
  try {
    const prefix = localKey.split('-')[0];
    const meta = PREFIX_TO_META[prefix];
    if (!meta) return null;

    // L1BOAR keys don't match CFITS keys Ã¢â‚¬â€ can't look up by key directly
    if (prefix === 'L1BOAR') return null;

    const jiraKey = localKey; // key prefix matches Jira project for all other boards

    const creds = await getJiraCredentials();
    const fields = `summary,description,issuetype,priority,status,assignee,reporter,parent,labels,comment,created,updated,${JIRA_CUSTOM_FIELDS}`;
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
          productionTicket: extractJiraValue(f.customfield_10665) ?? existingIssue.productionTicket,
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
          productionTicket: extractJiraValue(f.customfield_10665),
          // Preserve real Jira history instead of stamping "now" -- these feed
          // aging/SLA/timeline analytics, so a bulk backfill imported today
          // must still show its issues' true original creation dates.
          createdAt: f.created ? new Date(f.created) : undefined,
          updatedAt: f.updated ? new Date(f.updated) : undefined,
        },
      });
      issueId = created.id;
      // current_department isn't in the Prisma schema (added via a raw
      // migration) -- every other place in this file sets it with a plain
      // UPDATE rather than through the Prisma client, so do the same here.
      if (opts?.defaultDepartment) {
        await pool.query(`UPDATE issues SET current_department = $1 WHERE id = $2`, [opts.defaultDepartment, issueId]);
      }
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

// Projects that get an automatic, recurring catch-up sync from Jira -- see
// runJiraIssueSync below. Add a prefix here to bring another board under the
// same "never miss new tickets again" coverage. Only valid for boards where
// the local key IS the Jira key (confirmed true for L2B/L3B). CFITS is NOT
// one of these -- see importCfitsIssue below for why.
const SYNC_PROJECTS: { prefix: string; jiraProject: string }[] = [
  { prefix: 'L2B', jiraProject: 'L2B' },
  { prefix: 'L3B', jiraProject: 'L3B' },
];

const CFITS_JIRA_PROJECT = 'CFITS';
const CFITS_LOCAL_PREFIX = 'L1BOAR';
const CFITS_SPACE_KEY = 'TESTIN';
// Confirmed from real data, not assumed: 7465 of the 7468 already-migrated
// L1BOAR tickets are current_department = 'Migration' -- unlike L2B/L3B
// (which default to 'Dev'), this board is the Migration team's queue.
const CFITS_DEFAULT_DEPARTMENT = 'Migration';

// Mirrors the exact key-allocation logic POST /issues (the real "create
// ticket" endpoint) already uses: ONE counter shared across the whole
// space, not one per prefix -- confirmed from real data before writing
// this (the newest L1BOAR tickets created directly in the app, not
// migrated, sit in the 15000s: the same range L2B was in at the time,
// because both draw from the same space-wide MAX(...)+1). A separate
// per-prefix counter here would eventually hand out a key that collides
// with one the real create-issue flow already gave someone else.
async function allocateNextLocalKey(prefix: string, spaceId: string): Promise<string> {
  const r = await pool.query(
    `SELECT COALESCE(MAX(
       CASE WHEN SPLIT_PART(key, '-', ARRAY_LENGTH(STRING_TO_ARRAY(key, '-'), 1)) ~ '^[0-9]+$'
            THEN CAST(SPLIT_PART(key, '-', ARRAY_LENGTH(STRING_TO_ARRAY(key, '-'), 1)) AS INTEGER)
            ELSE 0 END
     ), 0) AS maxnum FROM issues WHERE "spaceId" = $1`,
    [spaceId]
  );
  const next = (parseInt(r.rows[0]?.maxnum || '0', 10) || 0) + 1;
  return `${prefix}-${next}`;
}

// CFITS needs its own import path instead of reusing importIssueFromJira:
// local L1BOAR keys have NO relationship to Jira CFITS-N numbers (e.g. local
// L1BOAR-7603 maps to real Jira CFITS-8110) -- the mapping lives entirely in
// the jira_source_key column. importIssueFromJira assumes jiraKey===localKey,
// which is only true for L2B/L3B; that's why it explicitly refuses L1BOAR.
async function importCfitsIssue(cfitsKey: string): Promise<string | null> {
  try {
    // Keyed by jira_source_key, not by a matching local key -- see above.
    const already = await pool.query(`SELECT key FROM issues WHERE jira_source_key = $1 LIMIT 1`, [cfitsKey]);
    if (already.rows[0]) return already.rows[0].key;

    const creds = await getJiraCredentials();
    const fields = `summary,description,issuetype,priority,status,assignee,reporter,parent,labels,comment,created,updated,${JIRA_CUSTOM_FIELDS}`;
    const res = await fetch(`${creds.base}/rest/api/3/issue/${cfitsKey}?fields=${fields}&expand=changelog`, {
      headers: { Authorization: creds.authHdr, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const ji: any = await res.json();
    const f = ji.fields || {};

    const space = await db.space.findUnique({ where: { key: CFITS_SPACE_KEY }, include: { statuses: true } });
    if (!space) return null;

    const jiraStatusName: string = f.status?.name || 'Open';
    const localStatus = space.statuses.find(
      (s: any) => s.name.toLowerCase() === jiraStatusName.toLowerCase()
    ) ?? space.statuses[0] ?? null;

    const resolveByDisplayName = async (jiraUser: any): Promise<string | null> => {
      if (!jiraUser?.displayName) return null;
      const name = jiraUser.displayName.trim();
      const parts = name.split(/\s+/);
      const byFull = await db.user.findFirst({
        where: { firstName: { equals: parts[0], mode: 'insensitive' },
                  lastName: { equals: parts.slice(1).join(' '), mode: 'insensitive' } },
      });
      if (byFull) return byFull.id;
      if (jiraUser.emailAddress) {
        const byEmail = await db.user.findFirst({ where: { email: { equals: jiraUser.emailAddress, mode: 'insensitive' } } });
        if (byEmail) return byEmail.id;
      }
      const byFirst = await db.user.findFirst({ where: { firstName: { equals: parts[0], mode: 'insensitive' } } });
      return byFirst?.id ?? null;
    };

    const [assigneeId, reporterId] = await Promise.all([
      resolveByDisplayName(f.assignee),
      resolveByDisplayName(f.reporter),
    ]);

    const localKey = await allocateNextLocalKey(CFITS_LOCAL_PREFIX, space.id);

    const created = await db.issue.create({
      data: {
        id: rid(), key: localKey,
        summary: f.summary || localKey,
        description: f.description ? (typeof f.description === 'object' ? adfNodeToHtml(f.description) : f.description) : null,
        type: (f.issuetype?.name || 'task').toLowerCase(),
        priority: (f.priority?.name || 'medium').toLowerCase(),
        spaceId: space.id, statusId: localStatus?.id ?? null,
        assigneeId, reporterId,
        labels: Array.isArray(f.labels) ? f.labels : [],
        customerName:   extractJiraValue(f.customfield_10401),
        clientName:     extractJiraValue(f.customfield_10883),
        projectManager: extractJiraValue(f.customfield_11380),
        productType:    extractJiraValue(f.customfield_10203),
        combination:    extractJiraValue(f.customfield_10236),
        productionTicket: extractJiraValue(f.customfield_10665),
        // Real Jira history, not "now" -- see the same note in importIssueFromJira.
        createdAt: f.created ? new Date(f.created) : undefined,
        updatedAt: f.updated ? new Date(f.updated) : undefined,
      },
    });
    // current_department and jira_source_key aren't in the Prisma schema
    // (added via raw migrations) -- set with a plain UPDATE like every other
    // place in this file that touches them. This UPDATE, not the create
    // above, is where the "already migrated?" race actually lands: two
    // concurrent calls for the same cfitsKey both pass the SELECT check at
    // the top, both create a distinct local issue (different allocated
    // keys, so that insert never conflicts), and then both try to stamp the
    // same jira_source_key here -- the unique index added above lets the
    // second one fail loudly instead of silently duplicating the ticket.
    try {
      await pool.query(
        `UPDATE issues SET current_department = $1, jira_source_key = $2 WHERE id = $3`,
        [CFITS_DEFAULT_DEPARTMENT, cfitsKey, created.id]
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        // Lost the race -- another call already migrated this cfitsKey.
        // Roll back the orphaned issue row this call created and defer to
        // the winner instead of leaving a duplicate/half-tagged ticket.
        await db.issue.delete({ where: { id: created.id } }).catch(() => {});
        const winner = await pool.query(`SELECT key FROM issues WHERE jira_source_key = $1 LIMIT 1`, [cfitsKey]);
        return winner.rows[0]?.key ?? null;
      }
      throw e;
    }

    const jiraComments: any[] = f.comment?.comments || [];
    for (const jc of jiraComments) {
      const commentAuthorId = await resolveByDisplayName(jc.author);
      const body = typeof jc.body === 'object' ? adfNodeToHtml(jc.body) : (jc.body || '');
      await db.comment.create({
        data: {
          id: rid(), body: body || '(empty)', issueId: created.id,
          authorId: commentAuthorId,
          authorName: jc.author?.displayName ?? null,
          authorEmail: null,
          createdAt: new Date(jc.created),
          updatedAt: new Date(jc.updated || jc.created),
        },
      });
    }

    const changelog: any[] = ji.changelog?.histories || [];
    const histRecs: any[] = [];
    for (const entry of changelog) {
      const authorName = entry.author?.displayName ?? null;
      for (const item of entry.items || []) {
        histRecs.push({
          id: rid(), issueId: created.id, field: item.field?.toLowerCase() || '',
          oldValue: item.fromString ?? null, newValue: item.toString ?? null,
          authorName, authorEmail: null, createdAt: new Date(entry.created),
        });
      }
    }
    if (histRecs.length > 0) await db.issueHistory.createMany({ data: histRecs });

    return localKey;
  } catch (e) {
    console.error('[importCfitsIssue] error:', e);
    return null;
  }
}

async function ensureAppSettingsTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`
  );
}

// jira_source_key only ever had a plain (non-unique) index. That's fine for
// L2B/L3B, which dedupe on the real `key` unique constraint instead, but
// importCfitsIssue dedupes by looking up jira_source_key first -- and this
// app's dev server has been observed to invoke its own boot sequence more
// than once concurrently (Next.js re-running instrumentation's register()),
// plus a sync run can legitimately take longer than the 5-minute interval
// between periodic ticks. Either case is a real window for two concurrent
// calls to both see "not migrated yet" for the same CFITS key and each
// create a separate local ticket for it. A real unique index turns that
// into a loud, catchable constraint violation instead of a silent
// duplicate. Confirmed zero existing duplicate jira_source_key values
// before adding this, so it's safe to create unconditionally.
async function ensureJiraSourceKeyUniqueIndex(): Promise<void> {
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_source_key_unique ON issues (jira_source_key) WHERE jira_source_key IS NOT NULL`
  );
}

// The sync checkpoint is the highest Jira issue-number already pulled in for
// a project. Deliberately NOT based on "created" timestamp: `ORDER BY
// created ASC` on this Jira instance returns issues wildly out of key order
// (e.g. L2B-5112 before L2B-11022) -- almost certainly issues moved into this
// project from elsewhere that kept their original creation date. A
// created-timestamp checkpoint would permanently skip any such ticket whose
// preserved date is older than the checkpoint. Issue *key numbers* are
// strictly increasing per Jira project regardless of that, so they're the
// only safe cursor for "have we seen this one yet".
async function getSyncCheckpoint(prefix: string): Promise<number> {
  await ensureAppSettingsTable();
  const row = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [`jira_sync_last_num_${prefix}`]);
  if (row.rows[0]) return parseInt(row.rows[0].value, 10) || 0;
  // No checkpoint yet -- bootstrap from whatever's already the highest local key
  // for this prefix, so first run only pulls what's genuinely missing.
  const r = await pool.query(
    `SELECT key FROM issues WHERE key LIKE $1 ORDER BY (regexp_replace(key, '^.*-', ''))::int DESC LIMIT 1`,
    [`${prefix}-%`]
  );
  return r.rows[0] ? (parseInt(r.rows[0].key.split('-').pop() || '0', 10) || 0) : 0;
}

async function setSyncCheckpoint(prefix: string, num: number): Promise<void> {
  await ensureAppSettingsTable();
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [`jira_sync_last_num_${prefix}`, String(num)]
  );
}

// Same storage shape as getSyncCheckpoint (reuses setSyncCheckpoint('CFITS', n)
// to persist), but a different bootstrap query: CFITS has no local key to
// scan since local L1BOAR numbers don't match Jira CFITS numbers at all (see
// importCfitsIssue) -- the highest already-migrated CFITS number instead
// lives in jira_source_key.
async function getCfitsSyncCheckpoint(): Promise<number> {
  await ensureAppSettingsTable();
  const row = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [`jira_sync_last_num_CFITS`]);
  if (row.rows[0]) return parseInt(row.rows[0].value, 10) || 0;
  const r = await pool.query(
    `SELECT jira_source_key FROM issues WHERE jira_source_key LIKE 'CFITS-%' ORDER BY (regexp_replace(jira_source_key, '^.*-', ''))::int DESC LIMIT 1`
  );
  return r.rows[0] ? (parseInt(r.rows[0].jira_source_key.split('-').pop() || '0', 10) || 0) : 0;
}

// Pulls every Jira issue created after the last-seen key number for each
// project in SYNC_PROJECTS and imports the ones missing locally, defaulting
// them into the Dev queue (matching how these boards are actually used --
// 14900+ of the ~14916 existing local L2B issues are already current_department
// = 'Dev'). Safe to call repeatedly/concurrently-ish: every issue is
// existence-checked by its unique key right before import, so nothing is
// ever duplicated even if a key gets seen again before its checkpoint commits.
// `maxPerRun` bounds how many issues one call will process -- callers reached
// over HTTP (with a real timeout) should pass a small number; the in-process
// scheduler in instrumentation.ts can afford to leave it high since it isn't
// subject to any request timeout.
// True while a sync is running, in this process. A single run has taken as
// long as ~5 minutes (a full backlog under the 500-per-call cap) -- right at
// the boundary of the periodic 5-minute interval in instrumentation.ts, so a
// slow run and the next scheduled tick WILL overlap under normal operation,
// not just as some rare edge case. Confirmed happening: two concurrent
// importCfitsIssue calls both passed the "not migrated yet" check for the
// same Jira ticket and both tried to create a local copy, one of them
// failing on the key collision. This flag makes an overlapping call a no-op
// instead of a second call actually racing the first.
let _jiraSyncRunning = false;

export async function runJiraIssueSync(maxPerRun: number = 5000): Promise<{ imported: string[]; errors: string[] }> {
  if (_jiraSyncRunning) {
    return { imported: [], errors: ['sync already in progress in this process, skipped'] };
  }
  _jiraSyncRunning = true;
  try {
  const imported: string[] = [];
  const errors: string[] = [];
  const creds = await getJiraCredentials();
  for (const { prefix, jiraProject } of SYNC_PROJECTS) {
    if (imported.length + errors.length >= maxPerRun) break;
    let checkpoint = await getSyncCheckpoint(prefix);
    let pageToken: string | undefined;
    // Fixed for the whole pagination sweep -- a nextPageToken is only valid
    // against the exact jql it was issued for. Recomputing jql each page
    // using the (by-then-advanced) `checkpoint` produced a jql that no
    // longer matched the token from the previous page's response, and Jira
    // rejected the mismatched pair with a 400 on every page after the first.
    const jql = encodeURIComponent(`project = ${jiraProject} AND issuekey > ${prefix}-${checkpoint} ORDER BY issuekey ASC`);
    while (imported.length + errors.length < maxPerRun) {
      let url = `${creds.base}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary`;
      if (pageToken) url += `&nextPageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetch(url, {
        headers: { Authorization: creds.authHdr, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      }).catch((e) => { errors.push(`${prefix}: search fetch failed: ${e?.message || e}`); return null; });
      if (!res) break;
      if (!res.ok) { errors.push(`${prefix}: search HTTP ${res.status}`); break; }
      const data: any = await res.json().catch(() => null);
      if (!data) { errors.push(`${prefix}: bad JSON from search`); break; }
      const keys: string[] = (data.issues || []).map((i: any) => i.key);
      if (keys.length === 0) break;
      for (const key of keys) {
        if (imported.length + errors.length >= maxPerRun) break;
        try {
          const existing = await db.issue.findUnique({ where: { key }, select: { id: true } });
          // Advance the checkpoint on confirmed success only (imported, or
          // already existed -- e.g. from the on-demand fallback) -- NOT on
          // failure. A failed import that still advanced the checkpoint
          // would be permanently skipped, since the next run's JQL only
          // asks for keys AFTER the checkpoint. Re-scanning a
          // still-succeeded key next run is safe/cheap: this existence
          // check just finds it and moves on.
          let ok = !!existing;
          if (!existing) {
            const result = await importIssueFromJira(key, { defaultDepartment: 'Dev' });
            if (result) { imported.push(key); ok = true; } else { errors.push(`${key}: import returned null`); }
          }
          if (ok) {
            const num = parseInt(key.split('-').pop() || '0', 10);
            if (num > checkpoint) { checkpoint = num; await setSyncCheckpoint(prefix, checkpoint); }
          }
        } catch (e: any) {
          errors.push(`${key}: ${e?.message || e}`);
        }
        // Gentle pacing so a ~1000-issue backlog doesn't hammer Jira Cloud's
        // rate limits in one burst.
        await new Promise((r) => setTimeout(r, 250));
      }
      if (data.isLast || !data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  // CFITS is handled separately from SYNC_PROJECTS above: its local key
  // (L1BOAR-N) has no relationship to the Jira key (CFITS-N) -- see
  // importCfitsIssue/allocateNextLocalKey. Checkpointing and pagination
  // follow the same shape, just keyed by the Jira issue number instead of a
  // (nonexistent) matching local key.
  if (imported.length + errors.length < maxPerRun) {
    await ensureJiraSourceKeyUniqueIndex();
    let cfitsCheckpoint = await getCfitsSyncCheckpoint();
    let cfitsPageToken: string | undefined;
    const cfitsJql = encodeURIComponent(`project = ${CFITS_JIRA_PROJECT} AND issuekey > ${CFITS_JIRA_PROJECT}-${cfitsCheckpoint} ORDER BY issuekey ASC`);
    while (imported.length + errors.length < maxPerRun) {
      let url = `${creds.base}/rest/api/3/search/jql?jql=${cfitsJql}&maxResults=50&fields=summary`;
      if (cfitsPageToken) url += `&nextPageToken=${encodeURIComponent(cfitsPageToken)}`;
      const res = await fetch(url, {
        headers: { Authorization: creds.authHdr, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      }).catch((e) => { errors.push(`CFITS: search fetch failed: ${e?.message || e}`); return null; });
      if (!res) break;
      if (!res.ok) { errors.push(`CFITS: search HTTP ${res.status}`); break; }
      const data: any = await res.json().catch(() => null);
      if (!data) { errors.push('CFITS: bad JSON from search'); break; }
      const cfitsKeys: string[] = (data.issues || []).map((i: any) => i.key);
      if (cfitsKeys.length === 0) break;
      for (const cfitsKey of cfitsKeys) {
        if (imported.length + errors.length >= maxPerRun) break;
        try {
          const localKey = await importCfitsIssue(cfitsKey);
          // Same rule as the L2B/L3B loop above: only advance past a key
          // once it's confirmed migrated (or already was) -- not on failure.
          if (localKey) {
            imported.push(`${cfitsKey} -> ${localKey}`);
            const num = parseInt(cfitsKey.split('-').pop() || '0', 10);
            if (num > cfitsCheckpoint) { cfitsCheckpoint = num; await setSyncCheckpoint('CFITS', cfitsCheckpoint); }
          } else {
            errors.push(`${cfitsKey}: import returned null`);
          }
        } catch (e: any) {
          errors.push(`${cfitsKey}: ${e?.message || e}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (data.isLast || !data.nextPageToken) break;
      cfitsPageToken = data.nextPageToken;
    }
  }

  return { imported, errors };
  } finally {
    _jiraSyncRunning = false;
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
          // Every issue is shown to users only by its CF-prefixed display key
          // -- row.key is the internal column. runMonitorAgentScan's own
          // SLA_BREACH notifications already key off cf_key || key (both for
          // display AND for this exact dedup lookup); this scanner used the
          // raw internal key for both, so the two scanners' notification
          // rows never matched each other and could double-notify the same
          // breach on top of showing the wrong key.
          const displayKey = row.cf_key || row.key;
          // Avoid duplicate notifications within 1 hour
          const already = await (db as any).notification.findFirst({
            where: { issueKey: displayKey, type: 'SLA_BREACH',
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
            title: `SLA breaching in ${minsLeft} min: ${displayKey}`,
            message: `${policy.name || 'SLA'} will breach in ${minsLeft} minutes. Issue: ${row.summary || displayKey}`,
            issueKey: displayKey,
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
              issueKey: displayKey,
              issueSummary: row.summary || displayKey,
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
  touchLastSeen(userId);
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
    // This unconditionally hardcoded role: 'admin' for every user in
    // development mode (skipping the DB lookup entirely, even when the DB
    // was working fine and the user existed) -- meant as a fallback for a
    // genuinely unreachable DB, but ran unconditionally instead. That
    // silently made every locally-tested account "admin" regardless of its
    // real role, so any role-gated behavior (space admin, permission
    // checks, etc.) was impossible to verify locally -- it always looked
    // like it worked because everyone was secretly an admin. Try the real
    // DB record first; only fall back to decoding identity from the JWT's
    // own claims if the DB is genuinely unreachable or the user row is
    // missing.
    try {
      const dbUser = await db.user.findUnique({ where: { id: userId } });
      if (dbUser) return json(formatUser(dbUser));
    } catch { /* DB unreachable -- fall through to dev fallback below */ }
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
    return json({ error: 'Unauthorized' }, 401);
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
  // instrumentation.ts's own scheduled background jobs have no user session
  // to send -- they authenticate with this per-process secret instead (see
  // internal-job-secret.ts). Scoped to one specific path rather than a
  // blanket bypass, since anything landing here has no session to audit.
  const isInternalJob = (path === 'jira-issue-sync' || path === 'admin/backfill-client-names')
    && req.headers.get('x-internal-job-secret') === INTERNAL_JOB_SECRET;

  if (!userId && !isPublicPath && !isInternalJob) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Load current user for role checks (cached 60s to avoid a DB round-trip on every request)
  const currentUser = userId ? await getCachedUser(userId) : null;
  const isAdmin = currentUser?.role === 'admin' || isInternalJob;

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
      create: { spaceId: sp.id, userId: uid, role: String(body.role || 'dev') },
      update: { role: String(body.role || 'dev') },
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
      //
      // That event log is ONLY written by in-app pass/return/close actions though
      // -- a ticket resolved via the old Jira migration (its status set by a raw
      // backfill, never through the app's own "close" flow) has no such row, so
      // it never showed up here even though it's clearly done and clearly this
      // person's. UNION in a second source: any ticket currently resolved/closed
      // in this dept that this person currently owns, live off `issues` directly,
      // no event history required. Dedup by issue id since a ticket can match
      // both sources.
      const mergedSourceSql = `
        SELECT qct.issue_id, qct.closed_at, qct.dept_name
        FROM queue_closed_tickets qct
        JOIN user_worked_on_tickets w ON w.issue_id = qct.issue_id AND LOWER(w.dept) = LOWER(qct.dept_name)
        WHERE qct.space_id = $1 AND LOWER(qct.dept_name) = LOWER($2) AND w.user_id = $3
        UNION ALL
        SELECT i.id AS issue_id, i."updatedAt" AS closed_at, i.current_department AS dept_name
        FROM issues i
        LEFT JOIN statuses s ON s.id = i."statusId"
        WHERE i."spaceId" = $1 AND LOWER(i.current_department) = LOWER($2)
          AND s.category = 'done'
          AND COALESCE(i.department_assignee_id, i."assigneeId") = $3
      `;
      const rows = await pool.query(
        `WITH merged AS (${mergedSourceSql}),
         dedup AS (SELECT issue_id, MAX(closed_at) AS closed_at, MAX(dept_name) AS dept_name FROM merged GROUP BY issue_id)
         SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.summary AS title, i.priority, i.type,
                i."createdAt", i."updatedAt", i."resolvedAt", i.dept_sla_started_at, i.jira_sla_breached,
                d.closed_at, d.dept_name,
                s.name AS status_name, s.color AS status_color, s.category AS status_category,
                i.dept_sla_log, i.dept_assignees, i.dept_statuses,
                CONCAT(a."firstName",' ',a."lastName") AS assignee_name, a."avatarUrl" AS assignee_avatar,
                a.id AS assignee_id
         FROM dedup d
         JOIN issues i ON i.id = d.issue_id
         LEFT JOIN statuses s ON i."statusId" = s.id
         LEFT JOIN users a ON i."assigneeId" = a.id
         ORDER BY COALESCE(i."updatedAt", d.closed_at) DESC LIMIT $4 OFFSET $5`,
        [spaceId, dept, targetUserId, limit, (page - 1) * limit]
      );
      const countRes = await pool.query(
        `WITH merged AS (${mergedSourceSql}) SELECT COUNT(DISTINCT issue_id) FROM merged`,
        [spaceId, dept, targetUserId]
      );
      // "Breached" on this list was always showing "No" for every ticket --
      // the response never included any breach field at all, so the
      // frontend's `issue.sla_breached ? 'Yes' : 'No'` check was reading
      // `undefined` every time. Compute it the same way the resolution-sla
      // report and Team Analytics do: live via computeSLAInstancesPure when
      // there's a real resolvedAt and a matching policy (using THIS dept's
      // own snapshot, not the ticket's current global department, since
      // "Worked on — Dev" should judge breach from Dev's own perspective
      // even after the ticket has since moved elsewhere), falling back to
      // the historical jira_sla_breached flag otherwise.
      const slaPoliciesRes = await pool.query(
        `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`,
        [spaceId]
      );
      const slaPolicies = slaPoliciesRes.rows;
      // "Worked on — Dev" showed the ticket's CURRENT global assignee, which is
      // whoever holds it now (possibly in a different dept after further
      // transfers) — not who was actually assigned while it sat in THIS dept.
      // A ticket someone worked in Dev before it moved on and got reassigned
      // elsewhere showed the new owner's name here instead of theirs. Prefer
      // the per-dept snapshot taken when the ticket left this dept.
      //
      // The exact same problem applied to status_name/color/category, just
      // never fixed alongside it: they came straight from the LIVE statuses
      // join on the ticket's current global statusId. Resolving a ticket in
      // Dev, then handing it back to Migration (which restores Migration's
      // own prior status, e.g. "In Progress" per computeSLAInstancesPure's
      // dept-handoff rules) changed what this supposedly-historical "Worked
      // on — Dev" row showed, even though Dev's own record of it never
      // stopped being "Resolved". Prefer the per-dept status snapshot the
      // same way, so this list reflects what Dev actually did, not whatever
      // the ticket's global status happens to read right now.
      const issues = rows.rows.map((r: any) => {
        const deptAssignees: Record<string, any> = r.dept_assignees || {};
        const snapKey = Object.keys(deptAssignees).find((k) => k.toLowerCase() === String(r.dept_name || '').toLowerCase());
        const snap = snapKey ? deptAssignees[snapKey] : null;
        const deptStatuses: Record<string, any> = r.dept_statuses || {};
        const statusSnapKey = Object.keys(deptStatuses).find((k) => k.toLowerCase() === String(r.dept_name || '').toLowerCase());
        const statusSnap = statusSnapKey ? deptStatuses[statusSnapKey] : null;
        const { dept_assignees, dept_statuses, ...rest } = r;
        const withStatus = statusSnap
          ? { ...rest, status_name: statusSnap.name, status_color: statusSnap.color, status_category: statusSnap.category }
          : rest;

        let slaBreached = false;
        if (r.resolvedAt) {
          const instances = computeSLAInstancesPure(
            { ...withStatus, current_department: r.dept_name, status: { name: withStatus.status_name, category: withStatus.status_category } },
            slaPolicies,
            false
          );
          slaBreached = instances.length ? instances.some((x: any) => x.isBreached) : (typeof r.jira_sla_breached === 'boolean' && r.jira_sla_breached);
        } else if (typeof r.jira_sla_breached === 'boolean') {
          slaBreached = r.jira_sla_breached;
        }

        if (snap && snap.id) {
          return { ...withStatus, sla_breached: slaBreached, assignee_id: snap.id, assignee_name: `${snap.firstName || ''} ${snap.lastName || ''}`.trim(), assignee_avatar: snap.avatarUrl || null };
        }
        return { ...withStatus, sla_breached: slaBreached };
      });

      // "Worked on" is meant to be the record of tickets THIS queue is actually
      // done with -- but user_worked_on_tickets' 'passed' entries fire on any
      // handoff, whether or not the ticket had reached a done status yet, so a
      // ticket merely passed along mid-work (still "In Progress" per this
      // queue's own status_category, matching the frozen dept_statuses snapshot
      // above) showed up here as if it were closed, even though it's still
      // actively open work that belongs in "Assigned to me" until it's actually
      // resolved. Only keep entries whose status (this queue's own perspective)
      // is a real done-category status.
      const doneIssues = issues.filter((i: any) => i.status_category === 'done');

      return json({ issues: doneIssues, total: doneIssues.length });
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

      // Per-user breakdown -- every member of this queue. Two different
      // things, both needed:
      //  - ticketsWorked/slaBreached (range-aware, from user_worked_on_tickets)
      //    is throughput: how many tickets they passed/returned/closed in the
      //    selected window. That table is ONLY written on those three events
      //    -- never just because a ticket is sitting open/in-progress with
      //      someone -- so a ticket nobody has transitioned yet (including an
      //      old one from before this window) never shows up here, at ANY
      //      range, even "All time". That silently hid exactly the tickets
      //      people most need visibility into: their current backlog.
      //  - current{Total,Open,InProgress,Waiting,SlaBreached} below fixes that
      //    by reading live ticket ownership straight off `issues` (never
      //    date-filtered -- it's "right now", not a historical window).
      let memberIds: string[] = [];
      try {
        const queueRows = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKeyParam]);
        for (const row of queueRows.rows) {
          const q = (row.queues || []).find((qq: any) => (qq.name || '').toLowerCase() === dept.toLowerCase());
          if (q?.memberIds?.length) { memberIds = q.memberIds; break; }
        }
      } catch { /* no custom queue config */ }

      let perUser: any[] = [];
      let perUserByProduct: Record<string, any[]> = {};
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

        // Live current-state counts, keyed by the ticket's dept-scoped owner
        // (falls back to the general assignee when a dept-specific one isn't
        // set) -- deliberately NOT range-filtered, so an old ticket someone
        // is still sitting on always counts.
        const currentRes = await pool.query(
          `SELECT i.department_assignee_id, i."assigneeId", i."dueDate", i.jira_sla_breached, i."productType",
                  s.name AS status_name, s.category AS status_category
           FROM issues i
           LEFT JOIN statuses s ON s.id = i."statusId"
           WHERE i."spaceId" = $1 AND LOWER(i.current_department) = LOWER($2)`,
          [spaceId, dept]
        );
        const isWaitingCat = (name: string) => /wait|hold/i.test(name || '');
        const currentByUser: Record<string, { total: number; open: number; inProgress: number; waiting: number; done: number; slaBreached: number }> = {};
        // Same current-ticket-load breakdown as currentByUser above, but split
        // by productType -- Jira runs Content/Message/Email migration as
        // separate boards with their own dashboards, so "who's carrying the
        // load" needs its own answer per product line, not just one number
        // that blends all three together.
        const PRODUCT_TYPES = ['Content Migration', 'Message Migration', 'Email Migration'];
        const currentByUserByProduct: Record<string, Record<string, { total: number; done: number }>> = {};
        for (const r of currentRes.rows) {
          const owner: string | null = r.department_assignee_id || r.assigneeId;
          if (!owner || !memberIds.includes(owner)) continue;
          const bucket = (currentByUser[owner] ??= { total: 0, open: 0, inProgress: 0, waiting: 0, done: 0, slaBreached: 0 });
          const waiting = isWaitingCat(r.status_name);
          const isDone = r.status_category === 'done';
          bucket.total++;
          if (isDone) bucket.done++;
          else if (waiting) bucket.waiting++;
          else if (r.status_category === 'in_progress') bucket.inProgress++;
          else bucket.open++;
          const dueBreach = !isDone && r.dueDate && new Date(r.dueDate).getTime() < Date.now();
          if (!isDone && (r.jira_sla_breached || dueBreach)) bucket.slaBreached++;

          if (r.productType && PRODUCT_TYPES.includes(r.productType)) {
            const ptBucket = ((currentByUserByProduct[r.productType] ??= {})[owner] ??= { total: 0, done: 0 });
            ptBucket.total++;
            if (isDone) ptBucket.done++;
          }
        }

        perUser = Object.values(byUser).map((u: any) => {
          const cur = currentByUser[u.userId] || { total: 0, open: 0, inProgress: 0, waiting: 0, done: 0, slaBreached: 0 };
          return {
            userId: u.userId, firstName: u.firstName, lastName: u.lastName, email: u.email, avatarUrl: u.avatarUrl,
            ticketsWorked: u.ticketIds.size, slaBreachedInRange: u.slaBreachedIds.size,
            currentTotal: cur.total, currentOpen: cur.open, currentInProgress: cur.inProgress, currentWaiting: cur.waiting,
            currentDone: cur.done, slaBreached: cur.slaBreached,
          };
        }).sort((a: any, b: any) => b.currentTotal - a.currentTotal);

        perUserByProduct = Object.fromEntries(PRODUCT_TYPES.map((pt) => {
          const bucket = currentByUserByProduct[pt] || {};
          const rows = memberIds.map((uid) => {
            const u = byUser[uid];
            const b = bucket[uid] || { total: 0, done: 0 };
            return { userId: uid, firstName: u?.firstName, lastName: u?.lastName, email: u?.email, currentTotal: b.total, currentDone: b.done };
          }).sort((a, b) => b.currentTotal - a.currentTotal);
          return [pt, rows];
        }));
      }

      return json({
        range: { from: from.toISOString(), to: to.toISOString() },
        totalIssues: deptIssuesRes.rows.length,
        slaBreachedCount,
        statusBreakdown: Object.entries(statusMap).map(([name, v]) => ({ name, ...v })),
        priorityBreakdown: Object.entries(priorityMap).map(([priority, count]) => ({ priority, count })),
        perUser,
        perUserByProduct,
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
    // "Worked" -- backed by user_worked_on_tickets (see loadTeamAnalyticsScope's
    // 'worked' dateType for the same table/reasoning) -- only meaningful
    // together with a dept filter, since that table's dept column is what
    // scopes it; only applied in the dept-scoped branch below.
    const workedRange   = url.searchParams.get('workedRange');
    // Opt-in: attaches inProgressHrs (hours actually spent in an "In
    // Progress"-type status, not total ticket age) to every returned issue --
    // requires an extra issue_history query, so only paid by callers that
    // actually render it (the Filters page's "Time Spent" column).
    const includeTimeSpentParam = url.searchParams.get('includeTimeSpent') === 'true';
    const excludeDone   = url.searchParams.get('excludeDone') === 'true';
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    // SLA breach isn't a real SQL column -- it's computed live, per issue,
    // much further below. Read this early so the fetches below can skip
    // their own DB-level pagination when it's set: filtering AFTER an
    // already-paginated page only ever filtered whatever 50 rows happened
    // to be fetched, and reported that filtered subset's own size as if it
    // were the true total across the whole matching set.
    const slaBreachedParamEarly = url.searchParams.get('slaBreached');
    const needsSlaPrefilter = slaBreachedParamEarly === 'yes' || slaBreachedParamEarly === 'no';
    const SLA_PREFILTER_CAP = 5000;

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
      if (needsSlaPrefilter) {
        // Can't paginate at the DB level on a field that isn't a real column --
        // fetch a bounded candidate set instead; the SLA-breach block further
        // below filters it fully, and pagination happens in JS after that.
        issues = await db.issue.findMany({
          where: where as any,
          include: {
            status: true,
            assignee: true,
            reporter: true,
            space: { select: { key: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: SLA_PREFILTER_CAP,
        });
        total = issues.length; // placeholder -- corrected after breach filtering below
      } else {
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
      }

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
               LEFT JOIN statuses s ON i."statusId" = s.id
               WHERE i."spaceId" = ANY($1::text[])
                 AND LOWER(COALESCE(i.current_department, '')) != LOWER($2)
                 AND (s.category IS NULL OR s.category != 'done')
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
               AND (s.category IS NULL OR s.category != 'done')
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
      // "Queue" filter on the main /filters page (opt-in via queueMembersOnly) --
      // restricts to tickets whose assignee is an actual configured member of
      // this department's queue, instead of every ticket merely labeled with
      // the department. Scoped to this one caller via the flag rather than
      // folded into deptDeptMatchSql for every caller, since this same branch
      // also powers the department queue board pages (All Tickets/Unassigned/
      // Assigned to me), where "All Tickets" is expected to mean literally
      // every ticket in the department, not just its configured members.
      const queueMembersOnlyParam = url.searchParams.get('queueMembersOnly') === 'true';
      if (queueMembersOnlyParam && !workedRange) {
        try {
          const cq = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [(spaceKey || '').toUpperCase()]);
          const queues: any[] = cq.rows[0]?.queues || [];
          const q = queues.find((qq: any) => String(qq.name || '').toLowerCase() === deptParam.toLowerCase());
          const memberIds: string[] = Array.isArray(q?.memberIds) ? q.memberIds : [];
          deptExtraClauses.push(memberIds.length ? `i."assigneeId" = ANY($${deptParamIdx}::text[])` : '1=0');
          if (memberIds.length) { deptExtraParams.push(memberIds); deptParamIdx++; }
        } catch { /* ignore -- no restriction if lookup fails */ }
      }
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

      // "Worked" range (see workedRange declaration above) -- built here, after
      // deptExtraClauses' own params are finalized, so its parameter indices
      // don't collide with theirs.
      let workedRangeSql = '';
      if (workedRange) {
        const { from: workedFrom, to: workedTo } = parseDateRange(workedRange);
        const workedFromIdx = deptParamIdx++;
        const workedToIdx = deptParamIdx++;
        deptExtraParams.push(workedFrom, workedTo);
        workedRangeSql = ` AND w.worked_at >= $${workedFromIdx} AND w.worked_at <= $${workedToIdx}`;
        // Only count work by someone who currently has access to this queue --
        // e.g. selecting "Dev" shouldn't credit a ticket to Dev's worked-count
        // just because SOME person touched it while it briefly carried that
        // department label; it must have been a real Dev-access person who
        // did the work. Same "no config = no restriction" rule as
        // queueMembersOnly above -- a department with no queue config at all
        // imposes no restriction here either.
        try {
          const cqW = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [(spaceKey || '').toUpperCase()]);
          const queuesW: any[] = cqW.rows[0]?.queues || [];
          const qW = queuesW.find((qq: any) => String(qq.name || '').toLowerCase() === deptParam.toLowerCase());
          const memberIdsW: string[] = Array.isArray(qW?.memberIds) ? qW.memberIds : [];
          if (memberIdsW.length) {
            const memberIdx = deptParamIdx++;
            deptExtraParams.push(memberIdsW);
            workedRangeSql += ` AND w.user_id = ANY($${memberIdx}::text[])`;
          }
        } catch { /* ignore -- no restriction if lookup fails */ }
      }

      const deptDoneClause = deptExcludeDone ? `AND (s.category IS NULL OR s.category != 'done')` : '';
      // Plain case: ticket must currently be in this dept (and, if requested,
      // currently open). History case: ALSO match if this user has ever been
      // credited with working this ticket while it was in this dept — covers
      // it having since been resolved or handed to another department.
      // Worked case (opt-in via workedRange, e.g. the Filters page's "Queue"
      // + a "Worked" date filter): takes over the dept-match entirely, backed
      // by user_worked_on_tickets -- a ticket worked while sitting in this
      // dept counts for it even if it has since moved to another queue,
      // matching Team Analytics' 'worked' dateType semantic.
      // "Worked" used to count a ticket the instant ANY user_worked_on_tickets
      // row existed for this dept -- including a 'passed' handoff logged while
      // the ticket was still actively open (e.g. still "In Progress" per this
      // dept's own frozen status), so still-open work counted as if it were
      // done and finished. A ticket only really belongs under "worked"/closed
      // once it's actually done, judged from THIS dept's own perspective: its
      // live status while still current here, or its frozen dept_statuses
      // snapshot (case-insensitive key match, same as every other per-dept
      // snapshot read in this file) once it's moved on to another dept.
      const deptDeptMatchSql = workedRange
        ? `EXISTS (SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND LOWER(w.dept) = LOWER($2)${workedRangeSql})
           AND (
             (LOWER(i.current_department) = LOWER($2) AND s.category = 'done')
             OR (LOWER(i.current_department) != LOWER($2) AND EXISTS (
               SELECT 1 FROM jsonb_each(COALESCE(i.dept_statuses, '{}'::jsonb)) ds(k, v)
               WHERE LOWER(k) = LOWER($2) AND LOWER(v->>'category') = 'done'
             ))
           )`
        : historyAssigneeIdx
        ? `(
            (LOWER(i.current_department) = LOWER($2) AND i."assigneeId" = ANY($${historyAssigneeIdx}::text[]) ${deptDoneClause})
            OR EXISTS (
              SELECT 1 FROM user_worked_on_tickets w
              WHERE w.issue_id = i.id AND w.user_id = ANY($${historyAssigneeIdx}::text[]) AND LOWER(w.dept) = LOWER($2)
            )
          )`
        : `LOWER(i.current_department) = LOWER($2) ${deptDoneClause}`;

      if (needsSlaPrefilter) {
        deptTotal = 0; // placeholder -- corrected after breach filtering below
      } else {
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
      }

      try {
        const rowParams: any[] = [allSpaceIds, deptParam];
        if (deptSearchParam) rowParams.push(deptSearchParam);
        rowParams.push(...deptExtraParams);
        const limitIdx = rowParams.length + 1;
        const offsetIdx = rowParams.length + 2;
        // Same "can't paginate a non-SQL field" reasoning as the non-dept
        // branch above -- fetch a bounded candidate set instead of the real
        // page when an SLA-breach filter is active, and let the shared
        // filtering block further below paginate the actually-filtered result.
        rowParams.push(needsSlaPrefilter ? SLA_PREFILTER_CAP : limit, needsSlaPrefilter ? 0 : (page - 1) * limit);
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
        // Now the TRUE total across the full (up to SLA_PREFILTER_CAP)
        // candidate set fetched above, not just whatever page would have
        // been fetched under normal DB-level pagination. Slice to the
        // requested page here, since pagination couldn't happen at the DB
        // level on a field that isn't a real column.
        deptTotal = enrichedIssues.length;
        const sliceStart = (page - 1) * limit;
        enrichedIssues = enrichedIssues.slice(sliceStart, sliceStart + limit);
      }
    } catch { /* sla breach is best-effort */ }

    if (includeTimeSpentParam && enrichedIssues.length) {
      try {
        const histIds = enrichedIssues.map((i: any) => i.id);
        const histRows = await pool.query(
          `SELECT "issueId", "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = ANY($1::text[]) AND field = 'status' ORDER BY "issueId", "createdAt" ASC`,
          [histIds]
        );
        const histByIssue: Record<string, any[]> = {};
        for (const h of histRows.rows) (histByIssue[h.issueId] ??= []).push(h);
        enrichedIssues = enrichedIssues.map((i: any) => {
          const statusHist = histByIssue[i.id] || [];
          const isDone = i.status?.category === 'done';
          const { inProgressHrs, noHistory } = computeInProgressHours(statusHist, i.createdAt, isDone, i.resolvedAt, i.status?.name || null);
          return { ...i, inProgressHrs, noHistory };
        });
      } catch { /* time-spent is best-effort -- never block the list on it */ }
    }

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
    let resolvedReporterEmail: string | null = reporterByEmail?.email ?? null;
    if (!resolvedReporterId && userId) {
      const reporterUser = await db.user.findUnique({ where: { id: userId } });
      resolvedReporterId = reporterUser?.id ?? null;
      resolvedReporterEmail = reporterUser?.email ?? null;
    }
    // Client Name auto-fills from the reporter's email domain
    // (e.g. "name@cloudfuze.com" -> "cloudfuze.com") whenever the caller
    // doesn't explicitly set one, so a new ticket starts with a client
    // attributed instead of blank. Only kicks in when clientName was never
    // provided at all -- an explicit value (including an intentional empty
    // string to clear it) always wins.
    const autoClientName = resolvedReporterEmail ? resolvedReporterEmail.split('@')[1]?.toLowerCase() || null : null;
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
        ...(body.clientName !== undefined
          ? { clientName: body.clientName ? String(body.clientName) : null }
          : autoClientName ? { clientName: autoClientName } : {}),
        ...(body.projectManager !== undefined && { projectManager: body.projectManager ? String(body.projectManager) : null }),
        ...(body.productionTicket !== undefined && { productionTicket: body.productionTicket ? String(body.productionTicket) : null }),
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
    const displayKey = (issue as any).cf_key || issue.key;
    if (!issue.assigneeId) {
      try {
        const { notifyUnassignedTicket } = await import('@/lib/notification-service');
        const leadIds = await getSpaceLeadUserIds(sp.id, issueDept);
        if (leadIds.length) {
          const leadUsers = await db.user.findMany({ where: { id: { in: leadIds } }, select: { email: true } });
          const leadEmails = leadUsers.map((u: any) => u.email).filter(Boolean);
          notifyUnassignedTicket({
            issueKey: displayKey,
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
      { type: 'CREATED', title: `New issue: ${displayKey}`, message: issue.summary, issueKey: displayKey }
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

  // Resolves a "CF-####" display key to the actual internal storage key
  // (e.g. "L2B-482"). Every route below that accepts a ticket key needs this
  // exact same resolution -- previously each of ~11 call sites inlined it
  // separately, and every one of them silently fell back to treating the
  // unresolved "CF-####" as if it WERE the real key whenever this query
  // failed (a transient DB pool hiccup -- see pg-pool.ts's own history of
  // "Connection terminated due to connection timeout" on this exact
  // production box). Since "CF-####" never matches any real `issues.key`
  // value, that fallback produced a false "Issue not found" / silent no-op
  // that looked exactly like the ticket didn't exist, self-resolving on the
  // next attempt once the transient hiccup cleared. Retrying the resolution
  // once before giving up fixes the actual race instead of just papering
  // over the symptom.
  async function resolveCfKey(key: string): Promise<string> {
    if (!key.startsWith('CF-')) return key;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cfRow = await pool.query<{ key: string }>(`SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [key]);
        return cfRow.rows[0] ? cfRow.rows[0].key : key;
      } catch {
        if (attempt === 1) return key;
      }
    }
    return key;
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Department Change (COPY / PASS) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Original ticket stays untouched on source board.
  // A NEW ticket is created on the target board with same content, new key, RR assignee, reset status.
  // History entry is added to the original ticket.
  const issueDeptMatch = path.match(/^issues\/([^/]+)\/department$/);
  if (issueDeptMatch && method === 'PATCH') {
    let key = await resolveCfKey(issueDeptMatch[1].toUpperCase());
    // Resolve CF-key Ã¢â€ ' Prisma key
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
        deptMapSet(deptAssignees, oldDept, {
          id: issue.assignee.id,
          email: (issue.assignee as any).email,
          firstName: (issue.assignee as any).firstName,
          lastName: (issue.assignee as any).lastName,
          displayName: `${(issue.assignee as any).firstName} ${(issue.assignee as any).lastName}`.trim(),
          avatarUrl: avatarRef(issue.assignee.id, (issue.assignee as any).avatarUrl),
        });
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
      const isReturningToDept = deptMapGet(deptStatuses, newDept) != null;

      let newDeptQueueStatuses: any[] = [];
      try {
        const allQueueRows = await pool.query(`SELECT queues FROM custom_queues`);
        for (const row of allQueueRows.rows) {
          const queues: any[] = row.queues || [];
          const matchedQ = queues.find((q: any) => (q.name || '').toLowerCase() === newDept.toLowerCase());
          if (matchedQ?.queueStatuses?.length) { newDeptQueueStatuses = matchedQ.queueStatuses; break; }
        }
      } catch {}

      // Every department tracks its own status independently -- a status like
      // Resolved belongs to whichever dept actually resolved it, not to a dept
      // that's only now receiving the ticket. But a dept this ticket has
      // ALREADY visited is different: that dept has its own dept_statuses
      // snapshot of what the ticket looked like on ITS side right before it
      // left (e.g. Migration's "In Progress" before handing off to Dev) --
      // restore THAT instead of guessing.
      const restoringOwnSnapshot = isDoneNow && deptMapGet(deptStatuses, newDept) != null;

      let newDeptStatusObj: any;
      if (restoringOwnSnapshot) {
        newDeptStatusObj = deptMapGet(deptStatuses, newDept);
      } else if (isDoneNow || isReturningToDept) {
        // A dept the ticket already visited (isReturningToDept) means work
        // resumes there. A done ticket landing somewhere new (isDoneNow, not
        // restoring) means that dept needs to actually start working it --
        // neither should show as untouched, so both get "In Progress".
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
      {
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
        deptMapSet(deptStatuses, oldDept, issue.status
          ? { id: issue.status.id, name: issue.status.name, category: issue.status.category, color: issue.status.color }
          : oldDeptStatusObj);
      }
      deptMapSet(deptStatuses, newDept, newDeptStatusObj);

      // Restore previously saved assignee for this dept, or round-robin to a new one
      let rrAssigneeId: string | null = null;
      let rrAgentName: string | null = null;
      const savedAssigneeForNewDept = deptMapGet(deptAssignees, newDept);
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
        if (!savedAssigneeStillExists) deptMapDelete(deptAssignees, newDept);
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
            deptMapSet(deptAssignees, newDept, { id: rrAgent.userId, displayName: rrAgent.name });
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
        const devAssignee = deptMapGet(deptAssignees, newDept);
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
          // Every ticket is shown to users only by its CF-prefixed display
          // key -- `key` here is the internal column, never shown anywhere
          // else in the app.
          const displayKey = (issue as any).cf_key || key;
          // Notify reporter that ticket was sent to new dept
          if (issue.reporterId) {
            await notifyUsers(
              [issue.reporterId],
              userId,
              { type: 'DEPT_CHANGE', title: `Ticket ${displayKey} sent to ${newDept}`, message: `Your ticket "${issue.summary}" has been transferred to ${newDept}.`, issueKey: displayKey }
            );
          }
          // Notify the RR-assigned agent
          if (rrAssigneeId) {
            await notifyUsers(
              [rrAssigneeId],
              userId,
              { type: 'ASSIGNED', title: `Ticket assigned to you: ${displayKey}`, message: `You have been assigned to "${issue.summary}" in the ${newDept} queue.`, issueKey: displayKey }
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
              { type: 'DEPT_ASSIGNED', title: `New ticket in ${newDept}: ${displayKey}`, message: `Ticket "${issue.summary}" has arrived in the ${newDept} queue.`, issueKey: displayKey }
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
              { type: 'SLA_PAUSED', title: `SLA paused for ${displayKey}`, message: `Ticket "${issue.summary}" moved out of ${oldDept} — its SLA clock has been paused.`, issueKey: displayKey }
            );
          }
          if (rrAssigneeId) {
            await notifyUsers(
              [rrAssigneeId],
              userId,
              { type: 'SLA_RESUMED', title: `SLA running for ${displayKey}`, message: `Ticket "${issue.summary}" has arrived in ${newDept} — its SLA clock is now running.`, issueKey: displayKey }
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
        // The same UPDATE above also changes statusId whenever the arriving
        // dept's status differs from what the ticket had leaving the old one
        // (restoring newDept's own snapshot, carrying a done status through,
        // or defaulting to Open/In Progress) -- previously only the
        // department field got a history row, so a ticket resolved in QA and
        // routed back to Migration showed the transfer in History but not
        // that its status had also silently gone from "Resolved" back to
        // whatever Migration's own status actually was.
        if (newStatusId !== issue.statusId) {
          await (db as any).issueHistory.create({
            data: {
              id: rid(), issueId: issue.id, field: 'status',
              oldValue: oldDeptStatusObj.name,
              newValue: newDeptStatusObj.name,
              authorName: authorName2, createdAt: new Date(),
            },
          });
        }
        // Same gap as the status entry just above, but for the restore-or-
        // round-robin assignee logic (lines ~4533-4565): it silently changes
        // issues.assigneeId on every transfer -- restoring whoever newDept
        // had before, or round-robining someone new -- but nothing logged it,
        // unlike a plain assignee-dropdown change (the only other place in
        // this file writing field:'assignee'). A ticket bouncing between
        // departments correctly got the right person back each time, but its
        // History tab showed no record of that ever happening.
        if (rrAssigneeId !== (issue.assigneeId ?? null)) {
          await (db as any).issueHistory.create({
            data: {
              id: rid(), issueId: issue.id, field: 'assignee',
              oldValue: issue.assignee ? (`${(issue.assignee as any).firstName ?? ''} ${(issue.assignee as any).lastName ?? ''}`.trim() || (issue.assignee as any).email) : null,
              newValue: rrAgentName,
              authorName: authorName2, createdAt: new Date(),
            },
          });
        }
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
          key: updatedIssue.key, cfKey: extraCols.cf_key, summary: updatedIssue.summary, priority: updatedIssue.priority,
          spaceKey: updatedIssue.space?.key ?? '', spaceName: updatedIssue.space?.name ?? '',
          status: { name: updatedIssue.status?.name ?? newStatusName, category: updatedIssue.status?.category ?? 'todo' },
          assignee: updatedIssue.assignee, reporter: updatedIssue.reporter,
          updatedBy: userId ? await db.user.findUnique({ where: { id: userId } }) : null,
          changes: [{ field: 'Department', from: oldDept || 'None', to: newDept }],
        }).catch(() => {});
        // The "Department" email above never says WHO the ticket is now
        // assigned to — a separate "Issue Assigned" email is what actually
        // carries that, and it only fires here when the transfer changed
        // the assignee (round-robin picked someone new, or restored someone
        // different from who had it before leaving oldDept).
        if (rrAssigneeId && rrAssigneeId !== issue.assigneeId) {
          notifyIssueAssigned({
            key: updatedIssue.key, cfKey: extraCols.cf_key, summary: updatedIssue.summary, priority: updatedIssue.priority,
            spaceKey: updatedIssue.space?.key ?? '', spaceName: updatedIssue.space?.name ?? '',
            status: { name: updatedIssue.status?.name ?? newStatusName, category: updatedIssue.status?.category ?? 'todo' },
            assignee: updatedIssue.assignee, reporter: updatedIssue.reporter,
            previousAssignee: issue.assignee,
          }).catch(() => {});
        }
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
    const existingOnTarget = await pool.query(`SELECT id, cf_key FROM issues WHERE key = $1`, [newKey]);
    let newCfKey: string | null = existingOnTarget.rows[0]?.cf_key ?? null;
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
      // This INSERT never allocated a CF-prefixed display key, unlike every
      // other place a ticket gets created -- the cross-board ticket this
      // creates showed only its bare internal key (e.g. "L2BOARD-5618") in
      // every notification and history entry about it, never the CF- key
      // shown everywhere else in the app.
      try {
        const maxRow = await pool.query(`SELECT MAX(CAST(SUBSTRING(cf_key FROM 4) AS INTEGER)) AS mx FROM issues WHERE cf_key LIKE 'CF-%'`);
        const nextNum = (maxRow.rows[0]?.mx ?? 0) + 1;
        newCfKey = `CF-${nextNum}`;
        await pool.query(`UPDATE issues SET cf_key = $1 WHERE id = $2`, [newCfKey, newId]);
      } catch { newCfKey = null; }
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
    const displayKey = (issue as any).cf_key || key;
    const newDisplayKey = newCfKey || newKey;
    await (db as any).issueHistory.create({
      data: {
        id: rid(), issueId: issue.id, field: 'department',
        oldValue: (issue as any).current_department || 'None',
        newValue: `Passed to ${newDept} → ${targetSpace.key} (${newDisplayKey})`,
        authorName, createdAt: new Date(),
      },
    });

    // History on NEW ticket: created by department pass
    await (db as any).issueHistory.create({
      data: {
        id: rid(), issueId: newId, field: 'department',
        oldValue: 'Created',
        newValue: `Passed from ${issue.space?.key || ''} (${displayKey}) · Assignee: ${assigneeName} (Round Robin)`,
        authorName: 'System', createdAt: new Date(),
      },
    });

    // Notify the reporter + newly round-robined assignee about this
    // cross-board department pass — this branch previously sent NO
    // notification at all (no email, no in-app bell), so a reporter whose
    // ticket got routed to a different board's queue never found out.
    try {
      const newAssigneeUser = rrAgent?.userId
        ? await db.user.findUnique({ where: { id: rrAgent.userId } })
        : null;
      const targetStatusCategory = firstStatus?.category ?? 'todo';
      notifyIssueUpdated({
        key: newKey, cfKey: newCfKey, summary: issue.summary, priority: issue.priority,
        spaceKey: targetSpace.key, spaceName: (targetSpace as any).name ?? '',
        status: { name: newStatusName, category: targetStatusCategory },
        assignee: newAssigneeUser, reporter: issue.reporter,
        updatedBy: authorUser,
        changes: [{ field: 'Department', from: (issue as any).current_department || 'None', to: newDept }],
      }).catch(() => {});
      if (newAssigneeUser) {
        notifyIssueAssigned({
          key: newKey, cfKey: newCfKey, summary: issue.summary, priority: issue.priority,
          spaceKey: targetSpace.key, spaceName: (targetSpace as any).name ?? '',
          status: { name: newStatusName, category: targetStatusCategory },
          assignee: newAssigneeUser, reporter: issue.reporter,
        }).catch(() => {});
      }
      const inAppIds = [issue.reporterId, newAssigneeUser?.id].filter((id): id is string => !!id);
      if (inAppIds.length) {
        notifyUsers(
          inAppIds,
          userId,
          { type: 'DEPT_CHANGE', title: `Ticket ${newDisplayKey} created in ${targetSpace.key}`, message: `"${issue.summary}" was passed to ${newDept} on ${targetSpace.key} as ${newDisplayKey}.`, issueKey: newDisplayKey }
        ).catch(() => {});
      }
    } catch { /* notification failures shouldn't block the transfer */ }

    return json({ ok: true, department: newDept, newKey, targetBoardKey: targetSpace.key, assignee: rrAgent, newStatus: newStatusName });
  }

  // ── SLA Breach Waiver (admin only) ──────────────────────────────────────
  // Lets an admin mark a specific SLA policy's breach on a specific ticket as
  // waived -- e.g. it was resolved late for a reason outside anyone's
  // control -- so the ticket stops reading as breached, without altering
  // its actual recorded dates/history (see computeSLAInstancesPure).
  const slaWaiverMatch = path.match(/^issues\/([^/]+)\/sla-waiver$/);
  if (slaWaiverMatch && method === 'PATCH') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    let key = await resolveCfKey(slaWaiverMatch[1].toUpperCase());
    const body = await readJson(req);
    const policyId = String(body.policyId || '');
    const waived = body.waived !== false;
    if (!policyId) return json({ error: 'policyId is required' }, 400);

    const issueRow = await pool.query(`SELECT id, sla_waivers FROM issues WHERE key = $1 LIMIT 1`, [key]);
    if (!issueRow.rows[0]) return json({ error: 'Not found' }, 404);
    const waivers: Record<string, any> = issueRow.rows[0].sla_waivers || {};
    const actor = userId ? await getCachedUser(userId) : null;
    const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Admin';

    if (waived) {
      waivers[policyId] = {
        waivedBy: userId || null,
        waivedByName: actorName,
        waivedAt: new Date().toISOString(),
        reason: body.reason ? String(body.reason).slice(0, 300) : null,
      };
    } else {
      delete waivers[policyId];
    }

    await pool.query(`UPDATE issues SET sla_waivers = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`, [JSON.stringify(waivers), issueRow.rows[0].id]);

    try {
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail") VALUES ($1,$2,'sla',$3,$4,$5,$6)`,
        [
          rid(), issueRow.rows[0].id, null,
          waived ? `SLA breach waived${body.reason ? ' — ' + String(body.reason).slice(0, 200) : ''}` : 'SLA breach waiver removed',
          actorName, actor?.email || null,
        ]
      );
    } catch { /* non-critical */ }

    return json({ ok: true, waived });
  }

  const issueKeyMatch = path.match(/^issues\/([^/]+)$/);
  if (issueKeyMatch && method === 'GET') {
    const rawKey = issueKeyMatch[1].toUpperCase();
    // Timing instrumentation: a ticket-open timeout was reported in production
    // (times out once, works moments later for someone else opening the exact
    // same ticket) with no way to tell whether the DB, an external Jira call,
    // or something else was the actual cause -- every fix so far has been
    // informed guessing. This logs a per-phase breakdown whenever a load takes
    // more than 3s, so the NEXT occurrence points at the real bottleneck in
    // the server logs instead of another guess. Safe to leave on permanently
    // -- it's a few Date.now() calls and one console.warn, not a real cost.
    const _perfT0 = Date.now();
    const _perfMarks: Array<[string, number]> = [];
    const _mark = (label: string) => _perfMarks.push([label, Date.now() - _perfT0]);
    // Normalize key: strip Jira sub-issue colon suffix (e.g. "L2B-12718:1" Ã¢â€ ' "L2B-12718")
    let key = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
    key = await resolveCfKey(key);
    _mark('resolve-cf-key');
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
    _mark('primary-issue-fetch');
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
    // productionTicket is checked with its own OR, not folded into the
    // all-null AND above -- a ticket already fully synced before this field
    // existed has every other field populated, so the all-null check alone
    // would never re-visit Jira to pick up just this newer one.
    if (
      (issue.customerName === null && issue.clientName === null &&
       issue.projectManager === null && issue.productType === null && issue.combination === null)
      || issue.productionTicket === null
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
                  productionTicket: extractJiraValue(f.customfield_10665),
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
                    productionTicket: extractJiraValue(f.customfield_10665),
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
    const [suspendCheckQueues, dbAttachments, dbHistory, outLinksRaw, inLinksRaw, childIssues, rawDeptRow, partnerRows] = await Promise.all([
      // Only a non-admin can ever be suspended from a queue, so this is
      // skipped entirely for admins. Fetches the space's own custom_queues
      // row directly (rather than a separate current_department lookup +
      // THEN this, sequentially, once we knew which dept) -- the dept is
      // already coming out of rawDeptRow below in this same batch, so the
      // actual suspendedIds check below can run purely from data already in
      // hand instead of paying its own extra round trip after this Promise.all
      // resolves.
      (!isAdmin && issue.space?.key)
        ? pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [issue.space.key.toUpperCase()]).catch(() => ({ rows: [] as any[] }))
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
        `SELECT current_department, department_assignee_id, dept_sla_started_at, dept_assignees, dept_statuses, dept_sla_log, cf_key, "partnerKey", "resolvedAt", sla_waivers FROM issues WHERE key = $1 LIMIT 1`,
        [key]
      ).catch(() => ({ rows: [] as any[] })),
      // Partner-ticket comment merge lookup -- also only needs `key`.
      pool.query(
        `SELECT i.id FROM issues i WHERE i."partnerKey" = $1`,
        [key]
      ).catch(() => ({ rows: [] as any[] })),
    ]);
    _mark('batch-promise-all');

    if (!isAdmin && issue.space?.key && suspendCheckQueues) {
      try {
        const issueDept: string | undefined = rawDeptRow.rows[0]?.current_department;
        const queues: any[] = suspendCheckQueues.rows[0]?.queues || [];
        const q = issueDept ? queues.find((qq: any) => String(qq.name || '').toLowerCase() === issueDept.toLowerCase()) : null;
        const isSuspended = userId && Array.isArray(q?.suspendedIds) && q.suspendedIds.includes(userId);
        if (isSuspended) {
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

    // cf_key is a raw ALTER TABLE column Prisma doesn't know about (same gap
    // as childCfKeyMap below) -- without this, "Linked work items" always
    // showed the raw internal key (e.g. "L1BOAR-2164") instead of the CF-
    // key every other section uses, and the frontend's `li.cfKey ?? li.key`
    // fallback silently landed on the raw key every time.
    const linkedCfKeys = linkedKeys.length
      ? await pool.query<{ key: string; cf_key: string | null }>(
          `SELECT key, cf_key FROM issues WHERE key = ANY($1::text[])`,
          [linkedKeys]
        )
      : { rows: [] as { key: string; cf_key: string | null }[] };
    const linkedCfKeyMap = new Map(linkedCfKeys.rows.map(r => [r.key, r.cf_key]));

    // rawDeptData (this ticket's own cf_key) isn't assembled from rawDeptRow
    // until later in this function -- read it straight off rawDeptRow here
    // instead of waiting for that named variable.
    const ownCfKey: string | null = rawDeptRow.rows[0]?.cf_key ?? null;
    const allLinks = deduped.map(l => {
      const otherKey = l.sourceKey === key ? l.targetKey : l.sourceKey;
      const otherSummary = summaryMap.get(otherKey)?.summary ?? otherKey;
      const otherCfKey = linkedCfKeyMap.get(otherKey) ?? null;
      return {
        id: l.id, linkType: l.linkType, sourceKey: l.sourceKey, targetKey: l.targetKey,
        _sourceSummary: l.sourceKey === key ? issue.summary : otherSummary,
        _targetSummary: l.targetKey === key ? issue.summary : otherSummary,
        _sourceCfKey: l.sourceKey === key ? ownCfKey : otherCfKey,
        _targetCfKey: l.targetKey === key ? ownCfKey : otherCfKey,
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
      // Was one DB round trip per partner ticket, awaited one at a time --
      // a ticket handed between boards several times (each hop adds another
      // partnerKey row) paid that latency serially on every single load. None
      // of these queries depend on each other, so run them together instead.
      const partnerCommentSets = await Promise.all(
        partnerRows.rows.map((pr: any) =>
          db.comment.findMany({
            where: { issueId: pr.id },
            include: { author: true },
            orderBy: { createdAt: 'asc' },
          })
        )
      );
      for (const partnerComments of partnerCommentSets) {
        allComments = [...allComments, ...partnerComments];
      }
      // Deduplicate by id and sort by createdAt
      const seen = new Set<string>();
      allComments = allComments.filter((c: any) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
      allComments.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch { /* ignore */ }
    _mark('partner-comments-merge');

    const mergedIssue = { ...issue, comments: allComments, _links: allLinks, ...rawDeptData };
    const slaInstances = await enrichSlaWithResolver(
      mergedIssue.id, await computeIssueSLAsFromDb(mergedIssue), mergedIssue.spaceId, mergedIssue.current_department
    );
    _mark('sla-enrichment');
    const responsePayload: any = {
      ...formatIssue(mergedIssue as any), attachments, attachmentCount: attachments.length, children, activity, sla: slaInstances, customFieldValues: {},
    };
    _mark('format-response');

    // A ticket whose description or comments contain large embedded images
    // (pasted directly into the rich-text editor, stored as base64 data URIs
    // rather than real uploaded attachments) can balloon this response to
    // several MB. Unlike the issue-list endpoint (which always truncates
    // description to a short preview), this single-ticket endpoint needs the
    // real full content -- but an abnormally large response is exactly the
    // kind of payload a slow connection or an intermediate proxy can deliver
    // truncated, which surfaced to users as "Couldn't load this ticket" with
    // no indication why, and no way to recover by retrying since the size
    // never changes. Detect that case before sending and cap only the
    // oversized field(s) instead of failing outright -- a ticket that loads
    // with one huge comment trimmed is far better than one that never loads.
    try {
      const byteSize = Buffer.byteLength(JSON.stringify(responsePayload), 'utf8');
      const MAX_SAFE_BYTES = 3 * 1024 * 1024; // 3MB
      if (byteSize > MAX_SAFE_BYTES) {
        console.warn(`[GET /issues/${key}] Response is ${(byteSize / 1024 / 1024).toFixed(1)}MB — trimming oversized fields before sending.`);
        const MAX_FIELD_CHARS = 150_000;
        const TRUNCATE_NOTE = '\n\n[This content was too large to load in full and has been trimmed. Ask an admin to check the original ticket if you need the rest.]';
        if (typeof responsePayload.description === 'string' && responsePayload.description.length > MAX_FIELD_CHARS) {
          responsePayload.description = responsePayload.description.slice(0, MAX_FIELD_CHARS) + TRUNCATE_NOTE;
        }
        if (Array.isArray(responsePayload.comments)) {
          responsePayload.comments = responsePayload.comments.map((c: any) =>
            typeof c.body === 'string' && c.body.length > MAX_FIELD_CHARS
              ? { ...c, body: c.body.slice(0, MAX_FIELD_CHARS) + TRUNCATE_NOTE }
              : c
          );
        }
        // The History tab's activity feed stores the FULL old/new text of every
        // edited field (see the `track()` history-recorder above) -- for a
        // 'description' change that's the entire description, twice, on every
        // single edit. A ticket with a long description edited many times (the
        // Migration template tickets especially) can accumulate megabytes here
        // even when the CURRENT description and comments are both small and
        // already under their own caps above -- this was the one field this
        // guard didn't check, so it kept sending truncated responses for
        // exactly this class of ticket.
        if (Array.isArray(responsePayload.activity)) {
          responsePayload.activity = responsePayload.activity.map((a: any) => ({
            ...a,
            oldValue: typeof a.oldValue === 'string' && a.oldValue.length > MAX_FIELD_CHARS
              ? a.oldValue.slice(0, MAX_FIELD_CHARS) + TRUNCATE_NOTE : a.oldValue,
            newValue: typeof a.newValue === 'string' && a.newValue.length > MAX_FIELD_CHARS
              ? a.newValue.slice(0, MAX_FIELD_CHARS) + TRUNCATE_NOTE : a.newValue,
          }));
        }
      }
    } catch (e) {
      console.error(`[GET /issues/${key}] Failed to measure/trim response size:`, e);
    }
    _mark('size-guard');

    const _perfTotal = Date.now() - _perfT0;
    if (_perfTotal > 3000) {
      const breakdown = _perfMarks.map(([label, t], i) => `${label}=${t - (_perfMarks[i - 1]?.[1] ?? 0)}ms`).join(', ');
      console.warn(`[PERF] GET /issues/${key} took ${_perfTotal}ms -- ${breakdown} (cumulative: ${_perfMarks.map(([l, t]) => `${l}@${t}ms`).join(', ')})`);
    }

    return json(responsePayload);
  }

  if (issueKeyMatch && method === 'PATCH') {
    const rawKey = issueKeyMatch[1].toUpperCase();
    let key = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
    key = await resolveCfKey(key);
    const body = await readJson(req);

    // Handle recall — return ticket to its origin dept (whichever queue it started in)
    if (body.recall === true) {
      try {
      // Fetch full state BEFORE modifying anything
      const recallRow = await pool.query(
        `SELECT i.current_department, i.original_dept, i.dept_assignees, i."reporterId", i.summary, i."assigneeId"
         FROM issues i WHERE i.key=$1 LIMIT 1`, [key]
      );
      if (!recallRow.rows[0]) return json({ error: 'Ticket not found' }, 404);
      const recallDept: string = recallRow.rows[0]?.current_department || '';
      const homeDept: string = recallRow.rows[0]?.original_dept || 'Migration';
      const savedDeptAssignees: Record<string, any> = recallRow.rows[0]?.dept_assignees || {};
      const savedHomeAssignee = savedDeptAssignees[homeDept];
      let restoreAssigneeId: string | null = savedHomeAssignee?.id || null;
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
          delete savedDeptAssignees[homeDept];
        }
      }

      await pauseDeptSLA(key, null, recallDept);
      // Restore the saved origin-dept assignee if available
      await pool.query(
        `UPDATE issues SET current_department=$2, "assigneeId"=$3, dept_sla_started_at=NOW(), dept_assignees=$4::jsonb, "updatedAt"=NOW() WHERE key=$1`,
        [key, homeDept, restoreAssigneeId, JSON.stringify(savedDeptAssignees)]
      );
      await startDeptSLA(key, null, homeDept);

      // Ticket returned home -- remove 'passed' worked-on entries since work continues
      pool.query(
        `DELETE FROM user_worked_on_tickets WHERE issue_id=(SELECT id FROM issues WHERE key=$1) AND reason='passed'`,
        [key]
      ).catch(() => {});

      // Notify: restored origin-dept assignee + reporter
      try {
        const recallIssue = await db.issue.findUnique({ where: { key }, select: { reporterId: true, summary: true, cf_key: true } });
        const summary = recallIssue?.summary || key;
        const displayKey = (recallIssue as any)?.cf_key || key;
        const notifyIds = [recallIssue?.reporterId, restoreAssigneeId].filter(Boolean) as string[];
        if (notifyIds.length) {
          await notifyUsers(notifyIds, userId, {
            type: 'DEPT_CHANGE',
            title: `Ticket ${displayKey} returned to ${homeDept}`,
            message: `Ticket "${summary}" has been returned to the ${homeDept} queue. SLA has resumed.`,
            issueKey: displayKey
          });
        }
        // Also notify all origin-dept members
        const spMembers = await db.spaceMember.findMany({ where: { spaceId: (await db.issue.findUnique({ where: { key }, select: { spaceId: true } }))?.spaceId }, include: { user: { select: { id: true } } } });
        const homeMemberIds = spMembers
          .filter((m: any) => (m as any).department?.toLowerCase() === homeDept.toLowerCase())
          .map((m: any) => m.user?.id)
          .filter((id: any) => id && !notifyIds.includes(id));
        if (homeMemberIds.length > 0) {
          await notifyUsers(homeMemberIds, userId, {
            type: 'DEPT_ASSIGNED',
            title: `Ticket ${displayKey} back in ${homeDept}`,
            message: `Ticket "${summary}" has returned to ${homeDept} queue. SLA is running.`,
            issueKey: displayKey
          });
        }
      } catch { /* non-critical */ }
      return NextResponse.json({ success: true, recalled: true, key, department: homeDept });
      } catch (recallErr: any) {
        console.error('[Recall ERROR]', recallErr?.message || recallErr);
        return json({ error: recallErr?.message || 'Recall failed' }, 500);
      }
    }

    // Resolve issue + assignee email + reporter email in parallel
    const assigneeEmailToLookup = body.assigneeEmail ? String(body.assigneeEmail) : (body.assignee as any)?.email ?? null;
    const [issue, resolvedAssigneePatch, resolvedReporterPatch, issueCfKeyRow] = await Promise.all([
      db.issue.findUnique({ where: { key }, include: { space: { include: { statuses: true } } } }),
      assigneeEmailToLookup
        ? db.user.findFirst({ where: { email: { equals: assigneeEmailToLookup, mode: 'insensitive' } } })
        : Promise.resolve(null),
      body.reporterEmail
        ? db.user.findFirst({ where: { email: { equals: String(body.reporterEmail), mode: 'insensitive' } } })
        : Promise.resolve(null),
      pool.query<{ cf_key: string | null }>(`SELECT cf_key FROM issues WHERE key = $1 LIMIT 1`, [key]),
    ]);
    if (!issue) return json({ error: 'Not found' }, 404);
    // cf_key is a raw ALTER TABLE column Prisma doesn't select on any
    // db.issue.findUnique/update call in this handler ("issue", "updated",
    // and "refreshed" below are all Prisma results) -- every notifyStatusChanged/
    // notifyIssueUpdated call here was reading `(x as any).cf_key`, which was
    // always undefined, silently falling back to the raw internal key (e.g.
    // "L1BOAR-15259" or "L2B-482") in every status-change email instead of the
    // CF-#### key every user-facing screen shows. cf_key never changes for an
    // existing ticket, so one lookup up front covers the whole handler.
    const issueCfKey: string | null = issueCfKeyRow.rows[0]?.cf_key ?? null;

    // Once a ticket has moved into a specific department's queue, only that
    // queue's own members (or an admin) may change its status — otherwise
    // someone from an unrelated queue (e.g. a Dev-queue member) can reopen or
    // resolve a ticket that's currently sitting in Migration, which silently
    // corrupts the SLA/resolution history the owning department is actually
    // responsible for. The department-transfer endpoint already enforces this
    // exact same rule via isUserAuthorizedForDeptQueue; this PATCH handler
    // (which is what every status change actually goes through) never did.
    if (!isAdmin && (body.statusId !== undefined || body.queueStatusId !== undefined)) {
      try {
        const deptRow = await pool.query(`SELECT current_department FROM issues WHERE id=$1 LIMIT 1`, [issue.id]);
        const currentDept: string | null = deptRow.rows[0]?.current_department || null;
        if (currentDept && issue.space?.key) {
          const authorized = await isUserAuthorizedForDeptQueue(issue.space.key, currentDept, userId);
          if (!authorized) {
            return json({ error: `You can view and comment on this ticket, but it has moved to ${currentDept} — only that queue can change its status.` }, 403);
          }
        }
      } catch { /* fail open on lookup errors, same as the department-change endpoint */ }
    }

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
    if (body.productionTicket !== undefined) data.productionTicket = body.productionTicket === null ? null : String(body.productionTicket);
    // Was read by POST /issues (creation) but never by this PATCH handler --
    // the ticket detail page's due-date editor called this endpoint and got
    // a 200 back with no error, but the edit was silently dropped every
    // time; nothing was ever saved or logged.
    if (body.dueDate !== undefined) data.dueDate = body.dueDate === null ? null : new Date(String(body.dueDate));

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
    // resolvedAt is a raw column outside Prisma's schema (like current_department),
    // so it can't go through db.issue.update's `data` object -- track the
    // intended change here and apply it via a raw UPDATE right after that
    // call actually runs. undefined = no change, Date = stamp resolution,
    // null = clear it (reopened).
    let resolvedAtChange: Date | null | undefined = undefined;
    if (body.queueStatusId) {
      try {
        const qRow = await pool.query(`SELECT current_department, dept_statuses FROM issues WHERE key=$1 LIMIT 1`, [key]);
        const dept: string = qRow.rows[0]?.current_department;
        if (dept) {
          const deptStatuses: Record<string, any> = qRow.rows[0]?.dept_statuses || {};
          const oldQueueStatusName = deptMapGet(deptStatuses, dept)?.name || 'Unknown';
          const oldQueueStatusCategory = deptMapGet(deptStatuses, dept)?.category || 'todo';
          deptMapSet(deptStatuses, dept, {
            id: String(body.queueStatusId),
            name: String(body.queueStatusName || ''),
            color: String(body.queueStatusColor || '#64748B'),
            category: String(body.queueStatusCategory || 'todo'),
          });
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
                resolvedAtChange = null;
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
                key: issue.key, cfKey: issueCfKey, summary: issue.summary, priority: issue.priority,
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
              // Stamp the actual resolution moment so the SLA check can tell
              // whether this ticket was resolved before or after its due
              // time -- without this, resolving always read as "on time"
              // (see computeSLAInstancesPure) no matter how overdue it
              // already was. Only stamp it on a genuine not-done -> done
              // transition, matching the exact same rule the plain
              // body.statusId path already applies (wasResolved/
              // willBeResolved below) -- this branch previously restamped
              // resolvedAt to right now every single time a done-category
              // queue status got applied, even to a ticket that was ALREADY
              // resolved (e.g. picking the same "Resolved" status again, or
              // any other action that re-applies a done-category
              // queue-scoped status while the ticket never left done).
              // That silently overwrote a ticket's real, on-time resolution
              // timestamp with whatever moment this unrelated action
              // happened, making it read as breached/"resolved late" even
              // though the actual work finished well before the due time.
              if (oldQueueStatusCategory !== 'done') {
                resolvedAtChange = new Date();
              }
              queueStatusSyncedDone = true;
              // This branch (like the reopen one above) skips the early-return
              // status-history insert further down, and never reaches the
              // generic "Status (resolve names)" history block past this
              // function either (both are gated on body.statusId, which stays
              // undefined for a queue-scoped status) -- a promise this exact
              // comment already made on the reopen branch above but never
              // actually followed through on here, so resolving a ticket via
              // a department's own queue status dropdown (the most common way
              // tickets get closed in this app) left no trace at all in the
              // History tab. Write it here, same shape as the reopen entry.
              const doneChanger = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
              pool.query(
                `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                [rid(), issue.id, 'status', oldQueueStatusName, String(body.queueStatusName || ''), doneChanger ? `${doneChanger.firstName} ${doneChanger.lastName}`.trim() : 'Unknown', doneChanger?.email || null]
              ).catch(() => {});
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
                const priorStatusForQueueHandoff = (issue.space?.statuses ?? []).find((s: any) => s.id === issue.statusId) || null;
                queueHandoffOldDept = await performDeptHandoff(
                  issue.id, issue.spaceId, (issue as any).productType || null,
                  queueHandoffTargetDept, priorStatusForQueueHandoff, null, userId,
                );
                queueHandoffDone = true;
                console.log(`[DeptHandoff] ${issue.key}: ${queueHandoffOldDept} → ${queueHandoffTargetDept} (via queue status)`);
              } catch (handoffErr: any) {
                console.error(`[DeptHandoff ERROR - queueStatus] ${issue.key}:`, handoffErr?.message || handoffErr);
              }
            } else {
              // A queue-scoped status that's neither done, a from-done reopen,
              // nor a "Waiting for X" handoff -- e.g. picking a plain
              // "In Progress" from this dept's own status list -- never
              // touched the real global statusId at all, only
              // dept_statuses[dept] above. That left the ticket's actual
              // statusId silently stuck on whatever it was before (often
              // still the space's default "To Do" from creation), disagreeing
              // with what was actually shown on screen. The done/reopen sync
              // branches already resolve-or-create a matching real status for
              // exactly this reason; apply the same sync here so the global
              // column never drifts from the dept-scoped label sitting on top
              // of it -- including the NEXT time this dept's status gets read
              // as a snapshot when the ticket leaves (that read comes from
              // the real column, not dept_statuses).
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
                if (matchedReal && matchedReal.id !== issue.statusId) {
                  await pool.query(`UPDATE issues SET "statusId"=$1, "updatedAt"=NOW() WHERE id=$2`, [matchedReal.id, issue.id]);
                }
              } catch (e: any) { console.error('[Queue status global sync failed]', issue.key, e?.message || e); }
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
              const refreshedDisplayKey = issueCfKey || refreshed.key;
              notifyStatusChanged({
                key: refreshed.key, cfKey: issueCfKey, summary: refreshed.summary, priority: refreshed.priority,
                spaceKey: refreshed.space?.key ?? '', spaceName: refreshed.space?.name ?? '',
                oldStatus: { name: oldQueueStatusName, category: 'todo' },
                newStatus: { name: String(body.queueStatusName || ''), category: String(body.queueStatusCategory || 'todo') },
                assignee: refreshed.assignee, reporter: refreshed.reporter,
                changedBy: changer,
              }).catch(() => {});
              // This branch returns early right below, so it never reached the
              // generic "Status changed?" block further down that normally
              // sends the in-app bell notification -- a queue-scoped status
              // change (e.g. picking "Waiting for Dev" from a queue's own
              // dropdown) updated the email but left the bell silent for both
              // reporter and assignee.
              notifyUsers(
                [refreshed.assigneeId, refreshed.reporterId],
                userId,
                { type: 'STATUS_CHANGED', title: `${refreshedDisplayKey} status → ${String(body.queueStatusName || '')}`, message: refreshed.summary, issueKey: refreshedDisplayKey }
              ).catch(() => {});
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
      // Stamp (or clear) the actual resolution moment on every done/not-done
      // transition -- computeSLAInstancesPure needs this to tell whether a
      // ticket was resolved before or after its due time. Without it, a
      // ticket that breached and was THEN resolved read as "resolved on
      // time" (isCompleted forced isBreached false with no way to tell the
      // two cases apart), silently erasing that it had ever breached.
      if (data.statusId !== issue.statusId) {
        // This handler's own `issue` fetch (above) only includes
        // space.statuses, not the status relation itself -- look the
        // current/new status category up from there instead.
        const spaceStatuses = issue.space?.statuses ?? [];
        const wasResolved = spaceStatuses.find((s: any) => s.id === issue.statusId)?.category === 'done';
        const willBeResolved = spaceStatuses.find((s: any) => s.id === data.statusId)?.category === 'done';
        if (willBeResolved && !wasResolved) resolvedAtChange = new Date();
        else if (!willBeResolved && wasResolved) resolvedAtChange = null;
      }
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
            deptMapSet(deptAssignees, currentDept, null);
          } else {
            const newAssignee = await db.user.findUnique({ where: { id: data.assigneeId as string }, select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } });
            if (newAssignee) {
              deptMapSet(deptAssignees, currentDept, { id: newAssignee.id, email: newAssignee.email, firstName: newAssignee.firstName, lastName: newAssignee.lastName, displayName: `${newAssignee.firstName} ${newAssignee.lastName}`.trim(), avatarUrl: avatarRef(newAssignee.id, newAssignee.avatarUrl) });
            }
          }
          await pool.query(`UPDATE issues SET dept_assignees=$1::jsonb WHERE key=$2`, [JSON.stringify(deptAssignees), key]);
        }
      } catch {}
    }

    let updated = await db.issue.update({
      where: { key },
      data: data as any,
      include: {
        status: true,
        assignee: true,
        reporter: true,
        space: { select: { key: true, name: true } },
      },
    });

    if (resolvedAtChange !== undefined) {
      await pool.query(`UPDATE issues SET "resolvedAt"=$1 WHERE id=$2`, [resolvedAtChange, updated.id]).catch(() => {});
    }

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
          const priorStatusForHandoff = (issue.space?.statuses ?? []).find((s: any) => s.id === issue.statusId) || null;
          handoffOldDept = await performDeptHandoff(
            issue.id, issue.spaceId, (issue as any).productType || null,
            handoffTargetDept, priorStatusForHandoff, data.statusId as string | null, userId,
          );
          deptHandoffDone = true;
          console.log(`[DeptHandoff] ${issue.key}: ${handoffOldDept} → ${handoffTargetDept}`);
          // performDeptHandoff just reassigned the ticket via raw SQL (restore
          // or round-robin) — but `updated` above was fetched via Prisma BEFORE
          // this ran, so it still shows whoever had the ticket prior to the
          // handoff. Without this refetch, the notification block below
          // (which reads `updated.assignee`/`updated.assigneeId`) emails and
          // bell-notifies the WRONG (old) assignee instead of the person the
          // handoff actually assigned it to.
          const refetchedAfterHandoff = await db.issue.findUnique({
            where: { key },
            include: { status: true, assignee: true, reporter: true, space: { select: { key: true, name: true } } },
          });
          if (refetchedAfterHandoff) updated = refetchedAfterHandoff;
        } catch (handoffErr: any) {
          console.error(`[DeptHandoff ERROR] ${issue.key}:`, handoffErr?.message || handoffErr);
        }
      }
    }

    // ── Keep dept_statuses[current department] in sync with plain status changes ──
    // Only performDeptHandoff / the manual Change Department endpoint / the
    // custom-queue-status flow ever refreshed dept_statuses -- all on a
    // department CHANGE. A ticket resolved via the ordinary status dropdown
    // while staying in the SAME department (the common case: Open -> In
    // Progress -> Resolved, never leaving Dev) left dept_statuses[Dev] stuck
    // at whatever it was before, even though the ticket's real current
    // status had moved on. Anywhere that snapshot is preferred over the
    // live status (getEffectiveIssueStatus on the detail page, and the
    // "Worked on" queue list) then showed that stale value instead of the
    // ticket's actual current status.
    if (body.statusId !== undefined && issue.statusId !== data.statusId && !deptHandoffDone) {
      try {
        const newStForSync = (issue.space?.statuses ?? []).find((s: any) => s.id === data.statusId) as any
          ?? (data.statusId ? await db.status.findUnique({ where: { id: String(data.statusId) } }) : null);
        if (newStForSync) {
          const syncRow = await pool.query(`SELECT current_department, dept_statuses FROM issues WHERE id=$1`, [issue.id]);
          const syncDept: string = syncRow.rows[0]?.current_department || '';
          if (syncDept) {
            const syncDeptStatuses: Record<string, any> = syncRow.rows[0]?.dept_statuses || {};
            deptMapSet(syncDeptStatuses, syncDept, { id: newStForSync.id, name: newStForSync.name, color: newStForSync.color, category: newStForSync.category });
            await pool.query(`UPDATE issues SET dept_statuses=$1::jsonb WHERE id=$2`, [JSON.stringify(syncDeptStatuses), issue.id]);
          }
        }
      } catch (syncErr: any) {
        console.error(`[dept_statuses sync ERROR] ${issue.key}:`, syncErr?.message || syncErr);
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
      if (body.dueDate !== undefined) {
        const oldD = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
        const newD = data.dueDate ? new Date(data.dueDate as Date).toISOString().split('T')[0] : null;
        track('due date', oldD, newD);
      }

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

      // Reporter (resolve display names) -- previously changed silently: a
      // PATCH that set BOTH assignee and reporter in the same request only
      // ever logged the assignee, since there was no track() call for this
      // field at all.
      if (data.reporterId !== undefined && issue.reporterId !== data.reporterId) {
        const oldR = issue.reporterId ? await db.user.findUnique({ where: { id: issue.reporterId } }) : null;
        const newR = data.reporterId ? await db.user.findUnique({ where: { id: data.reporterId as string } }) : null;
        const oldRN = oldR ? (`${oldR.firstName ?? ''} ${oldR.lastName ?? ''}`.trim() || oldR.email) : null;
        const newRN = newR ? (`${newR.firstName ?? ''} ${newR.lastName ?? ''}`.trim() || newR.email) : null;
        histRecs.push({ issueId: issue.id, field: 'reporter', oldValue: oldRN, newValue: newRN, authorName, authorEmail, createdAt: now });
      }

      if (histRecs.length > 0) {
        await (db as any).issueHistory.createMany({ data: histRecs });
      }
    } catch (_e) { /* history tracking should never break the main response */ }
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    // Send notifications (fire-and-forget)
    const spaceKey = updated.space?.key ?? '';
    const spaceName = updated.space?.name ?? '';
    // Every ticket is shown to users only by its CF-prefixed display key --
    // `key` is the internal column. cfKey here flows into notifyStatusChanged/
    // notifyIssueAssigned/notifyIssueUpdated below, which already know to
    // prefer it over the raw key for anything user-facing.
    const updatedDisplayKey = issueCfKey || updated.key;
    const issueForNotif = {
      key: updated.key, cfKey: issueCfKey, summary: updated.summary, priority: updated.priority,
      spaceKey, spaceName,
      status: { name: updated.status?.name ?? 'Open', category: updated.status?.category ?? 'todo' },
      assignee: updated.assignee, reporter: updated.reporter,
    };

    // Computed up front (rather than an if/else-if chain) so a single PATCH
    // that changes BOTH status and assignee at once notifies for both --
    // previously the assignee-changed branch was an "else if" off the
    // status-changed check, so a combined update silently skipped the
    // assignee notification entirely.
    const statusChangedForNotif = body.statusId !== undefined && issue.statusId !== data.statusId;
    const assigneeChangedForNotif = body.assigneeId !== undefined && issue.assigneeId !== data.assigneeId;

    // Status changed?
    if (statusChangedForNotif) {
      // If status moved to 'done' category, record worked-on for current assignee
      const newStRec = (issue.space?.statuses ?? []).find((s: any) => s.id === data.statusId);
      if (newStRec?.category === 'done' && updated.assigneeId) {
        pool.query(
          `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'closed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='closed', worked_at=NOW()`,
          [updated.assigneeId, issue.id, null]
        ).catch(() => {});
      }

      // Resolved/closed in a dept other than where the ticket originated — drop a
      // "Worked on" copy for the resolving dept, then send the ticket back to its
      // origin queue so it doesn't stay stranded away from home.
      if (newStRec?.category === 'done') {
        try {
          const deptRow = await pool.query(
            `SELECT current_department, original_dept, dept_assignees, dept_statuses FROM issues WHERE id=$1`,
            [issue.id]
          );
          const resolvingDept: string = deptRow.rows[0]?.current_department || '';
          const homeDept: string = deptRow.rows[0]?.original_dept || '';
          if (resolvingDept && homeDept && resolvingDept.toLowerCase() !== homeDept.toLowerCase()) {
            // Copy into the resolving dept's "Worked on" list
            await pool.query(
              `INSERT INTO queue_closed_tickets (space_id, dept_name, issue_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [issue.spaceId, resolvingDept, issue.id]
            );
            if (updated.assigneeId) {
              await pool.query(
                `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'closed') ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='closed', worked_at=NOW()`,
                [updated.assigneeId, issue.id, resolvingDept]
              );
            }
            await pauseDeptSLA(key, null, resolvingDept);

            // Move the ticket back to its origin dept, restoring whoever was
            // handling it there before it was passed along.
            const deptAssignees: Record<string, any> = deptRow.rows[0]?.dept_assignees || {};
            const homeAssignee = deptMapGet(deptAssignees, homeDept);
            const restoreAssigneeId: string | null = homeAssignee?.id || null;

            // Restore whatever status this ticket showed in its home dept
            // right before it was handed off -- opening it from home used to
            // show the RESOLVING dept's terminal status (e.g. Dev's
            // "Resolved") because this UPDATE never touched statusId at all,
            // leaving whatever the resolve action just set. Home should see
            // the same status it had before the handoff, so it can actually
            // review the work and close it themselves rather than land back
            // pre-marked done. The "Change Department" endpoint already
            // saves this exact snapshot into dept_statuses[oldDept] on every
            // manual handoff -- read it back here the same way that endpoint
            // resolves a snapshot name to a real status row.
            const deptStatuses: Record<string, any> = deptRow.rows[0]?.dept_statuses || {};
            const homeStatusSnapshot = deptMapGet(deptStatuses, homeDept);
            let restoredStatusId: string | null = null;
            if (homeStatusSnapshot?.name) {
              const realMatch = await db.status.findFirst({
                where: { spaceId: issue.spaceId, name: { equals: homeStatusSnapshot.name, mode: 'insensitive' } },
                orderBy: { order: 'asc' },
              });
              if (realMatch) restoredStatusId = realMatch.id;
            }
            // Record what the ticket's status actually was on leaving the
            // resolving dept, symmetric with how a manual transfer records
            // the old dept's status -- so a future visit back to this dept
            // sees accurate history instead of nothing.
            deptMapSet(deptStatuses, resolvingDept, { id: newStRec.id, name: newStRec.name, category: newStRec.category, color: newStRec.color });

            await pool.query(
              `UPDATE issues SET current_department=$1, "assigneeId"=$2, "statusId"=COALESCE($4, "statusId"), dept_statuses=$5::jsonb, "updatedAt"=NOW() WHERE id=$3`,
              [homeDept, restoreAssigneeId, issue.id, restoredStatusId, JSON.stringify(deptStatuses)]
            );
            await pool.query(
              `INSERT INTO issue_dept_transitions (issue_id, space_id, from_dept, to_dept) VALUES ($1, $2, $3, $4)`,
              [issue.id, issue.spaceId, resolvingDept, homeDept]
            );
            await (db as any).issueHistory.create({
              data: {
                id: rid(), issueId: issue.id, field: 'department',
                oldValue: resolvingDept,
                newValue: `Resolved in ${resolvingDept} — returned to ${homeDept}`,
                authorName: currentUser ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email) : 'System',
                createdAt: new Date(),
              },
            });
            // Notify whoever now owns it back home, plus the reporter
            const notifyIds = [restoreAssigneeId, updated.reporterId].filter(Boolean) as string[];
            if (notifyIds.length) {
              const updatedDisplayKey = issueCfKey || updated.key;
              await notifyUsers(notifyIds, userId, {
                type: 'DEPT_CHANGE',
                title: `Ticket ${updatedDisplayKey} back in ${homeDept}`,
                message: `Ticket "${updated.summary}" was resolved in ${resolvingDept} and has returned to ${homeDept}.`,
                issueKey: updatedDisplayKey,
              });
            }
          }
        } catch { /* non-critical */ }
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
        { type: 'STATUS_CHANGED', title: `${updatedDisplayKey} status → ${issueForNotif.status.name}`, message: updated.summary, issueKey: updatedDisplayKey }
      );
      await notifyWatchers(updated.key, userId, { title: `${updatedDisplayKey} status → ${issueForNotif.status.name}`, message: updated.summary });
    }
    // Assignee changed?
    if (assigneeChangedForNotif) {
      const prevAssignee = issue.assigneeId ? await db.user.findUnique({ where: { id: issue.assigneeId } }) : null;
      notifyIssueAssigned({ ...issueForNotif, previousAssignee: prevAssignee }).catch(() => {});
      // In-app: notify new assignee + reporter
      await notifyUsers(
        [updated.assigneeId, updated.reporterId],
        userId,
        { type: 'ASSIGNED', title: `${updatedDisplayKey} assigned to you`, message: updated.summary, issueKey: updatedDisplayKey }
      );
    }
    // General update (summary, description, priority, etc.) -- only when
    // neither of the above already covered this PATCH.
    if (!statusChangedForNotif && !assigneeChangedForNotif && Object.keys(data).some(k => ['summary','description','priority','type','labels'].includes(k))) {
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
          { type: 'UPDATED', title: `${updatedDisplayKey} updated`, message: changes.map(c => `${c.field}: ${c.to}`).join(', '), issueKey: updatedDisplayKey }
        );
        await notifyWatchers(updated.key, userId, { title: `${updatedDisplayKey} updated`, message: changes.map(c => `${c.field}: ${c.to}`).join(', ') });
      }
    }

    // None of these are part of Prisma's schema, so `updated` never carries
    // them -- computeIssueSLAsFromDb silently fell back to issue.createdAt
    // instead of the real dept-specific SLA start, and dropped every
    // dept-scoped policy entirely (its dept-match check saw an empty
    // current_department), for as long as this endpoint has existed. Merge
    // them in the same way the GET /issues/:key handler already does.
    try {
      const r = await pool.query(
        `SELECT current_department, dept_sla_started_at, dept_sla_log, "resolvedAt", sla_waivers FROM issues WHERE id=$1`,
        [updated.id]
      );
      Object.assign(updated as any, r.rows[0] || {});
    } catch { /* non-critical */ }

    // Record that this user did real work on the ticket while it sat in its
    // current department. Previously ONLY a formal department handoff (the
    // 'passed'/'returned'/'closed' inserts elsewhere in this file) ever wrote
    // to user_worked_on_tickets — a status or assignee change made by anyone
    // with legitimate access to this queue but no actual handoff (e.g. a
    // multi-queue member acting on a ticket that never formally left another
    // department) left zero trace here, so that work was invisible to the
    // Filters page's Queue + Worked view, the sidebar's "Worked on" list, and
    // Team Analytics alike, even though isUserAuthorizedForDeptQueue had
    // already confirmed they were allowed to touch it. Uses its own 'worked'
    // reason and only fills in worked_at on conflict (never overwrites an
    // existing 'passed'/'returned'/'closed' row's more specific reason).
    try {
      const statusChangedNow = body.statusId !== undefined && issue.statusId !== data.statusId;
      const assigneeChangedNow = body.assigneeId !== undefined && issue.assigneeId !== data.assigneeId;
      const workedDept: string | null = (updated as any).current_department || null;
      if (userId && workedDept && (statusChangedNow || assigneeChangedNow)) {
        await pool.query(
          `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1,$2,$3,'worked')
           ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET worked_at=NOW()`,
          [userId, updated.id, workedDept]
        );
      }
    } catch { /* non-critical */ }

    const slaInstances = await enrichSlaWithResolver(
      updated.id, await computeIssueSLAsFromDb(updated), updated.spaceId, (updated as any).current_department
    );

    // Fire connector events (fire-and-forget)
    const _issueUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/issues/${updated.key}`;
    const _issueBase = {
      key: updated.key, cf_key: issueCfKey ?? undefined,
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
    key = await resolveCfKey(key);
    const issue = await db.issue.findUnique({
      where: { key },
      include: { assignee: true, reporter: true, space: { select: { key: true, name: true } } },
    });
    if (!issue) return json({ error: 'Not found' }, 404);

    // The frontend only ever shows the delete control to admins (issue detail
    // page's "..." menu, the bulk-delete toolbar), but nothing here ever
    // actually enforced that server-side -- any authenticated session of any
    // role could hit this endpoint directly and delete a ticket. Matches the
    // same isAdmin gate the space/board DELETE endpoint already uses.
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

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

    // Snapshot everything that's about to cascade-delete (comments,
    // attachments, history) into the trash table before the real delete, so
    // it can be fully restored later. Raw SELECT * rather than a Prisma
    // include: several issue columns (current_department, jira_source_key,
    // dept_assignees, ...) were added via raw migrations and aren't in the
    // Prisma schema at all, so a Prisma query would silently drop them from
    // the snapshot.
    try {
      const issueRow = (await pool.query(`SELECT * FROM issues WHERE key = $1`, [key])).rows[0];
      const [comments, attachments, history] = await Promise.all([
        pool.query(`SELECT * FROM comments WHERE "issueId" = $1`, [issueRow.id]),
        pool.query(`SELECT * FROM attachments WHERE "issueId" = $1`, [issueRow.id]),
        pool.query(`SELECT * FROM issue_history WHERE "issueId" = $1`, [issueRow.id]),
      ]);
      const deleter = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
      await pool.query(
        `INSERT INTO deleted_issues (id, key, cf_key, space_key, summary, data, deleted_by_id, deleted_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          rid(), issueRow.key, issueRow.cf_key, issue.space?.key ?? null, issueRow.summary,
          JSON.stringify({ issue: issueRow, comments: comments.rows, attachments: attachments.rows, history: history.rows }),
          userId ?? null, deleter ? `${deleter.firstName} ${deleter.lastName}`.trim() : null,
        ]
      );
    } catch (e) {
      // If the snapshot fails for any reason, still let the delete proceed
      // rather than blocking someone from deleting a ticket -- but log it
      // loudly since it means that particular delete won't be recoverable.
      console.error(`[DELETE ${key}] Failed to snapshot for trash — this delete will NOT be recoverable:`, e);
    }

    await db.issue.delete({ where: { key } });
    await db.space.update({ where: { id: issue.spaceId }, data: { issueCount: { decrement: 1 } } });

    // Notify
    notifyIssueDeleted({
      key: issue.key, cfKey: (issue as any).cf_key, summary: issue.summary,
      spaceKey: issue.space?.key ?? '', spaceName: issue.space?.name ?? '',
      assignee: issue.assignee, reporter: issue.reporter,
      deletedBy: userId ? await db.user.findUnique({ where: { id: userId } }) : null,
    }).catch(() => {});

    return json({ ok: true });
  }


  // --- Deleted-ticket trash: list / restore / permanently purge ---------
  if (path === 'deleted-issues' && method === 'GET') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    const rows = await pool.query(
      `SELECT id, key, cf_key, space_key, summary, deleted_by_name, deleted_at FROM deleted_issues ORDER BY deleted_at DESC LIMIT 500`
    );
    return json({ deleted: rows.rows });
  }

  const restoreMatch = path.match(/^deleted-issues\/([^/]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    const trashId = restoreMatch[1];
    const trashRow = (await pool.query(`SELECT * FROM deleted_issues WHERE id = $1`, [trashId])).rows[0];
    if (!trashRow) return json({ error: 'Not found in trash' }, 404);

    const already = await pool.query(`SELECT 1 FROM issues WHERE key = $1`, [trashRow.key]);
    if (already.rows[0]) {
      return json({ error: `A ticket with key ${trashRow.key} already exists -- can't restore over it` }, 409);
    }

    const { issue: issueRow, comments = [], attachments = [], history = [] } = trashRow.data;

    // Re-insert each row exactly as it was, column-for-column, rather than
    // hardcoding a column list -- these rows can carry raw-migration columns
    // (current_department, jira_source_key, ...) that Prisma doesn't know
    // about, and hardcoding would silently drop any column added after this
    // code was written.
    const insertRow = async (table: string, row: Record<string, any>) => {
      const cols = Object.keys(row);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const values = cols.map((c) => row[c]);
      await pool.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`, values);
    };

    try {
      await insertRow('issues', issueRow);
      for (const c of comments) await insertRow('comments', c);
      for (const a of attachments) await insertRow('attachments', a);
      for (const h of history) await insertRow('issue_history', h);
      await db.space.update({ where: { id: issueRow.spaceId }, data: { issueCount: { increment: 1 } } }).catch(() => {});
      await pool.query(`DELETE FROM deleted_issues WHERE id = $1`, [trashId]);
    } catch (e: any) {
      console.error(`[restore ${trashRow.key}] failed:`, e);
      return json({ error: `Restore failed: ${e?.message || e}` }, 500);
    }
    return json({ ok: true, key: issueRow.key });
  }

  const purgeMatch = path.match(/^deleted-issues\/([^/]+)$/);
  if (purgeMatch && method === 'DELETE') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    await pool.query(`DELETE FROM deleted_issues WHERE id = $1`, [purgeMatch[1]]);
    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issue Links Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const issueLinksPost = path.match(/^issues\/([^/]+)\/links$/);
  if (issueLinksPost && method === 'POST') {
    let sourceKey = issueLinksPost[1].toUpperCase();
    const body = await readJson(req);
    let targetKey = String(body.targetKey || '').toUpperCase();
    if (!targetKey) return json({ error: 'targetKey required' }, 400);

    // Every issue is shown to users ONLY by its CF-prefixed display key (URLs,
    // breadcrumbs, search results, the ticket title itself) -- the "key"
    // column here (sourceKey/targetKey) is the internal Prisma key underneath
    // it, which the user never sees anywhere. The "Search issues" box's own
    // dropdown returns the correct internal key when a result is clicked, but
    // typing a CF-key directly and hitting Enter without picking a result
    // (or a stale/typo'd URL param) sent that CF-key straight through as
    // sourceKey/targetKey unresolved -- silently creating a link row that
    // could never match a real issue on either side, so it just vanished
    // instead of appearing (or erroring). Resolve CF- keys the same way
    // every other route in this file already does before using them.
    sourceKey = await resolveCfKey(sourceKey);
    targetKey = await resolveCfKey(targetKey);
    const [sourceExists, targetExists] = await Promise.all([
      pool.query(`SELECT id, cf_key FROM issues WHERE key = $1 LIMIT 1`, [sourceKey]),
      pool.query(`SELECT id, cf_key FROM issues WHERE key = $1 LIMIT 1`, [targetKey]),
    ]);
    if (!sourceExists.rows[0]) return json({ error: `Issue ${issueLinksPost[1]} not found` }, 404);
    if (!targetExists.rows[0]) return json({ error: `Issue ${body.targetKey} not found` }, 404);
    if (sourceKey === targetKey) return json({ error: 'An issue cannot be linked to itself' }, 400);

    // Upsert so duplicate calls are safe
    const link = await db.issueLink.upsert({
      where: { sourceKey_targetKey_linkType: { sourceKey, targetKey, linkType: String(body.linkType || 'relates') } },
      create: { id: rid(), sourceKey, targetKey, linkType: String(body.linkType || 'relates') },
      update: {},
    });
    // Logged on BOTH tickets -- a link is symmetric (creating it changed
    // what each side's "Linked work items" shows), and previously logged on
    // neither, so the History tab gave no trace a link was ever added.
    try {
      const linkAuthorName = currentUser
        ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
        : 'Unknown';
      const sourceDisplay = sourceExists.rows[0].cf_key || sourceKey;
      const targetDisplay = targetExists.rows[0].cf_key || targetKey;
      await (db as any).issueHistory.createMany({
        data: [
          { issueId: sourceExists.rows[0].id, field: 'link', oldValue: null, newValue: `Linked to ${targetDisplay} (${link.linkType})`, authorName: linkAuthorName, authorEmail: currentUser?.email ?? null, createdAt: new Date() },
          { issueId: targetExists.rows[0].id, field: 'link', oldValue: null, newValue: `Linked to ${sourceDisplay} (${link.linkType})`, authorName: linkAuthorName, authorEmail: currentUser?.email ?? null, createdAt: new Date() },
        ],
      });
    } catch { /* history tracking should never break the main response */ }
    return json(link);
  }

  const issueLinkDel = path.match(/^issues\/links\/([^/]+)$/);
  if (issueLinkDel && method === 'DELETE') {
    const id = issueLinkDel[1];
    try {
      const linkBefore = await db.issueLink.findUnique({ where: { id } });
      await db.issueLink.delete({ where: { id } });
      if (linkBefore) {
        try {
          const [srcRow, tgtRow] = await Promise.all([
            pool.query(`SELECT id, cf_key FROM issues WHERE key = $1 LIMIT 1`, [linkBefore.sourceKey]),
            pool.query(`SELECT id, cf_key FROM issues WHERE key = $1 LIMIT 1`, [linkBefore.targetKey]),
          ]);
          const linkAuthorName = currentUser
            ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
            : 'Unknown';
          const srcDisplay = srcRow.rows[0]?.cf_key || linkBefore.sourceKey;
          const tgtDisplay = tgtRow.rows[0]?.cf_key || linkBefore.targetKey;
          const recs = [];
          if (srcRow.rows[0]) recs.push({ issueId: srcRow.rows[0].id, field: 'link', oldValue: `Linked to ${tgtDisplay} (${linkBefore.linkType})`, newValue: null, authorName: linkAuthorName, authorEmail: currentUser?.email ?? null, createdAt: new Date() });
          if (tgtRow.rows[0]) recs.push({ issueId: tgtRow.rows[0].id, field: 'link', oldValue: `Linked to ${srcDisplay} (${linkBefore.linkType})`, newValue: null, authorName: linkAuthorName, authorEmail: currentUser?.email ?? null, createdAt: new Date() });
          if (recs.length) await (db as any).issueHistory.createMany({ data: recs });
        } catch { /* history tracking should never break the main response */ }
      }
    } catch {
      // already deleted
    }
    return json({ ok: true });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Issue Comments Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  const issueComments = path.match(/^issues\/([^/]+)\/comments$/);
  if (issueComments && method === 'POST') {
    let key = await resolveCfKey(issueComments[1].toUpperCase());
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


    const issueDisplayKey = (issue as any).cf_key || issue.key;
    // Email: notify assignee + reporter (not the commenter)
    notifyCommentAdded({
      key: issue.key, cfKey: (issue as any).cf_key, summary: issue.summary,
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
      { type: 'COMMENTED', title: `New comment on ${issueDisplayKey}`, message: commentPreview, issueKey: issueDisplayKey }
    );
    await notifyWatchers(issue.key, userId, { title: `New comment on ${issueDisplayKey}`, message: commentPreview });

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
        title: `${commenterName} mentioned you in ${issueDisplayKey}`,
        message: mentionPreview, issueKey: issueDisplayKey,
      });
      // Email notification
      if (mentionedUser.email) {
        notifyMentioned({
          mentionedEmail: mentionedUser.email,
          mentionedName: `${mentionedUser.firstName} ${mentionedUser.lastName}`.trim(),
          mentionedBy: commenterName,
          issueKey: issueDisplayKey,
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
    // Strips HTML/entities down to a short readable preview -- same approach
    // used for the comment-added notification preview above; a raw HTML
    // comment body in a history row would read as unrendered markup.
    const previewComment = (raw: string) => (raw || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (method === 'PATCH') {
      const body = await readJson(req);
      // Comment edits previously replaced the body with no trace of the
      // change -- fetch the prior body first so history has an old value to
      // show, not just "something changed."
      const before = await db.comment.findUnique({ where: { id: commentId } });
      const updated = await db.comment.update({
        where: { id: commentId },
        data: { body: String(body.body || ''), updatedAt: new Date() },
        include: { author: true },
      });
      if (before && before.body !== updated.body) {
        try {
          const authorName = currentUser
            ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
            : 'Unknown';
          await (db as any).issueHistory.create({
            data: {
              issueId: before.issueId, field: 'comment',
              oldValue: previewComment(before.body) || null,
              newValue: previewComment(updated.body) || null,
              authorName, authorEmail: currentUser?.email ?? null, createdAt: new Date(),
            },
          });
        } catch { /* history tracking should never break the main response */ }
      }
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
      // Same gap as edit above -- a deleted comment left no trace it had
      // ever existed. Fetch it first so history can record what was removed.
      const before = await db.comment.findUnique({ where: { id: commentId } });
      await db.comment.delete({ where: { id: commentId } });
      if (before) {
        try {
          const authorName = currentUser
            ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
            : 'Unknown';
          await (db as any).issueHistory.create({
            data: {
              issueId: before.issueId, field: 'comment',
              oldValue: previewComment(before.body) || null,
              newValue: '[deleted]',
              authorName, authorEmail: currentUser?.email ?? null, createdAt: new Date(),
            },
          });
        } catch { /* history tracking should never break the main response */ }
      }
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

    // Every ticket's user-facing key is "CF-<number>" -- typing just the bare
    // number (no "CF-" prefix) is a completely ordinary way to look one up,
    // but cf_key never literally equals a bare number, so without this it
    // never matched here and fell all the way through to the noisy `contains`
    // scan below, mixing the one ticket meant in with unrelated tickets that
    // happen to have that same digit sequence somewhere in their summary or
    // description (e.g. a phone number, a date, an unrelated id).
    const isNumericQuery = /^\d+$/.test(q);

    // Step 1: fetch exact + startsWith matches for CF key first (guaranteed to be in results)
    const exactMatches = await db.issue.findMany({
      where: {
        OR: [
          { cf_key: { equals: q, mode: 'insensitive' } },
          { key: { equals: q, mode: 'insensitive' } },
          ...(isNumericQuery ? [{ cf_key: { equals: `CF-${q}`, mode: 'insensitive' as const } }] : []),
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
    // Also pulls in that ticket's own subtasks and linked work items (and
    // nothing else) -- looking up one ticket by its exact number/key should
    // surface the family it belongs to, not get diluted by unrelated
    // substring matches.
    if (exactMatches.length > 0) {
      const matchedKeys = exactMatches.map((i) => i.key);
      const [subtasks, linksOut, linksIn] = await Promise.all([
        db.issue.findMany({ where: { parentKey: { in: matchedKeys } }, include: includeFields }),
        db.issueLink.findMany({ where: { sourceKey: { in: matchedKeys } } }),
        db.issueLink.findMany({ where: { targetKey: { in: matchedKeys } } }),
      ]);
      const linkedKeys = new Set<string>();
      for (const l of linksOut) linkedKeys.add(l.targetKey);
      for (const l of linksIn) linkedKeys.add(l.sourceKey);
      for (const k of matchedKeys) linkedKeys.delete(k);
      const linkedIssues = linkedKeys.size
        ? await db.issue.findMany({ where: { key: { in: Array.from(linkedKeys) } }, include: includeFields })
        : [];
      const seenIds = new Set<string>();
      const combined: any[] = [];
      for (const issue of [...exactMatches, ...subtasks, ...linkedIssues]) {
        if (!seenIds.has(issue.id)) { seenIds.add(issue.id); combined.push(issue); }
      }
      return json({ issues: combined.map(formatIssue), total: combined.length, page: 1, totalPages: 1 });
    }

    // A purely numeric query with no exact ticket match is a lookup that
    // came up empty, not a keyword to search for -- falling through to the
    // broad `contains` scan below matched that same digit sequence wherever
    // it happened to appear in any ticket's summary/description (a date, a
    // phone number, an unrelated id), returning unrelated tickets instead of
    // "no results" for a ticket number that simply doesn't exist.
    if (isNumericQuery) {
      return json({ issues: [], total: 0, page: 1, totalPages: 1 });
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

  // GET /reports/resolution-sla?dept=&productType=&dateFrom=&dateTo= — Resolution %,
  // SLA %, and SLA Breach % per the formulas:
  //   Resolution % = Resolved / Assigned * 100
  //   SLA %        = Resolved-within-SLA / Resolved * 100
  //   Breach %     = Resolved-outside-SLA / Resolved * 100  (= 100 - SLA %)
  // dept/productType are OPTIONAL scoping filters (when omitted, scoped to the
  // fixed Migration/Dev depts and Content/Message/Email product types this
  // report is for). A ticket is "within SLA" using the exact same live
  // breach check as the ticket detail page (computeSLAInstancesPure, reusing
  // its resolvedAt-vs-due-time comparison), not a separate/different rule.
  if (path === 'reports/resolution-sla' && method === 'GET') {
    if (!isAdmin && currentUser?.role !== 'manager') return json({ error: 'Forbidden' }, 403);
    const deptParam = url.searchParams.get('dept') || '';
    const productTypeParam = url.searchParams.get('productType') || '';
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');

    const DEPTS = ['Migration', 'Dev'];
    const PRODUCT_TYPES = ['Content Migration', 'Message Migration', 'Email Migration'];

    const whereClauses: string[] = [`i.current_department IS NOT NULL`];
    const params: any[] = [];
    let idx = 1;
    if (deptParam) { whereClauses.push(`LOWER(i.current_department) = LOWER($${idx++})`); params.push(deptParam); }
    else { whereClauses.push(`LOWER(i.current_department) = ANY($${idx++}::text[])`); params.push(DEPTS.map(d => d.toLowerCase())); }
    // productType (Content/Message/Email Migration) is a Migration-specific
    // categorization -- Dev tickets essentially never have it set at all
    // (checked: 15,565 of 15,566 Dev tickets have productType = null).
    // Requiring a match against the 3 fixed values by default silently
    // excluded every single Dev ticket from this report, dept filter or
    // not -- only apply this as a restriction when the caller explicitly
    // picked one; "no filter" means no restriction, not "must be Migration
    // content".
    if (productTypeParam) { whereClauses.push(`i."productType" = $${idx++}`); params.push(productTypeParam); }
    if (dateFrom) { whereClauses.push(`i."createdAt" >= $${idx++}`); params.push(new Date(dateFrom)); }
    if (dateTo) { whereClauses.push(`i."createdAt" <= $${idx++}`); params.push(new Date(new Date(dateTo).setHours(23, 59, 59, 999))); }

    const rows = await pool.query(
      `SELECT i.id, i.key, i.cf_key, i.priority, i."assigneeId", i."spaceId", i.current_department, i."productType",
              i.dept_sla_started_at, i.dept_sla_log, i."resolvedAt", i."updatedAt", i."createdAt",
              s.name AS status_name, s.category AS status_category
       FROM issues i
       LEFT JOIN statuses s ON s.id = i."statusId"
       WHERE ${whereClauses.join(' AND ')}
       LIMIT 100000`,
      params
    );

    const spaceIds = Array.from(new Set(rows.rows.map((r: any) => r.spaceId).filter(Boolean)));
    const policiesBySpace: Record<string, any[]> = {};
    if (spaceIds.length) {
      const polRows = await pool.query(`SELECT * FROM sla_definitions WHERE "spaceId" = ANY($1::text[]) AND status = 'active'`, [spaceIds]);
      for (const p of polRows.rows) (policiesBySpace[p.spaceId] ??= []).push(p);
    }
    const assigneeIds = Array.from(new Set(rows.rows.map((r: any) => r.assigneeId).filter(Boolean)));
    const usersRes = assigneeIds.length
      ? await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE id = ANY($1::text[])`, [assigneeIds])
      : { rows: [] as any[] };
    const userById: Record<string, any> = Object.fromEntries(usersRes.rows.map((u: any) => [u.id, u]));

    type Bucket = { totalAssigned: number; totalResolved: number; withinSla: number; breached: number };
    const mkBucket = (): Bucket => ({ totalAssigned: 0, totalResolved: 0, withinSla: 0, breached: 0 });
    const overall = mkBucket();
    const byDept: Record<string, Bucket> = {};
    const byProductType: Record<string, Bucket> = {};
    const byDeptProductType: Record<string, Bucket> = {};
    const byUser: Record<string, Bucket & { name: string; email: string }> = {};

    // Weekly breakdown by product type (Content/Message/Email only -- Dev
    // essentially never sets this field, same reason it's excluded from
    // "By Product Type" above) -- powers the "SLA Breach %" / "Resolution %"
    // grouped-bar-per-week charts. Weeks are anchored to createdAt, starting
    // at the selected dateFrom (or, with no range picked, the last 3 full
    // weeks ending today) so week boundaries always line up with the date
    // range filter shown on the page.
    const WEEKLY_PRODUCT_TYPES = ['Content Migration', 'Message Migration', 'Email Migration'];
    const DAY_MS = 24 * 60 * 60 * 1000;
    const weekRangeEnd = dateTo ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : new Date();
    const weekRangeStart = dateFrom ? new Date(dateFrom) : new Date(weekRangeEnd.getTime() - 21 * DAY_MS);
    const totalDays = Math.max(1, Math.ceil((weekRangeEnd.getTime() - weekRangeStart.getTime()) / DAY_MS));
    const weekCount = Math.min(12, Math.max(1, Math.ceil(totalDays / 7)));
    const weekLabels = Array.from({ length: weekCount }, (_, i) => `Wk${i + 1}`);
    const weekRanges = Array.from({ length: weekCount }, (_, i) => {
      const from = new Date(weekRangeStart.getTime() + i * 7 * DAY_MS);
      const to = new Date(Math.min(weekRangeStart.getTime() + (i + 1) * 7 * DAY_MS - 1, weekRangeEnd.getTime()));
      return { from: from.toISOString(), to: to.toISOString() };
    });
    const byWeekProductType: Record<string, Bucket[]> = {};
    for (const pt of WEEKLY_PRODUCT_TYPES) byWeekProductType[pt] = weekLabels.map(() => mkBucket());

    for (const row of rows.rows) {
      const dept = row.current_department;
      const ptype = row.productType || 'Unknown';
      const isDone = row.status_category === 'done';
      const deptBucket = (byDept[dept] ??= mkBucket());
      const typeBucket = (byProductType[ptype] ??= mkBucket());
      const comboBucket = (byDeptProductType[`${dept}::${ptype}`] ??= mkBucket());
      let userBucket: (Bucket & { name: string; email: string }) | null = null;
      if (row.assigneeId) {
        const u = userById[row.assigneeId];
        const name = u ? (`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email) : 'Unknown';
        userBucket = (byUser[row.assigneeId] ??= { ...mkBucket(), name, email: u?.email || '' });
      }
      let weekBucket: Bucket | null = null;
      if (WEEKLY_PRODUCT_TYPES.includes(row.productType) && row.createdAt) {
        const createdMs = new Date(row.createdAt).getTime();
        const weekIdx = Math.floor((createdMs - weekRangeStart.getTime()) / (7 * DAY_MS));
        if (weekIdx >= 0 && weekIdx < weekCount) weekBucket = byWeekProductType[row.productType][weekIdx];
      }
      overall.totalAssigned++; deptBucket.totalAssigned++; typeBucket.totalAssigned++; comboBucket.totalAssigned++;
      if (userBucket) userBucket.totalAssigned++;
      if (weekBucket) weekBucket.totalAssigned++;
      if (!isDone) continue;
      overall.totalResolved++; deptBucket.totalResolved++; typeBucket.totalResolved++; comboBucket.totalResolved++;
      if (userBucket) userBucket.totalResolved++;
      if (weekBucket) weekBucket.totalResolved++;

      // resolvedAt only gets stamped by this app's own PATCH handler (added
      // this session) -- a ticket resolved via the original Jira migration
      // import never had one written, for any of its resolved tickets
      // (checked against this exact dataset: 7,473 resolved Migration
      // tickets, only 1 has a real resolvedAt). Tried falling back to
      // updatedAt for those, but that produces a WORSE number, not a better
      // one: these tickets took months to migrate, while the currently
      // configured SLA policies are a few hours, so nearly all of them
      // read as "breached" purely because the SLA target being checked
      // almost certainly didn't exist yet when that historical work
      // actually happened -- a fabricated signal, not a real one. Only
      // count a ticket toward SLA%/Breach% when it has a REAL resolvedAt;
      // everything else is included in Resolution% (which only needs
      // assigned-vs-resolved, no timing) but excluded here, and the exact
      // count of how many are excluded is surfaced to the caller so this
      // doesn't quietly look like 100% either way.
      if (!row.resolvedAt) continue;
      const policies = policiesBySpace[row.spaceId] || [];
      const instances = computeSLAInstancesPure(
        { ...row, status: { name: row.status_name, category: row.status_category } },
        policies,
        false
      );
      if (!instances.length) continue; // no SLA policy applies -- excluded from the SLA%/Breach% denominator, same as "N/A"
      const primary = instances.find((x: any) => x.deptName && x.deptName.toLowerCase() === String(dept || '').toLowerCase()) || instances[0];
      const bump = (b: Bucket) => { if (primary.isBreached) b.breached++; else b.withinSla++; };
      bump(overall); bump(deptBucket); bump(typeBucket); bump(comboBucket);
      if (userBucket) bump(userBucket);
      if (weekBucket) bump(weekBucket);
    }

    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
    // withinSla + breached is the sample that actually HAS a real, trustworthy
    // resolvedAt -- not the same as totalResolved (which includes every
    // historical ticket with no resolution timestamp at all). Naming this out
    // explicitly so the UI can show "N of M resolved tickets have tracked
    // timing" instead of silently dividing by totalResolved and implying a
    // sample size that doesn't exist yet.
    const finalize = (b: Bucket) => {
      const slaTracked = b.withinSla + b.breached;
      return {
        ...b,
        slaTracked,
        resolutionPct: pct(b.totalResolved, b.totalAssigned),
        slaPct: pct(b.withinSla, slaTracked),
        breachPct: pct(b.breached, slaTracked),
      };
    };

    return json({
      overall: finalize(overall),
      byDept: Object.fromEntries(Object.entries(byDept).map(([k, v]) => [k, finalize(v)])),
      byProductType: Object.fromEntries(Object.entries(byProductType).map(([k, v]) => [k, finalize(v)])),
      byDeptProductType: Object.fromEntries(Object.entries(byDeptProductType).map(([k, v]) => [k, finalize(v)])),
      perUser: Object.entries(byUser)
        .map(([id, v]) => ({ id, ...finalize(v) }))
        .sort((a, b) => b.totalAssigned - a.totalAssigned),
      weekly: {
        weekLabels,
        weekRanges,
        byProductType: Object.fromEntries(
          WEEKLY_PRODUCT_TYPES.map(pt => [pt, byWeekProductType[pt].map(finalize)])
        ),
      },
    });
  }

  // Team Analytics -- ported from the standalone "Reports-" app, which pulled
  // Jira Cloud data into its own SQLite DB and computed these metrics in
  // memory over CSV rows. Re-implemented here directly against this app's own
  // issues/issue_history tables (live data, including tickets created inside
  // this app, not a periodically-refreshed copy). That app's "team" was an
  // arbitrary named group of people; the closest concept here is
  // current_department (Migration/Dev/QA/Infra/Pre-Sales/...), which every
  // filter below groups by instead.
  if (path.startsWith('reports/team-analytics') && method === 'GET') {
    if (!isAdmin && currentUser?.role !== 'manager') return json({ error: 'Forbidden' }, 403);
    const scope = await loadTeamAnalyticsScope(url);

    if (path === 'reports/team-analytics/overview') {
      return json(buildTeamAnalyticsOverview(scope));
    }
    if (path === 'reports/team-analytics/aging') {
      return json(buildTeamAnalyticsAging(scope));
    }
    if (path === 'reports/team-analytics/time-spent') {
      return json(buildTeamAnalyticsTimeSpent(scope, url.searchParams.get('q') || undefined));
    }
    return json({ error: 'Not found' }, 404);
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
              i.key, i.cf_key, i.summary, i.type, i.priority, i."statusId",
              s.name AS status_name, s.category AS status_category, s.color AS status_color,
              sp.key AS space_key, sp.name AS space_name,
              CONCAT(r."firstName", ' ', r."lastName") AS reporter_name, r.email AS reporter_email
       FROM user_worked_on_tickets w
       JOIN issues i ON i.id = w.issue_id
       LEFT JOIN statuses s ON s.id = i."statusId"
       LEFT JOIN spaces sp ON sp.id = i."spaceId"
       LEFT JOIN users r ON r.id = i."reporterId"
       WHERE w.user_id = $1 ${deptClause}
       ORDER BY w.worked_at DESC
       LIMIT 100`,
      params
    );
    const issues = rows.rows.map((r: any) => ({
      id: r.issue_id,
      key: r.key,
      cfKey: r.cf_key,
      summary: r.summary,
      type: r.type,
      priority: r.priority,
      dept: r.dept,
      reason: r.reason,
      workedAt: r.worked_at,
      status: r.status_name ? { id: r.statusId, name: r.status_name, category: r.status_category, color: r.status_color } : null,
      space: { key: r.space_key, name: r.space_name },
      reporterName: (r.reporter_name || '').trim() || null,
      reporterEmail: r.reporter_email || null,
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
    let key = await resolveCfKey(watchMatch[1].toUpperCase());
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
    let key = await resolveCfKey(unwatchMatch[1].toUpperCase());
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    await (db as any).issueWatch.deleteMany({ where: { issueKey: key, userId } });
    return json({ watching: false });
  }

  // GET /issues/:key/watch  Ã¢â‚¬â€ check if watching
  const watchCheckMatch = path.match(/^issues\/([^/]+)\/watch$/);
  if (watchCheckMatch && method === 'GET') {
    let key = await resolveCfKey(watchCheckMatch[1].toUpperCase());
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
      // Every issue is shown to users only by its CF-prefixed display key --
      // runMonitorAgentScan's own DUE_DATE notifications already dedup and
      // display via cf_key || key; using the raw internal key here (both for
      // display AND this dedup lookup) meant the two never matched each
      // other and could double-notify the same due date on top of showing
      // the wrong key.
      const displayKey = (issue as any).cf_key || issue.key;
      const already = await (db as any).notification.findFirst({
        where: { userId: issue.assigneeId, issueKey: displayKey, type: 'DUE_DATE',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (!already) {
        await createNotification({ userId: issue.assigneeId, type: 'DUE_DATE',
          title: `Overdue: ${displayKey}`, message: issue.summary, issueKey: displayKey });
        count++;
      }
    }
    for (const issue of dueToday) {
      if (!issue.assigneeId) continue;
      const displayKey = (issue as any).cf_key || issue.key;
      const already = await (db as any).notification.findFirst({
        where: { userId: issue.assigneeId, issueKey: displayKey, type: 'DUE_DATE',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (!already) {
        await createNotification({ userId: issue.assigneeId, type: 'DUE_DATE',
          title: `Due today: ${displayKey}`, message: issue.summary, issueKey: displayKey });
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

  // POST /jira-issue-sync -- admin-triggered manual run of the same catch-up
  // sync that also runs automatically on a timer (see instrumentation.ts).
  // Bounded to a small batch since this goes over HTTP and has a real
  // request timeout, unlike the in-process scheduled call.
  if (path === 'jira-issue-sync' && method === 'POST') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 500);
    // This had no try/catch of its own -- an exception ANYWHERE inside
    // runJiraIssueSync (a bad query, a schema mismatch, whatever) fell
    // through to the generic top-level error handler, which logs it as
    // "[API] Unhandled error: ..." (not "[Jira Sync]", so it's invisible to
    // anyone grepping logs for the sync specifically) and responds with
    // { error: 'Internal server error' } -- note `error`, singular.
    // instrumentation.ts's syncJiraIssues() only ever checked `data.errors`
    // (plural, an array), which is always empty on that response shape, so
    // NOTHING got logged there either. Net effect: if this has been crashing
    // on every single run, there would be zero trace of it anywhere, which
    // is exactly consistent with the sync checkpoint never once advancing.
    // Catching here and returning the proper { imported, errors } shape
    // regardless of how it failed means a real crash is now impossible to
    // silently lose again.
    try {
      const result = await runJiraIssueSync(limit);
      return json(result);
    } catch (e: any) {
      console.error('[Jira Sync] runJiraIssueSync threw:', e?.message || e, e?.stack);
      return json({ imported: [], errors: [`runJiraIssueSync threw: ${e?.message || e}`] });
    }
  }

  // POST /admin/backfill-client-names -- one-time catch-up for every EXISTING
  // ticket created before Client Name started auto-filling from the reporter's
  // email domain at creation time. Only ever fills a ticket whose clientName
  // is currently NULL -- a ticket that already has a real, manually-picked
  // customer name (the overwhelming majority of tickets with clientName set,
  // per the actual data) is never touched, so this can't clobber good
  // existing data. Admin-triggered manually, or run once automatically at
  // boot (see instrumentation.ts) the same way jira-issue-sync is.
  if (path === 'admin/backfill-client-names' && method === 'POST') {
    if (!isAdmin) return json({ error: 'Admin only' }, 403);
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      // Idempotent regardless of who/what calls this -- runs at most once
      // (across every server restart, not just this process) unless
      // explicitly forced, so wiring it into the boot sequence alongside the
      // other one-time catch-up jobs never repeats the bulk update.
      const already = await pool.query(`SELECT 1 FROM app_settings WHERE key = 'client_name_backfill_v1_done'`);
      if (already.rows.length > 0 && url.searchParams.get('force') !== 'true') {
        return json({ updated: 0, alreadyRan: true });
      }
      const result = await pool.query(`
        UPDATE issues i
        SET "clientName" = LOWER(SPLIT_PART(u.email, '@', 2)), "updatedAt" = NOW()
        FROM users u
        WHERE i."reporterId" = u.id
          AND i."clientName" IS NULL
          AND u.email IS NOT NULL
          AND POSITION('@' IN u.email) > 0
      `);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('client_name_backfill_v1_done', 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
      );
      return json({ updated: result.rowCount ?? 0 });
    } catch (e: any) {
      console.error('[backfill-client-names] failed:', e?.message || e);
      return json({ error: 'Backfill failed', details: e?.message }, 500);
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
        try {
          const uploaderName = currentUser
            ? (`${currentUser.firstName ?? ''} ${currentUser.lastName ?? ''}`.trim() || currentUser.email)
            : 'Unknown';
          await (db as any).issueHistory.create({
            data: {
              issueId, field: 'attachment', oldValue: null, newValue: `Added ${file.name}`,
              authorName: uploaderName, authorEmail: currentUser?.email ?? null, createdAt: new Date(),
            },
          });
        } catch { /* history tracking should never break the upload */ }
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
