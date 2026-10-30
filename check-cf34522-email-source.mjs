// Read-only: which monitored mailbox actually received the Voohalu Weekly
// Digest email that became CF-34522 (key L2B-34522), so the explanation of
// "why was it created" names the real account, not just the email pipeline
// mechanism in the abstract.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, key, cf_key, "spaceId", "createdAt", "emailthreadid", current_department
    FROM issues WHERE key = 'L2B-34522'
  `);
  const issue = rows[0];
  console.log('Issue row (relevant fields):', issue || 'NOT FOUND');

  if (issue) {
    const { rows: spaceRows } = await pool.query(`SELECT key, name FROM spaces WHERE id = $1`, [issue.spaceId]);
    console.log('Space:', spaceRows[0]);

    const { rows: configs } = await pool.query(
      `SELECT id, address, department, imap_host, smtp_host, created_at FROM email_configs WHERE space_key = $1`,
      [spaceRows[0]?.key]
    ).catch((e) => { console.log('email_configs query failed:', e.message); return { rows: [] }; });
    console.log(`Monitored mailbox(es) for this space:`, configs);

    if (issue.emailthreadid) {
      const { rows: processed } = await pool.query(
        `SELECT * FROM processed_emails WHERE id = $1 OR thread_id = $1`, [issue.emailthreadid]
      ).catch(() => ({ rows: [] }));
      console.log('processed_emails row (if any):', processed[0] || 'none');
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
