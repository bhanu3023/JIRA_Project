// The queue-resolve notification fix's own new code path produced zero
// notification rows for anyone, even though the DB update and history write
// in the exact same code block succeeded and no exception was logged. Before
// assuming my new code specifically is broken, check whether notification
// creation is broken SYSTEM-WIDE since the deploy -- e.g. a Prisma client
// regeneration issue from `npx prisma generate` during the build, or
// something else unrelated to this specific fix. If comments/mentions on
// OTHER real tickets (via the pre-existing, unmodified notification code
// paths) have also produced nothing since the deploy, the bug is bigger than
// my new code.
//
// Read-only.
//
// Usage: node check-notifications-system-wide.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('=== Most recent 15 notification rows, system-wide (any user, any type) ===');
  const { rows } = await pool.query(
    `SELECT n."userId", u.email, n.type, n.title, n."issueKey", n."createdAt" FROM notifications n
     LEFT JOIN users u ON u.id = n."userId"
     ORDER BY n."createdAt" DESC LIMIT 15`
  );
  for (const n of rows) console.log(`  [${n.createdAt.toISOString()}] -> ${n.email} : ${n.type} "${n.title}" (${n.issueKey})`);
  if (!rows.length) console.log('  (table is completely empty!)');

  console.log('\n=== Total notification row count ===');
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM notifications`);
  console.log(`  ${countRows[0].count}`);

  console.log('\n=== Current server time vs most recent notification ===');
  const { rows: nowRows } = await pool.query(`SELECT NOW() as now`);
  console.log(`  DB NOW(): ${nowRows[0].now.toISOString()}`);
  if (rows.length) {
    const ageMin = (nowRows[0].now.getTime() - new Date(rows[0].createdAt).getTime()) / 60000;
    console.log(`  Most recent notification is ${ageMin.toFixed(1)} minutes old`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
