// Read-only: the QA/CFITS catch-up checkpoint hasn't moved in 10+ minutes
// (identical timestamps across two checks), while the Periodic tick keeps
// logging "sync already in progress, skipped" -- meaning the in-process
// _jiraSyncRunning flag never reset, i.e. the one run that updated SOPS at
// 13:07:40 is still executing (or genuinely hung) somewhere between SOPS and
// QA's turn. Check for a long-running/blocked DB query, which would explain
// a hang that no fetch-level AbortSignal.timeout could catch (the per-issue
// Jira fetches have 8-15s timeouts; Prisma/pg calls here have none).
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: longRunning } = await pool.query(`
    SELECT pid, state, wait_event_type, wait_event, now() - query_start AS running_for,
           LEFT(query, 200) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND state != 'idle' AND pid != pg_backend_pid()
    ORDER BY query_start ASC
  `);
  console.log(`${longRunning.length} non-idle connection(s):`);
  for (const r of longRunning) {
    console.log(` - pid=${r.pid} state=${r.state} wait=${r.wait_event_type || 'none'}/${r.wait_event || 'none'} running_for=${r.running_for} query="${r.query}"`);
  }

  const { rows: blocked } = await pool.query(`
    SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
           LEFT(blocked.query, 150) AS blocked_query
    FROM pg_locks bl
    JOIN pg_stat_activity blocked ON blocked.pid = bl.pid
    JOIN pg_locks kl ON kl.locktype = bl.locktype AND kl.database IS NOT DISTINCT FROM bl.database
      AND kl.relation IS NOT DISTINCT FROM bl.relation AND kl.pid != bl.pid AND kl.granted
    JOIN pg_stat_activity blocking ON blocking.pid = kl.pid
    WHERE NOT bl.granted
  `).catch(() => ({ rows: [] }));
  console.log(`\n${blocked.length} blocked-lock pair(s):`, JSON.stringify(blocked, null, 2));

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
