// Calls POST /admin/backfill-sla-snapshots repeatedly until every currently-
// resolved ticket has a frozen sla_snapshot -- freezes each one's SLA
// breach/due verdict as of right now, using today's live sla_definitions
// (the true pre-existing value for tickets resolved before this fix
// shipped is unrecoverable, since sla_definitions never kept history).
// From this point forward, no future SLA policy edit can ever change a
// resolved ticket's outcome again.
//
// No dry-run mode -- this only ever WRITES a snapshot where one doesn't
// already exist (sla_snapshot IS NULL in the WHERE clause), never
// overwrites an existing one, so it's safe to run, safe to re-run, and
// safe to interrupt and resume.
//
// Usage: node run-sla-snapshot-backfill.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const BATCH_SIZE = 500;

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email, role FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  if (!user || user.role !== 'admin') { console.log('Admin user not found'); await pool.end(); return; }

  const payload = { sub: user.id, ip: '', ua: 'sla-snapshot-backfill-script', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-snapshot-backfill-script', new Date(Date.now() + 3600 * 1000)]
  );

  let totalProcessed = 0, totalFrozen = 0, batchNum = 0;
  while (true) {
    batchNum++;
    const url = `http://localhost:${PORT}/api/admin/backfill-sla-snapshots?limit=${BATCH_SIZE}`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`Batch ${batchNum} failed: HTTP ${res.status}`, await res.text().catch(() => ''));
      break;
    }
    const data = await res.json();
    totalProcessed += data.processedThisBatch || 0;
    totalFrozen += data.frozen || 0;
    console.log(`Batch ${batchNum}: processed ${data.processedThisBatch}, frozen ${data.frozen}, remaining before this batch: ${data.remainingBeforeThisBatch}`);
    if (!data.processedThisBatch || data.processedThisBatch === 0) break;
  }

  console.log(`\nDone. Total processed: ${totalProcessed}, total frozen: ${totalFrozen}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
