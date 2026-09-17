// Srinu Gudimitla says these 8 tickets are missing from his Dev worked
// count. Same methodology as the Naveed investigation: pull full
// status/assignee history for each, apply the app's real crediting rule
// (independent status change while he was assignee, not simultaneous with
// a reassignment away from himself), and show his current
// user_worked_on_tickets state for each -- so we know exactly which are
// genuine bugs vs. tickets he only routed through without real work.
//
// Read-only.
//
// Usage: node check-srinu-8-missing.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = 'srinu.gudimitla@cloudfuze.com';
const KEYS = [
  'CF-29932', 'CF-29931', 'CF-29921', 'CF-29646',
  'CF-29645', 'CF-29643', 'CF-29350', 'CF-29348',
];
const SIMULTANEOUS_WINDOW_MS = 5000;
const isSrinuName = (n) => /srinu/i.test(String(n || ''));

async function main() {
  for (const key of KEYS) {
    const { rows: issueRows } = await pool.query(
      `SELECT id, current_department, dept_assignees, "assigneeId" FROM issues WHERE cf_key = $1 OR key = $1`,
      [key]
    );
    if (!issueRows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const issue = issueRows[0];

    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history WHERE "issueId" = $1 AND field IN ('status','assignee') ORDER BY "createdAt" ASC`,
      [issue.id]
    );

    let currentAssigneeName = null;
    let verdict = 'NO -- no independent status change while he was assignee';
    for (const h of hist) {
      if (h.field === 'assignee') {
        currentAssigneeName = h.newValue === 'null' ? null : h.newValue;
      } else if (h.field === 'status') {
        if (h.authorEmail === EMAIL && isSrinuName(currentAssigneeName)) {
          const simultaneousReassign = hist.some((h2) =>
            h2.field === 'assignee' &&
            h2.authorEmail === EMAIL &&
            !isSrinuName(h2.newValue) &&
            Math.abs(h2.createdAt.getTime() - h.createdAt.getTime()) <= SIMULTANEOUS_WINDOW_MS
          );
          if (!simultaneousReassign) {
            verdict = `YES -- real status change while assigned, at ${h.createdAt.toISOString()}`;
          }
        }
      }
    }

    const { rows: worked } = await pool.query(
      `SELECT wu.email, w.dept, w.reason, w.worked_at FROM user_worked_on_tickets w
       JOIN users wu ON wu.id = w.user_id WHERE w.issue_id = $1 ORDER BY w.dept, wu.email`,
      [issue.id]
    );
    const srinuRow = worked.find((w) => w.email === EMAIL);

    console.log(`\n${key}  current_dept=${issue.current_department}  verdict: ${verdict}`);
    console.log(`  Srinu's own credit row: ${srinuRow ? `dept=${srinuRow.dept} reason=${srinuRow.reason} at=${srinuRow.worked_at.toISOString()}` : 'NONE'}`);
    console.log(`  All worked-on rows: ${worked.map((w) => `${w.email}/${w.dept}/${w.reason}`).join(', ') || '(none)'}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
