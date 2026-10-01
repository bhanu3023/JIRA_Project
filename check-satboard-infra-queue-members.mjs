// User screenshot: SAT_Board's Queues page shows its one queue ("Infra")
// with "0 members" -- asking whether that's expected or a bug. The card's
// member count comes straight from custom_queues.queues[].memberIds.length
// (spaces/[spaceKey]/page.tsx), so if it says 0, that array really is
// empty/missing in the DB. Checking that directly, plus whether real
// people are actually assigned to/working Infra tickets in SAT_Board
// despite no one being listed as a configured member -- same class of gap
// found earlier this session for CloudFuze Board's Dev/Migration queues.
//
// Read-only.
//
// Usage: node check-satboard-infra-queue-members.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id, key, name FROM spaces WHERE key = 'SB'`);
  const sp = spaceRows[0];
  if (!sp) { console.log('SAT_Board (key=SB) not found'); await pool.end(); return; }
  console.log(`Space: ${sp.key} (${sp.name})  id=${sp.id}`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [sp.key]);
  const queues = cqRows[0]?.queues || [];
  console.log(`\nConfigured queues: ${queues.map((q) => q.name).join(', ') || 'NONE'}`);
  for (const q of queues) {
    console.log(`  ${q.name}: memberIds=${JSON.stringify(q.memberIds || [])}`);
  }

  // Real people currently assigned to Infra-department tickets in SAT_Board
  const { rows: assignees } = await pool.query(
    `SELECT u.id, u."firstName", u."lastName", COUNT(*) AS cnt
     FROM issues i JOIN users u ON u.id = i."assigneeId"
     WHERE i."spaceId" = $1 AND i.current_department = 'Infra'
     GROUP BY u.id, u."firstName", u."lastName" ORDER BY cnt DESC`,
    [sp.id]
  );
  console.log(`\nReal current assignees on SAT_Board's Infra-department tickets (${assignees.length} distinct people):`);
  for (const a of assignees) console.log(`  ${a.firstName} ${a.lastName}: ${a.cnt} tickets`);

  const { rows: totalCount } = await pool.query(
    `SELECT COUNT(*) FROM issues WHERE "spaceId" = $1 AND current_department = 'Infra'`,
    [sp.id]
  );
  console.log(`\nTotal Infra-department tickets in SAT_Board: ${totalCount[0].count}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
