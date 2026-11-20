// Read-only diagnostic: the user noticed many tickets in the Filters list
// appear to have no Assignee/Reporter. Checks whether that's really true in
// the DB (reporterId/assigneeId actually null) or just a display issue
// (e.g. a reporter row exists but renders blank), for both specific tickets
// from the screenshots and a broader recent-tickets sweep on CloudFuze Board.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const SAMPLE_KEYS = [
  'CF-35419', 'CF-35418', 'CF-35410', 'CF-35407', 'CF-35406', 'CF-35402', 'CF-35401',
  'CF-35400', 'CF-35399', 'CF-35397', 'CF-35396', 'CF-35395', 'CF-35394', 'CF-35387',
  'CF-35386', 'CF-35385', 'CF-35381',
];

async function main() {
  console.log('--- Specific tickets from the screenshots ---');
  const { rows } = await pool.query(
    `SELECT i.key, i.cf_key, i."reporterId", i."assigneeId",
            r.email AS reporter_email, r."firstName" AS reporter_first, r."lastName" AS reporter_last,
            a.email AS assignee_email, a."firstName" AS assignee_first, a."lastName" AS assignee_last
     FROM issues i
     LEFT JOIN users r ON r.id = i."reporterId"
     LEFT JOIN users a ON a.id = i."assigneeId"
     WHERE i.key = ANY($1::text[]) OR i.cf_key = ANY($1::text[])
     ORDER BY i.key`,
    [SAMPLE_KEYS],
  );
  for (const r of rows) {
    const rep = r.reporterId ? `${r.reporter_first || ''} ${r.reporter_last || ''} <${r.reporter_email || 'NO EMAIL'}> (id=${r.reporterId})` : 'NULL';
    const asg = r.assigneeId ? `${r.assignee_first || ''} ${r.assignee_last || ''} <${r.assignee_email || 'NO EMAIL'}> (id=${r.assigneeId})` : 'NULL';
    console.log(`${r.cf_key || r.key}: reporter=${rep} | assignee=${asg}`);
  }

  console.log('\n--- Broader sweep: CloudFuze Board, last 500 tickets ---');
  const { rows: sweep } = await pool.query(
    `SELECT i."reporterId", i."assigneeId"
     FROM issues i
     JOIN spaces s ON s.id = i."spaceId"
     WHERE s.key = 'CF' OR s.name ILIKE '%cloudfuze board%'
     ORDER BY i."createdAt" DESC
     LIMIT 500`,
  );
  const total = sweep.length;
  const noReporter = sweep.filter(r => !r.reporterId).length;
  const noAssignee = sweep.filter(r => !r.assigneeId).length;
  console.log(`Of last ${total} tickets: ${noReporter} have NULL reporterId, ${noAssignee} have NULL assigneeId.`);

  console.log('\n--- Are any of those NULL-reporter tickets really email-created tickets? ---');
  const { rows: nullReporterSample } = await pool.query(
    `SELECT i.key, i.cf_key, i.summary, i."createdAt"
     FROM issues i
     JOIN spaces s ON s.id = i."spaceId"
     WHERE (s.key = 'CF' OR s.name ILIKE '%cloudfuze board%') AND i."reporterId" IS NULL
     ORDER BY i."createdAt" DESC
     LIMIT 10`,
  );
  for (const r of nullReporterSample) console.log(`  ${r.cf_key || r.key}  "${r.summary}"  created=${r.createdAt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
