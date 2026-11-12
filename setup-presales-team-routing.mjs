// One-time data change, per explicit request, on CloudFuze Board (TESTIN):
//
// 1. Dev/Infra/QA each have an existing "Routed to Pre-Sales-Old" queue
//    status (qst_dev_waitingpresales / qst_infra_waitingpresales /
//    qst_qa_waitingpresales) -- renamed in place to "Routed to
//    Pre-Sales-Team" (same id, color, category, order). The handoff target
//    department is parsed from the status NAME text at the point it's
//    picked (see performDeptHandoff's name-matching in jira-pg-api.ts), so
//    this rename alone is what redirects the handoff from the old,
//    now-unused "Pre-Sales-Old" department to "Pre-Sales-Team" going
//    forward -- no code change needed.
// 2. Migration has no pre-sales-routing status at all yet -- adds a fresh
//    "Routed to Pre-Sales-Team" entry there too.
// 3. Pre-Sales-Team itself currently has ZERO custom queueStatuses (it's
//    been running on the plain Open/In Progress/Resolved workflow this
//    whole time) -- adds its own full set: Open, In Progress, Routed to
//    Dev, Routed to Infra, Routed to QA, Resolved. Existing Pre-Sales-Team
//    tickets are unaffected until someone picks one of these for the first
//    time (getEffectiveIssueStatus falls back to the real statusId-based
//    status whenever dept_statuses['Pre-Sales-Team'] isn't set yet).
// 4. Any issue CURRENTLY sitting at one of the renamed Dev/Infra/QA
//    statuses (dept_statuses[dept].id matches) gets its own snapshot's
//    name field fixed too, so it doesn't keep showing the stale
//    "Routed to Pre-Sales-Old" text until its next status change.
//
// Dry-run by default -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'TESTIN';

const RENAMES = [
  { queueName: 'Dev',   statusId: 'qst_dev_waitingpresales' },
  { queueName: 'Infra', statusId: 'qst_infra_waitingpresales' },
  { queueName: 'QA',    statusId: 'qst_qa_waitingpresales' },
];
const NEW_NAME = 'Routed to Pre-Sales-Team';

const PRESALES_TEAM_STATUSES = [
  { id: 'qst_presalesteam_open',       name: 'Open',                      color: '#6366F1', category: 'todo',        order: 0 },
  { id: 'qst_presalesteam_inprogress', name: 'In Progress',               color: '#3B82F6', category: 'in_progress', order: 1 },
  { id: 'qst_presalesteam_waitingdev', name: 'Routed to Dev',             color: '#F59E0B', category: 'in_progress', order: 2 },
  { id: 'qst_presalesteam_waitinginfra', name: 'Routed to Infra',         color: '#F59E0B', category: 'in_progress', order: 3 },
  { id: 'qst_presalesteam_waitingqa',  name: 'Routed to QA',              color: '#F59E0B', category: 'in_progress', order: 4 },
  { id: 'qst_presalesteam_resolved',   name: 'Resolved',                  color: '#10B981', category: 'done',       order: 5 },
];

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) throw new Error(`Space ${SPACE_KEY} not found`);

  const { rows: cqRows } = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [SPACE_KEY]);
  let queues = cqRows[0]?.queues || [];
  if (typeof queues === 'string') { try { queues = JSON.parse(queues); } catch {} }

  console.log('--- Renames (Dev/Infra/QA "Routed to Pre-Sales-Old" -> "Routed to Pre-Sales-Team") ---');
  for (const r of RENAMES) {
    const q = queues.find((x) => x.name === r.queueName);
    if (!q) { console.log(`  ${r.queueName}: queue not found!`); continue; }
    const st = (q.queueStatuses || []).find((s) => s.id === r.statusId);
    if (!st) { console.log(`  ${r.queueName}: status ${r.statusId} not found!`); continue; }
    console.log(`  ${r.queueName}: "${st.name}" -> "${NEW_NAME}" (id=${st.id} unchanged)`);
    st.name = NEW_NAME;
  }

  console.log('\n--- Migration: add fresh "Routed to Pre-Sales-Team" ---');
  const migQ = queues.find((x) => x.name === 'Migration');
  if (!migQ) { console.log('  Migration queue not found!'); }
  else if ((migQ.queueStatuses || []).some((s) => s.name === NEW_NAME)) {
    console.log('  Migration already has this status -- skipping add.');
  } else {
    const maxOrder = Math.max(0, ...(migQ.queueStatuses || []).map((s) => s.order ?? 0));
    const newEntry = { id: 'qst_migration_waitingpresalesteam', name: NEW_NAME, color: '#F59E0B', category: 'in_progress', order: maxOrder + 1 };
    console.log(`  Adding: ${JSON.stringify(newEntry)}`);
    migQ.queueStatuses = [...(migQ.queueStatuses || []), newEntry];
  }

  console.log('\n--- Pre-Sales-Team: build full queueStatuses from scratch ---');
  const psQ = queues.find((x) => x.name === 'Pre-Sales-Team');
  if (!psQ) { console.log('  Pre-Sales-Team queue not found!'); }
  else if ((psQ.queueStatuses || []).length) {
    console.log(`  Pre-Sales-Team already has ${psQ.queueStatuses.length} queueStatuses -- aborting this part to avoid clobbering existing config.`);
  } else {
    console.log(`  Setting: ${PRESALES_TEAM_STATUSES.map((s) => s.name).join(', ')}`);
    psQ.queueStatuses = PRESALES_TEAM_STATUSES;
  }

  // Fix any issue currently sitting at a renamed status's stale snapshot name.
  const { rows: staleIssues } = await pool.query(
    `SELECT id, key, current_department, dept_statuses FROM issues
     WHERE "spaceId" = $1 AND dept_statuses IS NOT NULL
       AND (dept_statuses->'Dev'->>'id' = 'qst_dev_waitingpresales'
         OR dept_statuses->'Infra'->>'id' = 'qst_infra_waitingpresales'
         OR dept_statuses->'QA'->>'id' = 'qst_qa_waitingpresales')`,
    [spaceId],
  );
  console.log(`\n--- Issues currently sitting at a renamed status (stale snapshot name): ${staleIssues.length} ---`);
  for (const iss of staleIssues) console.log(`  ${iss.key} (dept=${iss.current_department})`);

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to write.');
    await pool.end();
    return;
  }

  await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), SPACE_KEY]);
  console.log('\ncustom_queues updated.');

  for (const iss of staleIssues) {
    const ds = iss.dept_statuses || {};
    for (const dept of ['Dev', 'Infra', 'QA']) {
      if (ds[dept]?.id === 'qst_dev_waitingpresales' || ds[dept]?.id === 'qst_infra_waitingpresales' || ds[dept]?.id === 'qst_qa_waitingpresales') {
        ds[dept] = { ...ds[dept], name: NEW_NAME };
      }
    }
    await pool.query(`UPDATE issues SET dept_statuses = $1::jsonb WHERE id = $2`, [JSON.stringify(ds), iss.id]);
  }
  console.log(`Fixed stale snapshot name on ${staleIssues.length} issue(s).`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
