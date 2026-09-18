// Per explicit request: change Updated + Resolved date/time to May 25, 2026
// for CF-24589 and its 6 related tickets (CF-24586, CF-24968, CF-27098,
// CF-24925, CF-24650, CF-24769), keeping each ticket's own existing
// time-of-day (as displayed, IST) -- only the calendar date moves to
// May 25, 2026. Values are stored in the DB as UTC but the UI displays them
// in IST (established convention this session, e.g. the MBR monthly-bucket
// IST fix), so this converts each existing UTC timestamp to its IST
// wall-clock time, swaps in May 25, 2026 as the date, then converts back to
// UTC for storage.
//
// Usage: node fix-cf24589-related-dates.mjs [--apply]

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const KEYS = ['CF-24589', 'CF-24586', 'CF-24968', 'CF-27098', 'CF-24925', 'CF-24650', 'CF-24769'];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIstParts(utcDate) {
  const ist = new Date(utcDate.getTime() + IST_OFFSET_MS);
  return {
    hours: ist.getUTCHours(),
    minutes: ist.getUTCMinutes(),
    seconds: ist.getUTCSeconds(),
    ms: ist.getUTCMilliseconds(),
  };
}

// Builds the UTC instant corresponding to May 25, 2026 at the given IST wall-clock time.
function may25AtIstTime(parts) {
  const istWallClockAsUtc = Date.UTC(2026, 4, 25, parts.hours, parts.minutes, parts.seconds, parts.ms);
  return new Date(istWallClockAsUtc - IST_OFFSET_MS);
}

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(
      `SELECT id, "updatedAt", "resolvedAt" FROM issues WHERE cf_key = $1 OR key = $1`,
      [key]
    );
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const r = rows[0];
    if (!r.updatedAt && !r.resolvedAt) { console.log(`${key}: no updatedAt/resolvedAt set -- skipping`); continue; }

    const newUpdatedAt = r.updatedAt ? may25AtIstTime(toIstParts(new Date(r.updatedAt))) : null;
    const newResolvedAt = r.resolvedAt ? may25AtIstTime(toIstParts(new Date(r.resolvedAt))) : null;

    console.log(`${key}:`);
    console.log(`  updatedAt:  ${r.updatedAt ? new Date(r.updatedAt).toISOString() : null} -> ${newUpdatedAt ? newUpdatedAt.toISOString() : null}`);
    console.log(`  resolvedAt: ${r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null} -> ${newResolvedAt ? newResolvedAt.toISOString() : null}`);

    if (APPLY) {
      await pool.query(
        `UPDATE issues SET "updatedAt" = COALESCE($1, "updatedAt"), "resolvedAt" = COALESCE($2, "resolvedAt") WHERE id = $3`,
        [newUpdatedAt, newResolvedAt, r.id]
      );
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
