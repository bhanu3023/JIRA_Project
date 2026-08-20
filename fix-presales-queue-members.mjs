/**
 * fix-presales-queue-members.mjs
 *
 * The Department "Move to status"/change-department dropdown only shows
 * options to a ticket's current queue members (or an admin) -- Dev and
 * Migration only LOOK like they're open to everyone because both already
 * have a broad member list (32 people each), while Pre-Sales was created
 * with just 2 members. This isn't a bug in the authorization check itself
 * (removing it would let anyone reassign anyone else's tickets); the fix
 * is to staff Pre-Sales the same way Dev/Migration already are.
 *
 * Adds every member already on the Dev and Migration queues (in the same
 * space) to the Pre-Sales queue too, keeping whoever's already on
 * Pre-Sales (Nivas B, Vignesh T) -- purely additive, no one is removed
 * from anywhere.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Run: node fix-presales-queue-members.mjs
 * Apply for real: DRY_RUN=false node fix-presales-queue-members.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    const devQueue = queues.find((q) => (q.name || '').toLowerCase() === 'dev');
    const migrationQueue = queues.find((q) => (q.name || '').toLowerCase() === 'migration');
    const presalesQueue = queues.find((q) => (q.name || '').toLowerCase() === 'pre-sales');
    if (!presalesQueue || (!devQueue && !migrationQueue)) continue;

    const before = new Set(presalesQueue.memberIds || []);
    const union = new Set(before);
    for (const id of devQueue?.memberIds || []) union.add(id);
    for (const id of migrationQueue?.memberIds || []) union.add(id);

    const added = [...union].filter((id) => !before.has(id));
    if (added.length === 0) continue;

    presalesQueue.memberIds = [...union];
    plan.push({ space: row.space_key, before: before.size, after: union.size, addedCount: added.length, addedIds: added });

    if (!DRY_RUN) {
      await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
    }
  }

  if (plan.length === 0) {
    console.log('No Pre-Sales queue found alongside a Dev/Migration queue, or nothing to add -- nothing to do.');
    await pool.end();
    return;
  }

  // Resolve added ids to human-readable names for the report.
  for (const entry of plan) {
    const users = await pool.query(`SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1::text[])`, [entry.addedIds]);
    entry.addedPeople = users.rows.map((u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email);
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} the Pre-Sales queue:`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
