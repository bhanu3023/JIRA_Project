/**
 * report-queue-dashboard-v2.mjs
 * READ-ONLY sanity check for the Queue Dashboard's newer additions on
 * /my-dashboard?viewedQueue=<dept>:
 *   - the Summary sub-tab's full per-status breakdown (statusBreakdown)
 *   - the User-wise Tickets sub-tab's table columns that DON'T require
 *     computeSLAInstancesPure: In Progress, Resolved, and the four
 *     "Waiting for Dev / Pre-Sales / QA / Infra" hand-off columns
 *   - the Compare-mode "Open" column's per-member, per-week cohort count
 *     (tickets created in that week, not-done as of now)
 *
 * Nothing is written. Pairs with the original report-queue-dashboard.mjs,
 * which already covers total/open counts, tickets-worked, the per-member
 * current-holdings bar chart, and created-vs-resolved week-over-week --
 * this script only adds the NEW fields introduced alongside the tabs/table/
 * compare-mode feature, so run both against a department to check the full
 * queueDashboard payload.
 *
 * Deliberately NOT reproduced here (same reasoning as the original script):
 * SLA Breached (any column/summary stat) and the Compare mode's "In
 * Progress"/"SLA Breached" figures that key off computeSLAInstancesPure --
 * that function's goal-duration/pause/waiver logic isn't worth
 * re-implementing in raw SQL for a spot check, and doing it badly here would
 * risk becoming exactly the "simpler dueDate proxy" the real endpoint was
 * written to avoid. Verify those directly against the running app instead.
 *
 * Usage: DATABASE_URL=... node report-queue-dashboard-v2.mjs "Migration"
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const dept = process.argv[2];
if (!dept) {
  console.error('Usage: node report-queue-dashboard-v2.mjs <department-name>   (e.g. "Migration" or "Dev")');
  process.exit(1);
}

const WAITING_HANDOFF_STATUS_NAMES = {
  'waiting for dev': 'waitingForDev',
  'waiting for pre-sales': 'waitingForPreSales',
  'waiting for qa': 'waitingForQA',
  'waiting for infra': 'waitingForInfra',
};

async function main() {
  console.log(`========== Queue Dashboard v2 sanity check: "${dept}" ==========\n`);

  const cq = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const memberIds = new Set();
  for (const row of cq.rows) {
    for (const q of row.queues || []) {
      if ((q.name || '').trim().toLowerCase() === dept.toLowerCase()) {
        (q.memberIds || []).forEach((id) => memberIds.add(id));
      }
    }
  }
  const memberIdList = [...memberIds];
  console.log(`Members resolved: ${memberIdList.length}`);

  let members = [];
  if (memberIdList.length) {
    const r = await pool.query(
      `SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1::text[])`,
      [memberIdList]
    );
    members = r.rows;
  }
  const nameOf = (id) => {
    const m = members.find((mm) => mm.id === id);
    return m ? (`${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email) : id;
  };

  // Pull every current ticket in this department -- same "one query, filter
  // in JS" approach the real endpoint uses, so results line up 1:1 with it
  // (the real endpoint's trimmed SELECT list omits fields this script
  // doesn't need either, but status name/category/assignee/createdAt are
  // all still present there).
  const issuesRes = await pool.query(
    `SELECT i."assigneeId", i."createdAt", s.name AS status_name, s.category AS status_category
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
     WHERE LOWER(i.current_department) = LOWER($1)`,
    [dept]
  );
  const issues = issuesRes.rows;
  const isWaiting = (name) => /wait|hold/i.test(name || '');
  const isDone = (r) => r.status_category === 'done';
  const isInProgress = (r) => r.status_category === 'in_progress' && !isWaiting(r.status_name);

  console.log('\n---------- Summary: full status breakdown (dept-wide) ----------');
  const statusMap = {};
  for (const r of issues) {
    const name = r.status_name || 'Unknown';
    statusMap[name] = (statusMap[name] || 0) + 1;
  }
  for (const [name, count] of Object.entries(statusMap).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }

  console.log('\n---------- User-wise Tickets: In Progress / Resolved / Waiting-for-X ----------');
  console.log('(SLA Breached and Tickets Worked columns are NOT checked here -- see file header)');
  const perMember = {};
  for (const id of memberIdList) {
    perMember[id] = { inProgress: 0, resolved: 0, waitingForDev: 0, waitingForPreSales: 0, waitingForQA: 0, waitingForInfra: 0 };
  }
  for (const r of issues) {
    const aid = r.assigneeId;
    if (!aid || !perMember[aid]) continue;
    const p = perMember[aid];
    if (isDone(r)) p.resolved++;
    else if (isInProgress(r)) p.inProgress++;
    const handoffKey = WAITING_HANDOFF_STATUS_NAMES[(r.status_name || '').trim().toLowerCase()];
    if (handoffKey) p[handoffKey]++;
  }
  for (const id of memberIdList) {
    const p = perMember[id];
    console.log(
      `  ${nameOf(id)}: inProgress=${p.inProgress} resolved=${p.resolved} ` +
      `waitingForDev=${p.waitingForDev} waitingForPreSales=${p.waitingForPreSales} ` +
      `waitingForQA=${p.waitingForQA} waitingForInfra=${p.waitingForInfra}`
    );
  }

  console.log('\n---------- Compare mode: "Open" per member, week over week ----------');
  console.log('Definition: tickets created in that week, not in a "done" status AS OF NOW.');
  console.log('(matches the tradeoff documented in jira-pg-api.ts -- no historical snapshot exists)');
  const now = Date.now();
  const thisWeekFrom = now - 7 * 86_400_000;
  const lastWeekFrom = now - 14 * 86_400_000;
  const lastWeekTo = thisWeekFrom;
  const openForWeek = (fromMs, toMs) => {
    const byMember = {};
    for (const id of memberIdList) byMember[id] = 0;
    for (const r of issues) {
      const aid = r.assigneeId;
      if (!aid || !(aid in byMember)) continue;
      const c = new Date(r.createdAt).getTime();
      if (c >= fromMs && c < toMs && !isDone(r)) byMember[aid]++;
    }
    return byMember;
  };
  const openLastWeek = openForWeek(lastWeekFrom, lastWeekTo);
  const openThisWeek = openForWeek(thisWeekFrom, now);
  for (const id of memberIdList) {
    console.log(`  ${nameOf(id)}: Open (Last Wk)=${openLastWeek[id]}, Open (This Wk)=${openThisWeek[id]}`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
