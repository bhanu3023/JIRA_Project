/**
 * migrate-infra-board.mjs
 * Reads jira_data.json (fetched from cf2020.atlassian.net project IB)
 * and merges the Infra-Board space + all 2,258 issues into the seed files.
 *
 * Run once:  node migrate-infra-board.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rid = () => crypto.randomUUID();

const ISSUES_SEED  = path.join(__dirname, '.jira-issues-seed.json');
const SPACES_SEED  = path.join(__dirname, '.jira-spaces-seed.json');
const USERS_SEED   = path.join(__dirname, '.jira-users-seed.json');
const JIRA_DATA    = path.join(__dirname, '..', 'jira_data.json');

// ── helpers ──────────────────────────────────────────────────────────────────
const loadJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const saveJson = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

// ── load source data ─────────────────────────────────────────────────────────
console.log('Loading jira_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_data.json not found!'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers, statuses: jiraStatuses } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── status mapping ────────────────────────────────────────────────────────────
const IB_STATUSES = [
  { id: 'st_ib_open',               name: 'Open',                        category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_ib_in_progress',        name: 'In Progress',                 category: 'in_progress', color: '#3B82F6', order: 1 },
  { id: 'st_ib_pending_dev',        name: 'Pending with dev',            category: 'in_progress', color: '#8B5CF6', order: 2 },
  { id: 'st_ib_pending_qa',         name: 'Pending with QA',             category: 'in_progress', color: '#06B6D4', order: 3 },
  { id: 'st_ib_pending_migration',  name: 'Pending with Migration',      category: 'in_progress', color: '#F97316', order: 4 },
  { id: 'st_ib_waiting_migration',  name: 'Waiting for Migration Team',  category: 'in_progress', color: '#F59E0B', order: 5 },
  { id: 'st_ib_reopen',             name: 'Reopen',                      category: 'in_progress', color: '#EF4444', order: 6 },
  { id: 'st_ib_resolved',           name: 'Resolved',                    category: 'done',        color: '#10B981', order: 7 },
  { id: 'st_ib_closed',             name: 'Closed',                      category: 'done',        color: '#059669', order: 8 },
];

// map Jira status name → our status object
const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return IB_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('progress')   ? IB_STATUSES.find(s => s.id === 'st_ib_in_progress')   : null)
    || (n.includes('resolved')   ? IB_STATUSES.find(s => s.id === 'st_ib_resolved')       : null)
    || (n.includes('closed')     ? IB_STATUSES.find(s => s.id === 'st_ib_closed')         : null)
    || (n.includes('reopen')     ? IB_STATUSES.find(s => s.id === 'st_ib_reopen')         : null)
    || (n.includes('migration')  ? IB_STATUSES.find(s => s.id === 'st_ib_pending_migration') : null)
    || (n.includes('pending')    ? IB_STATUSES.find(s => s.id === 'st_ib_pending_dev')    : null)
    || IB_STATUSES[0];
};

// priority mapping
const mapPriority = (p) => {
  const n = (p || '').toLowerCase();
  if (n === 'highest') return 'highest';
  if (n === 'high')    return 'high';
  if (n === 'medium')  return 'medium';
  if (n === 'low')     return 'low';
  if (n === 'lowest')  return 'lowest';
  return 'medium';
};

// issue type mapping
const mapType = (t) => {
  const n = (t || '').toLowerCase();
  if (n === 'bug')      return 'bug';
  if (n === 'story')    return 'story';
  if (n === 'epic')     return 'epic';
  if (n === 'sub-task' || n === 'subtask') return 'subtask';
  return 'task';
};

// ── build members map ─────────────────────────────────────────────────────────
const memberMap = new Map(); // accountId → member object
const appMembers = [];       // members with app-style IDs

for (const m of jiraMembers) {
  const accountId = m.accountId || m.key || rid();
  const displayName = m.displayName || '';
  const email = m.emailAddress || m.email || '';
  const nameParts = displayName.split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName  = nameParts.slice(1).join(' ');
  const appId = rid();

  const member = {
    id: appId,
    jiraAccountId: accountId,
    email,
    firstName,
    lastName,
    displayName,
    role: 'agent',
    boards: ['INFRABOARD'],
  };
  memberMap.set(accountId, member);
  if (email) memberMap.set(email.toLowerCase(), member);
  appMembers.push(member);
}

// resolve a Jira user field → our member object
const resolvePerson = (jiraUser) => {
  if (!jiraUser) return null;
  const aid = jiraUser.accountId || jiraUser.key || '';
  const email = (jiraUser.emailAddress || '').toLowerCase();
  return memberMap.get(aid) || (email ? memberMap.get(email) : null) || {
    id: aid,
    email,
    firstName: (jiraUser.displayName || '').split(' ')[0] || '',
    lastName:  (jiraUser.displayName || '').split(' ').slice(1).join(' ') || '',
    displayName: jiraUser.displayName || '',
  };
};

// ── convert Jira issues → app issues ─────────────────────────────────────────
console.log('Converting issues …');
const convertedIssues = jiraIssues.map((ji) => {
  const f = ji.fields || {};
  const status = statusByName(f.status?.name);
  const assignee = resolvePerson(f.assignee);
  const reporter = resolvePerson(f.reporter);

  // comments
  const comments = (f.comment?.comments || []).map((c) => {
    const author = resolvePerson(c.author);
    const bodyText = extractText(c.body);
    return {
      id: rid(),
      body: bodyText,
      authorId: author?.id || '',
      authorName: author ? `${author.firstName} ${author.lastName}`.trim() : 'Unknown',
      authorEmail: author?.email || '',
      createdAt: c.created,
      updatedAt: c.updated || c.created,
    };
  });

  return {
    id: rid(),
    key: ji.key,                          // IB-1, IB-2, …
    summary: f.summary || '(No summary)',
    description: extractText(f.description),
    type: mapType(f.issuetype?.name),
    status,
    priority: mapPriority(f.priority?.name),
    spaceKey: 'INFRABOARD',
    assignee: assignee ? {
      id: assignee.id,
      email: assignee.email,
      firstName: assignee.firstName,
      lastName: assignee.lastName,
      displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim(),
    } : null,
    reporter: reporter ? {
      id: reporter.id,
      email: reporter.email,
      firstName: reporter.firstName,
      lastName: reporter.lastName,
      displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim(),
    } : null,
    labels: (f.labels || []),
    parentKey: f.parent?.key || null,
    comments,
    createdAt: f.created || new Date().toISOString(),
    updatedAt: f.updated  || new Date().toISOString(),
  };
});

console.log(`  Converted: ${convertedIssues.length} issues`);

// ── build the INFRABOARD space object ─────────────────────────────────────────
const ibSpace = {
  id: rid(),
  key: 'INFRABOARD',
  name: 'Infra-Board',
  type: 'scrum',
  icon: '🏗️',
  description: 'Infra-Board migrated from Jira (cf2020.atlassian.net project IB)',
  statuses: IB_STATUSES,
  members: appMembers.map(m => ({
    id: m.id,
    email: m.email,
    firstName: m.firstName,
    lastName: m.lastName,
    role: m.role,
  })),
  memberCount: appMembers.length,
  issueCount: convertedIssues.length,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

// Spaces seed
const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceKeys = new Set(existingSpaces.map(s => s.key));
if (!spaceKeys.has('INFRABOARD')) {
  existingSpaces.push(ibSpace);
  saveJson(SPACES_SEED, existingSpaces);
  console.log('  ✓ Added INFRABOARD space');
} else {
  // update it
  const idx = existingSpaces.findIndex(s => s.key === 'INFRABOARD');
  existingSpaces[idx] = { ...existingSpaces[idx], ...ibSpace };
  saveJson(SPACES_SEED, existingSpaces);
  console.log('  ✓ Updated INFRABOARD space');
}

// Issues seed — skip if key already exists
const existingIssues = loadJson(ISSUES_SEED) || [];
const existingKeys = new Set(existingIssues.map(i => i.key));
let added = 0;
for (const issue of convertedIssues) {
  if (!existingKeys.has(issue.key)) {
    existingIssues.push(issue);
    existingKeys.add(issue.key);
    added++;
  }
}
saveJson(ISSUES_SEED, existingIssues);
console.log(`  ✓ Added ${added} new issues (${existingIssues.length} total in seed)`);

// Users seed — merge new users
const existingUsers = loadJson(USERS_SEED) || [];
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
let usersAdded = 0;
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({
      id: m.id,
      email: m.email,
      firstName: m.firstName,
      lastName: m.lastName,
      displayName: m.displayName,
      password: 'changeme123',
      role: 'agent',
      boards: ['INFRABOARD'],
      isActive: true,
    });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ Migration complete! Restart the dev server to see Infra-Board.\n');

// ── helper: extract plain text from Atlassian Document Format (ADF) ───────────
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(extractText).join('');
  }
  return '';
}
