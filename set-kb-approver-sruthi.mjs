// One-time write: makes Sruthi Chimata the KB approver for her team, so any
// KB article (or release note) they submit for publishing goes to her for
// approval. KB approval goes to the author's managers (users.manager_ids,
// see src/lib/kb-api.ts); that column is used for nothing else.
//
// Sruthi is ADDED to each person's managers -- anyone already set stays, and
// any one of them may approve. Articles they already submitted (status
// 'pending') get Sruthi added as an approver too; she sees them under
// "Awaiting my approval". Sruthi's own articles are left alone (nobody
// approves their own).
//
// Each name must match exactly one active user, or nothing is written.
// Dry run by default; pass --apply to write. Safe to re-run.
//   node --env-file=.env set-kb-approver-sruthi.mjs [--apply]
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const APPROVER = 'Sruthi Chimata';
const AUTHORS = [
  'Chaitanya Malle', 'Laxman Kadari', 'Pravallika', 'Sampath',
  'Sasya', 'satya.pinniti@cloudfuze.com', 'Tharun',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// "Chaitanya Malle" matches an active user whose name or email contains every
// word; a full email matches that user exactly, active or not.
async function findOne(label) {
  if (label.includes('@')) {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(NULLIF("displayName", ''), "firstName" || ' ' || "lastName") AS name, email, manager_ids FROM users
       WHERE LOWER(email) = LOWER($1)`, [label]);
    if (rows.length !== 1) throw new Error(`"${label}" matched ${rows.length} users`);
    return rows[0];
  }
  const words = label.toLowerCase().split(/\s+/);
  const { rows } = await pool.query(
    `SELECT id, COALESCE(NULLIF("displayName", ''), "firstName" || ' ' || "lastName") AS name, email, manager_ids FROM users
     WHERE "isActive" AND ${words.map((_, i) => `(LOWER(COALESCE("displayName", '') || ' ' || "firstName" || ' ' || "lastName") LIKE $${i + 1} OR LOWER(email) LIKE $${i + 1})`).join(' AND ')}`,
    words.map((w) => `%${w}%`),
  );
  if (rows.length !== 1) {
    throw new Error(`"${label}" matched ${rows.length} active users${rows.length ? ': ' + rows.map((r) => `${r.name} <${r.email}>`).join(', ') : ''}`);
  }
  return rows[0];
}

async function main() {
  const sruthi = await findOne(APPROVER);
  console.log(`Approver: ${sruthi.name} <${sruthi.email}>\n`);
  const authors = [];
  for (const label of AUTHORS) authors.push(await findOne(label));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of authors) {
      const current = a.manager_ids || [];
      const has = current.includes(sruthi.id);
      const pending = (await client.query(
        `SELECT id, title FROM kb_articles
         WHERE author_id = $1 AND status = 'pending' AND NOT ($2 = ANY(approver_ids))`,
        [a.id, sruthi.id],
      )).rows;
      console.log(`${a.name} <${a.email}>: ${has ? 'already has Sruthi' : `adding Sruthi (other managers: ${current.length})`}` +
        (pending.length ? `; ${pending.length} pending article(s) routed to her` : ''));
      if (!has) await client.query(`UPDATE users SET manager_ids = array_append(manager_ids, $1) WHERE id = $2`, [sruthi.id, a.id]);
      for (const art of pending) {
        // approver_name is what the author sees ("Waiting on X or Y").
        await client.query(
          `UPDATE kb_articles SET approver_ids = array_append(approver_ids, $2),
             approver_name = CASE WHEN COALESCE(approver_name, '') = '' THEN $3 ELSE approver_name || ' or ' || $3 END
           WHERE id = $1`,
          [art.id, sruthi.id, sruthi.name],
        );
      }
    }
    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    console.log(APPLY ? '\nDone.' : '\nDry run -- nothing written. Re-run with --apply.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; }).finally(() => pool.end());
