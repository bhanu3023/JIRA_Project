// Explains one person's MBR "Avg. resolution" / "Avg. response time": pulls
// their tickets from the LIVE /reports/mbr-team endpoint (so every number is
// exactly what the MBR page computed, not a re-implementation), shows which
// tickets make up the averages, and prints the status/assignee/department
// timeline of the biggest contributors so the "why" is visible. Read-only
// apart from a short-lived session row it creates and revokes for itself
// (same approach as diff-filters-vs-mbr-tickets.mjs).
//
// Usage (on the server):
//   DATABASE_URL=... node explain-mbr-person-times.mjs <email> [team=eng] [from=2026-09-01] [to=2026-09-30] [top=5]
// APP_URL env overrides http://localhost:5882 (the app's host port in docker-compose.yml).

import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
const APP_URL = process.env.APP_URL || 'http://localhost:5882';
const EMAIL = (process.argv[2] || '').toLowerCase();
const TEAM = process.argv[3] || 'eng';
const FROM = process.argv[4] || '2026-09-01';
const TO = process.argv[5] || '2026-09-30';
const TOP = Number(process.argv[6] || 5);

if (!EMAIL) {
  console.error('Usage: node explain-mbr-person-times.mjs <email> [team] [from] [to] [top]');
  process.exit(1);
}

const hms = (h) => {
  if (h === null || h === undefined) return '—';
  const s = Math.round(h * 3600);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—');

async function main() {
  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY "createdAt" ASC LIMIT 1`);
  const adminId = adminRows[0].id;
  const token = jwt.sign({ sub: adminId, ip: '', ua: 'explain-mbr', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','explain-mbr',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, adminId, new Date(Date.now() + 3600 * 1000)]
  );
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const params = new URLSearchParams({ team: TEAM, dateFrom: FROM, dateTo: TO, person: EMAIL, export: '1' });
    const res = await fetch(`${APP_URL}/api/reports/mbr-team?${params}`, { headers });
    if (!res.ok) throw new Error(`mbr-team -> HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const allRes = await fetch(`${APP_URL}/api/reports/mbr-team?${new URLSearchParams({ team: TEAM, dateFrom: FROM, dateTo: TO })}`, { headers });
    const row = ((await allRes.json()).people || []).find((p) => String(p.email).toLowerCase() === EMAIL);

    const tickets = data.tickets || [];
    const timed = tickets.filter((t) => t.resolutionHours !== null && t.resolutionHours !== undefined);
    const totalRes = timed.reduce((s, t) => s + t.resolutionHours, 0);
    const totalResp = timed.reduce((s, t) => s + (t.responseTimeHours || 0), 0);

    console.log(`${EMAIL} | ${TEAM} | ${FROM}..${TO}`);
    console.log(`MBR row: Avg. resolution ${hms(row?.avgResolutionHours)}, Avg. response ${hms(row?.avgResponseTimeHours)}`);
    console.log(`${tickets.length} ticket(s); ${timed.length} with a resolution time (the ones averaged)`);
    console.log(`  total resolution ${hms(totalRes)} / ${timed.length} = ${hms(timed.length ? totalRes / timed.length : null)}`);
    console.log(`  total response   ${hms(totalResp)} / ${timed.length} = ${hms(timed.length ? totalResp / timed.length : null)}\n`);

    const sorted = [...timed].sort((a, b) => b.resolutionHours - a.resolutionHours);
    console.log('Ticket          Resolution   Response   Share of total resolution   Status');
    let running = 0;
    for (const t of sorted) {
      running += t.resolutionHours;
      console.log(`${String(t.key).padEnd(15)} ${hms(t.resolutionHours).padStart(10)} ${hms(t.responseTimeHours).padStart(10)}   ${((t.resolutionHours / (totalRes || 1)) * 100).toFixed(1).padStart(5)}% (cumulative ${((running / (totalRes || 1)) * 100).toFixed(0)}%)   ${t.status}`);
    }

    const withoutTop = sorted.slice(TOP);
    if (withoutTop.length) {
      const r = withoutTop.reduce((s, t) => s + t.resolutionHours, 0) / withoutTop.length;
      const p = withoutTop.reduce((s, t) => s + (t.responseTimeHours || 0), 0) / withoutTop.length;
      console.log(`\nWithout the top ${TOP}: avg resolution ${hms(r)}, avg response ${hms(p)} over ${withoutTop.length} ticket(s)`);
    }

    for (const t of sorted.slice(0, TOP)) {
      const { rows: issueRows } = await pool.query(
        `SELECT id, "createdAt", "resolvedAt", current_department FROM issues WHERE cf_key = $1 OR key = $1 LIMIT 1`, [t.key]
      );
      const issue = issueRows[0];
      if (!issue) continue;
      console.log(`\n=== ${t.key}: resolution ${hms(t.resolutionHours)}, response ${hms(t.responseTimeHours)} | created ${iso(issue.createdAt)}, resolvedAt ${iso(issue.resolvedAt)}, now in ${issue.current_department}`);
      const { rows: hist } = await pool.query(
        `SELECT field, "oldValue", "newValue", "authorName", "createdAt" FROM issue_history
         WHERE "issueId" = $1 AND field IN ('status', 'assignee', 'department') ORDER BY "createdAt" ASC`, [issue.id]
      );
      const { rows: trans } = await pool.query(
        `SELECT from_dept, to_dept, moved_at FROM issue_dept_transitions WHERE issue_id = $1 ORDER BY moved_at ASC`, [issue.id]
      );
      const timeline = [
        ...hist.map((h) => ({ at: h.createdAt, line: `${h.field.padEnd(10)} ${JSON.stringify(h.oldValue)} -> ${JSON.stringify(h.newValue)}  [${h.authorName || 'Unknown'}]` })),
        ...trans.map((x) => ({ at: x.moved_at, line: `queue-move ${x.from_dept} -> ${x.to_dept}` })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));
      for (const e of timeline) console.log(`  ${iso(e.at)}  ${e.line}`);
    }
  } finally {
    await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]).catch(() => {});
    await pool.end();
  }
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
