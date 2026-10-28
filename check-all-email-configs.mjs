// Read-only: list EVERY monitored mailbox across all spaces (not scoped to
// TESTIN), to find the actual one that received the Voohalu Weekly Digest
// and turned it into CF-34522 -- the boot logs show far more addresses
// being polled (individual @cloudfuze.com accounts, erik@voohalu.co,
// moorus@filefuze.co) than the 2 rows the space-scoped query found.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, space_key, address, department, created_at FROM email_configs ORDER BY created_at DESC`
  );
  console.log(`${rows.length} total monitored mailbox(es) across all spaces:`);
  for (const r of rows) console.log(` - ${r.address} -> space_key=${r.space_key} dept=${r.department || 'none'} (added ${r.created_at.toISOString()})`);

  const match = rows.filter((r) => /voohalu|engage/i.test(r.address));
  console.log(`\nMatching 'voohalu'/'engage': ${match.length ? JSON.stringify(match, null, 2) : 'NONE -- this address is not a configured support mailbox at all'}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
