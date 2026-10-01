// Lakshmi Prasanna (ent) and Ajay Singh (smb) each show total=1 in MBR's
// August view but had ZERO tickets assigned to them updated in August --
// meaning their 1 ticket is counted via user_worked_on_tickets (the
// "worked" credit table) while assigned to someone else. Finds that
// specific ticket for each and dumps its status history + who the current
// assignee actually is, to see why the response-time credit isn't landing
// on them.
//
// Read-only.
//
// Usage: node check-lakshmi-ajay-worked-credit.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PEOPLE = [
  { email: 'lakshmi.prasanna@cloudfuze.com', dept: 'Migration' },
  { email: 'ajay.singh@cloudfuze.com', dept: 'Migration' },
];

async function main() {
  for (const { email, dept } of PEOPLE) {
    console.log(`\n\n========== ${email} (dept=${dept}) ==========`);
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userRows[0]?.id;
    if (!userId) { console.log('not found'); continue; }

    const { rows: worked } = await pool.query(
      `SELECT w.issue_id, w.dept, w.reason, w.worked_at, i.cf_key, i.key, i."assigneeId", au.email AS assignee_email,
              i.current_department, i.dept_sla_started_at, i."createdAt", i."updatedAt"
       FROM user_worked_on_tickets w
       JOIN issues i ON i.id = w.issue_id
       LEFT JOIN users au ON au.id = i."assigneeId"
       WHERE w.user_id = $1 AND LOWER(w.dept) = LOWER($2) AND w.reason != 'passed'
         AND i."updatedAt" >= '2026-08-01' AND i."updatedAt" < '2026-09-01'`,
      [userId, dept]
    );
    console.log(`Worked-credit tickets (Aug 2026, dept=${dept}): ${worked.length}`);
    for (const w of worked) {
      console.log(`\n${w.cf_key || w.key}: reason=${w.reason} worked_at=${w.worked_at?.toISOString?.() || w.worked_at}`);
      console.log(`  current assignee: ${w.assignee_email} | current_department: ${w.current_department} | dept_sla_started_at: ${w.dept_sla_started_at ? new Date(w.dept_sla_started_at).toISOString() : 'NULL'}`);
      const { rows: hist } = await pool.query(
        `SELECT "oldValue", "newValue", "authorEmail", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'status' ORDER BY "createdAt" ASC`,
        [w.issue_id]
      );
      for (const h of hist) console.log(`    [${h.createdAt.toISOString()}] ${h.oldValue} -> ${h.newValue} (by ${h.authorEmail})`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
