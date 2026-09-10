// One-time backfill, companion to scripts/rename-queue-statuses.mjs.
//
// That script renamed "Waiting for X" -> "Routed to X" in a QUEUE's config
// (custom_queues.queues[].queueStatuses) -- the dropdown options offered
// going forward. It does NOT touch dept_statuses, the per-ticket JSONB
// snapshot that gets a COPY of the picked status name at the moment someone
// selects it. A ticket routed before the config rename still carries the
// old "Waiting for X" text in its own dept_statuses snapshot forever, since
// that's a frozen copy, not a live reference back to the queue config.
// Confirmed for real: CF-29611, CF-29358, CF-29347 still show "Waiting for
// Migration"/"Waiting for Infra" despite the queue config already saying
// "Routed to X".
//
// Renames every dept_statuses["<dept>"] entry across ALL issues whose name
// matches "Waiting for X", to "Routed to X" -- id/color/category/order
// unchanged, exactly like the queue-config script. Does NOT touch the real
// `statuses` table or a ticket's live statusId column.
//
// Originally gated on the entry's id starting with "qst_" (the virtual
// queue-status id prefix), on the assumption that's the only way a
// dept_statuses entry gets this name. Confirmed wrong for real: CF-29358's
// own Migration entry has id "status_open" (a REAL statuses-table id) but
// name "Open" -- proving dept_statuses entries for the SAME kind of routing
// event can carry either a virtual qst_ id or a real one depending on how
// the transition happened, and the id-gated version silently skipped every
// non-qst_ case. A live count of "waiting for%" names across all tickets'
// dept_statuses came back far higher than the 3 tickets the id-gated
// version found, confirming real scope was being missed.
//
// Matching on name alone instead -- but that alone risks renaming an
// unrelated, legitimate status that merely starts with "Waiting for" (e.g.
// "Waiting for Customer Response") into nonsense ("Routed to Customer
// Response"). Guard against that by only renaming when the captured suffix
// matches an ACTUAL configured department/queue name, pulled live from
// custom_queues -- "Waiting for Dev"/"Waiting for Migration"/etc. are real
// department-routing labels, "Waiting for Customer Response" is not a
// queue name and is correctly left alone.
//
// Usage:
//   node backfill-rename-dept-status-labels.mjs             # dry run
//   node backfill-rename-dept-status-labels.mjs --apply     # writes the changes

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: queueRows } = await pool.query(`SELECT queues FROM custom_queues`);
  const knownDeptNames = new Set();
  for (const row of queueRows) {
    for (const q of (row.queues || [])) {
      const name = String(q?.name || '').trim().toLowerCase();
      if (name) knownDeptNames.add(name);
    }
  }
  console.log(`Known department/queue names: ${Array.from(knownDeptNames).join(', ')}`);

  function renamedName(name) {
    const m = String(name || '').match(/^waiting\s+for\s+(.+)$/i);
    if (!m) return null;
    const suffix = m[1].trim();
    if (!knownDeptNames.has(suffix.toLowerCase())) return null; // not a real dept name -- leave it alone
    return `Routed to ${suffix}`;
  }

  const { rows } = await pool.query(`
    SELECT id, cf_key, key, dept_statuses, "statusId"
    FROM issues
    WHERE dept_statuses IS NOT NULL AND dept_statuses != '{}'::jsonb
  `);
  console.log(`Scanning ${rows.length} tickets with a dept_statuses snapshot...`);

  const toUpdate = [];
  for (const row of rows) {
    const deptStatuses = row.dept_statuses || {};
    let changed = false;
    const newDeptStatuses = {};
    for (const [dept, st] of Object.entries(deptStatuses)) {
      const renamed = st ? renamedName(st.name) : null;
      if (renamed && renamed !== st.name) {
        changed = true;
        newDeptStatuses[dept] = { ...st, name: renamed };
      } else {
        newDeptStatuses[dept] = st;
      }
    }
    if (changed) {
      toUpdate.push({ id: row.id, key: row.cf_key || row.key, oldDeptStatuses: deptStatuses, newDeptStatuses });
    }
  }

  console.log(`\nWould rename dept_statuses entries on ${toUpdate.length} ticket${toUpdate.length === 1 ? '' : 's'}.`);
  for (const u of toUpdate.slice(0, 20)) {
    for (const [dept, st] of Object.entries(u.newDeptStatuses)) {
      const old = u.oldDeptStatuses[dept];
      if (old?.name !== st.name) console.log(`  ${u.key}: [${dept}] "${old.name}" -> "${st.name}"`);
    }
  }
  if (toUpdate.length > 20) console.log(`  ... and ${toUpdate.length - 20} more.`);

  if (!APPLY) {
    console.log(`\nDry run only -- no changes made. Re-run with --apply to write these ${toUpdate.length} change${toUpdate.length === 1 ? '' : 's'}.`);
    await pool.end();
    return;
  }

  if (!toUpdate.length) {
    console.log('\nNothing to apply.');
    await pool.end();
    return;
  }

  let written = 0;
  for (const u of toUpdate) {
    await pool.query(`UPDATE issues SET dept_statuses = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`, [JSON.stringify(u.newDeptStatuses), u.id]);
    written++;
  }
  console.log(`\nUpdated dept_statuses on ${written} ticket${written === 1 ? '' : 's'}.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
