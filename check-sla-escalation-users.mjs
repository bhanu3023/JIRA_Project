// Read-only diagnostic: look up the real user accounts named in the new
// SLA escalation requirement (Migration: Abhishek & Ajay, Ops, Sujana;
// Dev/Customer Engineering: Mayank, Ops, Sujana), so the actual feature
// can notify real people instead of guessed matches.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const NAMES = ['abhishek', 'ajay', 'mayank', 'sujana', 'ops'];

async function main() {
  for (const name of NAMES) {
    const { rows } = await pool.query(
      `SELECT id, "firstName", "lastName", email, role, "isActive" FROM users
       WHERE "firstName" ILIKE $1 OR "lastName" ILIKE $1 OR email ILIKE $1
       ORDER BY "firstName"`,
      [`%${name}%`],
    );
    console.log(`\n"${name}": ${rows.length} match(es)`);
    for (const u of rows) console.log(`  ${u.id}  ${u.firstName} ${u.lastName}  <${u.email}>  role=${u.role}  active=${u.isActive}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
