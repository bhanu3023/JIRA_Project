// Definitive yes/no for all 16 tickets Naveed flagged: did he personally
// change status to a done-category status (Resolved/Closed) WHILE he was
// the recorded assignee at that moment -- his own stated rule ("if I was
// really the assignee and worked it, count it; if I just assigned it to
// someone else, don't"). Pulls full status+assignee history per ticket and
// applies that rule mechanically, instead of inferring from the
// dept_assignees snapshot alone (which only reflects whoever held it LAST,
// not necessarily whether Naveed also did real work earlier).
//
// Read-only.
//
// Usage: node check-naveed-16-verdict.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = [
  'CF-29908', 'CF-29907', 'CF-29906', 'CF-29901', 'CF-29897', 'CF-29860',
  'CF-29859', 'CF-29858', 'CF-29857', 'CF-29825', 'CF-29817', 'CF-29816',
  'CF-29783', 'CF-29593', 'CF-29589', 'CF-29567',
];
const DONE_STATUSES = new Set(['resolved', 'closed', 'done', 'cancelled', 'declined']);

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

    // Walk the history tracking "who is the current assignee" (by name,
    // since assignee history stores display names, not ids) and check
    // whether NAVEED himself authored a status change INTO a done status
    // while HE was the then-current assignee.
    let currentAssigneeName = null;
    let naveedResolvedItHimself = false;
    let naveedOnlyReassigned = false;
    for (const h of hist) {
      if (h.field === 'assignee') {
        currentAssigneeName = h.newValue === 'null' ? null : h.newValue;
        if (h.authorEmail === 'naved.osama@cloudfuze.com' && h.newValue !== 'Naved' && !h.newValue?.startsWith('Naved')) {
          naveedOnlyReassigned = true;
        }
      } else if (h.field === 'status') {
        const isDoneNow = DONE_STATUSES.has(String(h.newValue || '').trim().toLowerCase());
        const naveedIsCurrentAssignee = currentAssigneeName === 'Naved' || currentAssigneeName === 'Naved ';
        if (isDoneNow && h.authorEmail === 'naved.osama@cloudfuze.com' && naveedIsCurrentAssignee) {
          naveedResolvedItHimself = true;
        }
      }
    }

    const verdict = naveedResolvedItHimself
      ? 'YES -- he was the assignee and personally resolved it'
      : naveedOnlyReassigned
        ? 'NO -- he only ever assigned it to someone else, never held/resolved it himself'
        : 'NO -- no record of him resolving it while he was the assignee';
    console.log(`${key}: ${verdict}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
