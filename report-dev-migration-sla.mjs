/**
 * report-dev-migration-sla.mjs
 * READ-ONLY reporting script, nothing is written.
 *
 * 1. How many tickets Dev "worked" in the last 7 days -- sourced from
 *    user_worked_on_tickets (dept='Dev'), the exact same table the app's
 *    own "Worked on" tab and per-queue analytics already use for this.
 * 2. How many tickets exist in the Migration queue -- total, and how many
 *    created in the last 7 days (both given since the ask was ambiguous
 *    about which).
 * 3. SLA-breached ticket count broken down by department/queue, using the
 *    exact same rule the app's own per-queue analytics endpoint uses:
 *    breached = jira_sla_breached (historical, imported from Jira) OR
 *    (not in a "done" status AND dueDate has already passed).
 *
 * Run: DATABASE_URL=... node report-dev-migration-sla.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

async function main() {
  console.log('========== 1. Dev tickets worked, last 7 days ==========');
  const devWorked = await pool.query(`
    SELECT COUNT(DISTINCT issue_id) AS tickets, COUNT(*) AS work_events
    FROM user_worked_on_tickets
    WHERE LOWER(dept) = 'dev' AND worked_at >= NOW() - INTERVAL '7 days'
  `);
  console.log(`Distinct tickets: ${devWorked.rows[0].tickets} | total work events (a ticket can be worked more than once): ${devWorked.rows[0].work_events}`);

  const devByReason = await pool.query(`
    SELECT reason, COUNT(DISTINCT issue_id) AS tickets
    FROM user_worked_on_tickets
    WHERE LOWER(dept) = 'dev' AND worked_at >= NOW() - INTERVAL '7 days'
    GROUP BY reason ORDER BY tickets DESC
  `);
  console.log('By reason:', JSON.stringify(devByReason.rows, null, 2));

  const devByUser = await pool.query(`
    SELECT u.email, u."firstName", u."lastName", COUNT(DISTINCT w.issue_id) AS tickets
    FROM user_worked_on_tickets w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE LOWER(w.dept) = 'dev' AND w.worked_at >= NOW() - INTERVAL '7 days'
    GROUP BY u.email, u."firstName", u."lastName"
    ORDER BY tickets DESC
  `);
  console.log('\nBy user:', JSON.stringify(devByUser.rows, null, 2));

  console.log('\n========== 2. Migration queue ticket counts ==========');
  const migTotal = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE LOWER(current_department) = 'migration'`);
  const migByKeyPrefix = await pool.query(`SELECT COUNT(*) AS n FROM issues WHERE key LIKE 'L1BOAR-%'`);
  const migCreatedLast7 = await pool.query(`
    SELECT COUNT(*) AS n FROM issues WHERE LOWER(current_department) = 'migration' AND "createdAt" >= NOW() - INTERVAL '7 days'
  `);
  console.log(`Total tickets currently in Migration department: ${migTotal.rows[0].n}`);
  console.log(`(cross-check, by key prefix L1BOAR-*: ${migByKeyPrefix.rows[0].n} -- may differ slightly if some L1BOAR tickets have since moved to another department, or vice versa)`);
  console.log(`Created in Migration in the last 7 days: ${migCreatedLast7.rows[0].n}`);

  console.log('\n========== 3. SLA breached, by department/queue ==========');
  const breached = await pool.query(`
    SELECT
      COALESCE(i.current_department, '(no department)') AS department,
      COUNT(*) AS breached_count
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE
      i.jira_sla_breached = true
      OR (
        (s.category IS DISTINCT FROM 'done')
        AND i."dueDate" IS NOT NULL
        AND i."dueDate" < NOW()
      )
    GROUP BY i.current_department
    ORDER BY breached_count DESC
  `);
  console.log(JSON.stringify(breached.rows, null, 2));

  const breachedTotal = await pool.query(`
    SELECT COUNT(*) AS n
    FROM issues i
    LEFT JOIN statuses s ON i."statusId" = s.id
    WHERE
      i.jira_sla_breached = true
      OR (
        (s.category IS DISTINCT FROM 'done')
        AND i."dueDate" IS NOT NULL
        AND i."dueDate" < NOW()
      )
  `);
  console.log(`\nTotal SLA-breached tickets across all queues: ${breachedTotal.rows[0].n}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
