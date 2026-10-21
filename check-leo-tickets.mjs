// Read-only check: who/what "leo" is, and how these Dev-queue tickets
// reported by leo are actually getting created (email ingestion vs manual
// vs some automated path), so we know what to actually turn off.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: users } = await pool.query(
    `SELECT id, email, "firstName", "lastName", role, "createdAt" FROM users WHERE LOWER(email) LIKE '%leo%' OR LOWER("firstName") = 'leo'`
  );
  console.log('--- Matching user accounts ---');
  console.log(users);

  const { rows: emailCfgs } = await pool.query(
    `SELECT id, space_key, address, department, auth_mode, created_at FROM email_configs WHERE LOWER(address) LIKE '%leo%'`
  );
  console.log('\n--- email_configs rows mentioning leo ---');
  console.log(emailCfgs);

  if (!users.length) {
    console.log('\nNo user account found for "leo" -- reporter must be stored via a different mechanism (jira_reporter_name?) Checking issues directly by reporter text...');
  }

  const reporterId = users[0]?.id;
  const { rows: tickets } = await pool.query(
    `SELECT i.id, i.key, i.summary, i."createdAt", i.current_department, i."emailThreadId" AS email_thread_id,
            i."reporterId", i.jira_reporter_name, i.description
     FROM issues i
     WHERE i."reporterId" = $1 OR LOWER(i.jira_reporter_name) LIKE '%leo%'
     ORDER BY i."createdAt" DESC
     LIMIT 15`,
    [reporterId || '___none___']
  );
  console.log(`\n--- ${tickets.length} recent tickets reported by leo ---`);
  for (const t of tickets) {
    console.log({
      key: t.key,
      createdAt: t.createdAt,
      dept: t.current_department,
      emailThreadId: t.email_thread_id,
      summary: (t.summary || '').slice(0, 120),
      descriptionPreview: (t.description || '').replace(/<[^>]+>/g, ' ').slice(0, 200),
    });
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
