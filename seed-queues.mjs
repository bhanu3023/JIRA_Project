/**
 * seed-queues.mjs
 * Seeds custom_queues table from department data in issues table.
 * Run on server after DB restore: node seed-queues.mjs
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db'
});

// Create table
await pool.query(`
  CREATE TABLE IF NOT EXISTS custom_queues (
    space_key TEXT PRIMARY KEY,
    queues JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// Get all spaces
const spaces = await pool.query(`SELECT id, key, name FROM spaces`);

for (const space of spaces.rows) {
  const existing = await pool.query(`SELECT queues FROM custom_queues WHERE space_key = $1`, [space.key]);
  const existingQueues = existing.rows.length > 0 ? existing.rows[0].queues : [];
  const existingNames = new Set(existingQueues.map((q) => (q.name || '').toLowerCase()));

  // Get departments actually in use in this space's real ticket data
  const depts = await pool.query(`
    SELECT DISTINCT current_department
    FROM issues
    WHERE "spaceId" = $1 AND current_department IS NOT NULL
    ORDER BY current_department
  `, [space.id]);

  if (depts.rows.length === 0) {
    console.log(existingQueues.length > 0
      ? `✓ ${space.key} (${space.name}) — already has ${existingQueues.length} queues, no department data to check against`
      : `⚠ ${space.key} (${space.name}) — no departments found, skipping`);
    continue;
  }

  // Only ADD departments missing from the existing list — never touch/remove/reorder
  // existing entries, so per-queue config (queueStatuses, memberIds, etc.) already set
  // on a queue survives. A space that "already has queues" can still be missing some:
  // e.g. a non-admin member's GET/PUT round-trip on their own queue's settings used to
  // silently drop every other queue from this same array (fixed elsewhere), which is
  // exactly the kind of gap this merge step now repairs on the next deploy instead of
  // requiring a manual DB fix.
  const missing = depts.rows.filter((d) => !existingNames.has((d.current_department || '').toLowerCase()));
  if (missing.length === 0) {
    console.log(`✓ ${space.key} (${space.name}) — already has all ${existingQueues.length} known department queue(s)`);
    continue;
  }

  const newQueues = missing.map((d, i) => ({
    id: `cq_${Date.now() + i}`,
    name: d.current_department,
    memberIds: []
  }));
  const merged = [...existingQueues, ...newQueues];

  await pool.query(
    `INSERT INTO custom_queues (space_key, queues, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (space_key) DO UPDATE SET queues = EXCLUDED.queues, updated_at = NOW()`,
    [space.key, JSON.stringify(merged)]
  );

  console.log(`✅ ${space.key} (${space.name}) — had ${existingQueues.length}, merged in ${newQueues.length} missing queue(s), now ${merged.length} total:`);
  newQueues.forEach((q) => console.log(`   + ${q.name} (${q.id})`));
}

await pool.end();
console.log('\nDone!');
