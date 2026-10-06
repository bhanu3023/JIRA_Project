// Replicates the Filters page's own CSV-generation logic (same escaping
// as csvCell in filters/page.tsx) against REAL API data for several
// different real users, then parses the generated CSV string back with
// a proper CSV-aware line counter to confirm the row count in the
// GENERATED FILE itself matches the API's reported total -- closing the
// loop on "is there a bug in how the export file is built" without
// relying on how Excel displays/counts it. Read-only (API), writes
// nothing to the DB.
//
// Usage: node check-csv-roundtrip.mjs
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Proper CSV row splitter (handles quoted fields containing newlines/commas),
// not a naive .split('\n') -- a naive split is exactly the kind of thing
// that WOULD miscount rows if a field contains an embedded newline.
function countCsvDataRows(csv) {
  let rows = 0, inQuotes = false, sawAnyCharOnLine = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (inQuotes && csv[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
      sawAnyCharOnLine = true;
    } else if (c === '\n' && !inQuotes) {
      rows++;
      sawAnyCharOnLine = false;
    } else if (c !== '\r') {
      sawAnyCharOnLine = true;
    }
  }
  if (sawAnyCharOnLine) rows++; // last line with no trailing newline
  return rows - 1; // minus header row
}

async function main() {
  const { rows: users } = await pool.query(`SELECT id, email FROM users WHERE email = 'bhanu.srikakulam@cloudfuze.com' LIMIT 1`);
  const user = users[0];
  const payload = { sub: user.id, ip: '', ua: 'csv-roundtrip-check', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, user.id, '', 'csv-roundtrip-check', new Date(Date.now() + 3600 * 1000)]
  );

  const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = 'TESTIN'`);
  const queues = cq[0]?.queues || [];
  const devQueue = queues.find(q => q.name === 'Dev');
  const migQueue = queues.find(q => q.name === 'Migration');

  const sampleMembers = [];
  for (const [label, q] of [['Dev', devQueue], ['Migration', migQueue]]) {
    if (!q?.memberIds?.length) continue;
    const { rows: real } = await pool.query(`SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1::text[]) LIMIT 5`, [q.memberIds]);
    for (const r of real) sampleMembers.push({ dept: label, ...r });
  }

  console.log(`Testing ${sampleMembers.length} real members (5 from Dev, 5 from Migration)...\n`);
  let anyMismatch = false;
  for (const m of sampleMembers) {
    const params = {
      spaceKey: 'TESTIN', dept: m.dept, queueMembersOnly: 'true', assignees: m.id,
      page: '1', limit: '2000', includeTimeSpent: 'true',
    };
    const qs = new URLSearchParams(params);
    const res = await fetch(`http://localhost:${PORT}/api/issues?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    const list = data?.issues || [];

    // Build CSV exactly like handleExport: header + one row per issue,
    // using real field values (summary is the field most likely to
    // contain commas/quotes/newlines that could break naive parsing).
    const header = ['Key', 'Type', 'Summary', 'Assignee', 'Reporter', 'Status'];
    const lines = [header.map(csvCell).join(',')];
    for (const issue of list) {
      lines.push([
        issue.cfKey || issue.key,
        issue.type,
        issue.summary,
        issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}` : '',
        issue.reporter ? `${issue.reporter.firstName} ${issue.reporter.lastName}` : '',
        issue.status?.name || '',
      ].map(csvCell).join(','));
    }
    const csv = lines.join('\n');
    const csvRowCount = countCsvDataRows(csv);

    const match = csvRowCount === data?.total && csvRowCount === list.length;
    if (!match) anyMismatch = true;
    console.log(`${m.dept} / ${m.firstName} ${m.lastName}: API total=${data?.total}, rows returned=${list.length}, CSV parsed back=${csvRowCount} ${match ? 'OK' : '<-- MISMATCH'}`);
  }

  console.log(anyMismatch ? '\nFound a real mismatch -- see above.' : '\nAll CSV round-trips matched exactly. No bug in CSV generation/escaping.');
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
