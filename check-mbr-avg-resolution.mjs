// Checks, for a given person (by email), the exact numbers behind MBR's
// "Avg. resolution (hrs)" column: total tickets, resolved (done-category)
// tickets, how many of THOSE actually have a resolvedAt, and the resulting
// average -- to see whether the average is being computed over a smaller
// denominator than the person's real resolved-ticket count (which would
// explain it looking "wrong" compared to a manual total-time / total-tickets
// calculation).
//
// Read-only.
//
// Usage: node check-mbr-avg-resolution.mjs <email>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = process.argv[2];

if (!EMAIL) {
  console.error('Usage: node check-mbr-avg-resolution.mjs <email>');
  process.exit(1);
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, "firstName", "lastName" FROM users WHERE email = $1`, [EMAIL]);
  if (!userRows.length) { console.log('User not found.'); await pool.end(); return; }
  const { id: userId, firstName, lastName } = userRows[0];
  console.log(`${firstName} ${lastName} <${EMAIL}> (${userId})\n`);

  const { rows: totals } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE s.category = 'done') AS resolved_count,
      COUNT(*) FILTER (WHERE s.category = 'done' AND i."resolvedAt" IS NOT NULL) AS resolved_with_resolvedat,
      COUNT(*) FILTER (WHERE s.category = 'done' AND i."resolvedAt" IS NULL) AS resolved_missing_resolvedat,
      ROUND(AVG(EXTRACT(EPOCH FROM (i."resolvedAt" - i."createdAt")) / 3600) FILTER (WHERE i."resolvedAt" IS NOT NULL), 2) AS avg_hours_current_formula,
      ROUND(SUM(EXTRACT(EPOCH FROM (i."resolvedAt" - i."createdAt")) / 3600) FILTER (WHERE i."resolvedAt" IS NOT NULL), 2) AS sum_hours
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."assigneeId" = $1
  `, [userId]);
  const t = totals[0];

  console.log(`Total tickets assigned:                  ${t.total}`);
  console.log(`Resolved (done-category):                ${t.resolved_count}`);
  console.log(`  ...of those, WITH a resolvedAt:         ${t.resolved_with_resolvedat}`);
  console.log(`  ...of those, MISSING resolvedAt:        ${t.resolved_missing_resolvedat}`);
  console.log();
  console.log(`Current MBR formula: AVG(resolvedAt - createdAt) over tickets WITH resolvedAt only`);
  console.log(`  = ${t.sum_hours} total hours / ${t.resolved_with_resolvedat} tickets = ${t.avg_hours_current_formula} hrs/ticket`);
  console.log();
  if (Number(t.resolved_missing_resolvedat) > 0) {
    const naiveIfCountedAsZero = (Number(t.sum_hours) / Number(t.resolved_count)).toFixed(2);
    console.log(`If you instead divided by ALL ${t.resolved_count} resolved tickets (treating the ${t.resolved_missing_resolvedat} missing ones as 0 extra hours):`);
    console.log(`  = ${t.sum_hours} / ${t.resolved_count} = ${naiveIfCountedAsZero} hrs/ticket -- DIFFERENT from what MBR shows`);
    console.log(`\nThis is the mismatch: MBR excludes the ${t.resolved_missing_resolvedat} ticket(s) with no resolvedAt from BOTH the sum and the count, rather than counting them at 0 or including them in the denominator differently.`);
  } else {
    console.log(`Every resolved ticket has a resolvedAt -- no mismatch for this person; the average is computed over their full resolved set.`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
