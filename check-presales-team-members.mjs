// Read-only: list the Pre-Sales-Team queue's current members (People & Access)
// so the RR rotation can be built from real, already-configured people
// instead of guessed names.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const q = queues.find((x) => (x.name || '').trim().toLowerCase() === 'pre-sales-team');
  if (!q) { console.log('Pre-Sales-Team queue not found.'); await pool.end(); return; }
  console.log(`Pre-Sales-Team queue id=${q.id}, memberIds=${(q.memberIds || []).length}, suspendedIds=${(q.suspendedIds || []).length}`);

  const memberIds = (q.memberIds || []).filter((id) => !(q.suspendedIds || []).includes(id));
  if (!memberIds.length) { console.log('No active (non-suspended) members.'); await pool.end(); return; }

  const { rows: users } = await pool.query(
    `SELECT id, "firstName", "lastName", email, role, "isActive" FROM users WHERE id = ANY($1::text[]) ORDER BY "firstName"`,
    [memberIds],
  );
  console.log('\nActive (non-suspended) members:');
  for (const u of users) console.log(`  ${u.id}  ${u.firstName} ${u.lastName}  <${u.email}>  role=${u.role}  isActive=${u.isActive}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
