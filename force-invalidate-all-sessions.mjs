// Retires every existing session (all rows in user_sessions), by request --
// the final step of the token-storage hardening: anyone still on a
// pre-cookie-migration session has their real, valid token sitting in
// localStorage (kept intentionally working so nobody got logged out
// unexpectedly by that deploy). This forces a clean break -- every current
// session stops working immediately, and everyone's next login goes through
// the new httpOnly-cookie-only flow, leaving no old token valid anywhere.
//
// Sets is_revoked = TRUE on every row rather than deleting them (keeps the
// audit trail of who was logged in when).
//
// Dry-run by default; pass --apply to write.
//
// Usage: node force-invalidate-all-sessions.mjs [--apply]
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_revoked = FALSE AND expires_at > NOW()) AS currently_active
     FROM user_sessions`
  );
  console.log(`Total session rows: ${rows[0].total}`);
  console.log(`Currently active (not revoked, not expired): ${rows[0].currently_active}`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to revoke every currently-active session (forces everyone to log in again).');
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE user_sessions SET is_revoked = TRUE WHERE is_revoked = FALSE`
  );
  console.log(`\nRevoked ${rowCount} sessions. Everyone will need to log in again on their next request.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
