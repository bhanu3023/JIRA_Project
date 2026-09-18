// Looks up L3B-782 and L2B-15838 by their internal key to find their
// CF- display key and basic info.
//
// Read-only.
//
// Usage: node check-two-tickets-lookup.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['L3B-782', 'L2B-15838'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT key, cf_key, summary, current_department, "assigneeId", au.email AS assignee_email,
              s.name AS status_name, i."createdAt", i."updatedAt", i."resolvedAt"
       FROM issues i
       LEFT JOIN users au ON au.id = i."assigneeId"
       LEFT JOIN statuses s ON i."statusId" = s.id
       WHERE i.key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    console.log(`${key}  ->  CF key: ${r.cf_key || '(none)'}  |  summary: ${r.summary}`);
    console.log(`  department=${r.current_department}  status=${r.status_name}  assignee=${r.assignee_email}`);
    console.log(`  createdAt=${r.createdAt?.toISOString()}  updatedAt=${r.updatedAt?.toISOString()}  resolvedAt=${r.resolvedAt?.toISOString() || 'NULL'}`);
    console.log(`  Open in tool: https://neutaraticketing.cftools.live/issues/${r.cf_key || r.key}\n`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
