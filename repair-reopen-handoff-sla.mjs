// Repairs SLA data damaged by two bugs fixed in src/lib/jira-pg-api.ts
// (found on CF-35038). DRY RUN by default -- prints what it would change.
//
//   node repair-reopen-handoff-sla.mjs              # report only, every ticket
//   node repair-reopen-handoff-sla.mjs CF-35038     # report only, one ticket
//   node repair-reopen-handoff-sla.mjs --apply      # write the fixes
//
// 1) Reopen-handoff clock stop. Picking "Routed to X"/"Waiting for X" on a
//    RESOLVED ticket reopened it, but the handoff landed department X with
//    the copied "Resolved" status and stopped X's SLA clock on arrival
//    ("SLA resumed — X" immediately followed by "SLA resolved — X"). X then
//    held the ticket with its clock stopped, so that time was never added to
//    dept_sla_log[X].elapsed_ms. Fix: add the uncounted stretch (from that
//    "SLA resolved — X" to X's next SLA event); if the ticket is still
//    sitting in X with no later event, restart X's clock instead.
//
// 2) Stale sla_snapshot. A resolved ticket's SLA result is frozen once; it
//    was never refreshed after a reopen + re-resolve. Fix: clear snapshots
//    whose resolution doesn't match the ticket's current resolvedAt (and
//    every ticket repaired in step 1) so they're recomputed and re-frozen.
//    Tickets that still have no snapshot are re-frozen the next time they
//    are opened, or via POST /api/admin/backfill-sla-snapshots.
import pg from 'pg';
import fs from 'fs';

// Same parsing the app uses (src/lib/pg-pool.ts): timestamp-without-time-zone
// columns hold UTC.
pg.types.setTypeParser(1114, (s) => new Date(s + 'Z'));

for (const f of ['.env', '.env.server']) {
  if (process.env.DATABASE_URL || !fs.existsSync(f)) continue;
  const m = fs.readFileSync(f, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '');
}

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.slice(2).find((a) => /^[A-Za-z0-9]+-\d+$/.test(a)) || null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const lc = (s) => String(s || '').trim().toLowerCase();
const fmt = (ms) => { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h ${m % 60}m` : `${h}h ${m % 60}m`; };
const DASH = ' — ';

function isSlaSnapshotStale(snapshot, issueResolvedAt) {
  if (!issueResolvedAt) return false;
  const currentMs = new Date(issueResolvedAt).getTime();
  if (!Number.isFinite(currentMs)) return false;
  for (const inst of snapshot) {
    const frozenFor = inst?.frozenForResolvedAt ?? inst?.resolvedAt;
    if (!frozenFor) continue;
    const frozenMs = new Date(frozenFor).getTime();
    if (Number.isFinite(frozenMs)) return Math.abs(frozenMs - currentMs) > 1000;
  }
  return false;
}

async function doneStatusNames() {
  const names = new Set(['resolved', 'closed', 'done']);
  const st = await pool.query(`SELECT name FROM statuses WHERE category = 'done'`);
  for (const r of st.rows) names.add(lc(r.name));
  try {
    const cq = await pool.query(`SELECT queues FROM custom_queues`);
    for (const row of cq.rows) for (const q of row.queues || []) for (const s of q.queueStatuses || []) if (s.category === 'done') names.add(lc(s.name));
  } catch { /* table may not exist */ }
  return names;
}

async function main() {
  console.log(APPLY ? '*** APPLY MODE: writing changes ***\n' : 'Dry run (nothing is written). Re-run with --apply to fix.\n');
  const doneNames = await doneStatusNames();
  const onlyFilter = ONLY ? `AND (i.cf_key = $1 OR i.key = $1)` : '';
  const onlyParams = ONLY ? [ONLY] : [];

  // ── 1) Reopen-handoff clock stops ─────────────────────────────────────
  const cand = await pool.query(
    `SELECT DISTINCT r."issueId"
       FROM issue_history r
       JOIN issues i ON i.id = r."issueId"
      WHERE r.field = 'sla' AND r."newValue" LIKE 'SLA resolved — %' ${onlyFilter}
        AND EXISTS (
          SELECT 1 FROM issue_history s
           WHERE s."issueId" = r."issueId" AND s.field = 'sla'
             AND s."newValue" IN ('SLA started — ' || substring(r."newValue" from 16), 'SLA resumed — ' || substring(r."newValue" from 16))
             AND s."createdAt" BETWEEN r."createdAt" - interval '3 seconds' AND r."createdAt")`,
    onlyParams,
  );

  const repairedIds = new Set();
  let fixedTickets = 0;
  for (const { issueId } of cand.rows) {
    const { rows: [issue] } = await pool.query(
      `SELECT i.id, i.key, i.cf_key, i.current_department, i.dept_sla_log, s.category AS status_category
         FROM issues i LEFT JOIN statuses s ON s.id = i."statusId" WHERE i.id = $1`, [issueId]);
    const hist = (await pool.query(
      `SELECT field, "oldValue", "newValue", "createdAt" FROM issue_history
        WHERE "issueId" = $1 AND field IN ('sla','status') ORDER BY "createdAt", id`, [issueId])).rows;
    const log = issue.dept_sla_log || {};
    const fixes = []; // { dept, fromMs, toMs | null }

    hist.forEach((h, idx) => {
      if (h.field !== 'sla' || !String(h.newValue || '').startsWith('SLA resolved' + DASH)) return;
      const dept = h.newValue.slice(('SLA resolved' + DASH).length).trim();
      const t1 = h.createdAt.getTime();
      const startedRightBefore = hist.some((x) => x.field === 'sla'
        && (lc(x.newValue) === lc(`SLA started${DASH}${dept}`) || lc(x.newValue) === lc(`SLA resumed${DASH}${dept}`))
        && x.createdAt.getTime() <= t1 && t1 - x.createdAt.getTime() <= 3000);
      // The bug's signature: in the same request, someone reopened a done
      // ticket by picking "Routed to <dept>"/"Waiting for <dept>".
      const reopenPick = hist.some((x) => {
        if (x.field !== 'status') return false;
        const dt = t1 - x.createdAt.getTime();
        if (dt < 0 || dt > 5000) return false;
        const m = String(x.newValue || '').match(/^(?:waiting\s+for|routed\s+to)\s+(.+)$/i);
        return !!m && lc(m[1]) === lc(dept) && doneNames.has(lc(x.oldValue));
      });
      if (!startedRightBefore || !reopenPick) return;
      const deptLogKey = Object.keys(log).find((k) => lc(k) === lc(dept));
      if (!deptLogKey) return;
      if ((log[deptLogKey].repaired_reopen_gaps || []).includes(h.createdAt.toISOString())) return; // already repaired
      const next = hist.slice(idx + 1).find((x) => x.field === 'sla' && [
        `SLA paused${DASH}${dept}`, `SLA resolved${DASH}${dept}`, `SLA resumed${DASH}${dept}`, `SLA started${DASH}${dept}`,
      ].some((v) => lc(v) === lc(x.newValue)));
      fixes.push({ dept: deptLogKey, at: h.createdAt.toISOString(), fromMs: t1, toMs: next ? next.createdAt.getTime() : null });
    });
    if (!fixes.length) continue;

    fixedTickets++;
    console.log(`=== ${issue.cf_key || issue.key} (now in ${issue.current_department}, status ${issue.status_category}) ===`);
    for (const f of fixes) {
      const entry = log[f.dept];
      const before = entry.elapsed_ms || 0;
      if (f.toMs !== null) {
        const gap = f.toMs - f.fromMs;
        entry.elapsed_ms = before + gap;
        console.log(`  ${f.dept}: clock stopped ${f.at} -> ${new Date(f.toMs).toISOString()}, ${fmt(gap)} never counted. elapsed ${fmt(before)} -> ${fmt(entry.elapsed_ms)}`);
      } else if (lc(issue.current_department) === lc(f.dept) && issue.status_category !== 'done' && entry.status === 'paused') {
        entry.status = 'running';
        entry.paused_at = null;
        console.log(`  ${f.dept}: still holding the ticket with its clock stopped since ${f.at} -> restart the clock (elapsed so far ${fmt(before)}; time since the handoff counts from dept_sla_started_at)`);
      } else {
        console.log(`  ${f.dept}: clock stopped at ${f.at} with no later SLA event and the ticket is not open in ${f.dept} -- left unchanged, check by hand`);
        continue;
      }
      entry.repaired_reopen_gaps = [...(entry.repaired_reopen_gaps || []), f.at];
    }
    repairedIds.add(issue.id);
    if (APPLY) {
      await pool.query(`UPDATE issues SET dept_sla_log = $1::jsonb, sla_snapshot = NULL WHERE id = $2`, [JSON.stringify(log), issue.id]);
    }
  }
  console.log(`\n[1] Tickets with uncounted department time from a reopen handoff: ${fixedTickets}${APPLY ? ' (fixed)' : ''}\n`);

  // ── 2) Stale snapshots ────────────────────────────────────────────────
  const snaps = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."resolvedAt", i.sla_snapshot
       FROM issues i
      WHERE i.sla_snapshot IS NOT NULL AND jsonb_typeof(i.sla_snapshot) = 'array' AND jsonb_array_length(i.sla_snapshot) > 0 ${onlyFilter}`,
    onlyParams,
  );
  const stale = snaps.rows.filter((r) => !repairedIds.has(r.id) && isSlaSnapshotStale(r.sla_snapshot, r.resolvedAt));
  for (const r of stale.slice(0, 50)) {
    const frozen = r.sla_snapshot.find((x) => x?.frozenForResolvedAt || x?.resolvedAt);
    console.log(`  ${r.cf_key || r.key}: snapshot frozen for ${frozen?.frozenForResolvedAt || frozen?.resolvedAt}, ticket last resolved ${r.resolvedAt?.toISOString?.() ?? r.resolvedAt}`);
  }
  if (stale.length > 50) console.log(`  ... and ${stale.length - 50} more`);
  if (APPLY && stale.length) {
    await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = ANY($1::text[])`, [stale.map((r) => r.id)]);
  }
  console.log(`\n[2] Resolved tickets showing an SLA result from an earlier resolution: ${stale.length}${APPLY ? ' (cleared)' : ''}\n`);

  // ── 3) Wrong-perspective snapshots ────────────────────────────────────
  // Report queries compute SLAs "as if" a ticket sat in some department, and
  // used to freeze that result as the ticket's own snapshot. Signature: the
  // snapshot's completed (resolving-department) entry names a different
  // department than the ticket's last "SLA resolved — <Dept>" History entry.
  // A ticket legitimately moved after being resolved is unaffected: its last
  // resolution still matches its snapshot.
  const staleIds = new Set(stale.map((r) => r.id));
  const remaining = snaps.rows.filter((r) => !repairedIds.has(r.id) && !staleIds.has(r.id));
  const lastResolved = new Map();
  if (remaining.length) {
    const lr = await pool.query(
      `SELECT DISTINCT ON ("issueId") "issueId", substring("newValue" from 16) AS dept
         FROM issue_history
        WHERE field = 'sla' AND "newValue" LIKE 'SLA resolved — %' AND "issueId" = ANY($1::text[])
        ORDER BY "issueId", "createdAt" DESC`,
      [remaining.map((r) => r.id)],
    );
    for (const row of lr.rows) lastResolved.set(row.issueId, lc(row.dept));
  }
  const wrongView = remaining.filter((r) => {
    const resolvedIn = lastResolved.get(r.id);
    const completed = r.sla_snapshot.find((x) => x?.isCompleted && x?.deptName);
    return !!resolvedIn && !!completed && lc(completed.deptName) !== resolvedIn;
  });
  for (const r of wrongView.slice(0, 50)) {
    const completed = r.sla_snapshot.find((x) => x?.isCompleted && x?.deptName);
    console.log(`  ${r.cf_key || r.key}: snapshot treats ${completed.deptName} as the resolving department, but it was last resolved in ${lastResolved.get(r.id)}`);
  }
  if (wrongView.length > 50) console.log(`  ... and ${wrongView.length - 50} more`);
  if (APPLY && wrongView.length) {
    await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = ANY($1::text[])`, [wrongView.map((r) => r.id)]);
  }
  console.log(`\n[3] Resolved tickets whose SLA result was saved from another department's view: ${wrongView.length}${APPLY ? ' (cleared)' : ''}`);
  if (APPLY && (stale.length || repairedIds.size || wrongView.length)) {
    console.log('\nCleared snapshots are rebuilt when each ticket is next opened, or all at once via POST /api/admin/backfill-sla-snapshots (admin; repeat until remaining is 0).');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
