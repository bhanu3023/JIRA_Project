// For every RESOLVED ticket whose priority was just bulk-migrated from
// highest to high (identified via the issue_history entry the
// migration script logged), the frozen sla_snapshot still reflects the
// OLD priority='highest' + the since-removed 0h goal -- Due still
// shows the same broken value even though priority now correctly
// shows High. The freeze-on-first-compute mechanism exists to protect
// resolved tickets from LATER, legitimate SLA policy edits (explicit
// earlier decision) -- but this isn't that: the original freeze was
// itself computed from confirmed-broken data, not a value that later
// changed. Clears sla_snapshot for just these tickets (not touching
// current_department, dept_sla_log, etc.), then calls the real GET
// endpoint for each -- which runs the actual, authoritative
// computeSLAInstancesPure logic (not a hand-replicated approximation)
// and re-freezes the correct result. Dry-run by default; --apply.
//
// Usage: node refresh-sla-snapshot-for-migrated-priority.mjs [--apply] [--limit N]
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1], 10) : null;

async function main() {
  const { rows: affected } = await pool.query(`
    SELECT DISTINCT i.id, COALESCE(i.cf_key, i.key) AS key
    FROM issue_history h
    JOIN issues i ON i.id = h."issueId"
    WHERE h.field = 'priority' AND h."authorName" = 'System (Highest priority removed)'
      AND i.sla_snapshot IS NOT NULL
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `);
  console.log(`${affected.length} resolved, previously-highest tickets have a stale frozen sla_snapshot.`);
  if (!affected.length) { await pool.end(); return; }

  if (!APPLY) {
    console.log('Dry run only -- re-run with --apply to clear + refresh these.');
    await pool.end();
    return;
  }

  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'sla-snapshot-refresh', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'sla-snapshot-refresh', new Date(Date.now() + 3600 * 1000)]
  );

  let refreshed = 0, errors = 0;
  for (const t of affected) {
    try {
      await pool.query(`UPDATE issues SET sla_snapshot = NULL WHERE id = $1`, [t.id]);
      const res = await fetch(`http://localhost:${PORT}/api/issues/${t.key}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) refreshed++; else errors++;
    } catch {
      errors++;
    }
    if ((refreshed + errors) % 200 === 0) console.log(`  ...${refreshed + errors}/${affected.length} processed (refreshed=${refreshed}, errors=${errors})`);
  }
  console.log(`\nDone. refreshed=${refreshed} errors=${errors}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
