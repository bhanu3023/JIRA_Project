// The resolvedAt backfill plan showed several DIFFERENT tickets sharing the
// exact same millisecond timestamp for their "became Resolved" history row
// (e.g. 2026-01-21T20:43:08.449Z on CF-12562, CF-12687, CF-12897) -- tickets
// don't organically resolve at the identical instant, so this smells like
// the same kind of bulk-import/mass-update artifact already found and fixed
// for the Sept-14 MBR corruption (see recover-corrupted-resolvedat.mjs), just
// a different date. Investigating before backfilling anything from these
// rows, since if they're artifacts, using them as "the real resolution
// moment" would write wrong data, not fix it.
//
// Read-only.
//
// Usage: node investigate-resolved-timestamp-clusters.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: clusters } = await pool.query(`
    SELECT "createdAt", COUNT(*) AS cnt
    FROM issue_history
    WHERE field = 'status' AND LOWER("newValue") = ANY(ARRAY['resolved','closed','done'])
    GROUP BY "createdAt"
    HAVING COUNT(*) > 5
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log('Timestamps shared by more than 5 different "became resolved/closed" history rows:');
  for (const c of clusters) console.log(`  ${c.createdAt.toISOString()}  x${c.cnt}`);

  if (clusters.length) {
    const top = clusters[0];
    console.log(`\nInspecting the biggest cluster (${top.createdAt.toISOString()}, ${top.cnt} rows):`);
    const { rows: sample } = await pool.query(
      `SELECT ih."issueId", COALESCE(i.cf_key, i.key) AS key, ih."oldValue", ih."newValue", ih."authorId", u."firstName", u."lastName"
       FROM issue_history ih
       JOIN issues i ON i.id = ih."issueId"
       LEFT JOIN users u ON u.id = ih."authorId"
       WHERE ih.field = 'status' AND ih."createdAt" = $1
       LIMIT 15`,
      [top.createdAt]
    );
    for (const s of sample) {
      console.log(`  ${s.key}: "${s.oldValue}" -> "${s.newValue}"  by ${s.firstName ? `${s.firstName} ${s.lastName}` : (s.authorId || '(no author)')}`);
    }

    // Does this cluster's timestamp also coincide with OTHER history fields
    // changing on the same tickets at the exact same instant -- another
    // fingerprint of a bulk re-import/mass-update rather than organic work.
    const { rows: otherFields } = await pool.query(
      `SELECT field, COUNT(*) AS cnt FROM issue_history WHERE "createdAt" = $1 GROUP BY field ORDER BY cnt DESC`,
      [top.createdAt]
    );
    console.log(`\nAll history fields touched at that exact same timestamp:`);
    for (const f of otherFields) console.log(`  ${f.field}: ${f.cnt}`);
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
