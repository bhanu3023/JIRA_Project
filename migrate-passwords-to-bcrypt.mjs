// Security audit finding: every user's password was stored and compared in
// PLAIN TEXT (no hashing library used anywhere in the codebase). The app
// code has been fixed to hash on write and verify via bcrypt (with a
// transparent upgrade-on-next-login for any row still plaintext), but that
// alone only migrates an account the next time its owner actually logs in.
// This proactively hashes every password still in plaintext right now, so
// no account is left exposed in the interim.
//
// Uses the exact same bcryptjs package the app itself uses (run this via
// `docker exec jira_app node ...` so it resolves from the container's own
// node_modules, not a different local install).
//
// A value already matching bcrypt's own hash format ($2a$/$2b$/$2y$ followed
// by a 2-digit cost and a 53-char base64 body) is left untouched.
//
// Dry-run by default; pass --apply to write. Never prints any password
// value, plaintext or hashed.
//
// Usage: node migrate-passwords-to-bcrypt.mjs [--apply]
import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$.{53}$/;

async function main() {
  const { rows } = await pool.query(`SELECT id, email, password FROM users WHERE password IS NOT NULL AND password != ''`);
  const toMigrate = rows.filter(r => !BCRYPT_HASH_RE.test(r.password));
  console.log(`Total users with a password set: ${rows.length}`);
  console.log(`Already bcrypt-hashed: ${rows.length - toMigrate.length}`);
  console.log(`Still plaintext, needs migration: ${toMigrate.length}`);
  if (toMigrate.length) console.log('Emails (no password values shown):', toMigrate.map(r => r.email).join(', '));

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to hash these ${toMigrate.length} passwords in place.`);
    await pool.end();
    return;
  }

  let done = 0;
  for (const r of toMigrate) {
    const hash = await bcrypt.hash(r.password, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hash, r.id]);
    done++;
  }
  console.log(`\nHashed ${done} previously-plaintext passwords.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
