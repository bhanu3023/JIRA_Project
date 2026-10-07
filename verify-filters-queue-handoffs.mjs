// Lists the tickets the Filters page's Queue view now INCLUDES because
// hand-off ('passed') worked-on records count: tickets a queue member held
// in this department and routed on (e.g. a Dev engineer works a
// Migration-raised ticket and sends it back), which the Queue view used to
// drop because every rule there ignored 'passed' rows.
//
// Scope mirrors Filters: Queue: <dept> + Created and Updated both set to
// <from>..<to> (combined as either one), IST calendar days.
//
// Read-only.
//
// Usage: node --env-file=.env verify-filters-queue-handoffs.mjs <SPACEKEY> <Dept> <YYYY-MM-DD> <YYYY-MM-DD>
// e.g.   node --env-file=.env verify-filters-queue-handoffs.mjs CF Dev 2026-09-01 2026-09-30

import pg from 'pg';

const [spaceKey, dept, from, to] = process.argv.slice(2);
if (!spaceKey || !dept || !from || !to) {
  console.error('Usage: node --env-file=.env verify-filters-queue-handoffs.mjs <SPACEKEY> <Dept> <YYYY-MM-DD> <YYYY-MM-DD>');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query('SET default_transaction_read_only = on');

  const space = (await pool.query(`SELECT id FROM spaces WHERE key = $1`, [spaceKey.toUpperCase()])).rows[0];
  if (!space) throw new Error(`No space ${spaceKey}`);

  const cq = (await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [spaceKey.toUpperCase()])).rows[0];
  const queue = (cq?.queues || []).find((q) => String(q.name || '').toLowerCase() === dept.toLowerCase());
  const memberIds = Array.isArray(queue?.memberIds) ? queue.memberIds : [];
  console.log(`Queue "${dept}" in ${spaceKey}: ${memberIds.length} configured members`);

  const fromTs = `${from}T00:00:00+05:30`;
  const toTs = `${to}T23:59:59.999+05:30`;
  const memberSql = memberIds.length ? `AND w.user_id = ANY($4::text[])` : '';
  const params = [space.id, fromTs, toTs, ...(memberIds.length ? [memberIds] : []), dept];
  const deptIdx = params.length;

  // In date range, not currently in this dept, and the ONLY evidence this
  // dept's members handled it is a 'passed' row -- i.e. newly included.
  const rows = (await pool.query(
    `SELECT COALESCE(i.cf_key, i.key) AS key, i.current_department, i."createdAt", i."updatedAt",
            string_agg(DISTINCT u."firstName" || ' ' || u."lastName", ', ') AS held_by
     FROM issues i
     JOIN user_worked_on_tickets w ON w.issue_id = i.id AND LOWER(w.dept) = LOWER($${deptIdx}) AND w.reason = 'passed' ${memberSql}
     JOIN users u ON u.id = w.user_id
     WHERE i."spaceId" = $1
       AND ((i."createdAt" >= $2 AND i."createdAt" <= $3) OR (i."updatedAt" >= $2 AND i."updatedAt" <= $3))
       AND LOWER(COALESCE(i.current_department, '')) != LOWER($${deptIdx})
       AND NOT EXISTS (
         SELECT 1 FROM user_worked_on_tickets w2
         WHERE w2.issue_id = i.id AND LOWER(w2.dept) = LOWER($${deptIdx}) AND w2.reason != 'passed'
           ${memberIds.length ? 'AND w2.user_id = ANY($4::text[])' : ''}
       )
     GROUP BY i.id
     ORDER BY i."createdAt" DESC`,
    params,
  )).rows;

  console.log(`\n${rows.length} ticket(s) now included under Queue: ${dept} that were missing before:\n`);
  console.table(rows.map((r) => ({
    key: r.key,
    nowIn: r.current_department,
    heldBy: r.held_by,
    created: r.createdAt?.toISOString().slice(0, 10),
    updated: r.updatedAt?.toISOString().slice(0, 10),
  })));
} catch (e) {
  console.error('Failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
