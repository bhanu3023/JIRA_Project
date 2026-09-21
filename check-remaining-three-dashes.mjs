// 3 people still show a dash after the null-department roster fallback fix:
// Mayank Jain (eng, total=1 dash out of total=3), Lakshmi Prasanna (ent,
// total=1), Ajay Singh (smb, total=1). For each, pulls their real August
// 2026 tickets, status history, current_department, and dept_sla_started_at
// to see exactly which condition in computeResponseTimeHours / the
// aggregation loop's credit logic is still failing for them.
//
// Read-only.
//
// Usage: node check-remaining-three-dashes.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);
const PEOPLE = [
  { email: 'mayank@cloudfuze.com', dept: 'Dev' },
  { email: 'lakshmi.prasanna@cloudfuze.com', dept: 'Migration' },
  { email: 'ajay.singh@cloudfuze.com', dept: 'Migration' },
];

async function main() {
  for (const { email, dept } of PEOPLE) {
    console.log(`\n\n========== ${email} (dept=${dept}) ==========`);
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userRows[0]?.id;
    if (!userId) { console.log('user not found'); continue; }

    // Check live queue membership for this dept, TESTIN space.
    const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
    let isLiveMember = false;
    for (const row of cqRows) {
      for (const q of (row.queues || [])) {
        if (String(q.name || '').toLowerCase() === dept.toLowerCase() && Array.isArray(q.memberIds) && q.memberIds.includes(userId)) isLiveMember = true;
      }
    }
    console.log(`Live ${dept} queue member: ${isLiveMember}`);

    // Tickets assigned to them, updated in August 2026 (proxy for MBR's August-scoped set).
    const { rows: issues } = await pool.query(
      `SELECT id, cf_key, key, current_department, dept_sla_started_at, "createdAt", "updatedAt"
       FROM issues WHERE "assigneeId" = $1 AND "updatedAt" >= '2026-08-01' AND "updatedAt" < '2026-09-01'
       ORDER BY "updatedAt" DESC LIMIT 5`,
      [userId]
    );
    console.log(`Assigned tickets updated in Aug 2026: ${issues.length}`);
    for (const issue of issues) {
      console.log(`\n${issue.cf_key || issue.key}: current_department="${issue.current_department}" dept_sla_started_at=${issue.dept_sla_started_at ? new Date(issue.dept_sla_started_at).toISOString() : 'NULL'} createdAt=${issue.createdAt.toISOString()}`);
      const { rows: hist } = await pool.query(
        `SELECT "oldValue", "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
        [issue.id]
      );
      if (!hist.length) { console.log('  (no status history)'); continue; }
      for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue} (by ${h.authorEmail})`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
