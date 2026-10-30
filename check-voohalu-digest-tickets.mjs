// Read-only: find every "Voohalu Weekly Digest"-style ticket (an automated
// newsletter email, not a real support request) created so far, and the
// exact reporter email/subject pattern, so the email-ingestion filter can
// target it precisely.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, i.cf_key, i.summary, i."createdAt", u.email AS reporter_email, u."firstName", u."lastName"
    FROM issues i LEFT JOIN users u ON u.id = i."reporterId"
    WHERE i.summary ILIKE '%voohalu%' OR u.email ILIKE '%voohalu%'
    ORDER BY i."createdAt" DESC
  `);
  console.log(`${rows.length} Voohalu-related ticket(s):`);
  for (const r of rows) console.log(` - ${r.key} (${r.cf_key}) | "${r.summary}" | reporter=${r.reporter_email} (${r.firstName} ${r.lastName}) | created=${r.createdAt.toISOString()}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
