// Broader check per explicit request: for the 11 tickets not yet flagged as
// genuine work, was Naveed EVER the recorded assignee at any point at all
// -- even briefly, even if he only reassigned it away afterward with no
// separate status change of his own. This is a different, looser bar than
// check-naveed-16-verdict-v2.mjs (which requires an independent status
// change while assigned) -- reports both so the actual tradeoff is visible:
// how many more tickets "ever assigned" catches beyond "did something while
// assigned", and for each, exactly how long he held it and what (if
// anything) happened in between.
//
// Read-only.
//
// Usage: node check-naveed-ever-assigned.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = [
  'CF-29907', 'CF-29901', 'CF-29860', 'CF-29859', 'CF-29858',
  'CF-29825', 'CF-29817', 'CF-29816', 'CF-29783', 'CF-29593', 'CF-29567',
];
const isNaveedName = (n) => n === 'Naved' || n === 'Naved ' || n?.startsWith('Naved ');

async function main() {
  for (const key of KEYS) {
    const { rows: issueRows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1`, [key]);
    if (!issueRows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const issueId = issueRows[0].id;

    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history WHERE "issueId" = $1 AND field IN ('status','assignee') ORDER BY "createdAt" ASC`,
      [issueId]
    );

    // Find every window where he was the current assignee, and what
    // (if anything) happened during that window.
    let currentAssigneeName = null;
    let becameAssigneeAt = null;
    const windows = [];
    for (const h of hist) {
      if (h.field === 'assignee') {
        const wasNaveed = isNaveedName(currentAssigneeName);
        const isNowNaveed = isNaveedName(h.newValue === 'null' ? null : h.newValue);
        if (wasNaveed && !isNowNaveed) {
          windows.push({ from: becameAssigneeAt, to: h.createdAt, events: 0 });
        }
        if (!wasNaveed && isNowNaveed) becameAssigneeAt = h.createdAt;
        currentAssigneeName = h.newValue === 'null' ? null : h.newValue;
      }
    }
    if (isNaveedName(currentAssigneeName)) windows.push({ from: becameAssigneeAt, to: null, events: 0 });

    for (const h of hist) {
      if (h.field !== 'status') continue;
      for (const w of windows) {
        const afterStart = h.createdAt.getTime() >= w.from.getTime();
        const beforeEnd = w.to ? h.createdAt.getTime() <= w.to.getTime() : true;
        if (afterStart && beforeEnd) w.events++;
      }
    }

    if (!windows.length) {
      console.log(`${key}: never assigned to him at all`);
      continue;
    }
    for (const w of windows) {
      const durationSec = w.to ? Math.round((w.to.getTime() - w.from.getTime()) / 1000) : null;
      console.log(`${key}: assigned to him ${w.from.toISOString()} -> ${w.to ? w.to.toISOString() : '(still/later)'}  (${durationSec != null ? durationSec + 's' : 'open-ended'})  status changes by anyone during that window: ${w.events}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
