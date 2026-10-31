// Recomputes every "SLA breached — Dept (Name)" History entry from the
// ticket's own SLA History, so each department that went over its target has
// exactly one entry, stamped at the minute its clock actually ran out and
// naming who it breached under.
//
// Why: fix-backfill-missing-breach-history.mjs (and the old SLA card) placed
// the breach by counting back from the department's LAST visit
// (last start + target - total time). That is only right for a department
// that held the ticket in one unbroken stretch. CF-33996 went back and forth
// between QA and Dev nine times: QA's clock really ran out on 9 Oct 07:35 IST
// with nobody assigned, but the backfill wrote "SLA breached — QA (Lakshmi
// Adabala)" at 11 Oct 02:59, when the ticket was in Dev.
//
// For each ticket and each department it has stopped working on (paused or
// resolved there -- the department currently running is the live breach
// check's job):
//   1. Rebuild the department's visits from its "SLA started/resumed —
//      Dept" and "SLA paused/resolved — Dept" entries. Skip the department if
//      those don't add up to the time dept_sla_log recorded (within 2 min), or
//      if it has none.
//   2. Walk the visits until the total reaches the department's target for
//      the ticket's priority: that minute is the breach. No breach if it
//      never does.
//   3. Name: same rules as breachHolderName in src/lib/jira-pg-api.ts --
//      whoever held it then; if nobody, the first person assigned in that
//      department afterwards; keep the two in step.
//   4. Insert / correct / delete the department's breach entries to match.
//
// Targets: the newest active dept-scoped policy in the ticket's space, with
// the same pre-2026-09-28 Dev/Migration overrides the app uses
// (HISTORICAL_SLA_OVERRIDES), applied to tickets from before QA/Infra had a
// policy too.
//
// Usage (from the app folder on the server):
//   node --env-file=.env fix-recompute-breach-history.mjs                 dry run, all tickets
//   node --env-file=.env fix-recompute-breach-history.mjs --key CF-33996  dry run, one ticket
//   node --env-file=.env fix-recompute-breach-history.mjs --apply         make the changes
import pg from 'pg';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const keyArgIdx = process.argv.indexOf('--key');
const ONLY_KEY = keyArgIdx > -1 ? process.argv[keyArgIdx + 1] : null;
const TOLERANCE_MS = 2 * 60 * 1000;
const EDGE_MS = 5000;
const PREFIX = 'SLA breached — ';

const HISTORICAL_SLA_OVERRIDES = {
  migration: { beforeMs: Date.parse('2026-09-28T10:57:56.000Z'), hoursByPriority: { medium: 10 } },
  dev: { beforeMs: Date.parse('2026-09-28T10:57:19.000Z'), hoursByPriority: { highest: 6, high: 8, medium: 24, low: 48, lowest: 48 } },
};

const rid = () => 'rb_' + crypto.randomBytes(12).toString('hex');
const ms = (d) => new Date(d).getTime();
const clean = (v) => (v && v !== 'None' ? String(v) : null);
const ist = (m) => new Date(m).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

// Same priority -> target rules as computeSLAInstancesPure: a 0 means this
// priority has no SLA; no row for the priority falls back to 8h.
function goalMs(policy, priority) {
  for (const goal of policy.goals || []) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        const val = parseFloat(row.timeValue);
        if (val === 0) return null;
        const unit = (row.timeUnit || 'hours').toLowerCase();
        return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
      }
    } else if (goal.timeValue) {
      const val = parseFloat(goal.timeValue);
      if (val === 0) return null;
      const unit = (goal.timeUnit || 'hours').toLowerCase();
      return unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
    }
  }
  return 8 * 3_600_000;
}

function visitsFor(slaRows, dept) {
  const key = dept.trim().toLowerCase();
  const visits = [];
  let open = null;
  for (const r of slaRows) {
    const m = String(r.newValue || '').match(/^SLA (started|resumed|paused|resolved) — (.+)$/);
    if (!m || m[2].trim().toLowerCase() !== key) continue;
    if (m[1] === 'started' || m[1] === 'resumed') { if (open === null) open = ms(r.createdAt); }
    else if (open !== null) { visits.push([open, ms(r.createdAt)]); open = null; }
  }
  return { visits, stillOpen: open !== null };
}

function holderName(assigns, visits, at) {
  if (!assigns.length) return null;
  const before = assigns.filter((a) => ms(a.createdAt) <= at);
  const holder = before.length ? clean(before[before.length - 1].newValue) : clean(assigns[0].oldValue);
  if (holder) return holder;
  const next = assigns.find((a) => {
    const t = ms(a.createdAt);
    return t >= at && clean(a.newValue) && visits.some(([s, e]) => t >= s - EDGE_MS && t < e - EDGE_MS);
  });
  return next ? clean(next.newValue) : null;
}

async function main() {
  const { rows: policies } = await pool.query(
    `SELECT "spaceId", dept_name, goals, "updatedAt" FROM sla_definitions WHERE status = 'active' AND COALESCE(dept_name, '') <> ''`,
  );
  const policyFor = new Map(); // spaceId|dept -> newest policy
  for (const p of policies) {
    const k = `${p.spaceId}|${p.dept_name.trim().toLowerCase()}`;
    const prev = policyFor.get(k);
    if (!prev || ms(p.updatedAt) > ms(prev.updatedAt)) policyFor.set(k, p);
  }

  const { rows: issues } = await pool.query(
    `SELECT id, COALESCE(cf_key, key) AS key, priority, "spaceId", dept_sla_log FROM issues
     WHERE dept_sla_log IS NOT NULL AND dept_sla_log::text <> '{}'
       ${ONLY_KEY ? `AND $1 IN (cf_key, key)` : ''}`,
    ONLY_KEY ? [ONLY_KEY] : [],
  );

  const stats = { tickets: issues.length, ok: 0, insert: 0, update: 0, delete: 0, noPolicy: 0, noHistory: 0, mismatch: 0, running: 0 };
  const changes = [];
  const mismatches = [];

  for (let i = 0; i < issues.length; i += 500) {
    const chunk = issues.slice(i, i + 500);
    const { rows: hist } = await pool.query(
      `SELECT id, "issueId", field, "oldValue", "newValue", "createdAt" FROM issue_history
       WHERE "issueId" = ANY($1::text[]) AND field IN ('assignee', 'sla')
       ORDER BY "createdAt" ASC, id ASC`,
      [chunk.map((x) => x.id)],
    );
    const histBy = new Map();
    for (const h of hist) (histBy.get(h.issueId) || histBy.set(h.issueId, []).get(h.issueId)).push(h);

    for (const issue of chunk) {
      const rows = histBy.get(issue.id) || [];
      const slaRows = rows.filter((r) => r.field === 'sla');
      const assigns = rows.filter((r) => r.field === 'assignee');
      const priority = (issue.priority || 'medium').toLowerCase();

      for (const [dept, entry] of Object.entries(issue.dept_sla_log || {})) {
        if (!entry || entry.status === 'running') { stats.running++; continue; }
        const deptKey = dept.trim().toLowerCase();
        const policy = policyFor.get(`${issue.spaceId}|${deptKey}`);
        if (!policy) { stats.noPolicy++; continue; }
        const override = HISTORICAL_SLA_OVERRIDES[deptKey];
        const overrideHours = override && entry.started_at && ms(entry.started_at) < override.beforeMs
          ? override.hoursByPriority[priority] : undefined;
        const goal = typeof overrideHours === 'number' ? overrideHours * 3_600_000 : goalMs(policy, priority);
        if (goal === null) { stats.noPolicy++; continue; }

        const { visits, stillOpen } = visitsFor(slaRows, dept);
        if (!visits.length) { stats.noHistory++; continue; }
        const total = visits.reduce((sum, [s, e]) => sum + (e - s), 0);
        if (stillOpen || Math.abs(total - (entry.elapsed_ms || 0)) > TOLERANCE_MS) {
          stats.mismatch++;
          mismatches.push(`${issue.key} ${dept}: History adds up to ${(total / 3.6e6).toFixed(2)}h, clock says ${((entry.elapsed_ms || 0) / 3.6e6).toFixed(2)}h${stillOpen ? ' (a visit never closed)' : ''}`);
          continue;
        }

        let breachedAt = null;
        let cum = 0;
        for (const [s, e] of visits) {
          if (cum + (e - s) >= goal) { breachedAt = s + (goal - cum); break; }
          cum += e - s;
        }

        const existing = slaRows.filter((r) => {
          const v = String(r.newValue || '').toLowerCase();
          const base = (PREFIX + dept).toLowerCase();
          return v === base || v.startsWith(base + ' (');
        });

        if (breachedAt === null) {
          if (existing.length) {
            stats.delete += existing.length;
            changes.push({ kind: 'delete', issue, ids: existing.map((e) => e.id), text: `${issue.key} ${dept}: not breached (${(total / 3.6e6).toFixed(1)}h of ${goal / 3.6e6}h) -- remove ${existing.map((e) => `"${e.newValue}" @ ${ist(e.createdAt)}`).join(', ')}` });
          } else stats.ok++;
          continue;
        }

        const name = holderName(assigns, visits, breachedAt);
        const label = `${PREFIX}${dept}${name ? ` (${name})` : ''}`;
        const at = new Date(Math.floor(breachedAt));
        if (!existing.length) {
          stats.insert++;
          changes.push({ kind: 'insert', issue, label, at, text: `${issue.key} ${dept}: add "${label}" @ ${ist(at)}` });
          continue;
        }
        const [keep, ...extra] = existing;
        const sameTime = Math.abs(ms(keep.createdAt) - at.getTime()) < 60_000;
        if (keep.newValue === label && sameTime && !extra.length) { stats.ok++; continue; }
        stats.update++;
        changes.push({ kind: 'update', issue, id: keep.id, extraIds: extra.map((e) => e.id), label, at,
          text: `${issue.key} ${dept}: "${keep.newValue}" @ ${ist(keep.createdAt)}  ->  "${label}" @ ${ist(at)}${extra.length ? ` (+ remove ${extra.length} duplicate)` : ''}` });
      }
    }
  }

  console.log(`Tickets checked: ${stats.tickets}`);
  console.log(`Departments already correct: ${stats.ok}`);
  console.log(`To add: ${stats.insert}   To correct: ${stats.update}   To remove (never breached): ${stats.delete}`);
  console.log(`Skipped -- still running there: ${stats.running}, no SLA for that dept/priority: ${stats.noPolicy}, no SLA history to replay: ${stats.noHistory}, history doesn't match the clock: ${stats.mismatch}`);
  const show = ONLY_KEY ? changes : changes.slice(0, 40);
  if (show.length) {
    console.log(`\nChanges${ONLY_KEY ? '' : ' (first 40)'}:`);
    for (const c of show) console.log(' - ' + c.text);
  }
  if (mismatches.length) {
    console.log(`\nSkipped because History and the clock disagree${ONLY_KEY ? '' : ' (first 15)'}:`);
    for (const m of (ONLY_KEY ? mismatches : mismatches.slice(0, 15))) console.log(' - ' + m);
  }

  if (!APPLY) {
    console.log('\nDRY RUN -- nothing changed. Re-run with --apply to make these changes.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      if (c.kind === 'insert') {
        await client.query(
          `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
           VALUES ($1, $2, 'sla', NULL, $3, 'System', NULL, $4)`,
          [rid(), c.issue.id, c.label, c.at],
        );
      } else if (c.kind === 'update') {
        await client.query(`UPDATE issue_history SET "newValue" = $2, "createdAt" = $3 WHERE id = $1`, [c.id, c.label, c.at]);
        if (c.extraIds.length) await client.query(`DELETE FROM issue_history WHERE id = ANY($1::text[])`, [c.extraIds]);
      } else {
        await client.query(`DELETE FROM issue_history WHERE id = ANY($1::text[])`, [c.ids]);
      }
    }
    await client.query('COMMIT');
    console.log(`\nApplied ${changes.length} changes.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nFailed, nothing changed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
