// Read-only: how many currently-unresolved tickets have a past-due generic
// "Due Date" field, in a department where NO active SLA policy genuinely
// applies to their priority (either no policy at all for that department,
// or the matching priority row is explicitly 0h/"removed from tracking")?
// Those are exactly the false positives the dueDate/SLA-breach conflation
// bug (just fixed) would have wrongly shown as "SLA Breached: Yes".
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function isPriorityRemoved(policy, priority) {
  for (const goal of (policy.goals || [])) {
    if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
      const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
      if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
        return parseFloat(row.timeValue) === 0;
      }
    } else if (goal.timeValue !== undefined && goal.timeValue !== null && goal.timeValue !== '') {
      return parseFloat(goal.timeValue) === 0;
    }
  }
  return false; // no matching row at all = unconfigured, NOT "removed" -- falls to the 8h default, a real policy
}

async function main() {
  const { rows: tickets } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."spaceId", i.current_department, i.priority, i."dueDate"
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."dueDate" IS NOT NULL AND i."dueDate" < NOW()
      AND (s.category IS NULL OR s.category != 'done')
  `);
  console.log(`Unresolved tickets with a past-due "Due Date" field: ${tickets.length}`);

  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  let falsePositives = 0;
  const samples = [];
  for (const t of tickets) {
    const priority = (t.priority || 'medium').toLowerCase();
    const dept = (t.current_department || '').trim().toLowerCase();
    const policies = (policiesBySpace[t.spaceId] || []).filter((p) => {
      const pDept = (p.dept_name || '').trim().toLowerCase();
      return !pDept || pDept === dept;
    });
    const noPolicyAtAll = policies.length === 0;
    const allRemoved = policies.length > 0 && policies.every((p) => isPriorityRemoved(p, priority));
    if (noPolicyAtAll || allRemoved) {
      falsePositives++;
      if (samples.length < 15) samples.push(`${t.key} (dept=${t.current_department}, priority=${t.priority}, dueDate=${t.dueDate.toISOString().slice(0,10)})`);
    }
  }
  console.log(`Of those, tickets with NO real applicable SLA policy at all (false positives from the bug): ${falsePositives}`);
  console.log('\nSample:');
  for (const s of samples) console.log(' - ' + s);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
