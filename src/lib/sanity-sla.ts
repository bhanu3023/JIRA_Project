// Sanity SLA -- a self-contained set of clocks for Sanity tickets
// (Ticket Category = "Sanity") and their bug subtasks. By explicit request,
// these REPLACE the board's normal department SLA policies for those tickets.
//
// Confirmed flow (2026-11-25, team clocks revised 2026-11-27):
//   Main Sanity ticket (stays in QA):
//     - Overall clock (default 24h): starts at creation, never pauses, stops on close.
//     - QA clock (default 6h): pauses while any open bug subtask is a Blocker,
//       continues from where it stopped once every Blocker is closed
//       (pauses again if a closed Blocker is reopened). Non-Blockers never pause it.
//   Bug subtask (created by QA, moved with the normal "Routed to X" statuses):
//     - Team clock while the subtask sits in that queue:
//         Dev (default 3h), Infra (default 1h), Migration (default 30m).
//       Any other queue (Support, Pre-Sales, ...) has no clock.
//     - QA re-test clock (default 1h): runs while the subtask is in QA once
//       it has reached Dev at least once (Dev changed code, so QA re-tests),
//       even if Infra/Migration handled it after Dev. Never been to Dev ->
//       no QA clock, QA just closes it. For a Blocker this hour is NOT part
//       of the main ticket's 6h -- the main QA clock is paused meanwhile.
//     - Every clock continues from where it stopped if the subtask returns
//       to that queue (never restarts).
//   The main ticket can't be closed while any Blocker subtask is still open
//   (open Non-Blockers don't stop the close).
//
// Storage is deliberately separate from the department SLA engine's own
// columns (dept_sla_log / dept_sla_started_at / sla_snapshot) so none of the
// existing clocks, scans or breach-history regexes are affected:
//   issues.sanity_bug_type  'blocker' | 'non_blocker' (bug subtasks only)
//   issues.sanity_sla       JSONB clock state (see SanityParentState / SanityBugState)
//   sanity_sla_settings     per-space editable hours

import { pgPool as pool } from '@/lib/pg-pool';

pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS sanity_bug_type TEXT`).catch(() => {});
pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS sanity_sla JSONB`).catch(() => {});
// Run in order: the two ALTERs need the table to exist first (on a fresh DB),
// and settings reads/writes wait for this so the new columns are there.
const settingsTableReady: Promise<void> = (async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS sanity_sla_settings (
      space_id TEXT PRIMARY KEY,
      overall_hours NUMERIC NOT NULL DEFAULT 24,
      qa_hours NUMERIC NOT NULL DEFAULT 6,
      bug_dev_hours NUMERIC NOT NULL DEFAULT 3,
      bug_qa_hours NUMERIC NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE sanity_sla_settings ADD COLUMN IF NOT EXISTS bug_infra_hours NUMERIC NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE sanity_sla_settings ADD COLUMN IF NOT EXISTS bug_migration_hours NUMERIC NOT NULL DEFAULT 0.5`);
  } catch { /* reads fall back to defaults */ }
})();

export const SANITY_CATEGORY = 'Sanity';
export const SANITY_BUG_TYPES = ['blocker', 'non_blocker'] as const;
export type SanityBugType = typeof SANITY_BUG_TYPES[number];
export const CLOSE_BLOCKED_MESSAGE = 'Close all Sanity Blocker subtasks first';

export interface SanityHours {
  overallHours: number; qaHours: number;
  bugDevHours: number; bugInfraHours: number; bugMigrationHours: number; bugQaHours: number;
}
export const DEFAULT_SANITY_HOURS: SanityHours = {
  overallHours: 24, qaHours: 6,
  bugDevHours: 3, bugInfraHours: 1, bugMigrationHours: 0.5, bugQaHours: 1,
};

interface Clock {
  elapsed_ms: number;              // time accumulated in finished running periods
  running_since: string | null;    // ISO start of the current running period, null when stopped
  first_started_at: string | null; // first time this clock ever ran
  paused_at: string | null;        // when it last stopped
}
interface SanityParentState { qa: Clock; blocked_by: string[]; closed_at: string | null }
// visited_dev: the bug has been in Dev at least once -> QA re-test applies.
interface SanityBugState {
  dev: Clock; infra: Clock; migration: Clock; qa: Clock;
  visited_dev: boolean; closed_at: string | null;
}

// Bug team clocks: department (lower-case) -> clock key in SanityBugState.
type BugTeamKey = 'dev' | 'infra' | 'migration';
const BUG_TEAM_CLOCKS: { key: BugTeamKey; label: string; hours: (h: SanityHours) => number }[] = [
  { key: 'dev', label: 'Dev', hours: (h) => h.bugDevHours },
  { key: 'infra', label: 'Infra', hours: (h) => h.bugInfraHours },
  { key: 'migration', label: 'Migration', hours: (h) => h.bugMigrationHours },
];
function normDept(d: unknown): string {
  const s = String(d ?? '').trim().toLowerCase();
  return s === 'infrastructure' ? 'infra' : s;
}

const HOUR_MS = 3600_000;

export function normalizeSanityBugType(v: unknown): SanityBugType | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'blocker' || s === 'sanity_blocker') return 'blocker';
  if (s === 'non_blocker' || s === 'nonblocker' || s === 'sanity_non_blocker') return 'non_blocker';
  return null;
}

export function isSanityCategory(cat: unknown): boolean {
  return String(cat ?? '').trim().toLowerCase() === SANITY_CATEGORY.toLowerCase();
}

// ── Settings ─────────────────────────────────────────────────────────────

const hoursCache = new Map<string, { hours: SanityHours; at: number }>();
const HOURS_CACHE_MS = 30_000;

function rowToHours(r: any): SanityHours {
  const n = (v: any, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    overallHours: n(r?.overall_hours, DEFAULT_SANITY_HOURS.overallHours),
    qaHours: n(r?.qa_hours, DEFAULT_SANITY_HOURS.qaHours),
    bugDevHours: n(r?.bug_dev_hours, DEFAULT_SANITY_HOURS.bugDevHours),
    bugInfraHours: n(r?.bug_infra_hours, DEFAULT_SANITY_HOURS.bugInfraHours),
    bugMigrationHours: n(r?.bug_migration_hours, DEFAULT_SANITY_HOURS.bugMigrationHours),
    bugQaHours: n(r?.bug_qa_hours, DEFAULT_SANITY_HOURS.bugQaHours),
  };
}

export async function getSanityHours(spaceId: string | null | undefined): Promise<SanityHours> {
  if (!spaceId) return DEFAULT_SANITY_HOURS;
  const cached = hoursCache.get(spaceId);
  if (cached && Date.now() - cached.at < HOURS_CACHE_MS) return cached.hours;
  try {
    await settingsTableReady;
    const r = await pool.query(`SELECT * FROM sanity_sla_settings WHERE space_id = $1 LIMIT 1`, [spaceId]);
    const hours = rowToHours(r.rows[0]);
    hoursCache.set(spaceId, { hours, at: Date.now() });
    return hours;
  } catch {
    return DEFAULT_SANITY_HOURS;
  }
}

export async function saveSanityHours(spaceId: string, input: Partial<SanityHours>): Promise<SanityHours> {
  const current = await getSanityHours(spaceId);
  const pick = (v: any, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 && x <= 24 * 365 ? x : d; };
  const next: SanityHours = {
    overallHours: pick(input.overallHours, current.overallHours),
    qaHours: pick(input.qaHours, current.qaHours),
    bugDevHours: pick(input.bugDevHours, current.bugDevHours),
    bugInfraHours: pick(input.bugInfraHours, current.bugInfraHours),
    bugMigrationHours: pick(input.bugMigrationHours, current.bugMigrationHours),
    bugQaHours: pick(input.bugQaHours, current.bugQaHours),
  };
  await settingsTableReady;
  await pool.query(
    `INSERT INTO sanity_sla_settings (space_id, overall_hours, qa_hours, bug_dev_hours, bug_infra_hours, bug_migration_hours, bug_qa_hours, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (space_id) DO UPDATE SET overall_hours=$2, qa_hours=$3, bug_dev_hours=$4,
       bug_infra_hours=$5, bug_migration_hours=$6, bug_qa_hours=$7, updated_at=NOW()`,
    [spaceId, next.overallHours, next.qaHours, next.bugDevHours, next.bugInfraHours, next.bugMigrationHours, next.bugQaHours]
  );
  hoursCache.set(spaceId, { hours: next, at: Date.now() });
  return next;
}

// ── Clock helpers ────────────────────────────────────────────────────────

function newClock(): Clock { return { elapsed_ms: 0, running_since: null, first_started_at: null, paused_at: null }; }

function normClock(c: any): Clock {
  return {
    elapsed_ms: Number(c?.elapsed_ms) || 0,
    running_since: c?.running_since || null,
    first_started_at: c?.first_started_at || null,
    paused_at: c?.paused_at || null,
  };
}

function setRunning(c: Clock, run: boolean, nowIso: string): void {
  if (run && !c.running_since) {
    c.running_since = nowIso;
    c.first_started_at = c.first_started_at || nowIso;
    c.paused_at = null;
  } else if (!run && c.running_since) {
    c.elapsed_ms += Math.max(0, new Date(nowIso).getTime() - new Date(c.running_since).getTime());
    c.running_since = null;
    c.paused_at = nowIso;
  }
}

function clockElapsed(c: Clock, nowMs: number): number {
  return c.elapsed_ms + (c.running_since ? Math.max(0, nowMs - new Date(c.running_since).getTime()) : 0);
}

// ── Sync: bring stored clock state in line with the ticket's current state ─

interface SanityRow {
  id: string; key: string; cf_key: string | null; parentKey: string | null;
  ticketCategory: string | null; sanity_bug_type: string | null; sanity_sla: any;
  current_department: string | null; createdAt: Date; resolvedAt: Date | null; status_category: string | null;
}

const ROW_SELECT = `SELECT i.id, i.key, i.cf_key, i."parentKey", i."ticketCategory", i.sanity_bug_type, i.sanity_sla,
  i.current_department, i."createdAt", i."resolvedAt", s.category AS status_category
  FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"`;

async function loadRow(keyOrCfKey: string): Promise<SanityRow | null> {
  const k = String(keyOrCfKey || '').toUpperCase().split(':')[0];
  if (!k) return null;
  const r = await pool.query(`${ROW_SELECT} WHERE i.key = $1 OR i.cf_key = $1 LIMIT 1`, [k]);
  return r.rows[0] || null;
}

function rowIsDone(r: { resolvedAt: any; status_category: string | null }): boolean {
  return !!r.resolvedAt || r.status_category === 'done';
}

function isParentRow(r: SanityRow): boolean { return !r.parentKey && isSanityCategory(r.ticketCategory); }
function isBugRow(r: SanityRow): boolean { return !!r.parentKey && !!normalizeSanityBugType(r.sanity_bug_type); }

async function saveState(id: string, before: any, after: any): Promise<void> {
  if (JSON.stringify(before ?? null) === JSON.stringify(after)) return;
  await pool.query(`UPDATE issues SET sanity_sla = $1::jsonb WHERE id = $2`, [JSON.stringify(after), id]);
}

async function openBugSubtasks(parentKey: string): Promise<{ key: string; type: SanityBugType }[]> {
  const r = await pool.query(
    `SELECT COALESCE(c.cf_key, c.key) AS display_key, c.sanity_bug_type
     FROM issues c LEFT JOIN statuses s ON s.id = c."statusId"
     WHERE c."parentKey" = $1 AND c.sanity_bug_type IS NOT NULL
       AND c."resolvedAt" IS NULL AND COALESCE(s.category, '') <> 'done'
     ORDER BY c."createdAt" ASC`,
    [parentKey]
  );
  return r.rows
    .map((x: any) => ({ key: x.display_key, type: normalizeSanityBugType(x.sanity_bug_type) as SanityBugType }))
    .filter((x) => !!x.type);
}

async function syncParentRow(row: SanityRow): Promise<void> {
  if (!isParentRow(row)) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const createdIso = new Date(row.createdAt).toISOString();
  const prev = row.sanity_sla;
  const state: SanityParentState = prev
    ? { qa: normClock(prev.qa), blocked_by: Array.isArray(prev.blocked_by) ? prev.blocked_by : [], closed_at: prev.closed_at || null }
    // First sync: the QA clock has been running since the ticket was created.
    : { qa: { elapsed_ms: 0, running_since: createdIso, first_started_at: createdIso, paused_at: null }, blocked_by: [], closed_at: null };

  const done = rowIsDone(row);
  const blockers = done ? [] : (await openBugSubtasks(row.key)).filter((b) => b.type === 'blocker').map((b) => b.key);
  setRunning(state.qa, !done && blockers.length === 0, nowIso);
  state.blocked_by = blockers;
  state.closed_at = done ? (state.closed_at || (row.resolvedAt ? new Date(row.resolvedAt).toISOString() : nowIso)) : null;
  await saveState(row.id, prev, state);
}

// Stored bug state -> current shape. States saved before the Infra/Migration
// clocks existed have only dev/qa (+ visited_dev); missing clocks start empty.
function readBugState(prev: any): SanityBugState {
  if (!prev) return { dev: newClock(), infra: newClock(), migration: newClock(), qa: newClock(), visited_dev: false, closed_at: null };
  const dev = normClock(prev.dev);
  return {
    dev, infra: normClock(prev.infra), migration: normClock(prev.migration), qa: normClock(prev.qa),
    visited_dev: !!prev.visited_dev || !!dev.first_started_at, closed_at: prev.closed_at || null,
  };
}

async function syncBugRow(row: SanityRow): Promise<void> {
  if (!isBugRow(row)) return;
  const nowIso = new Date().toISOString();
  const prev = row.sanity_sla;
  const state = readBugState(prev);

  const done = rowIsDone(row);
  const dept = normDept(row.current_department);
  if (!done && dept === 'dev') state.visited_dev = true;
  for (const t of BUG_TEAM_CLOCKS) setRunning(state[t.key], !done && dept === t.key, nowIso);
  setRunning(state.qa, !done && dept === 'qa' && state.visited_dev, nowIso);
  state.closed_at = done ? (state.closed_at || (row.resolvedAt ? new Date(row.resolvedAt).toISOString() : nowIso)) : null;
  await saveState(row.id, prev, state);
}

/**
 * Re-sync Sanity clocks for the given ticket keys (internal or CF keys) and,
 * for bug subtasks, their parent. Safe to call for any ticket: non-Sanity
 * tickets cost one indexed lookup and are left untouched. Never throws.
 */
export async function syncSanityForKeys(keys: (string | null | undefined)[], extraParentKeys: (string | null | undefined)[] = []): Promise<void> {
  const parents = new Set<string>();
  for (const k of keys) {
    if (!k) continue;
    try {
      const row = await loadRow(k);
      if (!row) continue;
      if (isBugRow(row)) {
        await syncBugRow(row);
        if (row.parentKey) parents.add(row.parentKey);
      } else if (isParentRow(row)) {
        parents.add(row.key);
      } else if (row.parentKey && isSanityCategory(row.ticketCategory)) {
        // A plain subtask whose bug type was just cleared still affects its parent.
        parents.add(row.parentKey);
      }
    } catch (e: any) {
      console.error('[SanitySLA] sync failed for', k, e?.message || e);
    }
  }
  for (const p of extraParentKeys) if (p) parents.add(p);
  for (const p of Array.from(parents)) {
    try {
      const prow = await loadRow(p);
      if (prow) await syncParentRow(prow);
    } catch (e: any) {
      console.error('[SanitySLA] parent sync failed for', p, e?.message || e);
    }
  }
}

/** Parent key of a ticket, if it's a subtask of a Sanity ticket -- for re-syncing after a delete. */
export async function sanityParentKeyOf(keyOrCfKey: string): Promise<string | null> {
  try {
    const row = await loadRow(keyOrCfKey);
    if (row?.parentKey && isSanityCategory(row.ticketCategory)) return row.parentKey;
  } catch { /* non-critical */ }
  return null;
}

/**
 * Close gate for a Sanity main ticket: returns the user-facing error when it
 * still has open BLOCKER subtasks, otherwise null. Open Non-Blockers don't
 * stop the close (decided 2026-11-25). Fails open on lookup errors.
 */
export async function sanityCloseBlockReason(issueId: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT key, "parentKey", "ticketCategory" FROM issues WHERE id = $1 LIMIT 1`, [issueId]);
    const row = r.rows[0];
    if (!row || row.parentKey || !isSanityCategory(row.ticketCategory)) return null;
    const open = (await openBugSubtasks(row.key)).filter((o) => o.type === 'blocker');
    if (!open.length) return null;
    return `${CLOSE_BLOCKED_MESSAGE} (still open: ${open.map((o) => o.key).join(', ')}).`;
  } catch {
    return null;
  }
}

/** Cached hours for synchronous callers; refreshes the cache in the background. */
export function getSanityHoursCached(spaceId: string | null | undefined): SanityHours {
  if (!spaceId) return DEFAULT_SANITY_HOURS;
  const cached = hoursCache.get(spaceId);
  if (!cached || Date.now() - cached.at >= HOURS_CACHE_MS) getSanityHours(spaceId).catch(() => {});
  return cached?.hours || DEFAULT_SANITY_HOURS;
}

/**
 * Synchronous breach verdict for list views (Filters' "SLA Breached"
 * column). Returns null when the row isn't a Sanity ticket / bug subtask or
 * doesn't carry the sanity columns, so the caller falls back to its normal
 * department-policy logic.
 */
export function sanityBreachVerdict(i: any, isResolved: boolean, nowMs: number): { slaBreached: boolean; overdue: boolean } | null {
  if (!i || !isSanityCategory(i.ticketCategory) || i.sanity_sla === undefined) return null;
  const hours = getSanityHoursCached(i.spaceId);
  const stored = i.sanity_sla || {};
  const done = isResolved || !!i.resolvedAt;
  const endMs = done ? new Date(stored.closed_at || i.resolvedAt || nowMs).getTime() : nowMs;
  const over = (c: any, goalH: number) => !!c && clockElapsed(normClock(c), endMs) > goalH * HOUR_MS;
  let breached = false;
  if (!i.parentKey) {
    const overallMs = endMs - new Date(i.createdAt).getTime();
    const qaClock = stored.qa || { elapsed_ms: 0, running_since: new Date(i.createdAt).toISOString() };
    breached = overallMs > hours.overallHours * HOUR_MS || over(qaClock, hours.qaHours);
  } else if (normalizeSanityBugType(i.sanity_bug_type)) {
    breached = BUG_TEAM_CLOCKS.some((t) => over(stored[t.key], t.hours(hours))) || over(stored.qa, hours.bugQaHours);
  } else {
    return null;
  }
  return { slaBreached: breached, overdue: breached && !done };
}

// ── SLA cards for the ticket detail panel ────────────────────────────────

function clockInstance(opts: {
  id: string; policyId: string; policyName: string; badge: string;
  clock: Clock; goalMs: number; nowMs: number; isCompleted: boolean; closedAt: string | null;
  pausedReason: string;
}) {
  const { clock, goalMs, nowMs, isCompleted, closedAt } = opts;
  // A finished clock is measured up to the close moment, even if a sync
  // hasn't stopped it yet.
  const elapsed = clockElapsed(clock, isCompleted && closedAt ? new Date(closedAt).getTime() : nowMs);
  const running = !!clock.running_since && !isCompleted;
  const isPaused = !running && !isCompleted;
  // Due time = the moment the remaining budget runs out if the clock keeps
  // running from its latest reference point (now when running, the pause
  // moment while paused, the close moment once done).
  const refMs = running
    ? new Date(clock.running_since as string).getTime() - clock.elapsed_ms
    : (isCompleted && closedAt ? new Date(closedAt).getTime() : (clock.paused_at ? new Date(clock.paused_at).getTime() : nowMs)) - elapsed;
  return {
    id: `${opts.id}`,
    policyId: opts.policyId,
    policyName: opts.policyName,
    deptName: null,
    sanity: true,
    sanityBadge: opts.badge,
    startedAt: clock.first_started_at,
    dueTime: new Date(refMs + goalMs).toISOString(),
    runningSince: running ? clock.running_since : null,
    // Time already used before the current running period -- the panel adds
    // (now - runningSince) to this for a live, pause-aware elapsed figure.
    elapsedBeforeRunMs: clock.elapsed_ms,
    pausedReason: isPaused ? opts.pausedReason : null,
    isBreached: elapsed > goalMs,
    isPaused,
    isCompleted,
    resolvedAt: isCompleted ? closedAt : null,
    goalDurationMs: goalMs,
    actualElapsedMs: running ? undefined : elapsed,
    isNotified: false,
    waived: false,
  };
}

/**
 * Sanity SLA cards for a ticket, or null when it isn't a Sanity main ticket
 * or Sanity bug subtask (the normal department SLA engine then applies).
 * Shape matches computeSLAInstancesPure's entries, plus a few sanity-only
 * fields the SLA panel reads (sanity, sanityBadge, runningSince, pausedReason).
 */
export async function computeSanitySlaInstances(issue: any, isResolved: boolean): Promise<any[] | null> {
  if (!issue || !isSanityCategory(issue.ticketCategory)) return null;
  let bugType = issue.sanity_bug_type;
  let stored = issue.sanity_sla;
  if (bugType === undefined || stored === undefined) {
    try {
      const r = await pool.query(`SELECT sanity_bug_type, sanity_sla FROM issues WHERE id = $1 LIMIT 1`, [issue.id]);
      bugType = r.rows[0]?.sanity_bug_type ?? null;
      stored = r.rows[0]?.sanity_sla ?? null;
    } catch { bugType = bugType ?? null; stored = stored ?? null; }
  }
  const isParent = !issue.parentKey;
  const isBug = !!issue.parentKey && !!normalizeSanityBugType(bugType);
  if (!isParent && !isBug) return null;

  const hours = await getSanityHours(issue.spaceId ?? issue.space?.id);
  const nowMs = Date.now();
  const displayKey = issue.cf_key || issue.key;
  const resolvedIso = issue.resolvedAt ? new Date(issue.resolvedAt).toISOString() : null;

  if (isParent) {
    const createdIso = new Date(issue.createdAt).toISOString();
    const qa = stored?.qa ? normClock(stored.qa)
      : { elapsed_ms: 0, running_since: isResolved ? null : createdIso, first_started_at: createdIso, paused_at: null };
    // Not yet synced but already resolved: count creation -> resolution.
    if (!stored?.qa && isResolved && resolvedIso) qa.elapsed_ms = Math.max(0, new Date(resolvedIso).getTime() - new Date(createdIso).getTime());
    const closedAt = isResolved ? (stored?.closed_at || resolvedIso || new Date(nowMs).toISOString()) : null;
    const blockedBy: string[] = Array.isArray(stored?.blocked_by) ? stored.blocked_by : [];

    const overallClock: Clock = {
      elapsed_ms: isResolved && closedAt ? Math.max(0, new Date(closedAt).getTime() - new Date(createdIso).getTime()) : 0,
      running_since: isResolved ? null : createdIso,
      first_started_at: createdIso,
      paused_at: null,
    };
    return [
      clockInstance({
        id: `sanity_overall_${displayKey}`, policyId: 'sanity_overall', policyName: 'Sanity – Overall', badge: 'Any queue',
        clock: overallClock, goalMs: hours.overallHours * HOUR_MS, nowMs, isCompleted: isResolved, closedAt, pausedReason: '',
      }),
      clockInstance({
        id: `sanity_qa_${displayKey}`, policyId: 'sanity_qa', policyName: 'Sanity – QA', badge: 'QA',
        clock: qa, goalMs: hours.qaHours * HOUR_MS, nowMs, isCompleted: isResolved, closedAt,
        pausedReason: blockedBy.length ? `SLA Paused – blocked by ${blockedBy.join(', ')}` : 'SLA paused',
      }),
    ];
  }

  // Bug subtask: one card per clock that has ever run, oldest first, so the
  // cards read in the order the bug actually travelled.
  const state = readBugState(stored);
  const closedAt = isResolved ? (stored?.closed_at || resolvedIso || new Date(nowMs).toISOString()) : null;
  const typeLabel = normalizeSanityBugType(bugType) === 'blocker' ? 'Blocker' : 'Non-Blocker';
  const nowWith = String(issue.current_department || '').trim();
  const pausedAs = (fallback: string) => (nowWith ? `Paused – with ${nowWith}` : fallback);
  const out: { at: string; card: any }[] = [];
  for (const t of BUG_TEAM_CLOCKS) {
    const c = state[t.key];
    if (!c.first_started_at) continue;
    out.push({ at: c.first_started_at, card: clockInstance({
      id: `sanity_bug_${t.key}_${displayKey}`, policyId: `sanity_bug_${t.key}`, policyName: `Sanity Bug – ${t.label} (${typeLabel})`, badge: t.label,
      clock: c, goalMs: t.hours(hours) * HOUR_MS, nowMs, isCompleted: isResolved, closedAt,
      pausedReason: pausedAs(`Paused – not with ${t.label}`),
    }) });
  }
  if (state.qa.first_started_at) {
    out.push({ at: state.qa.first_started_at, card: clockInstance({
      id: `sanity_bug_qa_${displayKey}`, policyId: 'sanity_bug_qa', policyName: `Sanity Bug – QA re-test (${typeLabel})`, badge: 'QA',
      clock: state.qa, goalMs: hours.bugQaHours * HOUR_MS, nowMs, isCompleted: isResolved, closedAt,
      pausedReason: pausedAs('Paused – not in QA re-test'),
    }) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).map((x) => x.card);
}
