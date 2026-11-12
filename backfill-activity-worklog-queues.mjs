// Files existing Ticket Worklog (activity_worklogs) entries under a queue.
// New entries get one from the Create form; older ones have queue = NULL and
// are placed by the author's queue membership -- so someone who is in BOTH
// Migration and Dev shows under both. This sets the queue on those old rows:
//
//   * author is a member of exactly ONE queue  -> filed under that queue
//   * author is in several queues              -> listed, left alone unless
//     you pass   --assign email=Queue   (or email=SPACEKEY:Queue when the
//     queue name exists in more than one space). Repeatable.
//   * author is in no queue                    -> listed, left alone
//
// Dry run by default -- pass --apply to write.
//   node backfill-activity-worklog-queues.mjs
//   node backfill-activity-worklog-queues.mjs --assign someone@cloudfuze.com=Migration --apply
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const assigns = new Map(); // email -> "SPACE:Queue" | "Queue"
process.argv.forEach((a, i) => {
  if (a === '--assign' && process.argv[i + 1]) {
    const [email, target] = process.argv[i + 1].split('=');
    if (email && target) assigns.set(email.trim().toLowerCase(), target.trim());
  }
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`ALTER TABLE activity_worklogs ADD COLUMN IF NOT EXISTS "spaceKey" TEXT, ADD COLUMN IF NOT EXISTS queue TEXT`);

  const cq = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const allQueues = []; // { spaceKey, name, memberIds }
  for (const r of cq.rows) for (const q of (r.queues || [])) {
    if (q?.name) allQueues.push({ spaceKey: r.space_key, name: String(q.name), memberIds: Array.isArray(q.memberIds) ? q.memberIds : [] });
  }

  const pending = await pool.query(`
    SELECT a."userId", COALESCE(u.email, a."authorEmail") AS email, MAX(a."authorName") AS name, COUNT(*)::int AS n,
           LOWER(COALESCE(u.role, '')) AS role
    FROM activity_worklogs a LEFT JOIN users u ON u.id = a."userId"
    WHERE a.queue IS NULL
    GROUP BY a."userId", COALESCE(u.email, a."authorEmail"), u.role
    ORDER BY name`);

  const plan = []; const unresolved = [];
  for (const p of pending.rows) {
    const email = String(p.email || '').toLowerCase();
    let target = null;
    if (assigns.has(email)) {
      const spec = assigns.get(email);
      const [a, b] = spec.includes(':') ? spec.split(':') : [null, spec];
      const matches = allQueues.filter((q) => q.name.toLowerCase() === b.toLowerCase() && (!a || q.spaceKey.toUpperCase() === a.toUpperCase()));
      if (matches.length !== 1) { unresolved.push(`${p.name} <${email}>: --assign "${spec}" matched ${matches.length} queues`); continue; }
      target = matches[0];
    } else {
      let mine = allQueues.filter((q) => q.memberIds.includes(p.userId));
      // Migration-team roles never go under Dev; if one of their queues is
      // named Migration, that's theirs.
      if (['migration_engineer', 'migration_manager'].includes(p.role)) {
        mine = mine.filter((q) => q.name.toLowerCase() !== 'dev');
        const migration = mine.filter((q) => q.name.toLowerCase() === 'migration');
        if (migration.length === 1) mine = migration;
      }
      if (mine.length === 1) target = mine[0];
      else {
        unresolved.push(`${p.name} <${email}> (${p.n} entries): ` +
          (mine.length ? `in ${mine.length} queues -- ${mine.map((q) => `${q.spaceKey}:${q.name}`).join(', ')}` : 'in no queue'));
        continue;
      }
    }
    plan.push({ ...p, email, target });
  }

  console.log('Will file:');
  for (const p of plan) console.log(`  ${p.name} <${p.email}>: ${p.n} entries -> ${p.target.spaceKey}:${p.target.name}`);
  if (unresolved.length) {
    console.log('\nLeft as-is (pass --assign email=Queue to file these):');
    for (const u of unresolved) console.log(`  ${u}`);
  }

  if (!APPLY) { console.log('\nDry run only -- rerun with --apply to save.'); await pool.end(); return; }
  for (const p of plan) {
    await pool.query(`UPDATE activity_worklogs SET "spaceKey" = $1, queue = $2 WHERE "userId" = $3 AND queue IS NULL`,
      [p.target.spaceKey, p.target.name, p.userId]);
  }
  console.log(`\nSaved: ${plan.length} people's entries filed.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
