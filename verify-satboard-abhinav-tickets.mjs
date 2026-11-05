// Read-only: verifies the 4 Abhinav tickets (CF-35017..CF-35020) landed
// correctly -- right space, right reporter/assignee, resolvedAt within 2h
// same date as createdAt, and a 3-entry History trail per ticket.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const { rows } = await pool.query(`
    SELECT i.key, s.key AS space_key, i.summary, i."createdAt", i."resolvedAt",
           st.name AS status_name, st.category AS status_category,
           a.email AS assignee_email, r.email AS reporter_email,
           (SELECT count(*) FROM issue_history h WHERE h."issueId" = i.id) AS hist_count
    FROM issues i
    JOIN spaces s ON s.id = i."spaceId"
    LEFT JOIN statuses st ON st.id = i."statusId"
    LEFT JOIN users a ON a.id = i."assigneeId"
    LEFT JOIN users r ON r.id = i."reporterId"
    WHERE i.key BETWEEN 'CF-35017' AND 'CF-35020'
    ORDER BY i."createdAt"
  `);
  console.log(`Found ${rows.length} tickets (expect 4)\n`);
  let problems = 0;
  for (const r of rows) {
    const created = new Date(r.createdAt);
    const resolved = new Date(r.resolvedAt);
    const sameDate = created.toISOString().slice(0,10) === resolved.toISOString().slice(0,10);
    const withinTwoHrs = (resolved - created) > 0 && (resolved - created) <= 2*3600*1000;
    const ok = r.space_key === 'SB' && r.status_name === 'Resolved' && r.status_category === 'done'
      && r.assignee_email === 'abhinav.surattu@cloudfuze.com' && r.reporter_email === 'abhinav.surattu@cloudfuze.com'
      && sameDate && withinTwoHrs && Number(r.hist_count) === 3;
    console.log(`${r.key}: ${ok ? 'OK' : 'PROBLEM'}  ${r.summary}  created=${r.createdAt.toISOString()} resolved=${r.resolvedAt.toISOString()} status=${r.status_name} assignee=${r.assignee_email} reporter=${r.reporter_email} hist=${r.hist_count}`);
    if (!ok) problems++;
  }
  console.log(problems === 0 ? '\nAll 4 tickets verified correct.' : `\n${problems} ticket(s) have a problem.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
