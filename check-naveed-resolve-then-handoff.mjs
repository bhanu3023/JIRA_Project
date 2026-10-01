// The 16 tickets Naveed flagged all show the SAME pattern: he's credited
// reason='passed' in Dev, even on tickets where dept_assignees.Dev itself
// names him as the real handler. Pulls full status/assignee/department
// history for a sample of them to confirm the exact mechanism: does he
// personally change status to Resolved (real work) in the same action that
// hands the ticket to Migration, only for the 'passed' handoff-credit
// write to fire and the 'worked' credit to get skipped by the
// reassigningToSomeoneElse guard?
//
// Read-only.
//
// Usage: node check-naveed-resolve-then-handoff.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-29906', 'CF-29897', 'CF-29857', 'CF-29589', 'CF-29817', 'CF-29567'];

async function main() {
  for (const key of KEYS) {
    const { rows } = await pool.query(`SELECT id FROM issues WHERE cf_key = $1 OR key = $1`, [key]);
    if (!rows.length) { console.log(`${key}: NOT FOUND`); continue; }
    const issueId = rows[0].id;
    console.log(`\n=== ${key} ===`);
    const { rows: hist } = await pool.query(
      `SELECT field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt"
       FROM issue_history
       WHERE "issueId" = $1 AND field IN ('status','assignee','department')
       ORDER BY "createdAt" ASC`,
      [issueId]
    );
    for (const h of hist) {
      console.log(`  [${h.createdAt.toISOString()}] ${h.field}: "${h.oldValue}" -> "${h.newValue}"  (by ${h.authorName} <${h.authorEmail}>)`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
