// Read-only: for tickets with empty dept_sla_log, the function's documented
// fallback measures elapsed from createdAt (or dept_sla_started_at if set)
// -- NOT "no SLA applies". If these tickets are simply old enough that
// createdAt + goal has already passed, the app is correctly reporting a
// real breach via that fallback, not exhibiting a bug. Check their age.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-20240', 'CF-25292', 'CF-22904', 'CF-19849', 'CF-19862']) {
    const { rows } = await pool.query(`
      SELECT COALESCE(cf_key,key) AS key, "createdAt", dept_sla_started_at, current_department, priority,
             "resolvedAt", s.category AS status_category, s.name AS status_name
      FROM issues i LEFT JOIN statuses s ON s.id = i."statusId"
      WHERE cf_key = $1 OR key = $1
    `, [key]);
    const r = rows[0];
    const ageHours = (Date.now() - new Date(r.createdAt).getTime()) / 3600000;
    console.log(`${key}: createdAt=${r.createdAt.toISOString()} (${ageHours.toFixed(0)}h ago), dept_sla_started_at=${r.dept_sla_started_at}, dept=${r.current_department}, priority=${r.priority}, status=${r.status_name} (${r.status_category}), resolvedAt=${r.resolvedAt}`);
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
