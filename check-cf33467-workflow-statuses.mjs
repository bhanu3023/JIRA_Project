// User reports the "Move to status" dropdown on CF-33467 still shows a
// duplicate "In Progress" entry even after deploying a dedup-by-name fix.
// Checking the RAW workflow/status/transition data behind this ticket
// directly (its space's statuses table + workflow transitions from its
// current status) instead of guessing further at the frontend.
//
// Read-only.
//
// Usage: node check-cf33467-workflow-statuses.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."spaceId", i."statusId", i.dept_statuses, i.current_department,
            s.name AS status_name, sp.key AS space_key
     FROM issues i LEFT JOIN statuses s ON s.id = i."statusId" LEFT JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i.cf_key = 'CF-33467' OR i.key = 'CF-33467'`
  );
  const r = rows[0];
  if (!r) { console.log('NOT FOUND'); await pool.end(); return; }
  console.log(`space: ${r.space_key}   current_department: ${r.current_department}`);
  console.log(`real statusId: ${r.statusId}   status name: ${r.status_name}`);
  console.log(`dept_statuses: ${JSON.stringify(r.dept_statuses)}`);

  console.log('\nAll statuses in this space:');
  const { rows: statuses } = await pool.query(
    `SELECT id, name, category, "order" FROM statuses WHERE "spaceId" = $1 ORDER BY "order"`,
    [r.spaceId]
  );
  for (const s of statuses) console.log(`  id=${s.id}  name="${s.name}"  category=${s.category}  order=${s.order}`);

  console.log('\nAll workflow transitions in this space:');
  const { rows: transitions } = await pool.query(
    `SELECT id, "fromStatusId", "toStatusId", name FROM "WorkflowTransition" WHERE "spaceId" = $1`,
    [r.spaceId]
  ).catch(async () => {
    // Table name might be snake_case if not using Prisma's default mapping
    return pool.query(`SELECT id, "fromStatusId", "toStatusId", name FROM workflow_transitions WHERE "spaceId" = $1`, [r.spaceId]);
  });
  for (const t of transitions) console.log(`  ${t.id}: from=${t.fromStatusId} to=${t.toStatusId} name="${t.name}"`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
