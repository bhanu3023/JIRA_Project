// Per explicit request: whichever queue created a subtask should always be
// able to resolve it, regardless of where the subtask has moved to since.
// Rather than rewriting original_dept (which is a historically-accurate
// record of what actually happened, and unsafe to guess at for a ticket
// that's moved multiple times), grants the creator's own queue resolve
// access via the existing resolve_override_depts mechanism -- the same
// escape hatch already used for CF-29995/CF-29994 and Ranadeep's Migration
// tickets earlier this session. Covers every subtask with exactly one
// unambiguous creator queue, regardless of whether it's moved on since
// (unlike check-all-subtasks-wrong-origin-dept.mjs's conservative
// still-in-that-queue-today guard).
//
// Usage: node fix-subtask-creator-resolve-override.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: subtasks } = await pool.query(
    `SELECT i.id, i.cf_key, i.key, i."spaceId", i.current_department, i.original_dept, i.resolve_override_depts, i."reporterId", sp.key AS space_key
     FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i."parentKey" IS NOT NULL`
  );

  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const queuesBySpace = {};
  for (const row of cqRows) queuesBySpace[row.space_key] = row.queues || [];

  let checked = 0, needsOverride = 0, applied = 0;
  for (const t of subtasks) {
    if (!t.reporterId) continue;
    const queues = queuesBySpace[t.space_key] || [];
    const memberQueues = queues.filter((q) => Array.isArray(q.memberIds) && q.memberIds.includes(t.reporterId) && q.name).map((q) => q.name);
    if (memberQueues.length !== 1) continue; // ambiguous -- skip
    checked++;
    const creatorDept = memberQueues[0];

    const currentOverrides = Array.isArray(t.resolve_override_depts) ? t.resolve_override_depts : [];
    const alreadyCanResolve = String(t.current_department || '').toLowerCase() === creatorDept.toLowerCase()
      || String(t.original_dept || '').toLowerCase() === creatorDept.toLowerCase()
      || currentOverrides.some((d) => String(d).toLowerCase() === creatorDept.toLowerCase());
    if (alreadyCanResolve) continue; // creator's queue can already resolve it one way or another

    needsOverride++;
    console.log(`${t.cf_key || t.key}: creator's queue "${creatorDept}" cannot currently resolve (current_department="${t.current_department}", original_dept="${t.original_dept}") -- ${APPLY ? 'adding' : 'would add'} to resolve_override_depts`);

    if (APPLY) {
      const next = [...currentOverrides, creatorDept];
      await pool.query(`UPDATE issues SET resolve_override_depts = $1::jsonb WHERE id = $2`, [JSON.stringify(next), t.id]);
      applied++;
    }
  }

  console.log(`\nChecked ${checked} subtasks with an unambiguous single-queue creator; ${needsOverride} needed an override${APPLY ? `, ${applied} applied` : ' (dry run -- re-run with --apply)'}.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
