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
      `SELECT ih."issueId", COALESCE(i.cf_key, i.key) AS key, ih."oldValue", ih."newValue", ih."authorName", ih."authorEmail"
       FROM issue_history ih
       JOIN issues i ON i.id = ih."issueId"
       WHERE ih.field = 'status' AND ih."createdAt" = $1
       LIMIT 15`,
      [top.createdAt]
    );
    for (const s of sample) {
      console.log(`  ${s.key}: "${s.oldValue}" -> "${s.newValue}"  by ${s.authorName || s.authorEmail || '(no author)'}`);
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

    // Critical question: for tickets caught in this cluster, is the cluster
    // row their ONLY "became resolved" record, or is there an earlier,
    // organic one that predates it (same shape as the Sept-14 case, where a
    // real resolution existed before a later artifact overwrote it)? This
    // determines whether the resolvedAt-gap script's "earliest done row"
    // logic would pick up a real event or the artifact itself.
    console.log(`\nFor tickets in this cluster, checking whether an EARLIER real "became done" row exists...`);
    const { rows: clusterIssueIds } = await pool.query(
      `SELECT DISTINCT "issueId" FROM issue_history WHERE field='status' AND "createdAt" = $1 LIMIT 10`,
      [top.createdAt]
    );
    for (const { issueId } of clusterIssueIds) {
      const { rows: allDone } = await pool.query(
        `SELECT "createdAt", "oldValue", "newValue" FROM issue_history
         WHERE "issueId"=$1 AND field='status' AND LOWER("newValue") = ANY(ARRAY['resolved','closed','done'])
         ORDER BY "createdAt" ASC`,
        [issueId]
      );
      const { rows: keyRow } = await pool.query(`SELECT COALESCE(cf_key, key) AS key FROM issues WHERE id=$1`, [issueId]);
      const key = keyRow[0]?.key || issueId;
      console.log(`  ${key}: ${allDone.length} "done" row(s) total -- ${allDone.map(r => r.createdAt.toISOString()).join(', ')}`);
    }
  }

  // Is "Sujana Manapuram" a real, currently-active user, or does this look
  // like a bulk-migration script's default/system author rather than a
  // person actually clicking "Resolve" 500+ times in seconds?
  console.log(`\nChecking whether "Sujana Manapuram" is a real active user...`);
  const { rows: sujana } = await pool.query(
    `SELECT id, email, role, "isActive" FROM users WHERE "firstName" ILIKE 'Sujana%'`
  );
  console.log(sujana.length ? sujana : '  No user found with that name at all.');

  // Across EVERY cluster found above (not just the biggest one), does any
  // ticket have the cluster timestamp as its ONLY "done" row -- meaning a
  // resolvedAt-backfill script relying on "earliest done row" would land on
  // the fake bulk timestamp instead of skipping it, because there's nothing
  // earlier to fall back to.
  console.log(`\nChecking ALL clustered timestamps for tickets with NO earlier real "done" row...`);
  let onlyArtifactCount = 0;
  for (const c of clusters) {
    const { rows: ids } = await pool.query(
      `SELECT "issueId" FROM issue_history WHERE field='status' AND "createdAt" = $1`,
      [c.createdAt]
    );
    for (const { issueId } of ids) {
      const { rows: earlier } = await pool.query(
        `SELECT 1 FROM issue_history WHERE "issueId"=$1 AND field='status' AND LOWER("newValue") = ANY(ARRAY['resolved','closed','done']) AND "createdAt" < $2 LIMIT 1`,
        [issueId, c.createdAt]
      );
      if (!earlier.length) onlyArtifactCount++;
    }
  }
  console.log(`  ${onlyArtifactCount} ticket(s) across all clusters have the bulk timestamp as their ONLY "done" record (no earlier real resolution to fall back to).`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
