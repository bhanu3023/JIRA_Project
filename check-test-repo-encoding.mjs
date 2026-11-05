// Read-only: inspects the raw bytes of a few garbled test summaries (shown
// as a literal "?" box in the UI) to tell whether this is recoverable
// mis-encoded UTF-8 (fixable by reprocessing) or an already-lost
// replacement character (U+FFFD, unrecoverable -- the original byte was
// discarded before it ever reached Postgres).
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT "jiraKey", summary FROM test_cases WHERE "jiraKey" IN ('TEST-66259', 'TEST-66299') OR summary LIKE '%�%' LIMIT 5`,
  );
  if (!rows.length) {
    console.log('No matching rows found by those jiraKeys or U+FFFD scan.');
  }
  for (const r of rows) {
    console.log(`\n${r.jiraKey}: ${r.summary}`);
    const buf = Buffer.from(r.summary, 'utf8');
    // Print hex around each replacement character (U+FFFD = EF BF BD in UTF-8)
    let idx = buf.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    while (idx !== -1) {
      const start = Math.max(0, idx - 6);
      const end = Math.min(buf.length, idx + 9);
      console.log(`  U+FFFD at byte ${idx}, surrounding hex: ${buf.subarray(start, end).toString('hex')}`);
      idx = buf.indexOf(Buffer.from([0xef, 0xbf, 0xbd]), idx + 3);
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
