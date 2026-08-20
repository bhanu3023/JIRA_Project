/**
 * add-presales-queue-status.mjs
 *
 * Adds the new "Pre-Sales" department to the custom-queue side of the
 * department handoff system (the "Department" custom field itself is
 * updated separately in .jira-custom-fields.json).
 *
 * Two changes, both purely additive:
 *
 * 1. For every queue named "Dev" (custom_queues.queues[], any space),
 *    adds a "Waiting for Pre-Sales" status to that queue's curated
 *    queueStatuses list (skipped if already present). This is what makes
 *    "Waiting for Pre-Sales" selectable from the Dev queue's status
 *    dropdown -- the server already treats any "Waiting for <X>" status
 *    name as a generic trigger to hand the ticket off to department <X>
 *    (see performDeptHandoff / the "waiting for" regex in
 *    src/lib/jira-pg-api.ts), so no code change is needed for the actual
 *    handoff, just the status option itself.
 *    If the Dev queue also defines queueTransitions (a restricted from/to
 *    list rather than "any status is reachable"), this adds an explicit
 *    transition from every non-done status in that queue to the new
 *    status -- otherwise it would exist but never be selectable.
 *
 * 2. Creates a brand-new queue named "Pre-Sales" (unconstrained -- no
 *    queueStatuses/queueTransitions restrictions, so it behaves like a
 *    normal open queue) in the same space(s) that already have a "Dev"
 *    queue, with an empty memberIds list. Skipped if a queue with that
 *    name already exists in that space. This is the queue tickets land
 *    in once "Waiting for Pre-Sales" -> department handoff fires; an
 *    admin can add members to it via Settings/Sidebar afterwards.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually write
 *
 * Run: node add-presales-queue-status.mjs
 * Apply for real: DRY_RUN=false node add-presales-queue-status.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const WAITING_STATUS_ID = 'qst_waiting_presales';
const WAITING_STATUS_NAME = 'Waiting for Pre-Sales';
const NEW_QUEUE_NAME = 'Pre-Sales';

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    let changed = false;

    const devQueue = queues.find((q) => (q.name || '').toLowerCase() === 'dev');
    if (devQueue && Array.isArray(devQueue.queueStatuses) && devQueue.queueStatuses.length > 0) {
      const hasWaitingPresales = devQueue.queueStatuses.some(
        (s) => (s.name || '').trim().toLowerCase() === WAITING_STATUS_NAME.toLowerCase()
      );
      if (!hasWaitingPresales) {
        const entry = { space: row.space_key, queue: devQueue.name, addedStatus: WAITING_STATUS_NAME, addedTransitions: [] };
        devQueue.queueStatuses.push({ id: WAITING_STATUS_ID, name: WAITING_STATUS_NAME, category: 'in_progress', color: '#F59E0B' });

        if (Array.isArray(devQueue.queueTransitions) && devQueue.queueTransitions.length > 0) {
          const reachableFrom = devQueue.queueStatuses.filter((s) => s.category !== 'done' && s.id !== WAITING_STATUS_ID);
          for (const fromSt of reachableFrom) {
            const already = devQueue.queueTransitions.some(
              (t) => (t.fromStatusId ?? t.from) === fromSt.id && (t.toStatusId ?? t.to) === WAITING_STATUS_ID
            );
            if (!already) {
              devQueue.queueTransitions.push({ fromStatusId: fromSt.id, toStatusId: WAITING_STATUS_ID, name: WAITING_STATUS_NAME });
              entry.addedTransitions.push(`${fromSt.name} -> ${WAITING_STATUS_NAME}`);
            }
          }
        } else {
          entry.addedTransitions.push('(no queueTransitions on this queue -- unconstrained, status is selectable from any status)');
        }

        plan.push(entry);
        changed = true;
      }
    }

    // Only create the Pre-Sales queue in the same space as the Dev queue --
    // GET /department-queue?dept=<name> scans every space's custom_queues row
    // and returns the FIRST name match, so a same-named queue created in every
    // space would make the handoff land wherever that scan happens to find one
    // first, not necessarily where the ticket actually came from.
    const hasPresalesQueue = queues.some((q) => (q.name || '').toLowerCase() === NEW_QUEUE_NAME.toLowerCase());
    if (devQueue && !hasPresalesQueue) {
      queues.push({ id: `cq_presales_${row.space_key}`, name: NEW_QUEUE_NAME, memberIds: [] });
      plan.push({ space: row.space_key, addedQueue: NEW_QUEUE_NAME });
      changed = true;
    }

    if (changed && !DRY_RUN) {
      await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would apply' : 'Applied'} the following changes:`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
