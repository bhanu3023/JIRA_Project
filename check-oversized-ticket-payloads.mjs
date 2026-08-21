/**
 * check-oversized-ticket-payloads.mjs
 * READ-ONLY. Checks whether the "some tickets have huge base64-embedded
 * images inline, ballooning the response" concern (already flagged in
 * jira-pg-api.ts's GET /issues/:key size guard, ~line 6485) is an actual,
 * currently-present factor in production data, with real numbers -- not a
 * hypothetical.
 *
 * Reports:
 *  1. The 10 largest issue `description` fields (bytes).
 *  2. The 10 largest single comment `body` fields (bytes).
 *  3. The 10 largest issue_history old/new-value fields (bytes) -- the
 *     activity feed keeps the FULL before/after text of every edit, so a
 *     description edited many times can be large here even when the CURRENT
 *     description is small.
 *  4. How many rows in each of the above exceed the handler's own
 *     MAX_SAFE_BYTES (3MB) and MAX_FIELD_CHARS (150,000 chars) trim
 *     thresholds, i.e. how often the trim guard actually fires in practice.
 *
 * Run: DATABASE_URL=... node check-oversized-ticket-payloads.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const MAX_FIELD_CHARS = 150_000; // matches jira-pg-api.ts's per-field trim threshold
const MAX_SAFE_BYTES = 3 * 1024 * 1024; // matches jira-pg-api.ts's whole-response trim threshold

function fmt(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function main() {
  console.log('=== Largest issue.description fields ===');
  const descRows = await pool.query(`
    SELECT key, length(description) AS chars, octet_length(description) AS bytes
    FROM issues
    WHERE description IS NOT NULL
    ORDER BY octet_length(description) DESC
    LIMIT 10
  `);
  for (const r of descRows.rows) {
    const flag = r.chars > MAX_FIELD_CHARS ? '  <-- exceeds per-field trim threshold' : '';
    console.log(`  ${r.key}: ${r.chars} chars, ${fmt(Number(r.bytes))}${flag}`);
  }

  console.log('\n=== Largest single comment bodies ===');
  const commentRows = await pool.query(`
    SELECT c.id, i.key AS issue_key, length(c.body) AS chars, octet_length(c.body) AS bytes
    FROM comments c
    JOIN issues i ON i.id = c."issueId"
    ORDER BY octet_length(c.body) DESC
    LIMIT 10
  `);
  for (const r of commentRows.rows) {
    const flag = r.chars > MAX_FIELD_CHARS ? '  <-- exceeds per-field trim threshold' : '';
    console.log(`  ${r.issue_key} (comment ${r.id}): ${r.chars} chars, ${fmt(Number(r.bytes))}${flag}`);
  }

  console.log('\n=== Largest issue_history old/new value fields ===');
  const histRows = await pool.query(`
    SELECT h.id, i.key AS issue_key, h.field,
           GREATEST(length(h."oldValue"), length(h."newValue")) AS chars,
           GREATEST(octet_length(h."oldValue"), octet_length(h."newValue")) AS bytes
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    WHERE h."oldValue" IS NOT NULL OR h."newValue" IS NOT NULL
    ORDER BY GREATEST(octet_length(h."oldValue"), octet_length(h."newValue")) DESC
    LIMIT 10
  `);
  for (const r of histRows.rows) {
    const flag = r.chars > MAX_FIELD_CHARS ? '  <-- exceeds per-field trim threshold' : '';
    console.log(`  ${r.issue_key} (history ${r.id}, field=${r.field}): ${r.chars} chars, ${fmt(Number(r.bytes))}${flag}`);
  }

  console.log('\n=== Counts vs. the handler\'s own trim thresholds ===');
  const overDesc = await pool.query(`SELECT count(*) FROM issues WHERE length(description) > $1`, [MAX_FIELD_CHARS]);
  const overComment = await pool.query(`SELECT count(*) FROM comments WHERE length(body) > $1`, [MAX_FIELD_CHARS]);
  const overHist = await pool.query(`SELECT count(*) FROM issue_history WHERE length("oldValue") > $1 OR length("newValue") > $1`, [MAX_FIELD_CHARS]);
  console.log(`  Issues with description > ${MAX_FIELD_CHARS} chars: ${overDesc.rows[0].count}`);
  console.log(`  Comments with body > ${MAX_FIELD_CHARS} chars: ${overComment.rows[0].count}`);
  console.log(`  History rows with old/newValue > ${MAX_FIELD_CHARS} chars: ${overHist.rows[0].count}`);

  console.log('\n=== Whole-ticket-payload estimate for the single largest ticket found ===');
  // Rough proxy for the full GET /issues/:key response size: description +
  // all comment bodies + all history old/new values for whichever single
  // ticket has the largest total. Not exact (misses attachments metadata,
  // sla objects, etc., which are all small/fixed-size), but the dominant
  // variable-size fields are exactly these three.
  const worst = await pool.query(`
    SELECT i.key,
      octet_length(i.description) AS desc_bytes,
      COALESCE((SELECT sum(octet_length(c.body)) FROM comments c WHERE c."issueId" = i.id), 0) AS comments_bytes,
      COALESCE((SELECT sum(octet_length(h."oldValue") + octet_length(h."newValue")) FROM issue_history h WHERE h."issueId" = i.id), 0) AS history_bytes
    FROM issues i
    ORDER BY octet_length(i.description)
      + COALESCE((SELECT sum(octet_length(c.body)) FROM comments c WHERE c."issueId" = i.id), 0)
      + COALESCE((SELECT sum(octet_length(h."oldValue") + octet_length(h."newValue")) FROM issue_history h WHERE h."issueId" = i.id), 0)
      DESC
    LIMIT 5
  `);
  for (const r of worst.rows) {
    const total = Number(r.desc_bytes || 0) + Number(r.comments_bytes || 0) + Number(r.history_bytes || 0);
    const flag = total > MAX_SAFE_BYTES ? '  <-- would trigger the whole-response trim guard' : '';
    console.log(`  ${r.key}: description=${fmt(Number(r.desc_bytes || 0))} comments=${fmt(Number(r.comments_bytes || 0))} history=${fmt(Number(r.history_bytes || 0))} total~=${fmt(total)}${flag}`);
  }

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
