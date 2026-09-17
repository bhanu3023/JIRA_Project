// Phase 1 inspection for the AI DevOps Incident Agent feature: lists every
// real space (board) in the system, its key, and its configured queues/
// departments, so the incident-ticket target space/department can be chosen
// against real data instead of a guess.
//
// Read-only.
//
// Usage: node inspect-spaces-for-incident-agent.mjs

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaces } = await pool.query(
    `SELECT id, key, name, type FROM spaces ORDER BY name`
  );
  console.log(`${spaces.length} space(s):\n`);
  for (const s of spaces) {
    console.log(`[${s.key}] ${s.name}  (type: ${s.type})`);
    const { rows: statuses } = await pool.query(
      `SELECT name, category FROM statuses WHERE "spaceId" = $1 ORDER BY "order"`,
      [s.id]
    );
    console.log(`  statuses: ${statuses.map(st => `${st.name}(${st.category})`).join(', ') || '(none)'}`);
    const { rows: issueCount } = await pool.query(`SELECT COUNT(*) AS cnt FROM issues WHERE "spaceId" = $1`, [s.id]);
    console.log(`  issue count: ${issueCount[0].cnt}`);
    console.log('');
  }

  // custom_queues (department/queue config) is referenced elsewhere in the
  // app as a JSONB config table -- check if it exists and what it holds for
  // CloudFuze Board / IT Administration specifically.
  const cfBoard = spaces.find(s => /cloudfuze board/i.test(s.name));
  const itAdmin = spaces.find(s => /it admin/i.test(s.name));
  for (const target of [cfBoard, itAdmin].filter(Boolean)) {
    try {
      const { rows: cq } = await pool.query(`SELECT queues FROM custom_queues WHERE "spaceId" = $1`, [target.id]);
      console.log(`custom_queues for ${target.name}:`, cq.length ? JSON.stringify(cq[0].queues).slice(0, 2000) : '(none configured)');
    } catch (e) {
      console.log(`custom_queues lookup failed for ${target.name}:`, e.message);
    }
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
