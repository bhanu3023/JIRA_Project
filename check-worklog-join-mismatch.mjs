// Read-only: raw issue_worklogs has 539 rows in the Oct5-Nov3 range, but the
// UI (which runs the real report query, INNER JOINed to issues and spaces)
// shows 538 entries and 782h29m -- 19 minutes less than the raw table's
// 782.8h. Find the specific row(s) the JOIN drops.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const from = new Date('2026-10-05');
  const to = new Date('2026-11-03');

  const { rows: joined } = await pool.query(`
    SELECT wl.id, wl."timeSpentMinutes"
    FROM issue_worklogs wl
    JOIN issues iss ON iss.id = wl."issueId"
    JOIN spaces sp ON sp.id = iss."spaceId"
    WHERE wl."workDate" >= $1 AND wl."workDate" <= $2
  `, [from, to]);
  console.log(`Joined (real report) query: ${joined.length} entries, ${(joined.reduce((s,r)=>s+r.timeSpentMinutes,0)/60).toFixed(2)}h`);

  const { rows: raw } = await pool.query(`
    SELECT id, "timeSpentMinutes", "issueId" FROM issue_worklogs
    WHERE "workDate" >= $1 AND "workDate" <= $2
  `, [from, to]);
  console.log(`Raw table: ${raw.length} entries, ${(raw.reduce((s,r)=>s+r.timeSpentMinutes,0)/60).toFixed(2)}h`);

  const joinedIds = new Set(joined.map((r) => r.id));
  const missing = raw.filter((r) => !joinedIds.has(r.id));
  console.log(`\nEntries dropped by the issues/spaces JOIN: ${missing.length}`);
  for (const m of missing) {
    const { rows: issueCheck } = await pool.query(`SELECT id, key, "spaceId" FROM issues WHERE id = $1`, [m.issueId]);
    console.log(` - worklog ${m.id}: timeSpentMinutes=${m.timeSpentMinutes}, issueId=${m.issueId}, issue exists=${issueCheck.length > 0}`, issueCheck[0] || '');
    if (issueCheck.length) {
      const { rows: spaceCheck } = await pool.query(`SELECT id, key FROM spaces WHERE id = $1`, [issueCheck[0].spaceId]);
      console.log(`   -> space ${issueCheck[0].spaceId} exists=${spaceCheck.length > 0}`, spaceCheck[0] || '');
    }
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
