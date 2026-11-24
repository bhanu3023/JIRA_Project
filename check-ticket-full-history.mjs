// Read-only: full chronological timeline for one ticket -- status/field
// changes (issue_history), comments, and worklogs, all merged and sorted by
// time, plus the ticket's own current snapshot. Pass the key as argv[2].
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEY = process.argv[2];
if (!KEY) { console.log('Usage: node check-ticket-full-history.mjs CF-35182'); process.exit(1); }

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT i.*, s.name AS status_name, s.category AS status_category,
            r.email AS reporter_email, r."firstName" AS reporter_first, r."lastName" AS reporter_last,
            a.email AS assignee_email, a."firstName" AS assignee_first, a."lastName" AS assignee_last
     FROM issues i
     LEFT JOIN statuses s ON s.id = i."statusId"
     LEFT JOIN users r ON r.id = i."reporterId"
     LEFT JOIN users a ON a.id = i."assigneeId"
     WHERE i.key = $1 OR i.cf_key = $1`,
    [KEY],
  );
  if (!issueRows.length) { console.log(`Ticket ${KEY} not found.`); await pool.end(); return; }
  const issue = issueRows[0];

  console.log('=== CURRENT SNAPSHOT ===');
  console.log(`Key: ${issue.cf_key || issue.key}`);
  console.log(`Summary: ${issue.summary}`);
  console.log(`Status: ${issue.status_name} (${issue.status_category})`);
  console.log(`Current department: ${issue.current_department}`);
  console.log(`Reporter: ${issue.reporter_first || ''} ${issue.reporter_last || ''} <${issue.reporter_email || 'none'}>`);
  console.log(`Assignee: ${issue.assignee_first || ''} ${issue.assignee_last || ''} <${issue.assignee_email || 'none'}>`);
  console.log(`Created: ${issue.createdAt}`);
  console.log(`Updated: ${issue.updatedAt}`);
  console.log(`Resolved: ${issue.resolvedAt || 'not resolved'}`);
  console.log(`dept_sla_started_at: ${issue.dept_sla_started_at}`);

  const [history, comments, worklogs] = await Promise.all([
    pool.query(`SELECT * FROM issue_history WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [issue.id]),
    pool.query(`SELECT * FROM comments WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [issue.id]),
    pool.query(`SELECT * FROM issue_worklogs WHERE "issueId" = $1 ORDER BY "createdAt" ASC`, [issue.id]),
  ]);

  const events = [
    ...history.rows.map((h) => ({ t: h.createdAt, kind: 'FIELD CHANGE', who: h.authorName || h.authorEmail || 'system', detail: `${h.field}: "${h.oldValue ?? ''}" -> "${h.newValue ?? ''}"` })),
    ...comments.rows.map((c) => ({ t: c.createdAt, kind: 'COMMENT', who: c.authorName || c.authorEmail || 'unknown', detail: c.body.slice(0, 300).replace(/\s+/g, ' ') })),
    ...worklogs.rows.map((w) => ({ t: w.createdAt, kind: 'WORKLOG', who: w.authorName || w.authorEmail || 'unknown', detail: `${w.department}, ${w.timeSpentMinutes}min -- ${w.description || ''}` })),
  ].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

  console.log(`\n=== TIMELINE (${events.length} events) ===`);
  for (const e of events) {
    console.log(`[${new Date(e.t).toISOString()}] ${e.kind.padEnd(12)} by ${e.who}: ${e.detail}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
