// Independently verifies the new MBR "Avg. Resolution (hrs)" formula
// (active In Progress time per ticket, not full elapsed time) against real
// data, by replicating computeInProgressHours' exact algorithm from
// jira-pg-api.ts here and running it per ticket for a given person + date
// range -- the same verification approach used for the old elapsed-time
// formula (check-mbr-monthly-avg-detail.mjs), applied to the new one.
//
// Read-only.
//
// Usage: node check-mbr-inprogress-detail.mjs <email> <YYYY-MM-DD> <YYYY-MM-DD>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const [, , EMAIL, FROM, TO] = process.argv;

if (!EMAIL || !FROM || !TO) {
  console.error('Usage: node check-mbr-inprogress-detail.mjs <email> <YYYY-MM-DD> <YYYY-MM-DD>');
  process.exit(1);
}

const IN_PROGRESS_STATUS_NAMES = new Set(['in progress', 'work in progress']);

// Exact port of computeInProgressHours from jira-pg-api.ts.
function computeInProgressHours(statusHist, createdAt, isDone, resolvedAt, currentStatusName) {
  const createdMs = new Date(createdAt).getTime();
  const statusTotals = {};
  let cursor = createdMs;
  let cursorStatus = statusHist[0]?.oldValue || currentStatusName || 'Unknown';
  for (const h of statusHist) {
    const t = new Date(h.createdAt).getTime();
    const hrs = (t - cursor) / 3_600_000;
    if (hrs > 0 && cursorStatus) statusTotals[cursorStatus] = (statusTotals[cursorStatus] || 0) + hrs;
    cursor = t;
    cursorStatus = h.newValue;
  }
  const tailEnd = isDone && resolvedAt ? new Date(resolvedAt).getTime() : Date.now();
  const tailHrs = (tailEnd - cursor) / 3_600_000;
  if (tailHrs > 0 && cursorStatus) statusTotals[cursorStatus] = (statusTotals[cursorStatus] || 0) + tailHrs;
  const inProgressHrs = Math.round(
    Object.entries(statusTotals).reduce((sum, [name, hrs]) => sum + (IN_PROGRESS_STATUS_NAMES.has(name.trim().toLowerCase()) ? hrs : 0), 0) * 10
  ) / 10;
  return inProgressHrs;
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, "firstName", "lastName" FROM users WHERE email = $1`, [EMAIL]);
  if (!userRows.length) { console.log('User not found.'); await pool.end(); return; }
  const { id: userId, firstName, lastName } = userRows[0];

  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."createdAt", i."updatedAt", i."resolvedAt", s.name AS status_name, s.category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."assigneeId" = $1
      AND (
        (i."createdAt"::date >= $2::date AND i."createdAt"::date <= $3::date)
        OR (i."updatedAt"::date >= $2::date AND i."updatedAt"::date <= $3::date)
      )
      AND s.category = 'done' AND i."resolvedAt" IS NOT NULL
    ORDER BY i."createdAt" ASC
  `, [userId, FROM, TO]);

  console.log(`${firstName} ${lastName} <${EMAIL}> -- ${rows.length} resolved ticket(s) with resolvedAt, matching MBR's date scoping for ${FROM} to ${TO}\n`);

  if (!rows.length) { console.log('No tickets to average.'); await pool.end(); return; }

  const ids = rows.map(r => r.id);
  const { rows: histRows } = await pool.query(
    `SELECT "issueId", "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = ANY($1::text[]) AND field = 'status' ORDER BY "issueId", "createdAt" ASC`,
    [ids]
  );
  const histByIssue = {};
  for (const h of histRows) (histByIssue[h.issueId] ??= []).push(h);

  let sum = 0;
  for (const r of rows) {
    const hrs = computeInProgressHours(histByIssue[r.id] || [], r.createdAt, true, r.resolvedAt, r.status_name);
    sum += hrs;
    console.log(`  ${r.key}  created=${r.createdAt.toISOString().slice(0, 10)}  in-progress=${hrs.toFixed(1)} hrs  (${(histByIssue[r.id] || []).length} status change(s) recorded)`);
  }

  console.log(`\n${rows.length} ticket(s), summing ${sum.toFixed(1)} in-progress hours.`);
  console.log(`Average = ${sum.toFixed(1)} / ${rows.length} = ${(sum / rows.length).toFixed(1)} hrs/ticket`);
  console.log(`\nThis should match what MBR's "Avg. Resolution (hrs)" column now shows for this person + date range.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
