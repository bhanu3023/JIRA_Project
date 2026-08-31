// Read-only report: how many hours were tickets actually "In Progress" while
// sitting in each department, for resolved tickets -- computed by walking
// status + department issue_history together on one timeline (not the
// existing app-wide inProgressHrs metric, which sums a ticket's whole
// lifetime as one number with no department attribution at all).
//
// Usage: node scripts/dept-inprogress-hours.mjs [--dept=Dev,Migration] [--sample=10]

import pg from 'pg';

const { Client } = pg;
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);

const deptArg = (process.argv.find((a) => a.startsWith('--dept=')) || '').split('=')[1];
const TARGET_DEPTS = deptArg ? deptArg.split(',').map((d) => d.trim().toLowerCase()) : null;
const sampleArg = parseInt((process.argv.find((a) => a.startsWith('--sample=')) || '').split('=')[1] || '5', 10);

function extractDeptFromChange(newValue) {
  if (!newValue) return null;
  // Same fix as scripts/backfill-worked-on-tracking.mjs: only the em-dash
  // introducing "— SLA started" should stop the match, not a plain hyphen
  // (a department can legitimately be named "Pre-Sales").
  const m = String(newValue).match(/(?:Transferred to|Handed to)\s+([^—]+)/i);
  if (m) return m[1].trim();
  return null;
}

function computeDeptInProgressHours(history, createdAt, endAt, initialDept) {
  const buckets = {};
  let cursorTime = new Date(createdAt).getTime();
  let curDept = initialDept;
  let curStatus = '';
  const endTime = new Date(endAt).getTime();

  const events = history
    .filter((h) => h.field === 'status' || h.field === 'department')
    .map((h) => ({ ...h, ts: new Date(h.createdAt).getTime() }))
    .filter((h) => h.ts >= cursorTime && h.ts <= endTime)
    .sort((a, b) => a.ts - b.ts);

  const flush = (until) => {
    if (until <= cursorTime) return;
    if (IN_PROGRESS_NAMES.has(curStatus) && curDept) {
      const key = curDept.toLowerCase();
      buckets[key] = (buckets[key] || 0) + (until - cursorTime);
    }
    cursorTime = until;
  };

  for (const ev of events) {
    flush(ev.ts);
    if (ev.field === 'status') curStatus = String(ev.newValue || '').trim().toLowerCase();
    else if (ev.field === 'department') {
      const next = extractDeptFromChange(ev.newValue);
      if (next) curDept = next;
    }
  }
  flush(endTime);

  const hours = {};
  for (const [k, ms] of Object.entries(buckets)) hours[k] = ms / 3_600_000;
  return hours;
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  const client = new Client({ connectionString });
  await client.connect();

  // Resolved tickets whose dept_statuses touches Dev or Migration -- scoped
  // to "resolved" since the ask was specifically In-Progress-to-Resolved time.
  const { rows: candidates } = await client.query(`
    SELECT i.id, i.cf_key, i.key, i."createdAt", i."resolvedAt", i."updatedAt", i.current_department
    FROM issues i
    WHERE i."resolvedAt" IS NOT NULL
      AND (i.dept_statuses ? 'Dev' OR i.dept_statuses ? 'Migration')
  `);
  console.log(`Resolved tickets touching Dev or Migration: ${candidates.length}`);

  const totals = {}; // dept(lower) -> {ms, tickets}
  const sample = [];
  const BATCH = 300;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const ids = batch.map((r) => r.id);
    const { rows: histRows } = await client.query(
      `SELECT "issueId", field, "oldValue", "newValue", "createdAt"
       FROM issue_history WHERE "issueId" = ANY($1::text[]) AND field IN ('status','department')
       ORDER BY "issueId", "createdAt" ASC`,
      [ids]
    );
    const histByIssue = new Map();
    for (const h of histRows) {
      if (!histByIssue.has(h.issueId)) histByIssue.set(h.issueId, []);
      histByIssue.get(h.issueId).push(h);
    }

    for (const issue of batch) {
      const history = histByIssue.get(issue.id) || [];
      if (!history.length) continue;
      const firstDeptChange = history.find((h) => h.field === 'department');
      const initialDept = firstDeptChange?.oldValue || issue.current_department;
      const hours = computeDeptInProgressHours(history, issue.createdAt, issue.resolvedAt, initialDept);
      for (const [dept, hrs] of Object.entries(hours)) {
        if (TARGET_DEPTS && !TARGET_DEPTS.includes(dept)) continue;
        if (!totals[dept]) totals[dept] = { ms: 0, tickets: 0 };
        totals[dept].ms += hrs * 3_600_000;
        totals[dept].tickets += 1;
      }
      if (sample.length < sampleArg && Object.keys(hours).length > 1) {
        sample.push({ key: issue.cf_key || issue.key, hours });
      }
    }
  }

  console.log('\nTotal In-Progress hours actually spent per department (resolved tickets only):');
  for (const [dept, t] of Object.entries(totals).sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${dept}: ${(t.ms / 3_600_000).toFixed(1)}h across ${t.tickets} tickets (avg ${(t.ms / 3_600_000 / t.tickets).toFixed(1)}h/ticket)`);
  }

  console.log(`\nSample of tickets that crossed multiple departments (up to ${sampleArg}):`);
  for (const s of sample) {
    console.log(`  ${s.key}: ${JSON.stringify(Object.fromEntries(Object.entries(s.hours).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`);
  }

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
