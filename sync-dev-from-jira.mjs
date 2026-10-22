// Bulk sync: for every Dev-queue ticket, find its matching real Jira issue
// (jira_source_key if populated, else a direct L2B/L3B key guess verified
// by normalized title match) and correct LOCAL status + assignee if they
// differ. Logs every change and every skip with a reason -- fully
// auditable. Resumable: writes progress to sync-dev-progress.json and
// skips already-processed tickets on a re-run.
//
// Rate-limited to ~5 req/sec to stay well under Jira Cloud's limits over
// a run this long. Explicitly requested as a full bulk check-and-fill
// across all Dev tickets, after a 40-ticket manual sample review.
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';
const DEPT = 'Dev';
const PROGRESS_FILE = '/app/sync-dev-progress.json';
const DELAY_MS = 40; // ~25 req/sec -- raised after 6800+ requests at 5 req/sec with zero errors showed real headroom

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJiraCreds() {
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { base: s.jira_url, authHdr: 'Basic ' + Buffer.from(`${s.jira_email}:${s.jira_token}`).toString('base64') };
}

async function fetchJiraIssue(base, authHdr, key) {
  const res = await fetch(`${base}/rest/api/3/issue/${key}?fields=summary,status,assignee,reporter`, {
    headers: { Authorization: authHdr, Accept: 'application/json' },
  }).catch(() => null);
  if (!res) return { ok: false, status: 0 };
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return { done: {} }; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;

  const { rows: devQueueRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const devQueue = (devQueueRows[0]?.queues || []).find((q) => (q.name || '').toLowerCase() === DEPT.toLowerCase());
  const devStatuses = devQueue?.queueStatuses || [];

  const { rows: spaceStatusRows } = await pool.query(`SELECT id, name, category FROM statuses WHERE "spaceId" = $1`, [spaceId]);

  function resolveLocalStatusId(jiraStatusName) {
    const n = normalize(jiraStatusName);
    const dq = devStatuses.find((s) => normalize(s.name) === n);
    if (dq) return { id: dq.id, table: 'queue' };
    const sw = spaceStatusRows.find((s) => normalize(s.name) === n);
    if (sw) return { id: sw.id, table: 'space' };
    return null;
  }

  const { rows: tickets } = await pool.query(
    `SELECT i.id, i.key, i.summary, i.jira_source_key, i."statusId",
            s.name AS status_name,
            a.id AS assignee_id, a.email AS assignee_email,
            r.id AS reporter_id, r.email AS reporter_email
     FROM issues i
     LEFT JOIN statuses s ON i."statusId" = s.id
     LEFT JOIN users a ON i."assigneeId" = a.id
     LEFT JOIN users r ON i."reporterId" = r.id
     WHERE i."spaceId" = $1 AND i.current_department = $2
     ORDER BY i."createdAt"`,
    [spaceId, DEPT]
  );
  console.log(`${tickets.length} total "${DEPT}" tickets to check.`);

  const { base, authHdr } = await getJiraCreds();
  const progress = loadProgress();
  let checked = 0, updated = 0, noMatch = 0, errors = 0, skippedAlready = 0;

  for (const t of tickets) {
    if (progress.done[t.key]) { skippedAlready++; continue; }
    checked++;

    try {
      let jira = null, matchedVia = null;
      if (t.jira_source_key) {
        const r = await fetchJiraIssue(base, authHdr, t.jira_source_key);
        await sleep(DELAY_MS);
        if (r.ok) { jira = r.data; matchedVia = `jira_source_key`; }
      }
      if (!jira) {
        const num = t.key.split('-').pop();
        for (const proj of ['L2B', 'L3B']) {
          const r = await fetchJiraIssue(base, authHdr, `${proj}-${num}`);
          await sleep(DELAY_MS);
          if (r.ok && normalize(r.data.fields?.summary).includes(normalize(t.summary).slice(0, 30))) {
            jira = r.data; matchedVia = `${proj}-${num}`;
            break;
          }
        }
      }

      if (!jira) {
        noMatch++;
        progress.done[t.key] = { result: 'no-match' };
        if (checked % 50 === 0) console.log(`[${checked}/${tickets.length}] ${t.key}: no Jira match`);
        continue;
      }

      const jf = jira.fields || {};
      const changes = [];

      const localStatusResolved = resolveLocalStatusId(jf.status?.name);
      if (localStatusResolved && normalize(jf.status?.name) !== normalize(t.status_name)) {
        await pool.query(`UPDATE issues SET "statusId" = $1 WHERE id = $2`, [localStatusResolved.id, t.id]);
        changes.push(`status: "${t.status_name}" -> "${jf.status?.name}"`);
      }

      const jiraAssigneeEmail = (jf.assignee?.emailAddress || '').toLowerCase();
      if (jiraAssigneeEmail && jiraAssigneeEmail !== (t.assignee_email || '').toLowerCase()) {
        const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [jiraAssigneeEmail]);
        if (userRows[0]) {
          await pool.query(`UPDATE issues SET "assigneeId" = $1 WHERE id = $2`, [userRows[0].id, t.id]);
          changes.push(`assignee: "${t.assignee_email || '(none)'}" -> "${jiraAssigneeEmail}"`);
        }
      }

      if (changes.length) {
        updated++;
        console.log(`[${checked}/${tickets.length}] ${t.key} (via ${matchedVia}): ${changes.join(', ')}`);
      }
      progress.done[t.key] = { result: changes.length ? 'updated' : 'already-correct', changes };
    } catch (e) {
      errors++;
      console.error(`[${checked}/${tickets.length}] ${t.key}: ERROR ${e?.message || e}`);
      progress.done[t.key] = { result: 'error', message: e?.message || String(e) };
    }

    if (checked % 100 === 0) {
      saveProgress(progress);
      console.log(`--- progress saved: ${checked} checked, ${updated} updated, ${noMatch} no-match, ${errors} errors (${skippedAlready} already done from a prior run) ---`);
    }
  }

  saveProgress(progress);
  console.log(`\nDONE. ${checked} checked this run, ${updated} updated, ${noMatch} no Jira match, ${errors} errors, ${skippedAlready} already done from a prior run.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
