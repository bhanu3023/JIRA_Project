// Investigates the 67 Migration-queue SLA-breached tickets that
// check-sla-breach-accuracy.mjs flagged as "assignee not on roster" --
// every one showed a name with email=<null> (Tanmai Arangi, Devarapu Kota
// siva, Pallavi K, dathu). Checks whether these are genuinely different
// people (real gap: someone off the roster is holding Migration tickets)
// or duplicate/legacy user rows for people who ARE already on the roster
// under a different (real-email) account -- e.g. "Pallavi K" vs the
// roster's pallavi.kosuvaripalli@cloudfuze.com.
//
// Read-only.
//
// Usage: node check-migration-duplicate-accounts.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const NAMES = ['Tanmai Arangi', 'Devarapu Kota siva', 'Pallavi K', 'dathu'];

async function main() {
  for (const name of NAMES) {
    console.log(`\n=== "${name}" ===`);
    const { rows } = await pool.query(
      `SELECT id, email, "firstName", "lastName", "displayName", "isActive", role, "createdAt"
       FROM users
       WHERE ("firstName" || ' ' || "lastName") ILIKE $1 OR "displayName" ILIKE $1 OR "firstName" ILIKE $1
       ORDER BY "createdAt" ASC`,
      [`%${name}%`]
    );
    for (const u of rows) {
      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*) AS n FROM issues WHERE "assigneeId" = $1`,
        [u.id]
      );
      const { rows: worked } = await pool.query(
        `SELECT COUNT(*) AS n FROM user_worked_on_tickets WHERE user_id = $1`,
        [u.id]
      );
      console.log(`  id=${u.id}  email=${u.email}  name="${u.firstName} ${u.lastName}"  displayName="${u.displayName}"  active=${u.isActive}  role=${u.role}  createdAt=${u.createdAt.toISOString()}  assignedIssues=${cnt[0].n}  workedOnRows=${worked[0].n}`);
    }
    if (!rows.length) console.log('  (no matching user found)');
  }

  console.log('\n=== Known Migration roster accounts with similar real names (for comparison) ===');
  const { rows: rosterLike } = await pool.query(
    `SELECT id, email, "firstName", "lastName", "isActive" FROM users
     WHERE email IN ('pallavi.kosuvaripalli@cloudfuze.com', 'dathu.kaluvala@cloudfuze.com')
     ORDER BY email`
  );
  for (const u of rosterLike) {
    console.log(`  id=${u.id}  email=${u.email}  name="${u.firstName} ${u.lastName}"  active=${u.isActive}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
