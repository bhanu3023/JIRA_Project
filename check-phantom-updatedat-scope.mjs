// Read-only: scope how many tickets have a phantom updatedAt -- stored
// updatedAt sitting well after the last REAL signal of activity (the most
// recent issue_history row, or resolvedAt, or createdAt if neither exists).
// A big gap with nothing in issue_history to explain it is the same
// signature as CF-29552: the Jira sync's old unconditional updatedAt-copy
// bug (just fixed) silently bumping it with zero real change behind it.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// last_real now also considers comments (createdAt AND updatedAt, since an
// edited comment bumps its own updatedAt without a new createdAt),
// attachments, and worklog entries -- none of those show up in
// issue_history (which only tracks field changes), but all are genuine
// activity that legitimately bumps updatedAt. Without this, a ticket with
// a real recent comment but no field change would be wrongly flagged as
// "phantom."
const LAST_REAL_CTE = `
  WITH last_real_activity AS (
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i."createdAt", i."resolvedAt", i."updatedAt",
           GREATEST(
             i."createdAt",
             COALESCE(i."resolvedAt", i."createdAt"),
             COALESCE((SELECT MAX(h."createdAt") FROM issue_history h WHERE h."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(GREATEST(c."createdAt", c."updatedAt")) FROM comments c WHERE c."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(a."createdAt") FROM attachments a WHERE a."issueId" = i.id), i."createdAt"),
             COALESCE((SELECT MAX(w."createdAt") FROM issue_worklogs w WHERE w."issueId" = i.id), i."createdAt")
           ) AS last_real
    FROM issues i
  )
`;

async function main() {
  const { rows } = await pool.query(`
    ${LAST_REAL_CTE}
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE "updatedAt" > last_real + INTERVAL '1 hour') AS phantom_1h,
           COUNT(*) FILTER (WHERE "updatedAt" > last_real + INTERVAL '1 day') AS phantom_1d,
           COUNT(*) FILTER (WHERE "updatedAt" > last_real + INTERVAL '7 days') AS phantom_7d
    FROM last_real_activity
  `);
  console.log(rows[0]);

  const { rows: sample } = await pool.query(`
    ${LAST_REAL_CTE}
    SELECT key, "createdAt", "resolvedAt", last_real, "updatedAt",
           EXTRACT(EPOCH FROM ("updatedAt" - last_real)) / 86400 AS gap_days
    FROM last_real_activity
    WHERE "updatedAt" > last_real + INTERVAL '7 days'
    ORDER BY gap_days DESC
    LIMIT 15
  `);
  console.log('\nWorst examples (biggest gap between last real activity and updatedAt):');
  for (const r of sample) console.log(` - ${r.key}: last_real=${r.last_real.toISOString().slice(0,10)} updatedAt=${r.updatedAt.toISOString().slice(0,10)} gap=${Math.round(r.gap_days)}d`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
