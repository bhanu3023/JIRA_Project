// Full recovery: for every ticket whose internal `key` is a real Jira
// issue key (format PROJECT-123, confirmed via check-kiran-real-jira-key
// and check-jira-real-updated-dates), pulls the REAL "updated" field
// from the live cf2020.atlassian.net Jira instance and restores it into
// our local updatedAt column -- undoing the corruption caused by old
// one-off backfill scripts that used Prisma's auto-managed @updatedAt
// on every row they touched, regardless of which field they actually
// meant to fix.
//
// Only updatedAt is touched -- createdAt already looks correct/varied
// locally, not uniformly stamped, so it's left alone. Batches 100 keys
// per Jira JQL call (well under Jira's limits), with retry on
// transient failures. Dry-run by default (reports scope + a sample of
// what would change); pass --apply to actually write.
//
// Usage: JIRA_TOKEN=... node recover-updatedat-from-jira.mjs [--apply] [--limit N]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1], 10) : null;

const JIRA_EMAIL = 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const BASE = 'https://cf2020.atlassian.net';
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function jiraSearch(keys, retries = 3) {
  const jql = `key in (${keys.join(',')})`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, fields: ['updated'], maxResults: 100 }),
      });
      if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`); }
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  if (!JIRA_TOKEN) { console.log('JIRA_TOKEN not set in this shell/container.'); await pool.end(); return; }

  const { rows: candidates } = await pool.query(`
    SELECT id, key, COALESCE(cf_key, key) AS cf_key, "updatedAt"
    FROM issues
    WHERE key ~ '^[A-Z][A-Z0-9]*-[0-9]+$'
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `);
  console.log(`${candidates.length} tickets have a real Jira-shaped key (candidates for recovery).`);
  const byKey = new Map(candidates.map(c => [c.key, c]));

  let checked = 0, differ = 0, applied = 0, notFoundInJira = 0, errors = 0;
  const batches = chunk(candidates.map(c => c.key), 100);
  console.log(`Processing in ${batches.length} batches of up to 100...\n`);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    try {
      const data = await jiraSearch(batch);
      const foundKeys = new Set();
      for (const issue of data.issues || []) {
        foundKeys.add(issue.key);
        const local = byKey.get(issue.key);
        if (!local) continue;
        checked++;
        const jiraUpdated = issue.fields?.updated ? new Date(issue.fields.updated) : null;
        if (!jiraUpdated) continue;
        const localUpdated = local.updatedAt ? new Date(local.updatedAt) : null;
        const sameMinute = localUpdated && Math.abs(jiraUpdated.getTime() - localUpdated.getTime()) < 60000;
        if (!sameMinute) {
          differ++;
          if (APPLY) {
            await pool.query(`UPDATE issues SET "updatedAt" = $1 WHERE id = $2`, [jiraUpdated, local.id]);
            applied++;
          } else if (differ <= 15) {
            console.log(`  ${issue.key} (${local.cf_key}): local=${local.updatedAt?.toISOString?.()} -> jira=${jiraUpdated.toISOString()}`);
          }
        }
      }
      for (const k of batch) if (!foundKeys.has(k)) notFoundInJira++;
    } catch (e) {
      errors++;
      console.log(`Batch ${bi + 1}/${batches.length} failed: ${e.message}`);
    }
    if ((bi + 1) % 10 === 0 || bi === batches.length - 1) {
      console.log(`  ...${bi + 1}/${batches.length} batches done (checked=${checked}, differ=${differ}, applied=${applied}, notFoundInJira=${notFoundInJira}, errors=${errors})`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`candidates=${candidates.length} checked=${checked} differ=${differ} notFoundInJira=${notFoundInJira} errors=${errors}`);
  console.log(APPLY ? `Applied: restored updatedAt on ${applied} tickets.` : 'Dry run only -- re-run with --apply to write these changes.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
