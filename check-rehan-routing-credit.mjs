// Checks the exact user_worked_on_tickets rows crediting Rehan Khan with
// "Dev" involvement on CF-29976/CF-29973 -- tickets that never originated
// in Dev (original_dept=Migration) and show him rapidly routing them
// through Dev and back within the same hour, not doing real dev work.
//
// Read-only.
//
// Usage: node check-rehan-routing-credit.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT w.issue_id, COALESCE(i.cf_key, i.key) AS key, w.dept, w.reason, w.worked_at,
           wu."firstName", wu."lastName"
    FROM user_worked_on_tickets w
    JOIN users wu ON wu.id = w.user_id
    JOIN issues i ON i.id = w.issue_id
    WHERE wu.email = 'rehan.khan@cloudfuze.com' AND i.cf_key IN ('CF-29976','CF-29973')
    ORDER BY key, worked_at
  `);
  for (const r of rows) {
    console.log(`${r.key}: dept=${r.dept}  reason=${r.reason}  worked_at=${r.worked_at.toISOString()}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
