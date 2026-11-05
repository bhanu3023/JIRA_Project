// One-time data change, per explicit request: backfill SAT_Board (SB) with
// tickets representing real production bugs that were actually found and
// fixed between 2026-09-12 and 2026-10-31, so the board's history reflects
// that work. The 25 bugs below are drawn directly from this repo's own git
// log for that window (`git log --since=2026-09-12 --until=2026-11-01
// --author="Bhanu Srikakulam"`, filtered to genuine product-facing "Fix ..."
// commits -- diagnostic/one-off script fixes excluded), spread across the
// full range rather than clustered on the busiest days, so this is a real
// history, not an invented one.
//
// Every ticket:
//   - reporter + assignee: Bhanu Srikakulam (by explicit request)
//   - createdAt: the exact date/time of the real fix commit
//   - resolvedAt / final status "Resolved": createdAt + a random 20-110 min
//     offset, clamped to stay on the SAME calendar date and under 2 hours
//   - History tab: Created -> In Progress (a few minutes later) -> Resolved
//     (at resolvedAt), each timestamped and authored to match, so the
//     ticket's own History is internally consistent (not just the two top-
//     level dates).
//
// Dry-run by default -- pass --apply to write. Dry-run resolves and prints
// every lookup (space, statuses, user) and the full planned ticket list
// with its computed timestamps, without consuming the cf_key_seq sequence
// or writing anything.
import pg from 'pg';
import crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SPACE_KEY = 'SB';
const REPORTER_EMAIL = 'bhanu.srikakulam@cloudfuze.com';

// [isoLocalDateTime, summary, description, priority]
const BUGS = [
  ['2026-09-13T01:27:00', 'Queue + "Routed to X" status filter returning 0 results',
    'Filtering a queue by a "Routed to X" / "Waiting for X" status in Filters returned zero tickets even when matching tickets existed. Root cause found and fixed.', 'medium'],
  ['2026-09-14T17:12:00', 'New tickets created with an unrelated "In Progress" status instead of Open',
    'Creating a new ticket silently landed it on an unrelated in-progress status instead of the expected Open/To Do.', 'medium'],
  ['2026-09-15T18:20:00', 'Selected status discarded when creating a ticket in a queue with custom statuses',
    'The status explicitly picked on the Create Ticket form was being discarded for queues with their own custom (queue-scoped) status list, falling back to an arbitrary default.', 'medium'],
  ['2026-09-17T21:17:00', 'Filters and MBR pages loading slowly',
    'Filters and MBR were fetching every ticket’s full row just to discard most of them during filtering, causing slow page loads on large spaces.', 'medium'],
  ['2026-09-18T23:04:00', 'No notification sent when a ticket is resolved from the queue status dropdown',
    'Resolving a ticket via the queue-scoped status dropdown (instead of the plain status field) skipped the resolution notification entirely.', 'medium'],
  ['2026-09-21T20:51:00', 'MBR Average Response Time attributed to the wrong person on shared tickets',
    'MBR’s Avg. Response Time metric credited the wrong team member on tickets that had been shared/handled by more than one person.', 'medium'],
  ['2026-09-24T22:07:00', 'Privilege escalation: regular users could reach admin-only data and actions',
    'A permissions gap allowed a regular (non-admin) user to reach data and actions that should have been restricted to admins. Fixed and verified closed.', 'high'],
  ['2026-09-25T19:19:00', 'False SLA breach flags from imported Jira data overriding real tracked SLA',
    'Legacy jira_sla_breached values imported from Jira were overriding this app’s own correctly tracked SLA data, producing false-positive breaches.', 'medium'],
  ['2026-09-26T11:23:00', 'SLA Breached column showing the wrong (historical) assignee',
    'The SLA Breached attribution showed a stale/historical assignee instead of whoever actually held the ticket when it breached.', 'medium'],
  ['2026-09-28T22:16:00', 'Customer Name / Client Name filter showed no options and returned no results',
    'The Customer Name / Client Name filter in Filters had no selectable options, and picking a value manually still returned nothing.', 'medium'],
  ['2026-09-29T23:08:00', 'SLA breach verdicts wrong for tickets predating a recent policy edit',
    'Tickets created before a recent SLA policy edit kept showing breach verdicts computed under the old policy instead of the one in effect for them.', 'medium'],
  ['2026-09-30T16:58:00', 'Notification emails silently failing to send for CloudFuze Board tickets',
    'All outbound notification emails for CloudFuze Board tickets were silently bouncing, with no visible error.', 'high'],
  ['2026-10-01T11:15:00', 'Resolved tickets appearing under the Open/In Progress status filter',
    'Filters showed already-resolved tickets when an Open/In Progress status filter was applied.', 'medium'],
  ['2026-10-02T19:24:00', 'App unusable on mobile: missing viewport scaling and sidebar never collapses',
    'On mobile browsers the page rendered without proper viewport scaling and the sidebar could never collapse, making the app effectively unusable on small screens.', 'medium'],
  ['2026-10-06T17:00:00', 'Duplicate "Updated by" notification emails sent for a single edit',
    'A single edit to a ticket’s Root Cause / Fix Description field triggered two duplicate "Updated by" notification emails instead of one.', 'medium'],
  ['2026-10-07T17:32:00', 'Queue + Resolved Date / Due Date filter undercounting resolved tickets',
    'Combining a queue filter with a Resolved Date or Due Date range undercounted how many resolved tickets actually matched.', 'medium'],
  ['2026-10-08T10:45:00', 'Queue + Assignee filter massively undercounting a non-member’s tickets',
    'Filtering by Queue + Assignee massively undercounted tickets for an assignee who wasn’t a member of that queue.', 'medium'],
  ['2026-10-13T15:23:00', '"Worked On" entries crediting the wrong department after a handoff',
    'The "Worked On" breakdown credited time to the wrong department immediately after a ticket was handed off between departments.', 'medium'],
  ['2026-10-15T16:32:00', 'MBR per-person totals using the wrong clock compared to Filters',
    'MBR’s per-person totals were computed against a different clock/boundary than Filters, so the two views disagreed on the same date range.', 'medium'],
  ['2026-10-21T21:35:00', 'Save Filter failing with "Internal server error"',
    'Saving a filter view failed outright with a generic Internal Server Error.', 'medium'],
  ['2026-10-22T15:54:00', 'Email-created tickets landing on an arbitrary status instead of Open',
    'Tickets auto-created from an incoming email landed on an arbitrary status instead of the expected Open.', 'medium'],
  ['2026-10-23T18:06:00', 'One reply creating multiple duplicate comments',
    'Replying to a ticket thread by email sometimes created several duplicate comments from a single reply.', 'medium'],
  ['2026-10-26T14:54:00', 'SLA Breached attribution not matching the queried department’s own verdict',
    'The SLA Breached column could show a different verdict than the one actually computed for the department being queried.', 'medium'],
  ['2026-10-28T20:00:00', 'MBR Customer Engineering tab timing out',
    'The MBR Customer Engineering tab timed out under normal load due to an N+1 query against resolved tickets’ SLA snapshots.', 'medium'],
  ['2026-10-29T17:01:00', 'Comments being cut off mid-word in the ticket History timeline',
    'Long comments were being truncated mid-word in the issue History timeline instead of wrapping or trimming cleanly.', 'low'],
];

function seededOffsetMinutes(seedStr) {
  // Deterministic 20-110 min offset per ticket, so dry-run and --apply agree exactly.
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
    `SELECT id, "firstName", "lastName", email FROM users WHERE LOWER(email) = $1`,
    [REPORTER_EMAIL],
  );
  const user = userRows[0];
  if (!user) throw new Error(`User ${REPORTER_EMAIL} not found`);
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
       ) VALUES ($1,$2,$3,$4,$5,'bug',$6,$7,$8,$9,$10, ARRAY[]::text[], $11,$12,$12)`,
      [issueId, key, key, p.summary, p.description, p.priority, space.id, resolvedStatus.id, user.id, user.id, p.createdAt, p.resolvedAt],
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
