/**
 * check-presales-queue-members.mjs
 * READ-ONLY. Shows exactly who the 2 current Pre-Sales queue members are
 * (id, email, displayName, role) -- check-presales-people.mjs found the
 * queue already has 2 members (not empty), so the department-change block
 * on CF-29568 is most likely because the logged-in test user isn't one of
 * them (or an admin), not that the queue has no one on it.
 *
 * Run: DATABASE_URL=... node check-presales-queue-members.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  const queues = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const row = queues.rows[0];
  const presales = (row?.queues || []).find((q) => (q.name || '').toLowerCase() === 'pre-sales');
  if (!presales) {
    console.log('No Pre-Sales queue found in TESTIN.');
    await pool.end();
    return;
  }
  console.log('Pre-Sales queue raw record:', JSON.stringify(presales, null, 2));

  const memberIds = presales.memberIds || [];
  if (memberIds.length) {
    const users = await pool.query(
      `SELECT id, email, "displayName", "firstName", "lastName", role FROM users WHERE id = ANY($1::text[])`,
      [memberIds]
    );
    console.log('\nMember details:');
    console.log(JSON.stringify(users.rows, null, 2));
  }

  const admins = await pool.query(`SELECT id, email, "displayName", role FROM users WHERE role = 'admin'`);
  console.log('\nAll admin-role users (these can always move a ticket regardless of queue membership):');
  console.log(JSON.stringify(admins.rows, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
