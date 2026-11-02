// Read-only: dump the configured "medium" priority SLA goal for every
// active department policy, straight from the real settings data.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function getGoalInfo(policy, priority) {
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        return { timeValue: row.timeValue, timeUnit: row.timeUnit || 'hours', removed: parseFloat(row.timeValue) === 0 };
      }
    } else if (goal.timeValue !== undefined && goal.timeValue !== null && goal.timeValue !== '') {
      return { timeValue: goal.timeValue, timeUnit: goal.timeUnit || 'hours', removed: parseFloat(goal.timeValue) === 0 };
    }
  }
  return { timeValue: null, timeUnit: null, removed: false, note: 'no matching row -- falls back to 8h default' };
}

async function main() {
  const { rows: policies } = await pool.query(`
    SELECT name, dept_name, goals, status FROM sla_definitions
    WHERE status = 'active' ORDER BY dept_name
  `);
  console.log('Medium priority SLA goal, per active department policy:\n');
  for (const p of policies) {
    const info = getGoalInfo(p, 'medium');
    const desc = info.removed
      ? 'REMOVED from tracking (0h)'
      : info.timeValue !== null
      ? `${info.timeValue} ${info.timeUnit}`
      : info.note;
    console.log(`${p.dept_name || '(space-wide)'} -- "${p.name}": ${desc}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
