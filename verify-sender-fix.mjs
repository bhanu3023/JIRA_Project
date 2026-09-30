// Confirms the fixed getTicketThreadInfo query now picks leo@fuzebot.io
// (not the blocked no-reply@cloudfuze.info) for a real CloudFuze Board
// ticket. Read-only, mirrors the exact query now in notification-service.ts.
//
// Usage: node verify-sender-fix.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT i.emailthreadid, ec.address AS inbox_email
    FROM issues i
    JOIN spaces s ON i."spaceId" = s.id
    LEFT JOIN email_configs ec ON LOWER(ec.space_key) = LOWER(s.key)
      AND LOWER(ec.address) != ALL($2::text[])
    WHERE i.key = $1 OR i.cf_key = $1
    ORDER BY ec.created_at ASC
    LIMIT 1
  `, ['CF-33688', ['no-reply@cloudfuze.info']]);
  console.log('getTicketThreadInfo would now pick:', JSON.stringify(rows[0]));
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
