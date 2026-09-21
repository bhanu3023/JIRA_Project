// The narrow check (assigneeId = srinu) only found 6 of his 58 MBR-credited
// tickets -- most of his credit likely comes through the "worked" table
// (user_worked_on_tickets), not current assignment. Pulls his FULL worked +
// assigned ticket pool (matching MBR's own emails-set logic) and checks how
// many have a genuine self-authored "In Progress" transition at all, to
// confirm the dash reflects real data sparsity rather than a bug.
//
// Read-only.
//
// Usage: node check-srinu-full-worked-pool.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);
const EMAIL = 'srinu.gudimitla@cloudfuze.com';

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
  const userId = userRows[0]?.id;
  const { rows: worked } = await pool.query(
    `SELECT DISTINCT issue_id FROM user_worked_on_tickets WHERE user_id = $1`,
    [userId]
  );
  const { rows: assigned } = await pool.query(`SELECT id FROM issues WHERE "assigneeId" = $1`, [userId]);

  const allIds = Array.from(new Set([...worked.map(w => w.issue_id), ...assigned.map(a => a.id)]));
  console.log(`Total distinct tickets (worked + assigned): ${allIds.length}`);

  let withSlaAnchor = 0, withInProgress = 0, authoredByHim = 0;
  for (const id of allIds) {
    const { rows: issueRows } = await pool.query(`SELECT cf_key, key, dept_sla_started_at FROM issues WHERE id = $1`, [id]);
    const issue = issueRows[0];
    if (!issue?.dept_sla_started_at) continue;
    withSlaAnchor++;
    const { rows: hist } = await pool.query(
      `SELECT "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
      [id]
    );
    const startMs = new Date(issue.dept_sla_started_at).getTime();
    const match = hist.find(h => IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase()) && new Date(h.createdAt).getTime() >= startMs);
    if (!match) continue;
    withInProgress++;
    if ((match.authorEmail || '').toLowerCase() === EMAIL) authoredByHim++;
  }

  console.log(`Of those, ${withSlaAnchor} have a dept_sla_started_at anchor.`);
  console.log(`Of those, ${withInProgress} have a qualifying In Progress transition at all.`);
  console.log(`Of those, ${authoredByHim} were authored by him personally.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
