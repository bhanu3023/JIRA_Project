// Read-only: finds every queue named "QA" across every space (with its
// member roster) and every user account matching "Bhuvana" -- needed before
// restricting Test Repository access to QA-queue members + admin, and its
// delete actions to admin + Bhuvana specifically.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('--- Queues named "QA" ---');
  const { rows: queueRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of queueRows) {
    const queues = row.queues || [];
    const qaQueues = queues.filter((q) => String(q.name || '').trim().toLowerCase() === 'qa');
    for (const q of qaQueues) {
      const memberIds = Array.isArray(q.memberIds) ? q.memberIds : [];
      console.log(`\nSpace: ${row.space_key}  Queue id: ${q.id}  Name: "${q.name}"  Members: ${memberIds.length}`);
      if (memberIds.length) {
        const { rows: users } = await pool.query(
          `SELECT id, "firstName", "lastName", email, role FROM users WHERE id = ANY($1)`,
          [memberIds],
        );
        for (const u of users) console.log(`  - ${u.firstName} ${u.lastName} <${u.email}> (${u.role}) [${u.id}]`);
      }
    }
  }

  console.log('\n--- Users matching "Bhuvana" ---');
  const { rows: bhuvanaRows } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role FROM users WHERE LOWER("firstName") LIKE '%bhuvana%' OR LOWER("lastName") LIKE '%bhuvana%'`,
  );
  for (const u of bhuvanaRows) console.log(`  - ${u.firstName} ${u.lastName} <${u.email}> (${u.role}) [${u.id}]`);
  if (!bhuvanaRows.length) console.log('  (none found)');

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
