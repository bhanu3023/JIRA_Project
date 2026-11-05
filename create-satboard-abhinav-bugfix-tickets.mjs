// One-time data change, per explicit request: add 4 more SAT_Board (SB)
// tickets for bugs supplied directly by the user (a fix-log table for a
// different product), with reporter + assignee = Abhinav (not Bhanu this
// time). Same shape as create-satboard-bugfix-history-tickets.mjs:
// createdAt = the given fix date, resolvedAt within 2 hours on the same
// date, final status Resolved, and a Created -> In Progress -> Resolved
// History trail.
//
// Dry-run by default -- pass --apply to write. If the Abhinav lookup finds
// zero or more than one matching user, it prints the candidates and exits
// without creating anything (even under --apply), since reporter/assignee
// must be unambiguous.
import pg from 'pg';
import crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'SB';
const REPORTER_NAME_LIKE = 'abhinav';

// [isoLocalDateTime, summary, description, priority] -- no time was given in
// the source table, only a date, so each gets a distinct plausible
// business-hours time; only the DATE is significant here.
const BUGS = [
  ['2026-09-04T10:15:00', 'Marking showing zero or wrong',
    'When the AI grading service couldn’t be reached, the app gave made-up stand-in marks instead of failing visibly. Fixed so it never shows a mark the AI didn’t actually give.', 'high'],
  ['2026-09-26T14:30:00', 'Weekly test not recorded correctly',
    'Double-clicking Start created two attempts for the same week, a stuck attempt never closed on its own, and an attempt left open from the previous week could bleed into the wrong week. All three fixed.', 'medium'],
  ['2026-10-06T11:45:00', 'Timing and scheduling issues',
    'The week now closes at an exact cutoff (Sunday midnight), the intro video is excluded from counted exam time, and reminder emails go only to people who haven’t passed yet and name the actual deadline.', 'medium'],
  ['2026-10-14T16:00:00', 'Listening options appearing twice',
    'Listening test questions and their answer options could repeat within the same attempt. Rewritten so questions/options never repeat and each attempt keeps its own independent question set.', 'medium'],
];

function seededOffsetMinutes(seedStr) {
  let h = 0;
  for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 20 + (h % 91); // 20..110
}

function computeResolvedAt(createdAt, offsetMin) {
  const maxMinBeforeMidnight = (24 * 60) - 1 - (createdAt.getHours() * 60 + createdAt.getMinutes());
  const clamped = Math.max(5, Math.min(offsetMin, maxMinBeforeMidnight));
  return new Date(createdAt.getTime() + clamped * 60_000);
}

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id, name FROM spaces WHERE key = $1`, [SPACE_KEY]);
  const space = spaceRows[0];
  if (!space) throw new Error(`Space ${SPACE_KEY} not found`);

  const { rows: statusRows } = await pool.query(`SELECT id, name, category FROM statuses WHERE "spaceId" = $1`, [space.id]);
  const findStatus = (name) => statusRows.find((s) => s.name.toLowerCase() === name);
  const openStatus = findStatus('open');
  const inProgressStatus = findStatus('in progress');
  const resolvedStatus = findStatus('resolved');
  if (!openStatus || !inProgressStatus || !resolvedStatus) {
    throw new Error(`Missing one of Open/In Progress/Resolved statuses on ${SPACE_KEY}: ${JSON.stringify(statusRows)}`);
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, "firstName", "lastName", email FROM users WHERE "firstName" ILIKE $1 OR email ILIKE $1`,
    [`%${REPORTER_NAME_LIKE}%`],
  );
  if (userRows.length !== 1) {
    console.log(`Expected exactly 1 user matching "${REPORTER_NAME_LIKE}", found ${userRows.length}:`);
    for (const u of userRows) console.log(`  ${u.id}  ${u.firstName} ${u.lastName}  <${u.email}>`);
    console.log('\nAborting -- no tickets created. Re-run after confirming the right user.');
    await pool.end();
    return;
  }
  const user = userRows[0];
  const userName = `${user.firstName} ${user.lastName}`.trim() || user.email;

  console.log(`Space: ${space.name} (${SPACE_KEY}, id=${space.id})`);
  console.log(`Statuses: Open=${openStatus.id}  In Progress=${inProgressStatus.id}  Resolved=${resolvedStatus.id}`);
  console.log(`User: ${userName} <${user.email}> (id=${user.id})`);
  console.log(`\nPlanned tickets: ${BUGS.length}\n`);

  const planned = BUGS.map(([isoLocal, summary, description, priority]) => {
    const createdAt = new Date(isoLocal);
    const offset = seededOffsetMinutes(isoLocal + summary);
    const resolvedAt = computeResolvedAt(createdAt, offset);
    const inProgressAt = new Date(createdAt.getTime() + Math.min(10, Math.max(2, Math.floor(offset / 6))) * 60_000);
    return { createdAt, inProgressAt, resolvedAt, summary, description, priority };
  });

  for (const p of planned) {
    console.log(`${p.createdAt.toISOString()}  ->  ${p.resolvedAt.toISOString()}  [${p.priority}]  ${p.summary}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only -- ${planned.length} ticket(s) would be created. Rerun with --apply to write.`);
    await pool.end();
    return;
  }

  let count = 0;
  for (const p of planned) {
    const { rows: keyRows } = await pool.query(`SELECT 'CF-' || nextval('cf_key_seq') AS key`);
    const key = keyRows[0].key;
    const issueId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO issues (
         id, key, cf_key, summary, description, type, priority,
         "spaceId", "statusId", "assigneeId", "reporterId",
         labels, "createdAt", "updatedAt", "resolvedAt"
       ) VALUES ($1,$2,$3,$4,$5,'bug',$6,$7,$8,$9,$10, ARRAY[]::text[], $11,$12,$13)`,
      [issueId, key, key, p.summary, p.description, p.priority, space.id, resolvedStatus.id, user.id, user.id, p.createdAt, p.resolvedAt, p.resolvedAt],
    );

    const histRows = [
      { field: 'created', oldValue: null, newValue: `Issue created by ${userName}`, at: p.createdAt },
      { field: 'status', oldValue: openStatus.name, newValue: inProgressStatus.name, at: p.inProgressAt },
      { field: 'status', oldValue: inProgressStatus.name, newValue: resolvedStatus.name, at: p.resolvedAt },
    ];
    for (const h of histRows) {
      await pool.query(
        `INSERT INTO issue_history (id, "issueId", field, "oldValue", "newValue", "authorName", "authorEmail", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [crypto.randomUUID(), issueId, h.field, h.oldValue, h.newValue, userName, user.email, h.at],
      );
    }

    console.log(`Created ${key}: ${p.summary}`);
    count++;
  }
  console.log(`\nCreated ${count} ticket(s) on ${SPACE_KEY}.`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
