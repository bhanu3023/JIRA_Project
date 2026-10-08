// The 20 tickets Filters counts under "Queue: Dev" but MBR's Customer
// Engineering tab doesn't are ALL currently tagged Migration/Pre-Sales/
// Infra/QA (not Dev), assigned to people who read as Migration ENT/SMB
// roster members (habeebunnisa.begum, vineetha.yenti, siva.kota, etc).
// Hypothesis: these people are ALSO configured as members of the Dev
// custom_queue itself, which is what makes Filters' memberClause's bare
// "assigneeId = ANY(memberIds)" branch match them regardless of the
// ticket's actual current department. Confirms or refutes that directly
// against custom_queues before deciding on a fix. Read-only.
//
// Usage: node check-dev-queue-membership-overlap.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SUSPECT_EMAILS = [
  'habeebunnisa.begum@cloudfuze.com', 'vineetha.yenti@cloudfuze.com', 'amulya.anapuram@cloudfuze.com',
  'siva.kota@cloudfuze.com', 'vainateya.rasala@cloudfuze.com', 'davidraj.dumpala@cloudfuze.com',
  'vijendar.burgula@cloudfuze.com', 'harshith.kaduluri@cloudfuze.com', 'lakshmareddy@cloudfuze.com',
  'pallavi.kosuvaripalli@cloudfuze.com', 'manoj.bathula@cloudfuze.com',
];

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const devQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'dev');
  const migrationQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
  console.log(`Dev queue memberIds count: ${devQueue?.memberIds?.length || 0}`);
  console.log(`Migration queue memberIds count: ${migrationQueue?.memberIds?.length || 0}`);

  const devMemberIds = new Set(devQueue?.memberIds || []);
  const migrationMemberIds = new Set(migrationQueue?.memberIds || []);

  const { rows: userRows } = await pool.query(`SELECT id, email, "firstName", "lastName" FROM users WHERE LOWER(email) = ANY($1::text[])`, [SUSPECT_EMAILS]);
  console.log(`\n=== Checking each suspect assignee's queue membership ===`);
  for (const u of userRows) {
    console.log(`  ${u.email} (${u.firstName} ${u.lastName}): inDevQueue=${devMemberIds.has(u.id)} inMigrationQueue=${migrationMemberIds.has(u.id)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
