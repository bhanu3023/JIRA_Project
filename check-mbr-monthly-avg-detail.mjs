// Shows the actual per-ticket resolution times behind a person's MBR
// "Avg. resolution (hrs)" for a given date range, so an on-screen average can
// be checked against real ticket-by-ticket numbers instead of trusting the
// aggregate blindly. Mirrors MBR's own date-scoping rule: a ticket counts for
// the range if EITHER its createdAt OR its updatedAt falls inside it (not
// just createdAt) -- which means a ticket created long before the range but
// merely touched during it can still be included, and its full
// (resolvedAt - createdAt) span (potentially months) still feeds the average.
// That's the most likely source of an unexpectedly large or small number.
//
// Read-only.
//
// Usage: node check-mbr-monthly-avg-detail.mjs <email> <YYYY-MM-DD> <YYYY-MM-DD>

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const [, , EMAIL, FROM, TO] = process.argv;

if (!EMAIL || !FROM || !TO) {
  console.error('Usage: node check-mbr-monthly-avg-detail.mjs <email> <YYYY-MM-DD> <YYYY-MM-DD>');
  process.exit(1);
}

async function main() {
  const { rows: userRows } = await pool.query(`SELECT id, "firstName", "lastName" FROM users WHERE email = $1`, [EMAIL]);
  if (!userRows.length) { console.log('User not found.'); await pool.end(); return; }
  const { id: userId, firstName, lastName } = userRows[0];

  const { rows } = await pool.query(`
    SELECT COALESCE(i.cf_key, i.key) AS key, i."createdAt", i."updatedAt", i."resolvedAt", s.name AS status_name, s.category
    FROM issues i
    LEFT JOIN statuses s ON s.id = i."statusId"
    WHERE i."assigneeId" = $1
      AND (
        (i."createdAt"::date >= $2::date AND i."createdAt"::date <= $3::date)
        OR (i."updatedAt"::date >= $2::date AND i."updatedAt"::date <= $3::date)
      )
    ORDER BY i."createdAt" ASC
  `, [userId, FROM, TO]);

  console.log(`${firstName} ${lastName} <${EMAIL}> -- ${rows.length} ticket(s) matching MBR's date scoping for ${FROM} to ${TO}\n`);

  let sumHrs = 0, countWithResolvedAt = 0;
  let outsideRangeCreated = 0;
  for (const r of rows) {
    const createdInRange = r.createdAt.toISOString().slice(0, 10) >= FROM && r.createdAt.toISOString().slice(0, 10) <= TO;
    if (!createdInRange) outsideRangeCreated++;
    let hrsStr = '(no resolvedAt)';
    if (r.resolvedAt) {
      const hrs = (new Date(r.resolvedAt).getTime() - new Date(r.createdAt).getTime()) / 3_600_000;
      sumHrs += hrs;
      countWithResolvedAt++;
      hrsStr = `${hrs.toFixed(1)} hrs`;
    }
    console.log(`  ${r.key}  created=${r.createdAt.toISOString().slice(0, 10)}${createdInRange ? '' : ' (OUTSIDE range -- matched via updatedAt)'}  status=${r.status_name}  resolution=${hrsStr}`);
  }

  console.log(`\n${countWithResolvedAt} ticket(s) with a resolvedAt, summing ${sumHrs.toFixed(1)} hours.`);
  console.log(`Average = ${sumHrs.toFixed(1)} / ${countWithResolvedAt} = ${(sumHrs / countWithResolvedAt).toFixed(1)} hrs/ticket`);
  console.log(`${outsideRangeCreated} of the ${rows.length} ticket(s) were created OUTSIDE ${FROM}..${TO} and only matched because they were updated during it -- their full (potentially much longer) resolvedAt-createdAt span still counts toward the average above.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
