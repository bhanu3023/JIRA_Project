// Read-only: investigate who/what "leo" is and why so many tickets show up
// reported by them -- before anything gets deleted, need to know whether
// these are genuine duplicates from a sync bug, spam, or real tickets, and
// exactly what's creating them, how often, and from where.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Is "leo" a real app user account?
  const { rows: userRows } = await pool.query(
    `SELECT id, email, "firstName", "lastName", role, "isActive", "createdAt" FROM users WHERE "firstName" ILIKE 'leo' OR email ILIKE '%leo%'`
  );
  console.log('Real app user accounts matching "leo":', JSON.stringify(userRows, null, 2));

  // Issues whose reporter (real account OR raw synced name) is "leo"
  const { rows: issues } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.summary, i."spaceId", sp.key AS "spaceKey",
           i."createdAt", i."updatedAt", i."reporterId", i.jira_reporter_name, i."statusId", s.name AS "statusName",
           i."assigneeId", i.priority, i.type, i.jira_issue_key, i.jira_project_key
    FROM issues i
    LEFT JOIN spaces sp ON sp.id = i."spaceId"
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i.jira_reporter_name ILIKE 'leo%'
       OR i.id IN (SELECT i2.id FROM issues i2 JOIN users u ON u.id = i2."reporterId" WHERE u."firstName" ILIKE 'leo')
    ORDER BY i."createdAt" DESC
  `);
  console.log(`\nTotal issues reported by "leo": ${issues.length}`);

  const byDate = new Map();
  for (const r of issues) {
    const d = r.createdAt.toISOString().slice(0, 10);
    byDate.set(d, (byDate.get(d) || 0) + 1);
  }
  console.log('\nCreated-date breakdown:');
  for (const [d, c] of [...byDate.entries()].sort()) console.log(`  ${d}: ${c}`);

  const bySpace = new Map();
  for (const r of issues) bySpace.set(r.spaceKey, (bySpace.get(r.spaceKey) || 0) + 1);
  console.log('\nBy space:', Object.fromEntries(bySpace));

  console.log('\nFirst 15 sample rows:');
  for (const r of issues.slice(0, 15)) {
    console.log(` - ${r.key} [${r.spaceKey}] "${r.summary}" status=${r.statusName} created=${r.createdAt.toISOString()} jira_issue_key=${r.jira_issue_key} jira_project_key=${r.jira_project_key}`);
  }

  // Duplicate-summary check: are these re-imports of tickets that already exist under a different reporter?
  const summaryCounts = new Map();
  for (const r of issues) summaryCounts.set(r.summary, (summaryCounts.get(r.summary) || 0) + 1);
  const dupedSummaries = [...summaryCounts.entries()].filter(([, c]) => c > 1);
  console.log(`\nSummaries that repeat among leo's own tickets: ${dupedSummaries.length}`);
  for (const [s, c] of dupedSummaries.slice(0, 10)) console.log(`  (${c}x) "${s}"`);

  if (issues.length) {
    const sampleSummary = issues[0].summary;
    const { rows: others } = await pool.query(
      `SELECT COALESCE(cf_key,key) AS key, jira_reporter_name, "reporterId", "createdAt" FROM issues WHERE summary = $1`,
      [sampleSummary]
    );
    console.log(`\nAll tickets with summary "${sampleSummary}":`, JSON.stringify(others, null, 2));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
