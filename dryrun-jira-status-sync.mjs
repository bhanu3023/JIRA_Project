// Read-only dry run: for a SAMPLE of local Dev-queue tickets created
// before the given cutoff, try to find the matching real Jira issue
// (jira_source_key if populated, else try the ticket's own key against
// L2B/L3B directly, else title match within L2B/L3B) and report a
// before/after diff for status/assignee/reporter -- no writes at all.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const DEPT = 'Dev';
const CUTOFF = process.argv[2] || '2026-08-01';
const SAMPLE_SIZE = parseInt(process.argv[3] || '20', 10);

async function getJiraCreds() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { base: s.jira_url, authHdr: 'Basic ' + Buffer.from(`${s.jira_email}:${s.jira_token}`).toString('base64') };
}

async function fetchJiraIssue(base, authHdr, key) {
  const res = await fetch(`${base}/rest/api/3/issue/${key}?fields=summary,status,assignee,reporter`, {
    headers: { Authorization: authHdr, Accept: 'application/json' },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: tickets } = await pool.query(
    `SELECT i.id, i.key, i.summary, i."createdAt", i.jira_source_key,
            s.name AS status_name,
            a.email AS assignee_email, CONCAT(a."firstName",' ',a."lastName") AS assignee_name,
            r.email AS reporter_email, CONCAT(r."firstName",' ',r."lastName") AS reporter_name
     FROM issues i
     LEFT JOIN statuses s ON i."statusId" = s.id
     LEFT JOIN users a ON i."assigneeId" = a.id
     LEFT JOIN users r ON i."reporterId" = r.id
     WHERE i."spaceId" = $1 AND i.current_department = $2 AND i."createdAt" < $3 AND s.category != 'done'
     ORDER BY RANDOM()
     LIMIT $4`,
    [spaceId, DEPT, CUTOFF, SAMPLE_SIZE]
  );
  console.log(`Sampling ${tickets.length} "${DEPT}" tickets created before ${CUTOFF} that are currently NOT done locally\n`);

  const { base, authHdr } = await getJiraCreds();

  for (const t of tickets) {
    console.log(`--- ${t.key} (local) --- created ${t.createdAt.toISOString().slice(0, 10)}`);
    console.log(`  Local: status="${t.status_name}" assignee="${t.assignee_name || t.assignee_email || '(none)'}" reporter="${t.reporter_name || t.reporter_email || '(none)'}"`);
    console.log(`  Summary: ${(t.summary || '').slice(0, 80)}`);

    let matched = null;
    let matchedVia = null;

    if (t.jira_source_key) {
      matched = await fetchJiraIssue(base, authHdr, t.jira_source_key);
      if (matched) matchedVia = `jira_source_key=${t.jira_source_key}`;
    }
    if (!matched) {
      // Try the ticket's own key directly against L2B/L3B (only the numeric
      // suffix matters since the local prefix is "CF", not "L2B"/"L3B").
      const num = t.key.split('-').pop();
      for (const proj of ['L2B', 'L3B']) {
        const candidate = await fetchJiraIssue(base, authHdr, `${proj}-${num}`);
        if (candidate && normalize(candidate.fields?.summary) === normalize(t.summary)) {
          matched = candidate;
          matchedVia = `direct key guess ${proj}-${num} (title matched)`;
          break;
        }
      }
    }

    if (!matched) {
      console.log(`  Jira: NO MATCH FOUND\n`);
      continue;
    }
    const jf = matched.fields || {};
    console.log(`  Jira (${matchedVia}): status="${jf.status?.name}" assignee="${jf.assignee?.displayName || jf.assignee?.emailAddress || '(unassigned)'}" reporter="${jf.reporter?.displayName || jf.reporter?.emailAddress || '(none)'}"`);

    const statusDiff = normalize(jf.status?.name) !== normalize(t.status_name);
    const assigneeDiff = normalize(jf.assignee?.emailAddress) !== normalize(t.assignee_email);
    const reporterDiff = normalize(jf.reporter?.emailAddress) !== normalize(t.reporter_email);
    console.log(`  DIFF: status=${statusDiff} assignee=${assigneeDiff} reporter=${reporterDiff}\n`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
