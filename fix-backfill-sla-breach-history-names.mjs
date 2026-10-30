// Backfills the assignee name onto OLD "SLA breached — Dept" History
// entries that predate the CF-34582 fix (which made new breach events log
// "SLA breached — Dept (Name)" going forward, but never touched existing
// rows). For each old-format row, replays the ticket's own assignee
// history to find who was actually assigned AT THE EXACT MOMENT that row
// was created (same "assignee as of this instant" logic the ticket detail
// page's SLA panel already uses), and appends that name.
//
// Defaults to DRY RUN. Pass --apply to actually write the corrections.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

function assigneeNameAsOf(assigneeHistory, atMs) {
  let name = null;
  for (const ev of assigneeHistory) {
    if (new Date(ev.createdAt).getTime() > atMs) break;
    name = ev.newValue && ev.newValue !== 'None' ? ev.newValue : null;
  }
  return name;
}

async function main() {
  const client = await pool.connect();
  try {
    // Old-format rows: "SLA breached — <Dept>" with no trailing "(Name)".
    const { rows: oldRows } = await client.query(`
      SELECT h.id, h."issueId", h."newValue", h."createdAt"
      FROM issue_history h
      WHERE h.field = 'sla'
        AND h."newValue" ~ '^SLA breached — [^(]+$'
    `);
    console.log(`Old-format "SLA breached" rows (no name attached): ${oldRows.length}`);

    // Group by issueId so we only fetch each ticket's assignee history once.
    const byIssue = new Map();
    for (const r of oldRows) {
      if (!byIssue.has(r.issueId)) byIssue.set(r.issueId, []);
      byIssue.get(r.issueId).push(r);
    }
    console.log(`Across ${byIssue.size} distinct tickets.`);

    let resolved = 0, noAssigneeAtTime = 0;
    const updates = [];
    for (const [issueId, rowsForIssue] of byIssue) {
      const { rows: histRows } = await client.query(
        `SELECT "oldValue", "newValue", "createdAt" FROM issue_history WHERE "issueId" = $1 AND field = 'assignee' ORDER BY "createdAt" ASC`,
        [issueId]
      );
      for (const r of rowsForIssue) {
        const name = assigneeNameAsOf(histRows, new Date(r.createdAt).getTime());
        if (!name) { noAssigneeAtTime++; continue; }
        const dept = r.newValue.replace(/^SLA breached — /, '').trim();
        const newLabel = `SLA breached — ${dept} (${name})`;
        updates.push({ id: r.id, oldValue: r.newValue, newValue: newLabel });
        resolved++;
      }
    }

    console.log(`\nRows where an assignee-at-that-moment was found: ${resolved}`);
    console.log(`Rows with no assignee at all at that time (left unchanged -- genuinely unassigned then): ${noAssigneeAtTime}`);
    console.log('\nSample (first 10):');
    for (const u of updates.slice(0, 10)) console.log(` - "${u.oldValue}" -> "${u.newValue}"`);

    if (!APPLY) {
      console.log('\nDRY RUN ONLY -- no rows changed. Re-run with --apply to actually update.');
      return;
    }

    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(`UPDATE issue_history SET "newValue" = $1 WHERE id = $2`, [u.newValue, u.id]);
    }
    await client.query('COMMIT');
    console.log(`\nUpdated ${updates.length} history rows.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
