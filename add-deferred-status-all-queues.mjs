// Adds a "Deferred" status to EVERY queue (in every space) that has its own
// custom status list (queueStatuses), the same way the Dev queue got one via
// add-dev-queue-deferred-status.mjs. Picking "Deferred" in a queue hands the
// ticket back to the department that originally raised it (see the
// isDeferred handoff in jira-pg-api.ts).
//
// Queues WITHOUT their own status list (they borrow the space workflow via
// statusIds, or fall back to Open / In Progress / Resolved) are listed but
// NOT changed: giving them a custom list here would replace the statuses they
// show today. Add "Deferred" to those from Space > Queue > Workflow instead.
//
// If a queue restricts which statuses can follow which (queueTransitions),
// a transition to Deferred is added from each of its not-done statuses so
// Deferred actually appears in the status dropdown.
//
// Dry run by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const STATUS_NAME = 'Deferred';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`SELECT space_key, queues FROM custom_queues ORDER BY space_key`);
  let changedSpaces = 0;
  const skipped = [];

  for (const row of rows) {
    const queues = Array.isArray(row.queues) ? row.queues : [];
    let spaceChanged = false;

    const updatedQueues = queues.map((q) => {
      const label = `${row.space_key} / ${q.name}`;
      const statuses = Array.isArray(q.queueStatuses) ? q.queueStatuses : [];
      if (!statuses.length) {
        skipped.push(label);
        return q;
      }
      if (statuses.some((s) => String(s.name || '').trim().toLowerCase() === STATUS_NAME.toLowerCase())) {
        console.log(`  ${label}: already has "${STATUS_NAME}" -- unchanged`);
        return q;
      }

      const newStatus = {
        id: `qst_deferred_${String(q.id || q.name).replace(/[^a-zA-Z0-9_]/g, '_')}`,
        name: STATUS_NAME,
        color: '#6b7280',
        category: 'todo',
        order: statuses.length,
      };
      const transitions = Array.isArray(q.queueTransitions) ? q.queueTransitions : [];
      const newTransitions = transitions.length
        ? statuses
            .filter((s) => s.category !== 'done')
            .map((s) => ({ from: s.id, to: newStatus.id }))
        : [];

      console.log(`  ${label}: will add "${STATUS_NAME}"` +
        (newTransitions.length ? ` (+${newTransitions.length} transitions into it)` : ''));
      spaceChanged = true;
      return {
        ...q,
        queueStatuses: [...statuses, newStatus],
        ...(transitions.length ? { queueTransitions: [...transitions, ...newTransitions] } : {}),
      };
    });

    if (spaceChanged) {
      changedSpaces++;
      if (APPLY) {
        await pool.query(`UPDATE custom_queues SET queues = $1 WHERE space_key = $2`, [JSON.stringify(updatedQueues), row.space_key]);
      }
    }
  }

  if (skipped.length) {
    console.log(`\nNot changed (no custom status list -- add "${STATUS_NAME}" from Space > Queue > Workflow if needed):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  console.log(APPLY
    ? `\nSaved. Updated ${changedSpaces} space(s).`
    : `\nDry run only -- ${changedSpaces} space(s) would change. Rerun with --apply to save.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
