// User's Filters screenshot has Space filter set to "rSpaces=TESTIN" in the
// URL, Queue=Dev, Created/Updated both 2026-09-14..2026-09-20, and shows 171
// issues -- but the sidebar's actual SPACES list (CloudFuze Board,
// Customer_Board, IT ADMINISTRATION, QA Agent, SAT_Board) has nothing
// called "TESTIN". Checking whether that's a real space key at all, and if
// not, whether the 171 results are actually just ignoring the (invalid)
// space filter and returning everything -- a real bug -- vs. "TESTIN"
// being a legitimate but hidden/archived space, vs. a red herring.
//
// Read-only.
//
// Usage: node check-testin-space-filter.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('All spaces in DB (key, name, archived?):');
  const { rows: spaces } = await pool.query(`SELECT key, name, type, "createdAt" FROM spaces ORDER BY key`);
  for (const s of spaces) console.log(`  key="${s.key}"  name="${s.name}"  type=${s.type}`);

  const testinMatch = spaces.filter(s => s.key.toUpperCase().includes('TESTIN') || s.name.toUpperCase().includes('TESTIN'));
  console.log(`\nSpaces matching "TESTIN": ${testinMatch.length ? JSON.stringify(testinMatch) : 'NONE'}`);

  // Reproduce the same query shape: Dev-department issues created+updated in that window
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM issues i
     WHERE i.current_department = 'Dev'
       AND i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
       AND i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'`
  );
  console.log(`\nDev-department issues, created AND updated in 2026-09-14..2026-09-20 (ANY space): ${countRows[0].count}`);

  // Breakdown by actual space, so we can see which space(s) the 171 result
  // is really drawing from
  const { rows: bySpace } = await pool.query(
    `SELECT sp.key, sp.name, COUNT(*) AS cnt FROM issues i JOIN spaces sp ON sp.id = i."spaceId"
     WHERE i.current_department = 'Dev'
       AND i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
       AND i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'
     GROUP BY sp.key, sp.name ORDER BY cnt DESC`
  );
  console.log('\nBreakdown by actual space:');
  for (const r of bySpace) console.log(`  ${r.key} (${r.name}): ${r.cnt}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
