/**
 * backfill-worked-on-for-resolved.mjs
 *
 * "Worked on" only gets a row when a ticket passes through an in-app status
 * change to done, a department transfer, or a handoff -- but thousands of
 * L1BOAR/L2B/L3B tickets got their status set to Resolved via direct
 * database updates (the original migration, and this session's own
 * backfill-jira-status.mjs), never through that code path. Their real,
 * current assignee is correctly recorded on the ticket itself, but has no
 * "worked on" record at all -- e.g. Adari Venkata Jaswanth shows as the
 * real assignee on 564 Resolved Dev tickets, but "Worked on" only knew
 * about 2, purely because the other 564 never went through the app's own
 * close-handling code.
 *
 * For every issue that is: assigned to a real user, has a real current
 * department, and is in a 'done'-category status, with no existing
 * user_worked_on_tickets row for (assignee, issue, dept) -- inserts one
 * with reason='closed', exactly what the normal in-app resolve flow would
 * have recorded.
 *
 * Purely additive: never overwrites an existing row (ON CONFLICT DO
 * NOTHING), never touches ticket status/assignee/comments/anything else.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually insert
 *
 * Run: node backfill-worked-on-for-resolved.mjs
 * Apply for real: DRY_RUN=false node backfill-worked-on-for-resolved.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const rows = await pool.query(`
    SELECT i.id, i.key, i."assigneeId", i.current_department,
           u."firstName", u."lastName", u.email
    FROM issues i
    JOIN statuses s ON s.id = i."statusId"
    LEFT JOIN users u ON u.id = i."assigneeId"
    WHERE s.category = 'done'
      AND i."assigneeId" IS NOT NULL
      AND i.current_department IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_worked_on_tickets w
        WHERE w.user_id = i."assigneeId" AND w.issue_id = i.id AND w.dept = i.current_department
      )
  `);
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${rows.rows.length} resolved tickets with a real assignee and no worked-on record.`);

  const byUser = {};
  for (const r of rows.rows) {
    const who = `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.email || r.assigneeId;
    byUser[who] = (byUser[who] || 0) + 1;
    if (!DRY_RUN) {
      await pool.query(
        `INSERT INTO user_worked_on_tickets (user_id, issue_id, dept, reason) VALUES ($1, $2, $3, 'closed') ON CONFLICT (user_id, issue_id, dept) DO NOTHING`,
        [r.assigneeId, r.id, r.current_department]
      );
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done. ${rows.rows.length} rows ${DRY_RUN ? 'would be' : 'were'} inserted.`);
  console.log('\nBy user (top 20):');
  console.log(
    Object.fromEntries(Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 20))
  );

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
