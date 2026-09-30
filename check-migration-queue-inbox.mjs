// Rather than brute-forcing all 120 connected mailboxes, find the EXACT
// mailbox notifyStatusChanged actually sends FROM for CF-33687/CF-33696
// (the tickets whose Migration/Dev DL bounces we saw in the logs) -- that's
// the mailbox the bounce (NDR) landed back in. Checking the connectors
// table and each ticket's own source mailbox. Read-only.
//
// Usage: node check-migration-queue-inbox.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name ILIKE '%mail%' OR column_name ILIKE '%inbox%' OR column_name ILIKE '%source%'`
  );
  console.log('issues columns relevant to source mailbox:', JSON.stringify(cols.map(c => c.column_name)));

  const { rows: connCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'connectors'`
  ).catch(() => ({ rows: [] }));
  console.log('\nconnectors table columns:', JSON.stringify(connCols.map(c => c.column_name)));

  const { rows: conns } = await pool.query(`SELECT * FROM connectors LIMIT 20`).catch(() => ({ rows: [] }));
  console.log('\nSample connectors rows:');
  console.log(JSON.stringify(conns, null, 2));

  const { rows: tix } = await pool.query(
    `SELECT COALESCE(cf_key, key) AS key, * FROM issues WHERE cf_key IN ('CF-33687','CF-33696')`
  );
  console.log('\nCF-33687 / CF-33696 full rows (to find source mailbox field):');
  for (const t of tix) {
    const relevant = Object.fromEntries(Object.entries(t).filter(([k]) => /mail|inbox|source|from/i.test(k)));
    console.log(t.key, JSON.stringify(relevant));
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
