// Investigates CF-30033 before making any changes: user says it was
// resolved in July but resolvedAt/updatedAt look wrong, and separately
// that QA doesn't seem to have a working "Resolved" status option.
// Read-only -- pulls the real current state and full history first.
//
// Usage: node check-cf30033.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.current_department, i.dept_statuses,
            i."createdAt", i."updatedAt", i."resolvedAt", i."statusId", s.name AS status_name, s.category AS status_category,
            i."spaceId"
     FROM issues i LEFT JOIN statuses s ON i."statusId" = s.id
     WHERE i.cf_key = 'CF-30033' OR i.key = 'CF-30033'`
  );
  if (!rows.length) { console.log('CF-30033 not found'); await pool.end(); return; }
  const issue = rows[0];
  console.log(`${issue.key}`);
  console.log(`  current_department=${issue.current_department}`);
  console.log(`  live status=${issue.status_name} (${issue.status_category})`);
  console.log(`  dept_statuses=${JSON.stringify(issue.dept_statuses)}`);
  console.log(`  createdAt=${issue.createdAt.toISOString()}`);
  console.log(`  updatedAt=${issue.updatedAt.toISOString()}`);
  console.log(`  resolvedAt=${issue.resolvedAt ? issue.resolvedAt.toISOString() : 'NULL'}`);

  console.log('\n=== Status/assignee/department history ===');
  const { rows: hist } = await pool.query(
    `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
     FROM issue_history WHERE "issueId" = $1 AND field IN ('status','assignee','department') ORDER BY "createdAt" ASC`,
    [issue.id]
  );
  for (const h of hist) console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName})`);

  console.log('\n=== QA queue status list (does it have a real Resolved/done-category status?) ===');
  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues`);
  for (const row of cq) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (String(q?.name || '').toLowerCase() === 'qa') {
        console.log(`  QA queue statuses: ${JSON.stringify((q.queueStatuses || []).map(s => ({ name: s.name, category: s.category })))}`);
      }
    }
  }

  console.log('\n=== Space-wide status list (fallback set) ===');
  const { rows: spaceStatuses } = await pool.query(`SELECT id, name, category FROM statuses WHERE "spaceId" = $1 ORDER BY "order"`, [issue.spaceId]);
  for (const s of spaceStatuses) console.log(`  ${s.name} (${s.category})`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
