// User added infrateam@cloudfuze.com as the notify DL for CloudFuze
// Board's Infra queue via the new Notifications tab. Before telling them
// yes/no on whether it'll actually work, verifying: (1) it's really
// persisted in the DB (not just showing in the UI optimistically), and
// (2) the exact lookup the notification code uses (case-insensitive name
// match against custom_queues.queues[]) actually finds it, the same way
// getQueueNotifyEmails() in jira-pg-api.ts does it for real.
//
// Read-only.
//
// Usage: node check-infra-notify-dl.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = rows[0]?.queues || [];
  const infraQueue = queues.find((q) => String(q.name || '').toLowerCase() === 'infra');

  console.log(`Infra queue found in custom_queues: ${infraQueue ? 'YES' : 'NO'}`);
  if (infraQueue) {
    console.log(`  id: ${infraQueue.id}`);
    console.log(`  notifyEmails: ${JSON.stringify(infraQueue.notifyEmails || [])}`);
  }

  // Reproduce getQueueNotifyEmails('TESTIN', 'Infra') exactly
  const match = queues.find((q) => String(q.name || '').toLowerCase() === 'infra'.toLowerCase());
  const result = Array.isArray(match?.notifyEmails) ? match.notifyEmails : [];
  console.log(`\ngetQueueNotifyEmails('TESTIN', 'Infra') would return: ${JSON.stringify(result)}`);
  console.log(`Contains infrateam@cloudfuze.com: ${result.includes('infrateam@cloudfuze.com') ? 'YES' : 'NO'}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
