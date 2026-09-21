// Naved Osama and Adari Venkata Jaswanth both show a flat 0:00:00 Avg.
// response time across 49 and 40 resolved tickets respectively, while
// teammates on the same MBR tab (Rehan Khan, Vishal Kumar, Pragati Pandey)
// show real, varied nonzero values. Not random -- something systemic about
// how THEIR tickets reach "In Progress" specifically. Pulls a sample of
// each person's real tickets and their full status history around
// dept_sla_started_at to see whether the "In Progress" transition is
// genuinely simultaneous with department arrival for them (e.g. an
// auto-assignment path that also auto-sets status, unlike a manually
// routed ticket where a human has to click into it later).
//
// Read-only.
//
// Usage: node check-naved-jaswanth-response-time.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const IN_PROGRESS_NAMES = new Set(['in progress', 'work in progress']);
const EMAILS = ['naved.osama@cloudfuze.com', 'jaswanth.adari@cloudfuze.com'];

function computeResponseTimeHours(statusHist, deptStartedAt) {
  if (!deptStartedAt) return null;
  const startMs = new Date(deptStartedAt).getTime();
  for (const h of statusHist) {
    if (!IN_PROGRESS_NAMES.has(String(h.newValue || '').trim().toLowerCase())) continue;
    const t = new Date(h.createdAt).getTime();
    if (t < startMs) continue;
    return { hours: Math.round((t - startMs) / 1000) / 3600, diffMs: t - startMs };
  }
  return null;
}

async function main() {
  for (const email of EMAILS) {
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userRows[0]?.id;
    if (!userId) { console.log(`${email}: not found`); continue; }

    console.log(`\n\n========== ${email} ==========`);
    const { rows: issues } = await pool.query(
      `SELECT id, cf_key, key, current_department, dept_sla_started_at
       FROM issues WHERE "assigneeId" = $1 AND dept_sla_started_at IS NOT NULL
       ORDER BY "updatedAt" DESC LIMIT 12`,
      [userId]
    );

    for (const issue of issues) {
      const { rows: hist } = await pool.query(
        `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt" FROM issue_history
         WHERE "issueId" = $1 ORDER BY "createdAt" ASC`,
        [issue.id]
      );
      const statusHist = hist.filter(h => h.field === 'status');
      const result = computeResponseTimeHours(statusHist, issue.dept_sla_started_at);
      console.log(`\n${issue.cf_key || issue.key} (dept=${issue.current_department}): responseTime=${result ? result.hours + 'h (diff ' + result.diffMs + 'ms)' : 'null (never started)'}`);
      console.log(`  dept_sla_started_at: ${new Date(issue.dept_sla_started_at).toISOString()}`);
      for (const h of hist.filter(h => h.field === 'status' || h.field === 'department' || h.field === 'assignee')) {
        console.log(`    [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}" (by ${h.authorName || h.authorEmail || 'system'})`);
      }
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
