/**
 * diagnose-ticket-timeout.mjs
 * READ-ONLY. The GET /issues/:key handler already logs a detailed per-phase
 * timing breakdown to the server console whenever a load takes > 3s (see the
 * `_perfMarks`/`_perfTotal` block in src/lib/jira-pg-api.ts, around the
 * "[PERF] GET /issues/..." warning). That log line is the single most direct
 * answer to "why did THIS load take so long" -- more direct than anything
 * this script can infer from the DB alone -- so before or alongside running
 * this, also grep the app container's logs for the ticket key, e.g.:
 *
 *   docker compose logs app --since 2h | grep -i "CF-29607\|\[PERF\]"
 *
 * If that PERF line never appears for this ticket at all, the load never
 * reached this handler (killed earlier -- proxy/nginx timeout, container
 * restart, network) or took under 3s on the server side despite the
 *20s client-side timeout firing (pointing at something between the browser
 * and the server, not the DB/app query path).
 *
 * This script covers what the logs can't: whether THIS specific ticket has
 * any structural reason to be slow (oversized fields, a deep partner/link
 * chain), and whether the DB connection pool itself was saturated at the
 * time you run it (a proxy for "were other requests starving this one of a
 * connection").
 *
 * Run: DATABASE_URL=... node diagnose-ticket-timeout.mjs CF-29607
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const MAX_FIELD_CHARS = 150_000;
const MAX_SAFE_BYTES = 3 * 1024 * 1024;

function fmt(bytes) {
  bytes = Number(bytes || 0);
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function main() {
  const key = (process.argv[2] || 'CF-29607').toUpperCase();

  console.log(`=== Resolving ${key} ===`);
  const idRow = await pool.query(
    `SELECT id, key, cf_key, "spaceId", "partnerKey", current_department FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1`,
    [key]
  );
  if (!idRow.rows[0]) {
    console.log(`No ticket found for ${key} (checked both cf_key and key columns).`);
    await pool.end();
    return;
  }
  const { id, key: internalKey, cf_key, spaceId, partnerKey, current_department } = idRow.rows[0];
  console.log(`  internal key=${internalKey} cf_key=${cf_key} dept=${current_department} partnerKey=${partnerKey}`);

  console.log('\n=== Payload size for this ticket ===');
  const sizeRow = await pool.query(`
    SELECT
      length(i.description) AS desc_chars,
      octet_length(i.description) AS desc_bytes,
      (SELECT count(*) FROM comments c WHERE c."issueId" = i.id) AS comment_count,
      COALESCE((SELECT sum(octet_length(c.body)) FROM comments c WHERE c."issueId" = i.id), 0) AS comments_bytes,
      COALESCE((SELECT max(octet_length(c.body)) FROM comments c WHERE c."issueId" = i.id), 0) AS max_comment_bytes,
      (SELECT count(*) FROM issue_history h WHERE h."issueId" = i.id) AS history_count,
      COALESCE((SELECT sum(octet_length(h."oldValue") + octet_length(h."newValue")) FROM issue_history h WHERE h."issueId" = i.id), 0) AS history_bytes,
      (SELECT count(*) FROM attachments a WHERE a."issueId" = i.id) AS attachment_count,
      (SELECT count(*) FROM issue_links l WHERE l."sourceKey" = i.key OR l."targetKey" = i.key) AS link_count,
      (SELECT count(*) FROM issues c2 WHERE c2."parentKey" = i.key) AS child_count,
      (SELECT count(*) FROM issues p WHERE p."partnerKey" = i.key) AS partner_referencing_count
    FROM issues i WHERE i.id = $1
  `, [id]);
  const s = sizeRow.rows[0];
  const totalBytes = Number(s.desc_bytes || 0) + Number(s.comments_bytes || 0) + Number(s.history_bytes || 0);
  console.log(`  description: ${s.desc_chars || 0} chars (${fmt(s.desc_bytes)})`);
  console.log(`  comments: ${s.comment_count} rows, ${fmt(s.comments_bytes)} total, largest single comment ${fmt(s.max_comment_bytes)}`);
  console.log(`  issue_history: ${s.history_count} rows, ${fmt(s.history_bytes)} total`);
  console.log(`  attachments: ${s.attachment_count}, links: ${s.link_count}, children: ${s.child_count}, tickets pointing here via partnerKey: ${s.partner_referencing_count}`);
  console.log(`  estimated response payload (desc+comments+history): ${fmt(totalBytes)}${totalBytes > MAX_SAFE_BYTES ? '  <-- exceeds 3MB trim guard, should be getting trimmed' : ''}`);
  if (Number(s.max_comment_bytes) > MAX_FIELD_CHARS) console.log(`  NOTE: largest comment exceeds the ${MAX_FIELD_CHARS}-char per-field trim threshold on its own.`);

  console.log('\n=== Query timing for this ticket (EXPLAIN ANALYZE) ===');
  async function explain(label, sql, params) {
    try {
      const t0 = Date.now();
      const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      const wall = Date.now() - t0;
      const text = r.rows.map(row => row['QUERY PLAN']).join('\n');
      const execMatch = text.match(/Execution Time: ([\d.]+) ms/);
      const hasSeqScan = /Seq Scan/i.test(text);
      console.log(`  ${label}: wall=${wall}ms exec=${execMatch ? execMatch[1] + 'ms' : '?'} ${hasSeqScan ? '⚠️ SEQ SCAN' : 'ok'}`);
      if (hasSeqScan || wall > 200) console.log(text.split('\n').map(l => '      ' + l).join('\n'));
    } catch (e) {
      console.log(`  ${label}: ERROR ${e.message}`);
    }
  }
  await explain('primary issue fetch', `SELECT * FROM issues WHERE key = $1 LIMIT 1`, [internalKey]);
  await explain('attachments', `SELECT * FROM attachments WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [id]);
  await explain('issue_history', `SELECT * FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" DESC`, [id]);
  await explain('issue_links out', `SELECT * FROM issue_links WHERE "sourceKey" = $1`, [internalKey]);
  await explain('issue_links in', `SELECT * FROM issue_links WHERE "targetKey" = $1`, [internalKey]);
  await explain('children', `SELECT * FROM issues WHERE "parentKey" = $1`, [internalKey]);
  await explain('sla_definitions', `SELECT * FROM sla_definitions WHERE "spaceId" = $1 AND status = 'active'`, [spaceId]);
  await explain('notifications SLA breach check', `SELECT id FROM notifications WHERE "issueKey" = $1 AND type = 'SLA_BREACH' LIMIT 1`, [cf_key || internalKey]);
  await explain('comments', `SELECT * FROM comments WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [id]);

  console.log('\n=== DB connection pool state RIGHT NOW (proxy for "was the pool saturated") ===');
  const activity = await pool.query(`
    SELECT state, count(*) AS n, max(EXTRACT(EPOCH FROM (now() - query_start))) AS longest_running_secs
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
    ORDER BY n DESC
  `);
  for (const r of activity.rows) {
    console.log(`  state=${r.state || '(null)'} count=${r.n} longest_running=${r.longest_running_secs ? Number(r.longest_running_secs).toFixed(1) + 's' : '-'}`);
  }
  const totalConns = activity.rows.reduce((sum, r) => sum + Number(r.n), 0);
  console.log(`  total connections to this DB right now: ${totalConns}  (app pool max is 20 -- if this is consistently near/over 20+ across all processes, that alone can produce exactly this symptom: requests queueing for a free connection instead of failing fast, until connectionTimeoutMillis=10s trips)`);

  const longQueries = await pool.query(`
    SELECT pid, state, EXTRACT(EPOCH FROM (now() - query_start)) AS running_secs, left(query, 200) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND query_start < now() - interval '2 seconds'
    ORDER BY query_start ASC
  `);
  if (longQueries.rows.length) {
    console.log('\n  Queries currently running > 2s:');
    for (const r of longQueries.rows) {
      console.log(`    pid=${r.pid} running=${Number(r.running_secs).toFixed(1)}s: ${r.query}`);
    }
  } else {
    console.log('\n  No queries currently running > 2s (this only reflects the instant you ran this script, not the moment of the timeout).');
  }

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
