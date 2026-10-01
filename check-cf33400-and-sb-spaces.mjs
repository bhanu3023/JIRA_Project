// The previous check queried issues joined to spaces on sp.key = 'SB' and
// got ZERO rows for SAT_Board, even though CF-33400 (created today, visibly
// in the SAT_Board sidebar per screenshot) obviously exists. Either there's
// more than one space row that looks like "SAT_Board", or CF-33400's actual
// spaceId doesn't point at the space keyed 'SB'. Tracing this directly
// instead of guessing.
//
// Read-only.
//
// Usage: node check-cf33400-and-sb-spaces.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cf } = await pool.query(
    `SELECT i.id, i.key, i.cf_key, i."spaceId", sp.key AS space_key, sp.name AS space_name
     FROM issues i LEFT JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i.cf_key = 'CF-33400' OR i.key = 'CF-33400'`
  );
  console.log('CF-33400:', cf);

  const { rows: allSpaces } = await pool.query(`SELECT id, key, name, "issueCount" FROM spaces ORDER BY name`);
  console.log('\nAll spaces:');
  for (const s of allSpaces) console.log(`  id=${s.id}  key="${s.key}"  name="${s.name}"  issueCount=${s.issueCount}`);

  const { rows: countBySpace } = await pool.query(
    `SELECT sp.key, sp.name, COUNT(i.id) AS actual_issue_count
     FROM spaces sp LEFT JOIN issues i ON i."spaceId" = sp.id
     GROUP BY sp.key, sp.name ORDER BY sp.name`
  );
  console.log('\nActual issue counts per space:');
  for (const c of countBySpace) console.log(`  ${c.key} (${c.name}): ${c.actual_issue_count}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
