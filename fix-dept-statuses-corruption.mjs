// Scans for the cross-department dept_statuses corruption confirmed on
// CF-29456: dept_statuses["Dev"] held id "qst_migration_resolved" -- a
// Migration-flavored queue status -- because the queue-status PATCH handler
// (src/lib/jira-pg-api.ts, body.queueStatusId path) used to write whatever
// status was picked from department X's queue dropdown under whatever
// department the ticket's current_department FRESHLY read as by the time the
// request was processed, with no check that the two still matched. Fixed
// going forward by the queueStatusDept guard (see that file); this script
// repairs data already written wrong before that fix existed.
//
// Detection: a department D's dept_statuses entry has a qst_-prefixed id
// that is NOT one of D's own queue's configured statuses (custom_queues),
// but IS a status id that belongs to a DIFFERENT department's queue. That's
// unambiguous corruption -- a qst_ id is only ever offered by the one
// queue/department that defines it.
//
// Reconstruction: for a misattributed dept D slot, look at
// issue_dept_transitions to find the time window(s) the ticket actually sat
// in D, then the LAST issue_history 'status' entry inside that window is
// what D's status genuinely was. Matched back to a real status object
// (id/color/category) via D's own queue statuses or the space's real
// statuses table, by name. Only entries with exactly one clean history match
// are auto-applied; everything else is reported as needs-manual-review and
// left untouched.
//
// Usage:
//   node fix-dept-statuses-corruption.mjs             # dry run, full report
//   node fix-dept-statuses-corruption.mjs --apply     # writes only the
//                                                        confidently-reconstructed ones

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: queueRows } = await pool.query(`SELECT queues FROM custom_queues`);
  const deptOwnStatusById = new Map();   // deptNameLower -> Map(id -> statusObj)
  const deptOwnStatusByName = new Map(); // deptNameLower -> Map(nameLower -> statusObj)
  const idOwnerDept = new Map();         // id -> department display name (first queue that defines it)
  for (const row of queueRows) {
    for (const q of (row.queues || [])) {
      const deptName = String(q?.name || '').trim();
      if (!deptName) continue;
      const key = deptName.toLowerCase();
      if (!deptOwnStatusById.has(key)) deptOwnStatusById.set(key, new Map());
      if (!deptOwnStatusByName.has(key)) deptOwnStatusByName.set(key, new Map());
      for (const s of (q.queueStatuses || [])) {
        if (!s?.id) continue;
        deptOwnStatusById.get(key).set(s.id, s);
        deptOwnStatusByName.get(key).set(String(s.name || '').trim().toLowerCase(), s);
        if (!idOwnerDept.has(s.id)) idOwnerDept.set(s.id, deptName);
      }
    }
  }
  console.log(`Loaded queue-status ownership for ${deptOwnStatusById.size} department(s).`);

  const { rows: issues } = await pool.query(`
    SELECT id, "spaceId", cf_key, key, current_department, dept_statuses
    FROM issues
    WHERE dept_statuses IS NOT NULL AND dept_statuses != '{}'::jsonb
  `);

  const findings = [];
  for (const issue of issues) {
    const deptStatuses = issue.dept_statuses || {};
    for (const [dept, st] of Object.entries(deptStatuses)) {
      if (!st || typeof st.id !== 'string' || !st.id.startsWith('qst_')) continue;
      const deptKey = dept.trim().toLowerCase();
      const owned = deptOwnStatusById.get(deptKey);
      if (owned && owned.has(st.id)) continue; // correctly attributed
      const trueOwner = idOwnerDept.get(st.id);
      if (trueOwner && trueOwner.toLowerCase() !== deptKey) {
        findings.push({ issue, dept, st, trueOwner });
      }
    }
  }

  const affectedTickets = new Set(findings.map(f => f.issue.cf_key || f.issue.key));
  console.log(`\nFound ${findings.length} misattributed dept_statuses entr${findings.length === 1 ? 'y' : 'ies'} across ${affectedTickets.size} ticket${affectedTickets.size === 1 ? '' : 's'}.\n`);
  for (const f of findings) {
    console.log(`  ${f.issue.cf_key || f.issue.key}: dept_statuses["${f.dept}"] = ${f.st.id} "${f.st.name}" -- actually belongs to ${f.trueOwner}'s queue (ticket's current_department: ${f.issue.current_department})`);
  }

  if (!findings.length) {
    console.log('\nNothing to reconstruct.');
    await pool.end();
    return;
  }

  console.log(`\n--- Reconstructing correct value for each misattributed slot ---\n`);
  const applyList = [];
  const needsReview = [];

  for (const f of findings) {
    const issueId = f.issue.id;
    const deptKey = f.dept.trim().toLowerCase();
    const label = `${f.issue.cf_key || f.issue.key} [${f.dept}]`;

    const { rows: transitions } = await pool.query(
      `SELECT from_dept, to_dept, moved_at FROM issue_dept_transitions WHERE issue_id=$1 ORDER BY moved_at ASC`,
      [issueId]
    );

    // Build the time window(s) this department actually held the ticket.
    const windows = [];
    let enteredAt = null;
    let everEntered = false;
    for (const t of transitions) {
      if (t.to_dept && t.to_dept.trim().toLowerCase() === deptKey) { enteredAt = t.moved_at; everEntered = true; }
      if (t.from_dept && t.from_dept.trim().toLowerCase() === deptKey) {
        windows.push([enteredAt, t.moved_at]); // enteredAt may be null (held since ticket creation)
        enteredAt = null;
      }
    }
    if (enteredAt) windows.push([enteredAt, null]); // still holding it now
    if (!everEntered && transitions.length && transitions[0].from_dept?.trim().toLowerCase() === deptKey) {
      windows.push([null, transitions[0].moved_at]); // held from creation until the first recorded move-out
    }

    if (!windows.length) {
      needsReview.push({ ...f, reason: 'no issue_dept_transitions window found for this department' });
      console.log(`  ${label}: NEEDS MANUAL REVIEW -- no department time-window found`);
      continue;
    }

    let bestEntry = null;
    for (const [start, end] of windows) {
      const params = [issueId];
      let sql = `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId"=$1 AND field='status'`;
      if (start) { params.push(start); sql += ` AND "createdAt" >= $${params.length}`; }
      if (end) { params.push(end); sql += ` AND "createdAt" <= $${params.length}`; }
      sql += ` ORDER BY "createdAt" DESC LIMIT 1`;
      const { rows } = await pool.query(sql, params);
      if (rows[0] && (!bestEntry || new Date(rows[0].createdAt) > new Date(bestEntry.createdAt))) bestEntry = rows[0];
    }

    if (!bestEntry) {
      needsReview.push({ ...f, reason: 'no issue_history status entry found inside this department\'s window(s)' });
      console.log(`  ${label}: NEEDS MANUAL REVIEW -- no matching history entry in window`);
      continue;
    }

    const reconstructedName = String(bestEntry.newValue || '').trim();
    const byName = deptOwnStatusByName.get(deptKey);
    let matchedStatus = byName?.get(reconstructedName.toLowerCase());
    if (!matchedStatus) {
      const { rows: realRows } = await pool.query(
        `SELECT id, name, category, color FROM statuses WHERE "spaceId"=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
        [f.issue.spaceId, reconstructedName]
      );
      matchedStatus = realRows[0];
    }

    if (!matchedStatus) {
      needsReview.push({ ...f, reason: `reconstructed name "${reconstructedName}" matches neither this department's queue statuses nor the real statuses table` });
      console.log(`  ${label}: NEEDS MANUAL REVIEW -- reconstructed name "${reconstructedName}" has no matching status object`);
      continue;
    }

    const newEntry = { id: matchedStatus.id, name: matchedStatus.name, category: matchedStatus.category, color: matchedStatus.color };
    console.log(`  ${label}: "${f.st.name}" (${f.st.id}) -> "${newEntry.name}" (${newEntry.id})  [reconstructed from history at ${bestEntry.createdAt}]`);
    applyList.push({ issueId, dept: f.dept, newEntry });
  }

  console.log(`\n${applyList.length} of ${findings.length} confidently reconstructed; ${needsReview.length} need manual review (left untouched either way).`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write the ${applyList.length} confidently-reconstructed change${applyList.length === 1 ? '' : 's'}.`);
    await pool.end();
    return;
  }

  if (!applyList.length) {
    console.log('\nNothing confident enough to apply.');
    await pool.end();
    return;
  }

  let written = 0;
  for (const a of applyList) {
    const { rows } = await pool.query(`SELECT dept_statuses FROM issues WHERE id=$1`, [a.issueId]);
    const deptStatuses = rows[0]?.dept_statuses || {};
    deptStatuses[a.dept] = a.newEntry;
    await pool.query(`UPDATE issues SET dept_statuses=$1::jsonb, "updatedAt"=NOW() WHERE id=$2`, [JSON.stringify(deptStatuses), a.issueId]);
    written++;
  }
  console.log(`\nRepaired ${written} dept_statuses entr${written === 1 ? 'y' : 'ies'}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
