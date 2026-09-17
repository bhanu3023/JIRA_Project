// Checks whether the 2026-02-06 bulk "Closed -> Resolved" status-cleanup
// artifact (500-ticket batches, confirmed NOT organic individual work)
// polluted user_worked_on_tickets for Sujana Manapuram -- that table is what
// drives Filters' "Worked on" view and Team Analytics, so if the bulk event
// wrote there too, she'd be wrongly credited with work she never did.
//
// Read-only.
//
// Usage: node check-sujana-worked-on.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: user } = await pool.query(`SELECT id FROM users WHERE email = 'sujana.manapuram@cloudfuze.com'`);
  if (!user.length) { console.log('User not found.'); await pool.end(); return; }
  const userId = user[0].id;

  const { rows: total } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM user_worked_on_tickets WHERE user_id = $1`, [userId]
  );
  console.log(`Total user_worked_on_tickets rows for Sujana: ${total[0].cnt}`);

  const { rows: byDay } = await pool.query(
    `SELECT DATE(worked_at) AS day, COUNT(*) AS cnt FROM user_worked_on_tickets WHERE user_id = $1 GROUP BY DATE(worked_at) ORDER BY cnt DESC LIMIT 10`,
    [userId]
  );
  console.log('\nTop days by row count:');
  for (const r of byDay) console.log(`  ${r.day.toISOString().slice(0, 10)}: ${r.cnt}`);

  const { rows: feb6 } = await pool.query(
    `SELECT reason, COUNT(*) AS cnt FROM user_worked_on_tickets WHERE user_id = $1 AND DATE(worked_at) = '2026-02-06' GROUP BY reason`,
    [userId]
  );
  console.log('\nRows specifically on 2026-02-06, by reason:');
  console.log(feb6.length ? feb6 : '  (none)');

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
