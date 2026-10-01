// Corrected version of check-naveed-16-verdict.mjs: the first version only
// counted a DONE-category status change (Resolved/Closed) as "real work",
// which missed CF-29908 -- Naveed changed status Open -> In Progress as a
// separate action, 112 seconds BEFORE a later, separate reassignment to
// Lakshmi Adabala. Per the app's own actual crediting rule (PATCH handler:
// `statusChangedNow && !reassigningToSomeoneElse`), that counts as real
// 'worked' credit regardless of which status it changed to -- the
// disqualifying case is only a status change happening in the SAME request
// as a reassignment away from himself (checked here as an assignee-change
// row within 5 seconds of the status-change row, same as how close two
// history rows from one PATCH call land in practice).
//
// Read-only.
//
// Usage: node check-naveed-16-verdict-v2.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = [
  'CF-29908', 'CF-29907', 'CF-29906', 'CF-29901', 'CF-29897', 'CF-29860',
  'CF-29859', 'CF-29858', 'CF-29857', 'CF-29825', 'CF-29817', 'CF-29816',
  'CF-29783', 'CF-29593', 'CF-29589', 'CF-29567',
];
const SIMULTANEOUS_WINDOW_MS = 5000;
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

    let currentAssigneeName = null;
    let realWorkFound = false;
    let realWorkAt = null;

    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      if (h.field === 'assignee') {
        currentAssigneeName = h.newValue === 'null' ? null : h.newValue;
      } else if (h.field === 'status') {
        const naveedIsCurrentAssignee = isNaveedName(currentAssigneeName);
        if (h.authorEmail === 'naved.osama@cloudfuze.com' && naveedIsCurrentAssignee) {
          // Was this status change part of the SAME request as a
          // reassignment away from him? Look for an assignee-change row
          // authored by him, reassigning to someone else, within the
          // simultaneous window either side of this status change.
          const simultaneousReassign = hist.some((h2) =>
            h2.field === 'assignee' &&
            h2.authorEmail === 'naved.osama@cloudfuze.com' &&
            !isNaveedName(h2.newValue) &&
            Math.abs(h2.createdAt.getTime() - h.createdAt.getTime()) <= SIMULTANEOUS_WINDOW_MS
          );
          if (!simultaneousReassign) {
            realWorkFound = true;
            realWorkAt = h.createdAt.toISOString();
          }
        }
      }
    }

    console.log(`${key}: ${realWorkFound ? `YES -- real status change while assigned, at ${realWorkAt}, not a simultaneous handoff` : 'NO -- no independent status change while he was assignee'}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
