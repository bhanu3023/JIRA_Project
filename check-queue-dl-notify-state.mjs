// User says the queue notify-DL feature isn't actually sending emails to
// the configured DL addresses. Checking whether the DLs were actually
// saved into custom_queues.queues[].notifyEmails in the first place (a
// config/save problem) before assuming it's a send-side bug. Read-only.
//
// Usage: node check-queue-dl-notify-state.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues ORDER BY space_key`);
  for (const row of rows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    for (const q of queues) {
      if (Array.isArray(q.notifyEmails) && q.notifyEmails.length) {
        console.log(`${row.space_key} / "${q.name}" (id=${q.id}): notifyEmails = ${JSON.stringify(q.notifyEmails)}`);
      }
    }
  }
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
