// The Worklog page's "Queue: Dev" filter (person-based: roster membership,
// not entry tag) still isn't showing entries from people confirmed to be
// Dev-queue members (Hemadasu Kantam, Ravi Srivastava, Jaswanth Adari,
// Naved, Vishal Kumar), even after a hard refresh. Checks the EXACT
// authorId stored on their real worklog entries against the EXACT
// memberIds array the frontend fetches via custom-queues/TESTIN, to find
// out if this is an ID-format mismatch, a live API response difference,
// or something else. Read-only.
//
// Usage: node check-worklog-roster-mismatch.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const NAMES = ['Hemadasu Kantam', 'Ravi Srivastava', 'Adari Venkata Jaswanth', 'Naved', 'Vishal Kumar'];

async function main() {
  const { rows: spaceRow } = await pool.query(`SELECT space_key, queues FROM custom_queues WHERE space_key ILIKE $1`, [SPACE_KEY]);
  console.log(`custom_queues row(s) matching space_key ILIKE '${SPACE_KEY}':`, spaceRow.map((r) => r.space_key));
  const queues = spaceRow[0]?.queues || [];
  const devQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'dev');
  console.log(`Dev queue found: ${!!devQueue}, memberIds count: ${devQueue?.memberIds?.length}`);
  const devMemberIds = new Set(Array.isArray(devQueue?.memberIds) ? devQueue.memberIds : []);
  console.log('Dev memberIds (raw):', JSON.stringify([...devMemberIds]));

  console.log('\n=== Checking each named person\'s real worklog entries ===');
  for (const name of NAMES) {
    const { rows } = await pool.query(
      `SELECT DISTINCT wl."authorId", wl."authorName", wl."authorEmail"
       FROM issue_worklogs wl WHERE wl."authorName" = $1`,
      [name]
    );
    for (const r of rows) {
      const inRoster = devMemberIds.has(r.authorId);
      console.log(`${r.authorName} <${r.authorEmail}> -- worklog authorId="${r.authorId}" -- in Dev memberIds: ${inRoster}`);
    }
    if (!rows.length) console.log(`${name}: no worklog entries found with this exact authorName`);
  }

  // Also: what does the users table say each of these people's real id is,
  // and is THAT id (not the worklog's stored authorId) in the roster --
  // catches a stale/mismatched authorId stored on the worklog entry itself.
  console.log('\n=== Cross-check against users table by email ===');
  const { rows: userRows } = await pool.query(
    `SELECT id, email, "firstName", "lastName" FROM users WHERE "firstName" || ' ' || "lastName" = ANY($1::text[]) OR email = ANY($2::text[])`,
    [NAMES, []]
  );
  for (const u of userRows) {
    console.log(`${u.firstName} ${u.lastName} <${u.email}> -- users.id="${u.id}" -- in Dev memberIds: ${devMemberIds.has(u.id)}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
