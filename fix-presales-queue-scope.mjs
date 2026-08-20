/**
 * fix-presales-queue-scope.mjs
 *
 * Corrects a mistake made by add-presales-queue-status.mjs: that script
 * created a "Pre-Sales" queue in EVERY space that has a custom_queues row
 * (it should only have created one in the space that actually has a "Dev"
 * queue). Because GET /department-queue?dept=<name> scans every space's
 * custom_queues row and returns the FIRST name match, having several
 * same-named "Pre-Sales" queues across different spaces makes the
 * department handoff land in whichever one happens to be returned first --
 * not necessarily the one next to the Dev queue tickets actually came from.
 *
 * This removes the "Pre-Sales" queue from every space EXCEPT the one(s)
 * that also contain a "Dev" queue, leaving exactly one "Pre-Sales" queue
 * in place. Only ever deletes a queue that has no memberIds and no
 * queueStatuses/queueTransitions (i.e. still exactly as
 * add-presales-queue-status.mjs left it, untouched by an admin since) --
 * if someone has already configured it, this leaves it alone and reports
 * it instead so it can be reviewed manually.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Run: node fix-presales-queue-scope.mjs
 * Apply for real: DRY_RUN=false node fix-presales-queue-scope.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';
const QUEUE_NAME = 'Pre-Sales';

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    const hasDevQueue = queues.some((q) => (q.name || '').toLowerCase() === 'dev');
    if (hasDevQueue) continue; // this is the space to KEEP Pre-Sales in

    const idx = queues.findIndex((q) => (q.name || '').toLowerCase() === QUEUE_NAME.toLowerCase());
    if (idx === -1) continue;

    const q = queues[idx];
    const untouched = (!q.memberIds || q.memberIds.length === 0)
      && (!q.queueStatuses || q.queueStatuses.length === 0)
      && (!q.queueTransitions || q.queueTransitions.length === 0);

    if (!untouched) {
      plan.push({ space: row.space_key, skipped: 'Pre-Sales queue has been configured since creation -- review manually', queue: q });
      continue;
    }

    queues.splice(idx, 1);
    plan.push({ space: row.space_key, removedQueue: QUEUE_NAME });

    if (!DRY_RUN) {
      await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would apply' : 'Applied'} the following changes:`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
