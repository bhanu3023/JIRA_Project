// One-time data change, per explicit request: add a literal "Resolved"
// status to SAT_Board (space key SB) alongside its existing In Progress /
// Done / Open / InReview. SAT_Board has ZERO workflow_transitions rows at
// all, so the issue detail page's own "no transitions configured for this
// status -> show every status unconstrained" fallback already applies --
// confirmed via check-satboard-statuses.mjs -- meaning this new status will
// show up in the status dropdown for every ticket/every user with no further
// transition wiring needed, exactly like Done/Open/InReview already do.
import pg from 'pg';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'SB';

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) throw new Error('Space not found');

  const { rows: existing } = await pool.query(
    `SELECT id FROM statuses WHERE "spaceId" = $1 AND LOWER(name) = 'resolved'`,
    [spaceId]
  );
  if (existing.length) { console.log('A "Resolved" status already exists for SB:', existing[0]); await pool.end(); return; }

  const { rows: maxOrderRows } = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS max_order FROM statuses WHERE "spaceId" = $1`, [spaceId]);
  const nextOrder = (maxOrderRows[0]?.max_order || 0) + 1;

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES ($1, 'Resolved', 'done', '#10B981', $2, $3)`,
    [id, nextOrder, spaceId]
  );
  console.log(`Created "Resolved" status (id=${id}, order=${nextOrder}) for SB.`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
