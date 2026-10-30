// Creates the missing "SLA breached — Dept (Name)" History entry for every
// currently-breached ticket that has none at all, using the REAL due time
// already computed and frozen for that department (from sla_snapshot for a
// resolved ticket, or computed live from dept_sla_log for an open one), and
// the real assignee as of that exact moment (same "assignee as of this
// instant" logic the ticket detail page's SLA panel and the earlier
// name-backfill both already use).
//
// Defaults to DRY RUN. Pass --apply to actually insert the rows.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = 'http://localhost:8080';
const APPLY = process.argv.includes('--apply');

function assigneeNameAsOf(assigneeHistory, atMs) {
  let name = null;
  for (const ev of assigneeHistory) {
    if (new Date(ev.createdAt).getTime() > atMs) break;
    name = ev.newValue && ev.newValue !== 'None' ? ev.newValue : null;
  }
  return name;
}

function getGoalMs(policies, priority) {
  for (const policy of policies) {
    for (const goal of (policy.goals || [])) {
      if (goal.isPriorityGroup && Array.isArray(goal.priorityRows)) {
        const row = goal.priorityRows.find((r) => (r.priority || '').toLowerCase() === priority);
        if (row && row.timeValue !== undefined && row.timeValue !== null && row.timeValue !== '') {
          const val = parseFloat(row.timeValue);
          if (val === 0) continue;
          const unit = (row.timeUnit || 'hours').toLowerCase();
          return unit === 'minutes' ? val * 60000 : unit === 'days' ? val * 86400000 : val * 3600000;
        }
      } else if (goal.timeValue !== undefined && goal.timeValue !== null && goal.timeValue !== '') {
        const val = parseFloat(goal.timeValue);
        if (val === 0) continue;
        const unit = (goal.timeUnit || 'hours').toLowerCase();
        return unit === 'minutes' ? val * 60000 : unit === 'days' ? val * 86400000 : val * 3600000;
      }
    }
  }
  return 8 * 3600000;
}

async function makeSessionToken(adminEmail) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  const userId = rows[0].id;
  const payload = { sub: userId, ip: '', ua: 'backfill-missing-breach-history', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,'','backfill-missing-breach-history',$3) ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, userId, new Date(Date.now() + 3600 * 1000)]
  );
  return { token, tokenHash };
}

function rid() {
  return 'bf_' + crypto.randomBytes(12).toString('hex');
}

async function main() {
  const { token, tokenHash } = await makeSessionToken('bhanu.srikakulam@cloudfuze.com');
  const authHeader = { Authorization: `Bearer ${token}` };

  const policiesBySpace = {};
  const { rows: allPolicies } = await pool.query(`SELECT * FROM sla_definitions WHERE status = 'active'`);
  for (const p of allPolicies) (policiesBySpace[p.spaceId] ??= []).push(p);

  const toInsert = [];
  for (const dept of ['Dev', 'QA', 'Infra', 'Migration']) {
    const url = `${APP_URL}/api/issues?spaceKey=TESTIN&dept=${dept}&queueMembersOnly=true&slaBreached=yes&page=1&limit=500`;
    const res = await fetch(url, { headers: authHeader, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    const issues = data.issues || [];

    for (const issue of issues) {
      const { rows: already } = await pool.query(
        `SELECT 1 FROM issue_history WHERE "issueId" = $1 AND field = 'sla' AND "newValue" ILIKE $2 LIMIT 1`,
        [issue.id, `SLA breached — ${dept}%`]
      );
      if (already.length) continue;

      const { rows } = await pool.query(`
        SELECT i.id, COALESCE(i.cf_key,i.key) AS key, i.dept_sla_log, i.priority, i."spaceId", i.sla_snapshot,
               i."createdAt", i.dept_sla_started_at
        FROM issues i WHERE i.id = $1
      `, [issue.id]);
      const r = rows[0];
      const deptLogKey = Object.keys(r.dept_sla_log || {}).find((k) => k.toLowerCase() === dept.toLowerCase());
      const entry = deptLogKey ? r.dept_sla_log[deptLogKey] : null;
      const priority = (r.priority || 'medium').toLowerCase();
      const policies = (policiesBySpace[r.spaceId] || []).filter((p) => {
        const pDept = (p.dept_name || '').trim().toLowerCase();
        return !pDept || pDept === dept.toLowerCase();
      });

      // Prefer the frozen snapshot's own dueTime for this department when
      // it exists -- that's the authoritative, already-computed value.
      const snapEntry = (r.sla_snapshot || []).find((x) => (x.deptName || '').toLowerCase() === dept.toLowerCase());
      let dueTimeMs = null;
      if (snapEntry?.dueTime) {
        dueTimeMs = new Date(snapEntry.dueTime).getTime();
      } else if (entry?.started_at) {
        const goalMs = getGoalMs(policies, priority);
        const priorElapsedMs = entry.elapsed_ms || 0;
        dueTimeMs = new Date(entry.started_at).getTime() + (goalMs - priorElapsedMs);
      } else {
        // No dept_sla_log entry at all for this department -- same
        // createdAt/dept_sla_started_at fallback the live breach check
        // itself uses for a ticket that's never had a formal department
        // handoff recorded.
        const goalMs = getGoalMs(policies, priority);
        const startMs = r.dept_sla_started_at ? new Date(r.dept_sla_started_at).getTime() : new Date(r.createdAt).getTime();
        dueTimeMs = startMs + goalMs;
      }

      const { rows: histRows } = await pool.query(
        `SELECT "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'assignee' ORDER BY "createdAt" ASC`,
        [r.id]
      );
      const name = assigneeNameAsOf(histRows, dueTimeMs);
      const label = `SLA breached — ${dept}${name ? ` (${name})` : ''}`;
      toInsert.push({ issueId: r.id, key: r.key, label, createdAt: new Date(dueTimeMs) });
    }
  }

  console.log(`Missing "SLA breached" History entries to create: ${toInsert.length}`);
  console.log('\nSample (first 15):');
  for (const u of toInsert.slice(0, 15)) console.log(` - ${u.key}: "${u.label}" at ${u.createdAt.toISOString()}`);

  if (!APPLY) {
    console.log('\nDRY RUN ONLY -- no rows inserted. Re-run with --apply to actually create them.');
    await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
    await pool.end();
    return;
  }

  let inserted = 0;
  for (const u of toInsert) {
    await pool.query(
      `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
       VALUES ($1,$2,'sla',NULL,$3,'System',NULL,$4)`,
      [rid(), u.issueId, u.label, u.createdAt]
    );
    inserted++;
  }
  console.log(`\nInserted ${inserted} backfilled History entries.`);

  await pool.query(`UPDATE user_sessions SET is_revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
