/**
 * sync-all-assignees.mjs
 * Syncs assignee + reporter for every ticket across ALL boards from Jira.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import https from 'https';
import crypto from 'crypto';

const rid     = () => crypto.randomUUID();
const DB_URL  = 'postgresql://postgres:neutara123@localhost:5432/neutara_db';
const adapter = new PrismaPg({ connectionString: DB_URL });
const prisma  = new PrismaClient({ adapter });

const AUTH = Buffer.from(
  'sujana.manapuram@cloudfuze.com:REDACTED_API_TOKEN'
).toString('base64');

// App board key â†’ Jira project key
const BOARD_MAP = {
  L2BOARD:   'L2B',
  L1BOAR:    'CFITS',
  INFRABOARD:'IB',
  QABOAR:    'QAB',
  PSMBOARD:  'PSM',
  CFMBOARD:  'CFM',
  L3BOARD:   'L3B',
  MBBOARD:   'MB',
  EBBOARD:   'EB',
  SOPSBOARD: 'SOPS',
  CBBOARD:   'CB',
};

function jiraReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Basic ${AUTH}`, Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request(
      { hostname: 'cf2020.atlassian.net', path: urlPath, method, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } }); }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchAssigneesForProject(jiraKey) {
  const issueMap = new Map(); // jira key â†’ { assignee, reporter }
  let nextPageToken = null;
  do {
    const body = {
      jql: `project = ${jiraKey} ORDER BY created DESC`,
      maxResults: 100,
      fields: ['assignee', 'reporter', 'summary'],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraReq('POST', '/rest/api/3/search/jql', body);
    if (res.errorMessages || res.errors) {
      console.error(`  âš ï¸  Jira error for ${jiraKey}:`, JSON.stringify(res).slice(0, 120));
      break;
    }
    for (const ji of (res.issues || [])) {
      issueMap.set(ji.key, { assignee: ji.fields?.assignee || null, reporter: ji.fields?.reporter || null, summary: ji.fields?.summary || '' });
    }
    nextPageToken = res.nextPageToken || null;
    if ((res.issues || []).length < 100) break;
    await new Promise(r => setTimeout(r, 200));
  } while (nextPageToken);
  return issueMap;
}

// Global user cache
let allUsers = [];
const byEmail = new Map();
const accountToDbId = new Map();

async function initUsers() {
  allUsers = await prisma.user.findMany({ select: { id: true, email: true, displayName: true, firstName: true, lastName: true } });
  for (const u of allUsers) byEmail.set(u.email.toLowerCase(), u);
}

async function resolvePerson(ju) {
  if (!ju) return null;
  const aid = ju.accountId || '';
  if (accountToDbId.has(aid)) return accountToDbId.get(aid);

  const email       = (ju.emailAddress || ju.email || '').toLowerCase();
  const displayName = (ju.displayName || '').trim();

  if (email && byEmail.has(email)) {
    accountToDbId.set(aid, byEmail.get(email).id);
    return byEmail.get(email).id;
  }
  // Match by display name
  if (displayName) {
    const lc = displayName.toLowerCase();
    const match = allUsers.find(u =>
      (u.displayName || '').toLowerCase() === lc ||
      `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase() === lc
    );
    if (match) { accountToDbId.set(aid, match.id); return match.id; }
  }
  // Create new user
  const emailToUse = email || `jira_${aid.slice(0, 10)}@cloudfuze.com`;
  const parts = displayName.split(/\s+/);
  try {
    const u = await prisma.user.upsert({
      where:  { email: emailToUse },
      create: {
        id: rid(), email: emailToUse,
        firstName: parts[0] || displayName || 'Unknown',
        lastName:  parts.slice(1).join(' '),
        displayName: displayName || emailToUse,
        password: 'changeme123', role: 'agent', isActive: true,
      },
      update: {
        displayName: displayName || undefined,
        firstName: parts[0] || undefined,
        lastName:  parts.slice(1).join(' ') || undefined,
      },
    });
    accountToDbId.set(aid, u.id);
    byEmail.set(emailToUse, u);
    allUsers.push(u);
    return u.id;
  } catch { return null; }
}

async function syncBoard(spaceKey, jiraKey) {
  process.stdout.write(`\nðŸ“‹ ${spaceKey} (Jira: ${jiraKey})\n`);

  // Get all DB issues for this space
  const space = await prisma.space.findUnique({ where: { key: spaceKey } });
  if (!space) { console.log(`   âš ï¸  Space ${spaceKey} not found in DB â€” skipping`); return { fixed: 0, ok: 0 }; }

  const dbIssues = await prisma.issue.findMany({
    where: { spaceId: space.id },
    select: { id: true, key: true, assigneeId: true, reporterId: true, updatedAt: true },
  });
  if (dbIssues.length === 0) { console.log(`   âš ï¸  No issues in DB â€” skipping`); return { fixed: 0, ok: 0 }; }

  const dbMap = new Map(dbIssues.map(i => [i.key, i]));

  // Fetch from Jira
  const jiraMap = await fetchAssigneesForProject(jiraKey);
  console.log(`   DB: ${dbIssues.length} | Jira: ${jiraMap.size}`);

  let fixed = 0, ok = 0, skipped = 0;

  for (const [jiraTicketKey, { assignee, reporter }] of jiraMap) {
    const db = dbMap.get(jiraTicketKey);
    if (!db) { skipped++; continue; }

    const assigneeId = await resolvePerson(assignee);
    const reporterId = await resolvePerson(reporter);

    if (db.assigneeId !== assigneeId || db.reporterId !== reporterId) {
      await prisma.issue.update({
        where: { id: db.id },
        // updatedAt is @updatedAt in the schema, so Prisma silently resets it
        // to "now" on any update that doesn't pass it explicitly -- this is
        // a data-correction sync, not real ticket activity, so preserve the
        // real (Jira-sourced) updatedAt instead of stomping it.
        data: { assigneeId: assigneeId ?? null, reporterId: reporterId ?? null, updatedAt: db.updatedAt },
      });
      fixed++;
      if (fixed <= 5) {
        // Show first 5 fixes as sample
        console.log(`   ðŸ”„ ${jiraTicketKey} â†’ assignee: ${assignee?.displayName || 'Unassigned'}`);
      } else if (fixed === 6) {
        console.log(`   ðŸ”„ ... (more fixes)`);
      }
    } else {
      ok++;
    }
  }

  console.log(`   âœ… Fixed: ${fixed} | Already OK: ${ok} | Not in DB: ${skipped}`);
  return { fixed, ok };
}

async function main() {
  console.log('ðŸ”„ Syncing assignees for ALL boards from Jira...\n');
  console.log('Board map:');
  for (const [app, jira] of Object.entries(BOARD_MAP)) console.log(`  ${app.padEnd(14)} â†’ Jira: ${jira}`);

  await initUsers();
  console.log(`\nLoaded ${allUsers.length} existing users from DB`);

  const totals = { fixed: 0, ok: 0 };

  for (const [spaceKey, jiraKey] of Object.entries(BOARD_MAP)) {
    const result = await syncBoard(spaceKey, jiraKey);
    totals.fixed += result.fixed;
    totals.ok    += result.ok;
  }

  console.log(`\n${'â•'.repeat(55)}`);
  console.log(`âœ… ALL BOARDS SYNC COMPLETE`);
  console.log(`   Total fixed  : ${totals.fixed}`);
  console.log(`   Already OK   : ${totals.ok}`);

  // Final summary per board
  console.log('\nðŸ“Š Final assignee breakdown per board:');
  const summary = await prisma.$queryRaw`
    SELECT sp.key,
           COUNT(DISTINCT i.id)::int as total,
           COUNT(DISTINCT CASE WHEN i."assigneeId" IS NOT NULL THEN i.id END)::int as assigned,
           COUNT(DISTINCT CASE WHEN i."assigneeId" IS NULL THEN i.id END)::int as unassigned
    FROM spaces sp
    LEFT JOIN issues i ON i."spaceId" = sp.id
    GROUP BY sp.key
    ORDER BY total DESC
  `;
  console.log('  BOARD'.padEnd(18), 'TOTAL'.padEnd(8), 'ASSIGNED'.padEnd(10), 'UNASSIGNED');
  console.log('  ' + 'â”€'.repeat(48));
  for (const r of summary) {
    if (r.total === 0) continue;
    console.log(`  ${r.key.padEnd(16)} ${String(r.total).padEnd(8)} ${String(r.assigned).padEnd(10)} ${r.unassigned}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

