/**
 * add-reopen-queue-status.mjs
 *
 * Custom queues that define their own curated status list
 * (custom_queues.queues[].queueStatuses -- virtual qst_ ids, not real rows
 * in the statuses table) can only ever offer whatever's in that list. The
 * Migration queue's list (Open / Waiting for Dev / Waiting for Infra /
 * Waiting for QA / Resolved) has no "Reopen" entry at all, so a resolved
 * ticket in that queue can never be reopened from the status dropdown --
 * not a workflow-transition restriction, "Reopen" simply isn't a
 * candidate option in the first place.
 *
 * For every queue (in every space) that has a queueStatuses array and is
 * missing a status named "Reopen"/"Reopened", this adds one:
 *   { id: 'qst_reopen', name: 'Reopen', category: 'in_progress', color: '#8B5CF6' }
 *
 * If that queue ALSO defines queueTransitions (i.e. it restricts which
 * statuses are reachable from which, rather than allowing any -> any),
 * this additionally adds an explicit transition from every 'done'-category
 * status in that queue to the new Reopen status -- otherwise the new
 * status would exist but never actually be selectable from Resolved.
 *
 * The other half of "reopening should resume the SLA, not leave it paused
 * forever" is a code fix (jira-pg-api.ts), not a data change -- this
 * script only adds the missing status/transition data.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 * Purely additive -- never removes or renames an existing status/transition.
 *
 * Env vars:
 *   DATABASE_URL - optional, defaults to the local dev DB
 *   DRY_RUN      - default 'true'; pass 'false' to actually write
 *
 * Run: node add-reopen-queue-status.mjs
 * Apply for real: DRY_RUN=false node add-reopen-queue-status.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const REOPEN_ID = 'qst_reopen';

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  let queuesChecked = 0;
  let queuesUpdated = 0;
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    let changed = false;

    for (const q of queues) {
      if (!Array.isArray(q.queueStatuses) || q.queueStatuses.length === 0) continue;
      queuesChecked++;

      const hasReopen = q.queueStatuses.some((s) => /^reopen(ed)?$/i.test((s.name || '').trim()));
      if (hasReopen) continue;

      const doneStatuses = q.queueStatuses.filter((s) => s.category === 'done');
      const entry = { space: row.space_key, queue: q.name, addedTransitions: [] };

      q.queueStatuses.push({ id: REOPEN_ID, name: 'Reopen', category: 'in_progress', color: '#8B5CF6' });

      if (Array.isArray(q.queueTransitions) && q.queueTransitions.length > 0) {
        for (const ds of doneStatuses) {
          const fromId = ds.id;
          const already = q.queueTransitions.some(
            (t) => (t.fromStatusId ?? t.from) === fromId && (t.toStatusId ?? t.to) === REOPEN_ID
          );
          if (!already) {
            q.queueTransitions.push({ fromStatusId: fromId, toStatusId: REOPEN_ID, name: 'Reopen' });
            entry.addedTransitions.push(`${ds.name} -> Reopen`);
          }
        }
      } else {
        entry.addedTransitions.push('(no queueTransitions on this queue -- unconstrained, Reopen is selectable from any status)');
      }

      plan.push(entry);
      changed = true;
    }

    if (changed) {
      queuesUpdated++;
      if (!DRY_RUN) {
        await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
      }
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Checked ${queuesChecked} queue(s) with a curated status list.`);
  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${queuesUpdated} queue(s):`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
