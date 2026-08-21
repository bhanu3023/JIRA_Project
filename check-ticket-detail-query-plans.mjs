/**
 * check-ticket-detail-query-plans.mjs
 * READ-ONLY. Reconstructs the actual queries the GET /issues/:key handler
 * (src/lib/jira-pg-api.ts) issues to assemble a single ticket-detail page,
 * and runs EXPLAIN ANALYZE on each against a real ticket key, so we can see
 * concretely whether any of them is doing a sequential scan instead of using
 * an index, rather than guessing.
 *
 * This does NOT execute from the sandbox this was written in (no reachable
 * Postgres there) -- run it from a machine that can reach the real DB.
 *
 * Run: DATABASE_URL=... node check-ticket-detail-query-plans.mjs [TICKET_KEY]
 * If no ticket key is given, it picks a recently-created one automatically.
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

function summarize(label, plan) {
  const text = plan.map(r => r['QUERY PLAN']).join('\n');
  const hasSeqScan = /Seq Scan/i.test(text);
  const totalTimeMatch = text.match(/Execution Time: ([\d.]+) ms/);
  console.log(`\n--- ${label} ---`);
  console.log(text);
  console.log(`>>> ${hasSeqScan ? '⚠️  SEQ SCAN PRESENT' : '✓ no seq scan'}${totalTimeMatch ? `, execution time ${totalTimeMatch[1]}ms` : ''}`);
}

async function explain(label, sql, params) {
  try {
    const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    summarize(label, r.rows);
  } catch (e) {
    console.log(`\n--- ${label} ---`);
    console.log('ERROR running EXPLAIN:', e.message);
  }
}

async function main() {
  let key = process.argv[2];
  if (!key) {
    const r = await pool.query(`SELECT key FROM issues ORDER BY "createdAt" DESC LIMIT 1`);
    if (!r.rows[0]) { console.log('No issues found in DB.'); await pool.end(); return; }
    key = r.rows[0].key;
    console.log(`No ticket key given -- using most recently created ticket: ${key}`);
  }

  const issueRow = await pool.query(`SELECT id, "spaceId", cf_key, current_department, "partnerKey" FROM issues WHERE key = $1 LIMIT 1`, [key]);
  if (!issueRow.rows[0]) { console.log(`Ticket ${key} not found.`); await pool.end(); return; }
  const { id: issueId, spaceId, cf_key, current_department, partnerKey } = issueRow.rows[0];
  const spaceRow = await pool.query(`SELECT key FROM spaces WHERE id = $1 LIMIT 1`, [spaceId]);
  const spaceKey = spaceRow.rows[0]?.key || key.split('-')[0];
  console.log(`Ticket ${key}: id=${issueId} spaceId=${spaceId} spaceKey=${spaceKey} cf_key=${cf_key} dept=${current_department} partnerKey=${partnerKey}`);

  // 1. resolveCfKey -- only runs when the URL key starts with "CF-", which is
  //    the normal case since the frontend redirects to the cf_key URL.
  if (cf_key) {
    await explain('resolveCfKey: SELECT key FROM issues WHERE cf_key = $1', `SELECT key FROM issues WHERE cf_key = $1 LIMIT 1`, [cf_key]);
  }

  // 2. Primary issue fetch (what db.issue.findUnique({ where: { key } }) does
  //    at the SQL level for the base row -- Prisma adds its own JOINs/queries
  //    for the `include`d relations on top of this).
  await explain('primary issue fetch by key', `SELECT * FROM issues WHERE key = $1 LIMIT 1`, [key]);

  // 3. The Promise.all batch queries
  await explain('custom_queues by space_key (suspension check)', `SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey.toUpperCase()]);
  await explain('attachments by issueId', `SELECT * FROM attachments WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [issueId]);
  await explain('issue_history by issueId', `SELECT * FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" DESC`, [issueId]);
  await explain('issue_links outbound (sourceKey)', `SELECT * FROM issue_links WHERE "sourceKey" = $1`, [key]);
  await explain('issue_links inbound (targetKey)', `SELECT * FROM issue_links WHERE "targetKey" = $1`, [key]);
  await explain('children by parentKey', `SELECT * FROM issues WHERE "parentKey" = $1`, [key]);
  await explain('raw dept columns by key', `SELECT current_department, department_assignee_id, dept_sla_started_at, dept_assignees, dept_statuses, dept_sla_log, cf_key, "partnerKey", "resolvedAt", sla_waivers FROM issues WHERE key = $1 LIMIT 1`, [key]);
  await explain('partner ticket lookup by partnerKey', `SELECT i.id FROM issues i WHERE i."partnerKey" = $1`, [key]);

  // 4. SLA computation queries (computeIssueSLAsFromDb)
  await explain('sla_definitions by spaceId', `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  await explain(
    'notifications by issueKey+type (SLA breach check) -- THE ONE WITH NO MATCHING INDEX BEFORE THIS FIX',
    `SELECT id FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' LIMIT 1`,
    [cf_key || key]
  );

  console.log('\nDone. Look for "⚠️  SEQ SCAN PRESENT" above -- on a table with any real row count,\n' +
    'that flags a query that is not using an index and will get slower as the table grows.\n' +
    'The notifications query above is expected to show a seq scan until\n' +
    'idx_notifications_issuekey_type is created (see deploy.sh or\n' +
    'add-notifications-issuekey-index.mjs) -- re-run this script after creating it\n' +
    'to confirm it switches to an Index Scan.');

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
