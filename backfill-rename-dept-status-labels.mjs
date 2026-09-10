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
// matches "Waiting for X" AND whose id is a virtual "qst_"-prefixed one, to
// "Routed to X" -- id/color/category/order unchanged, exactly like the
// queue-config script. Does NOT touch the real `statuses` table or a
// ticket's live statusId column -- "Waiting for X"/"Routed to X" only ever
// exists as a per-queue virtual dept_statuses snapshot in this app (see
// isRoutingLabel in jira-pg-api.ts), never a real status row.
//
// Usage:
//   node backfill-rename-dept-status-labels.mjs             # dry run
//   node backfill-rename-dept-status-labels.mjs --apply     # writes the changes

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function renamedName(name) {
  const m = String(name || '').match(/^waiting\s+for\s+(.+)$/i);
  return m ? `Routed to ${m[1].trim()}` : null;
}

async function main() {
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
      const renamed = st && typeof st.id === 'string' && st.id.startsWith('qst_') ? renamedName(st.name) : null;
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
