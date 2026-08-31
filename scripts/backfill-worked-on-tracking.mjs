// One-time backfill: reconstructs queue_closed_tickets + user_worked_on_tickets
// rows for tickets whose dept_statuses shows a department was genuinely
// resolved there, but which predate the code that writes those two tracking
// tables live (added after most of this app's historical data already
// existed) -- without them, the "Worked on" queue view can't find who closed
// a ticket in a given department, even though the ticket's own dept_statuses
// snapshot correctly remembers it WAS resolved there.
//
// Reconstructs by walking each affected issue's own issue_history
// chronologically -- the exact same signal the live app itself uses to
// freeze a dept_statuses snapshot when a ticket changes department -- tracking
// which department was "current" at each point, and recording the LAST
// status change to a done-category status name within each department stint
// as that department's closer (author + timestamp). A department with a
// done dept_statuses entry but no reconstructable closing event in its
// history (e.g. bulk-imported data with no granular history) is left alone
// and reported, never guessed.
//
// Usage:
//   node scripts/backfill-worked-on-tracking.mjs --dry-run   (default; prints stats + a sample, writes nothing)
//   node scripts/backfill-worked-on-tracking.mjs --live      (actually inserts, ON CONFLICT DO NOTHING)

import pg from 'pg';

const { Client } = pg;
const DRY_RUN = !process.argv.includes('--live');

function extractDeptFromChange(newValue) {
  if (!newValue) return null;
  // Observed formats: "Transferred to Migration", "Handed to Dev — SLA started"
  const m = String(newValue).match(/(?:Transferred to|Handed to)\s+([^—-]+)/i);
  if (m) return m[1].trim();
  return null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  if (!connectionString) {
    console.error('Set DATABASE_URL (or PG_CONNECTION_STRING) before running.');
    process.exit(1);
  }
  const client = new Client({ connectionString });
  await client.connect();

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write)'}`);

  // Scope to issues that actually have a missing entry -- same LEFT JOIN
  // shape used to measure the gap, just returning issue ids instead of a count.
  const { rows: candidateIssues } = await client.query(`
    WITH dept_done AS (
      SELECT i.id AS issue_id, ds.key AS dept_name
      FROM issues i, jsonb_each(i.dept_statuses) AS ds
      WHERE ds.value->>'category' = 'done'
    )
    SELECT DISTINCT dd.issue_id
    FROM dept_done dd
    LEFT JOIN queue_closed_tickets qct ON qct.issue_id = dd.issue_id AND LOWER(qct.dept_name) = LOWER(dd.dept_name)
    WHERE qct.id IS NULL
  `);
  console.log(`Issues with at least one missing tracking entry: ${candidateIssues.length}`);

  let deptEntriesReconstructed = 0;
  let deptEntriesUnreconstructable = 0;
  let userRowsReconstructed = 0;
  let userRowsSkippedNoUserMatch = 0;
  const sample = [];
  const qctInserts = []; // { spaceId, deptName, issueId, closedAt }
  const workedInserts = []; // { userId, issueId, dept, closedAt }

  const BATCH = 200;
  for (let i = 0; i < candidateIssues.length; i += BATCH) {
    const batchIds = candidateIssues.slice(i, i + BATCH).map((r) => r.issue_id);
    const { rows: issues } = await client.query(
      `SELECT id, key, cf_key, "spaceId", current_department, dept_statuses FROM issues WHERE id = ANY($1::text[])`,
      [batchIds]
    );
    const { rows: histRows } = await client.query(
      `SELECT "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history WHERE "issueId" = ANY($1::text[]) AND field IN ('department','status')
       ORDER BY "issueId", "createdAt" ASC`,
      [batchIds]
    );
    const histByIssue = new Map();
    for (const h of histRows) {
      if (!histByIssue.has(h.issueId)) histByIssue.set(h.issueId, []);
      histByIssue.get(h.issueId).push(h);
    }

    for (const issue of issues) {
      const deptStatuses = issue.dept_statuses || {};
      const doneDepts = Object.entries(deptStatuses)
        .filter(([, v]) => v?.category === 'done')
        .map(([k]) => k);
      if (!doneDepts.length) continue;

      const history = histByIssue.get(issue.id) || [];
      // Starting department: the oldValue of the FIRST department-change event,
      // if any; otherwise the ticket never changed department, so its whole
      // history happened in current_department.
      const firstDeptChange = history.find((h) => h.field === 'department');
      let currentDept = firstDeptChange?.oldValue || issue.current_department || null;
      const candidateByDept = new Map(); // dept(lower) -> { deptName, closedAt, authorName, authorEmail }

      // dept_statuses keys are the app's own recorded department names, but
      // currentDept is parsed from free-text issue_history messages -- their
      // casing isn't guaranteed to match exactly, so look up done-status
      // names case-insensitively rather than by exact object key (a mismatch
      // here would silently drop an otherwise-reconstructable entry).
      const deptStatusesByLower = new Map(
        Object.entries(deptStatuses).map(([k, v]) => [k.trim().toLowerCase(), v])
      );

      // Match against THIS ticket's own recorded done-status NAME per
      // department (deptStatuses[dept].name), not a generic guessed list of
      // "done-sounding" words -- the live app already recorded, per ticket,
      // exactly which status name it froze as that department's done state
      // (e.g. "Resolved", "Canceled", "Declined" -- spelling and wording
      // varies by board/import source), so matching against that directly is
      // both more accurate and immune to spelling variants a hardcoded list
      // would inevitably miss (caught "Canceled" vs "cancelled" this way
      // during a spot-check).
      for (const h of history) {
        if (h.field === 'status') {
          const currentDeptEntry = currentDept ? deptStatusesByLower.get(currentDept.trim().toLowerCase()) : null;
          const doneNameForCurrentDept = currentDeptEntry?.name;
          const isDoneHere = currentDept
            && currentDeptEntry?.category === 'done'
            && doneNameForCurrentDept
            && String(h.newValue || '').trim().toLowerCase() === String(doneNameForCurrentDept).trim().toLowerCase();
          if (isDoneHere) {
            candidateByDept.set(currentDept.toLowerCase(), {
              deptName: currentDept,
              closedAt: h.createdAt,
              authorName: h.authorName,
              authorEmail: h.authorEmail,
            });
          }
        } else if (h.field === 'department') {
          const next = extractDeptFromChange(h.newValue);
          if (next) currentDept = next;
        }
      }

      for (const dept of doneDepts) {
        const cand = candidateByDept.get(dept.toLowerCase());
        if (!cand) { deptEntriesUnreconstructable++; continue; }
        deptEntriesReconstructed++;
        qctInserts.push({ spaceId: issue.spaceId, deptName: cand.deptName, issueId: issue.id, closedAt: cand.closedAt });
        if (sample.length < 15) {
          sample.push({ cfKey: issue.cf_key || issue.key, dept: cand.deptName, closedAt: cand.closedAt, by: cand.authorName || cand.authorEmail });
        }
        if (cand.authorEmail) {
          workedInserts.push({ email: cand.authorEmail.toLowerCase(), issueId: issue.id, dept: cand.deptName, closedAt: cand.closedAt });
        }
      }
    }
  }

  // Resolve author emails -> user ids in one batch lookup.
  const emails = Array.from(new Set(workedInserts.map((w) => w.email)));
  const emailToId = new Map();
  if (emails.length) {
    const { rows: userRows } = await client.query(
      `SELECT id, LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])`,
      [emails]
    );
    for (const u of userRows) emailToId.set(u.email, u.id);
  }
  for (const w of workedInserts) {
    const userId = emailToId.get(w.email);
    if (!userId) { userRowsSkippedNoUserMatch++; continue; }
    userRowsReconstructed++;
    w.userId = userId;
  }

  console.log(`\nDepartment "done" entries reconstructed: ${deptEntriesReconstructed}`);
  console.log(`Department "done" entries left alone (no closing event found in history): ${deptEntriesUnreconstructable}`);
  console.log(`user_worked_on_tickets rows reconstructed: ${userRowsReconstructed}`);
  console.log(`user_worked_on_tickets rows skipped (author email didn't match a real user): ${userRowsSkippedNoUserMatch}`);
  console.log(`\nSample of what would be inserted into queue_closed_tickets:`);
  for (const s of sample) console.log(`  ${s.cfKey}  dept=${s.dept}  closedAt=${new Date(s.closedAt).toISOString()}  by=${s.by}`);

  if (DRY_RUN) {
    console.log('\nDry run only -- nothing written. Re-run with --live to apply.');
    await client.end();
    return;
  }

  console.log(`\nWriting ${qctInserts.length} queue_closed_tickets rows...`);
  for (const b of qctInserts) {
    await client.query(
      `INSERT INTO queue_closed_tickets (space_id, dept_name, issue_id, closed_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (space_id, dept_name, issue_id) DO NOTHING`,
      [b.spaceId, b.deptName, b.issueId, b.closedAt]
    );
  }
  console.log(`Writing ${workedInserts.filter((w) => w.userId).length} user_worked_on_tickets rows...`);
  for (const w of workedInserts) {
    if (!w.userId) continue;
    await client.query(
      `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at) VALUES ($1,$2,$3,'closed',$4)
       ON CONFLICT (user_id, issue_id, dept) DO UPDATE SET reason='closed', worked_at=EXCLUDED.worked_at`,
      [w.userId, w.issueId, w.dept, w.closedAt]
    );
  }
  console.log('Done.');
  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
