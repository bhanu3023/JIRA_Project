// Deletes the self-mail-loop tickets created by the KB-publish-notification
// bug (see announcePublished's fix in kb-api.ts): every ticket in CUSTM
// reported by the guest_leo_fuzebot_io account, titled "New KB Article: ...".
// Scoped tightly (reporterId + title prefix + space) so it can never touch a
// genuine customer ticket that happens to share the same reporter by
// coincidence. Dry-run by default -- pass --apply to actually delete.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`
    SELECT i.id, COALESCE(i.cf_key, i.key) AS key, i.summary, i."createdAt"
    FROM issues i
    JOIN spaces sp ON sp.id = i."spaceId"
    WHERE i."reporterId" = 'guest_leo_fuzebot_io'
      AND sp.key = 'CUSTM'
      AND i.summary ILIKE 'New KB Article:%'
    ORDER BY i."createdAt" ASC
  `);

  console.log(`Found ${rows.length} self-loop tickets to ${APPLY ? 'DELETE' : 'delete (dry run)'}:`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.key}  "${r.summary}"  created=${r.createdAt.toISOString()}`);
  if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to actually delete these.');
    await pool.end();
    return;
  }

  const ids = rows.map((r) => r.id);
  const result = await pool.query(`DELETE FROM issues WHERE id = ANY($1::text[])`, [ids]);
  console.log(`\nDeleted ${result.rowCount} tickets.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
