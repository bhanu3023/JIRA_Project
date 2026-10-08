// Theory: the Migration whole-queue gap (50 tickets in a broad "belongs to
// Migration" ground truth but missing from the live Queue: Migration view)
// is largely tickets whose assigneeId is a DUPLICATE/legacy user record for
// someone who's a real, active Migration queue member under their OTHER
// (current) user id -- the queue's configured memberIds list would only
// list the current id, silently excluding tickets parked under the old one.
// Checks this directly: for every email with more than one row in `users`,
// show both ids, which one (if any) is in the Migration queue's memberIds,
// and how many issues are assigned to each id. Read-only.
//
// Usage: node check-duplicate-user-accounts.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

async function main() {
  const { rows: dupes } = await pool.query(`
    SELECT LOWER(email) AS email, COUNT(*)::int AS cnt, array_agg(id) AS ids
    FROM users WHERE email IS NOT NULL
    GROUP BY LOWER(email) HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);
  console.log(`Found ${dupes.length} email(s) with more than one user record.\n`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const migQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'migration');
  const migMemberIds = new Set(Array.isArray(migQueue?.memberIds) ? migQueue.memberIds : []);

  for (const d of dupes) {
    const idsInRoster = d.ids.filter((id) => migMemberIds.has(id));
    const idsNotInRoster = d.ids.filter((id) => !migMemberIds.has(id));
    const { rows: counts } = await pool.query(
      `SELECT "assigneeId" AS id, COUNT(*)::int AS cnt FROM issues WHERE "assigneeId" = ANY($1::text[]) AND "spaceId" = (SELECT id FROM spaces WHERE key = $2) GROUP BY "assigneeId"`,
      [d.ids, SPACE_KEY]
    );
    const countsMap = Object.fromEntries(counts.map((r) => [r.id, r.cnt]));
    console.log(`${d.email}: ids=${JSON.stringify(d.ids)}`);
    console.log(`  in Migration roster: ${JSON.stringify(idsInRoster)}, NOT in roster: ${JSON.stringify(idsNotInRoster)}`);
    console.log(`  tickets assigned per id: ${d.ids.map((id) => `${id}=${countsMap[id] || 0}`).join(', ')}`);
  }

  // Direct check: of the specific "usr_" style ids seen in the Migration
  // discrepancy sample, which ones have a sibling "pg_" record for the same
  // email, and is THAT sibling in the roster?
  const suspectIds = [
    'usr_sairaj_kanigicharla_cloudfuze_com', 'usr_shivam_singh_cloudfuze_com',
    'usr_jaswanth_adari_cloudfuze_com', 'usr_vishal_kumar_cloudfuze_com',
  ];
  console.log('\n=== Specific suspect ids from the Migration discrepancy sample ===');
  for (const id of suspectIds) {
    const { rows } = await pool.query(`SELECT id, email FROM users WHERE id = $1`, [id]);
    if (!rows[0]) { console.log(`${id}: no such user row at all`); continue; }
    const email = rows[0].email;
    const { rows: siblings } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
    const siblingIds = siblings.map((r) => r.id);
    console.log(`${id} (${email}): sibling ids=${JSON.stringify(siblingIds)}, any in Migration roster=${siblingIds.some((sid) => migMemberIds.has(sid))}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
