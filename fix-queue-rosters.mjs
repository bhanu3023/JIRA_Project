// Two fixes, applied together per queue:
//   1. Add every REAL (confirmed via users table) current assignee of a
//      ticket in a queue's department who is NOT already in that queue's
//      memberIds -- these are genuinely doing work in that department
//      right now, and their absence from the roster silently excludes
//      their tickets from the Filters "Queue: X" count.
//   2. Remove any memberIds entry that doesn't resolve to a real users
//      row (stale/orphaned, same class of bug already fixed for
//      Migration).
// Dry-run by default; pass --apply to write.
//
// Usage: node fix-queue-rosters.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: cqRows } = await pool.query(`SELECT space_key, queues FROM custom_queues`);

  for (const cq of cqRows) {
    const queues = cq.queues || [];
    let changedAny = false;

    for (const q of queues) {
      if (!q.name) continue;
      const memberIds = q.memberIds || [];

      const { rows: existing } = memberIds.length
        ? await pool.query(`SELECT id FROM users WHERE id = ANY($1::text[])`, [memberIds])
        : { rows: [] };
      const existingSet = new Set(existing.map(r => r.id));
      const orphaned = memberIds.filter((id) => !existingSet.has(id));

      const { rows: missingAssignees } = await pool.query(`
        SELECT DISTINCT i."assigneeId" AS id
        FROM issues i
        JOIN spaces sp ON sp.id = i."spaceId"
        WHERE sp.key = $1 AND LOWER(i.current_department) = LOWER($2)
          AND i."assigneeId" IS NOT NULL
          AND NOT (i."assigneeId" = ANY($3::text[]))
      `, [cq.space_key, q.name, memberIds.length ? memberIds : ['__none__']]);

      if (!orphaned.length && !missingAssignees.length) continue;

      const next = memberIds.filter((id) => !orphaned.includes(id));
      for (const m of missingAssignees) next.push(m.id);

      console.log(`[${cq.space_key}] ${q.name}: ${memberIds.length} -> ${next.length} (removing ${orphaned.length} orphaned, adding ${missingAssignees.length} missing real assignees)`);
      q.memberIds = next;
      changedAny = true;
    }

    if (changedAny && APPLY) {
      await pool.query(`UPDATE custom_queues SET queues = $1 WHERE space_key = $2`, [JSON.stringify(queues), cq.space_key]);
      console.log(`  -> applied for space ${cq.space_key}`);
    }
  }

  if (!APPLY) console.log('\nDry run only -- re-run with --apply to write these changes.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
