// After the attribution fix (commit 78d8938), srinu gudimitla's Avg.
// response time shows "-" (no data) instead of a number, despite 58
// resolved tickets. Could be legitimate (he genuinely never personally
// authors the "In Progress" transition on his own tickets -- someone else
// always sets it before/while assigning to him) or a remaining matching
// bug. Pulls his real tickets and checks, for each one with a
// dept_sla_started_at, whether ANY "In Progress" transition after that
// point has an authorEmail matching him at all (regardless of the
// worked-roster/assignee membership check the real aggregation also
// applies) -- to see which case this actually is.
//
// Read-only.
//
// Usage: node check-srinu-response-time-dash.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);
const EMAIL = 'srinu.gudimitla@cloudfuze.com';

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  const userId = userRows[0]?.id;

  const { rows: issues } = await pool.query(
    `SELECT id, cf_key, key, current_department, dept_sla_started_at
     FROM issues WHERE "assigneeId" = $1 AND dept_sla_started_at IS NOT NULL
     ORDER BY "updatedAt" DESC LIMIT 20`,
    [userId]
  );

  let anyMatch = 0, anyInProgress = 0, noInProgressAtAll = 0;
  for (const issue of issues) {
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorEmail", "authorName", "createdAt" FROM issue_history
       WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [issue.id]
    );
    const startMs = new Date(issue.dept_sla_started_at).getTime();
    const match = hist.find(h => IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase()) && new Date(h.createdAt).getTime() >= startMs);
    if (!match) { noInProgressAtAll++; console.log(`${issue.cf_key || issue.key}: no qualifying In Progress transition after dept_sla_started_at`); continue; }
    anyInProgress++;
    const isHim = (match.authorEmail || '').toLowerCase() === EMAIL;
    if (isHim) anyMatch++;
    console.log(`${issue.cf_key || issue.key}: In Progress by "${match.authorName}" <${match.authorEmail}> ${isHim ? '<-- HIM' : '(someone else)'}`);
  }
  console.log(`\nOut of ${issues.length} tickets: ${anyInProgress} had a qualifying In Progress transition, ${anyMatch} authored by him, ${noInProgressAtAll} had none at all.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
