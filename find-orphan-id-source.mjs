// Where do these 4 orphaned IDs actually live? Check custom_queues member
// lists (most likely source) across all spaces/queues. Read-only.
//
// Usage: node find-orphan-id-source.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const suspectIds = new Set([
    'pg_8g68kcrard',
    'usr_pallavi_kosuvaripalli_cloudfuze_com',
    'usr_arundhati_sen_cloudfuze_com',
    'ar_99238a2f89449b526e269a64',
  ]);

  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  for (const row of rows) {
    const queues = row.queues || [];
    for (const q of queues) {
      const memberIds = q.memberIds || [];
      const hits = memberIds.filter((id) => suspectIds.has(id));
      if (hits.length) {
        console.log(`custom_queues.space_key=${row.space_key} queue.name=${q.name} queue.dept=${q.dept || q.department}`);
        console.log(`  orphaned memberIds found: ${JSON.stringify(hits)}`);
        console.log(`  total memberIds in this queue: ${memberIds.length}`);
      }
    }
  }

  // Also check issues table in case these IDs were assigneeId/reporterId directly
  const { rows: issueHits } = await pool.query(
    `SELECT id, key, "assigneeId", "reporterId" FROM issues WHERE "assigneeId" = ANY($1::text[]) OR "reporterId" = ANY($1::text[]) LIMIT 10`,
    [Array.from(suspectIds)]
  );
  console.log(`\nIssues directly referencing these IDs as assignee/reporter: ${issueHits.length}`);
  console.log(JSON.stringify(issueHits, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
