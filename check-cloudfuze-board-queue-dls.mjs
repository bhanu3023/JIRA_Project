// The DL notifyEmails found so far are all saved under space_key TESTIN,
// but the tickets the user is actually asking about (CF-xxxxx) live on the
// CloudFuze Board space. Checking whether CloudFuze Board's own space_key
// has ANY custom_queues row at all, and what its queue names actually are
// -- if the DLs were saved on the wrong space (or a queue-name mismatch),
// that alone would explain every real ticket's notifyEmails lookup coming
// back empty. Read-only.
//
// Usage: node check-cloudfuze-board-queue-dls.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaces } = await pool.query(`SELECT id, key, name FROM spaces ORDER BY name`);
  console.log('All spaces:');
  for (const s of spaces) console.log(`  key=${s.key}  name="${s.name}"`);

  const { rows: cq } = await pool.query(`SELECT space_key, queues FROM custom_queues ORDER BY space_key`);
  console.log('\nAll custom_queues rows (space_key + queue names):');
  for (const row of cq.rows ?? cq) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    console.log(`  ${row.space_key}: [${queues.map((q) => q.name).join(', ')}]`);
  }

  // Confirm which space_key CF-xxxxx tickets actually belong to
  const { rows: sample } = await pool.query(
    `SELECT i.cf_key, s.key AS space_key, s.name AS space_name, i.current_department
     FROM issues i JOIN spaces s ON s.id = i."spaceId"
     WHERE i.cf_key IN ('CF-26109','CF-33639','CF-32756')`
  );
  console.log('\nSample CF tickets and their real space_key:');
  for (const r of sample) console.log(`  ${r.cf_key}: space_key=${r.space_key} (${r.space_name}), dept=${r.current_department}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
