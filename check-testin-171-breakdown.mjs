// Filters page: Space=TESTIN (CloudFuze Board), Queue=Dev, Created and
// Updated both 2026-09-14..2026-09-20 -> shows 171 issues. A strict
// "current_department=Dev AND created-in-range AND updated-in-range,
// TESTIN only" count only found 4. Checking the two most likely reasons
// for the gap: (1) TESTIN has sub-boards folded into the same queue view
// (intentional, not a bug, if so) and (2) Created/Updated are applied as
// a union (ticket matches if EITHER falls in range), not an intersection
// (matching a comment found in the dept-scoped branch's own code re:
// "never narrower than any one filter alone would allow").
//
// Read-only.
//
// Usage: node check-testin-171-breakdown.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRow } = await pool.query(
    `SELECT id, key, COALESCE(sub_board_keys, '{}') AS sub_board_keys FROM spaces WHERE key = 'TESTIN'`
  );
  const sp = spaceRow[0];
  console.log(`TESTIN id=${sp.id}  sub_board_keys=${JSON.stringify(sp.sub_board_keys)}`);

  let allSpaceIds = [sp.id];
  if (sp.sub_board_keys.length) {
    const { rows: subs } = await pool.query(`SELECT id, key FROM spaces WHERE key = ANY($1::text[])`, [sp.sub_board_keys]);
    console.log('Sub-boards:', subs.map(s => s.key).join(', ') || 'none found');
    allSpaceIds.push(...subs.map(s => s.id));
  }

  // 1) Strict AND, TESTIN only (what we already ran)
  const { rows: r1 } = await pool.query(
    `SELECT COUNT(*) FROM issues i WHERE i."spaceId" = $1 AND i.current_department = 'Dev'
       AND i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
       AND i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'`,
    [sp.id]
  );
  console.log(`\n1) AND semantics, TESTIN only: ${r1[0].count}`);

  // 2) OR semantics (created OR updated in range), TESTIN only
  const { rows: r2 } = await pool.query(
    `SELECT COUNT(*) FROM issues i WHERE i."spaceId" = $1 AND i.current_department = 'Dev'
       AND ((i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21')
         OR (i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'))`,
    [sp.id]
  );
  console.log(`2) OR semantics, TESTIN only: ${r2[0].count}`);

  // 3) OR semantics, TESTIN + sub-boards
  const { rows: r3 } = await pool.query(
    `SELECT COUNT(*) FROM issues i WHERE i."spaceId" = ANY($1::text[]) AND i.current_department = 'Dev'
       AND ((i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21')
         OR (i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'))`,
    [allSpaceIds]
  );
  console.log(`3) OR semantics, TESTIN + sub-boards: ${r3[0].count}`);

  // 4) AND semantics, TESTIN + sub-boards
  const { rows: r4 } = await pool.query(
    `SELECT COUNT(*) FROM issues i WHERE i."spaceId" = ANY($1::text[]) AND i.current_department = 'Dev'
       AND i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21'
       AND i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'`,
    [allSpaceIds]
  );
  console.log(`4) AND semantics, TESTIN + sub-boards: ${r4[0].count}`);

  // 5) No department restriction at all, OR semantics, TESTIN + sub-boards
  //    (in case "Dev" is matching via some broader worked-on/history rule
  //    rather than current_department, this shows the ceiling)
  const { rows: r5 } = await pool.query(
    `SELECT COUNT(*) FROM issues i WHERE i."spaceId" = ANY($1::text[])
       AND ((i."createdAt" >= '2026-09-14' AND i."createdAt" < '2026-09-21')
         OR (i."updatedAt" >= '2026-09-14' AND i."updatedAt" < '2026-09-21'))`,
    [allSpaceIds]
  );
  console.log(`5) No dept filter at all, OR semantics, TESTIN + sub-boards (ceiling): ${r5[0].count}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
