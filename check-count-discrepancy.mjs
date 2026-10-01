// Checks the priority breakdown of tickets matching Queue:Dev + Assignee-
// history:srinu gudimitla + Created/Updated Aug 2026, to see whether a
// Priority filter difference (the one visible difference between two
// screenshots showing 57 vs 58) is what actually explains the count gap,
// rather than a real backend bug.
//
// Read-only.
//
// Usage: node check-count-discrepancy.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = 'srinu.gudimitla@cloudfuze.com'`);
  const userId = userRows[0]?.id;
  if (!userId) { console.log('User not found'); await pool.end(); return; }

  // Tickets belonging to Dev (current OR origin), assigned to or worked by
  // srinu (current OR historical), created or updated in Aug 2026.
  const { rows: direct } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i.priority, i."assigneeId", i.current_department
    FROM issues i
    WHERE (
      LOWER(i.current_department) = 'dev'
      OR LOWER(COALESCE(
           i.original_dept,
           (SELECT h."oldValue" FROM issue_history h WHERE h."issueId" = i.id AND h.field = 'department' ORDER BY h."createdAt" ASC LIMIT 1),
           i.current_department
         )) = 'dev'
    )
      AND (
        (i."createdAt"::date >= '2026-08-01' AND i."createdAt"::date <= '2026-08-31')
        OR (i."updatedAt"::date >= '2026-08-01' AND i."updatedAt"::date <= '2026-08-31')
      )
      AND (i."assigneeId" = $1 OR EXISTS (
        SELECT 1 FROM user_worked_on_tickets w WHERE w.issue_id = i.id AND w.user_id = $1 AND w.reason != 'passed'
      ))
    ORDER BY i.priority NULLS FIRST
  `, [userId]);

  console.log(`Total matching (Queue:Dev, srinu current-or-worked, Created/Updated Aug 2026): ${direct.length}\n`);

  const byPriority = {};
  for (const r of direct) {
    const p = r.priority || '(none/null)';
    (byPriority[p] ??= []).push(r.key);
  }
  console.log('Breakdown by priority:');
  for (const [p, keys] of Object.entries(byPriority)) {
    console.log(`  ${p}: ${keys.length}  (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''})`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
