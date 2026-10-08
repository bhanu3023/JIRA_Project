// parseDateRange's default case silently treats ANY unrecognized date-range
// string as "from the beginning of time to now" -- i.e. no restriction at
// all, matching every ticket ever. This format has changed more than once
// today (between:FROM,TO -> between:FROM:TO, moreThan's redefinition), so
// a Saved Filter created before any of those changes could carry a stale
// string that now silently falls into this trap. Checks every saved
// filter's createdRange/updatedRange/workedRange/dueDateRange/resolvedRange
// against the actual recognized patterns. Read-only.
//
// Usage: node check-stale-saved-filter-dates.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Mirrors parseDateRange's own recognized shapes exactly.
function isRecognized(val) {
  if (!val) return true; // empty/absent is fine, not a date filter at all
  if (val.startsWith('withinLast:')) return true;
  if (val.startsWith('moreThan:')) return true;
  if (val.startsWith('between:')) {
    const parts = val.split(':');
    return parts.length === 3 && parts[1] && parts[2];
  }
  return ['today', 'yesterday', '7d', '30d', '90d'].includes(val);
}

async function main() {
  const { rows } = await pool.query(`SELECT id, name, "ownerId", "ownerName", criteria FROM filters`);
  console.log(`Checking ${rows.length} saved filter(s)...\n`);
  let staleCount = 0;
  const dateFields = ['createdRange', 'updatedRange', 'workedRange', 'dueDateRange', 'resolvedRange'];
  for (const r of rows) {
    const c = r.criteria || {};
    for (const field of dateFields) {
      const val = c[field];
      if (val && !isRecognized(val)) {
        staleCount++;
        console.log(`STALE: filter "${r.name}" (id=${r.id}, owner=${r.ownerName}) -- ${field} = "${val}" (not recognized by current parseDateRange -- this field is silently matching EVERY ticket ever when this filter is applied)`);
      }
    }
  }
  console.log(`\n${staleCount} stale date value(s) found across ${rows.length} saved filters.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
