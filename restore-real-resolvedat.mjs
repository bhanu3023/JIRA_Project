// Restores resolvedAt for tickets whose saved resolution date was moved
// forward by a data-repair script rather than by anyone actually resolving
// them. Confirmed for real on CF-23245: genuinely resolved/routed in April,
// then complete-stuck-handoffs.mjs (Sep) finished its stuck hand-off and
// started a department SLA clock on the already-resolved ticket, a later
// clock-pausing backfill stopped that clock, and backfill-stale-resolvedat.mjs
// (which treats "current department's clock paused after resolvedAt" as proof
// resolvedAt is stale) moved resolvedAt to that repair-time pause. The ticket
// then showed as "resolved in September" in MBR and Filters, with ~5 months of
// nobody touching it counted as its owner's resolution time.
//
// A ticket is corrected only when ALL of these hold:
//   - it is done and has a resolvedAt;
//   - no real status change into a done status lands within 10 minutes of
//     that resolvedAt (nothing actually resolved it then);
//   - an earlier real done transition exists, with no status change of any
//     kind after it (never reopened since);
//   - nobody did anything to it after that transition: no comments, and no
//     history rows other than repair/system entries ('Manual data fix',
//     'System') or automatic SLA entries.
// The new resolvedAt is that last real done transition. Bulk status-cleanup
// artifacts (one instant shared by more than 5 tickets' done rows, see
// audit-fix-resolvedat-gaps.mjs) never count as a real resolution.
//
// Also rewrites sla_snapshot entries whose resolvedAt equals the old value,
// same as backfill-stale-resolvedat.mjs.
//
// Usage:
//   node restore-real-resolvedat.mjs                 # dry run, every ticket
//   node restore-real-resolvedat.mjs CF-23245        # dry run, one ticket: prints its
//                                                    # history and which check stopped it
//   node restore-real-resolvedat.mjs --apply         # write the corrections
//   node restore-real-resolvedat.mjs CF-23245 --apply

import pg from 'pg';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_KEY = args.find((a) => !a.startsWith('--'));
const MATCH_WINDOW_MS = 10 * 60 * 1000;
const DONE_NAMES = ['done', 'resolved', 'closed', 'approved', 'complete', 'completed', 'cancelled', 'canceled', 'rejected'];
const NON_HUMAN_AUTHORS = new Set(['manual data fix', 'system']);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: bulkRows } = await pool.query(`
    SELECT h."createdAt" FROM issue_history h
    WHERE h.field = 'status' AND LOWER(TRIM(h."newValue")) = ANY($1::text[])
    GROUP BY h."createdAt" HAVING COUNT(DISTINCT h."issueId") > 5
  `, [DONE_NAMES]);
  const bulkInstants = new Set(bulkRows.map((r) => new Date(r.createdAt).getTime()));

  // With a single key, report the ticket's state and which check stopped it
  // (read-only) -- so a "0 would be corrected" result is explainable.
  const { rows: issues } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."resolvedAt", i.sla_snapshot, i.current_department,
           s.name AS status_name, s.category AS status_category
    FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE ${ONLY_KEY ? `(i.cf_key = $1 OR i.key = $1)` : `s.category = 'done' AND i."resolvedAt" IS NOT NULL`}
  `, ONLY_KEY ? [ONLY_KEY] : []);
  if (ONLY_KEY && !issues.length) console.log(`${ONLY_KEY}: not found`);

  const fmt = (d) => (d ? new Date(d).toISOString() : 'null');
  let candidates = 0;
  for (const issue of issues) {
    const skip = (reason) => { if (ONLY_KEY) console.log(`\n${issue.key}: SKIPPED -- ${reason}`); };
    const { rows: hist } = await pool.query(
      `SELECT id, field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    if (ONLY_KEY) {
      console.log(`${issue.key}: status "${issue.status_name}" (${issue.status_category}), dept ${issue.current_department}, resolvedAt ${fmt(issue.resolvedAt)}`);
      console.log('history:');
      for (const h of hist) console.log(`  ${fmt(h.createdAt)}  ${h.field.padEnd(10)} ${JSON.stringify(h.oldValue)} -> ${JSON.stringify(h.newValue)}  [${h.authorName || 'Unknown'}]`);
    }
    if (issue.status_category !== 'done' || !issue.resolvedAt) { skip('not currently done with a resolvedAt'); continue; }
    const resolvedMs = new Date(issue.resolvedAt).getTime();
    const statusRows = hist.filter((h) => h.field === 'status');
    const isRealDone = (h) => DONE_NAMES.includes(String(h.newValue || '').trim().toLowerCase())
      && !bulkInstants.has(new Date(h.createdAt).getTime());

    const matching = statusRows.find((h) => isRealDone(h) && Math.abs(new Date(h.createdAt).getTime() - resolvedMs) <= MATCH_WINDOW_MS);
    if (matching) { skip(`resolvedAt is backed by a real "${matching.newValue}" at ${fmt(matching.createdAt)}`); continue; }

    const lastStatus = statusRows[statusRows.length - 1];
    if (!lastStatus) { skip('no status history at all'); continue; }
    if (!isRealDone(lastStatus)) { skip(`last status change is "${lastStatus.newValue}" at ${fmt(lastStatus.createdAt)}, not a real resolution (reopened/routed since, or a bulk artifact)`); continue; }
    const realMs = new Date(lastStatus.createdAt).getTime();
    if (realMs >= resolvedMs - MATCH_WINDOW_MS) { skip('last real resolution is not earlier than resolvedAt'); continue; }

    const humanAfter = hist.find((h) => new Date(h.createdAt).getTime() > realMs
      && h.field !== 'sla'
      && !NON_HUMAN_AUTHORS.has(String(h.authorName || '').trim().toLowerCase()));
    if (humanAfter) { skip(`activity after the last real resolution: ${humanAfter.field} by ${humanAfter.authorName || 'Unknown'} at ${fmt(humanAfter.createdAt)}`); continue; }
    const { rows: commentRows } = await pool.query(
      `SELECT "createdAt" FROM comments WHERE "issueId" = $1 AND "createdAt" > $2 ORDER BY "createdAt" LIMIT 1`,
      [issue.id, lastStatus.createdAt]
    );
    if (commentRows.length) { skip(`comment after the last real resolution at ${fmt(commentRows[0].createdAt)}`); continue; }

    candidates++;
    const oldIso = new Date(issue.resolvedAt).toISOString();
    const newIso = new Date(lastStatus.createdAt).toISOString();
    const days = ((resolvedMs - realMs) / 86_400_000).toFixed(1);
    console.log(`${issue.key}: resolvedAt ${oldIso} -> ${newIso}  (last real "${lastStatus.newValue}" by ${lastStatus.authorName || 'Unknown'}; moved ${days} days back)`);

    if (APPLY) {
      const snapshot = Array.isArray(issue.sla_snapshot) ? issue.sla_snapshot : [];
      const newSnapshot = snapshot.map((inst) => (inst?.resolvedAt === oldIso ? { ...inst, resolvedAt: newIso } : inst));
      // Copy the history row's own stored value, so no timezone conversion
      // happens on the way back into the naive timestamp column.
      await pool.query(
        `UPDATE issues SET "resolvedAt" = (SELECT "createdAt" FROM issue_history WHERE id = $1), sla_snapshot = $2::jsonb WHERE id = $3`,
        [lastStatus.id, JSON.stringify(newSnapshot), issue.id]
      );
    }
  }

  console.log(`\n${candidates} ticket(s) ${APPLY ? 'corrected' : 'would be corrected'}${APPLY ? '' : ' -- dry run only, re-run with --apply to write'}.`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
