// CF-30865 and CF-33222 both show "Start" happening AFTER "Due" on the
// Migration SLA panel -- logically impossible for a real SLA window
// (due = start + duration, so due must always be >= start). Pulling
// raw dept_sla_started_at/dept_sla_log/sla_snapshot/resolvedAt/
// sla_waivers to see what's actually feeding the display. Read-only.
//
// Usage: node check-sla-start-after-due.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  for (const key of ['CF-30865', 'CF-33222']) {
    const { rows } = await pool.query(`
      SELECT id, key, cf_key, current_department, dept_sla_started_at, dept_sla_log,
        sla_snapshot, sla_waivers, "resolvedAt", "dueDate", "statusId"
      FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1
    `, [key]);
    if (!rows.length) { console.log(`${key}: not found`); continue; }
    const r = rows[0];
    console.log(`\n=== ${key} (id=${r.id}) ===`);
    console.log('current_department:', r.current_department);
    console.log('dept_sla_started_at:', r.dept_sla_started_at);
    console.log('dept_sla_log:', JSON.stringify(r.dept_sla_log, null, 2));
    console.log('sla_snapshot:', JSON.stringify(r.sla_snapshot, null, 2));
    console.log('sla_waivers:', JSON.stringify(r.sla_waivers, null, 2));
    console.log('resolvedAt:', r.resolvedAt);
    console.log('dueDate (global field):', r.dueDate);

    // Status-change history specifically for SLA-relevant events
    const { rows: hist } = await pool.query(`
      SELECT field, "oldValue", "newValue", "authorName", "createdAt"
      FROM issue_history
      WHERE "issueId" = $1 AND (field = 'sla' OR field = 'status' OR field = 'department')
      ORDER BY "createdAt" ASC
    `, [r.id]);
    console.log('\nSLA/status/department history:');
    for (const h of hist) {
      console.log(`  [${h.createdAt?.toISOString?.()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" by ${h.authorName}`);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
