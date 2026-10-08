// Worklog page's Queue: Dev filter shows only 2 entries for Sep 9 - Oct 8
// 2026, reported as "not working". Checks the RAW count of every
// department=Dev worklog entry in that range (before the roster filter the
// frontend now applies), and which of those loggers are/aren't configured
// Dev queue members, to tell apart "the roster filter is wrongly hiding
// real Dev entries" from "there simply are only 2 Dev-tagged entries in
// this window to begin with". Read-only.
//
// Usage: node check-worklog-dev-filter.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DATE_FROM = '2026-09-09';
const DATE_TO = '2026-10-08';
const SPACE_KEY = 'TESTIN';
const DEPT = 'Dev';

async function main() {
  const { rows } = await pool.query(`
    SELECT wl.id, wl."timeSpentMinutes", wl."authorName", wl."authorId", wl."workDate",
           COALESCE(iss.cf_key, iss.key) AS issue_key
    FROM issue_worklogs wl
    JOIN issues iss ON iss.id = wl."issueId"
    WHERE LOWER(wl.department) = LOWER($1)
      AND wl."workDate" >= $2::date AND wl."workDate" < ($3::date + interval '1 day')
    ORDER BY wl."workDate" DESC
  `, [DEPT, DATE_FROM, DATE_TO]);

  console.log(`Raw count of department=${DEPT} worklog entries, ${DATE_FROM} to ${DATE_TO}: ${rows.length}\n`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  const queues = cqRows[0]?.queues || [];
  const devQueue = queues.find((q) => String(q.name || '').toLowerCase() === DEPT.toLowerCase());
  const memberIds = new Set(Array.isArray(devQueue?.memberIds) ? devQueue.memberIds : []);

  let inRoster = 0, notInRoster = 0;
  for (const r of rows) {
    const isMember = r.authorId ? memberIds.has(r.authorId) : false;
    if (isMember) inRoster++; else notInRoster++;
    console.log(`${r.issueKey}: ${r.authorName} -- ${r.timeSpentMinutes}min, ${new Date(r.workDate).toISOString().slice(0, 10)} -- Dev roster member: ${isMember}`);
  }

  console.log(`\n${inRoster} entries from a configured Dev roster member, ${notInRoster} from someone NOT on the Dev roster.`);
  console.log(`(Worklog page's Queue: Dev filter should show exactly the ${inRoster} roster-member entries.)`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
