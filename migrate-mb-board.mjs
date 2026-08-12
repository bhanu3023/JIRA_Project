/**
 * migrate-mb-board.mjs
 * Migrates Message Migration Backlogs (MB) from Jira into the app.
 * Run: node migrate-mb-board.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rid = () => crypto.randomUUID();

const ISSUES_SEED = path.join(__dirname, '.jira-issues-seed.json');
const SPACES_SEED = path.join(__dirname, '.jira-spaces-seed.json');
const USERS_SEED  = path.join(__dirname, '.jira-users-seed.json');
const JIRA_DATA   = path.join(__dirname, '..', 'jira_mb_data.json');

const loadJson = (file) => { try { let r = fs.readFileSync(file, 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

console.log('Loading jira_mb_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_mb_data.json not found! Run fetch-mb.mjs first.'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── MB statuses ───────────────────────────────────────────────────────────────
const MB_STATUSES = [
  { id: 'st_mb_todo',          name: 'To Do',               category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_mb_open',          name: 'Open',                category: 'todo',        color: '#94A3B8', order: 1 },
  { id: 'st_mb_in_progress',   name: 'In Progress',         category: 'in_progress', color: '#3B82F6', order: 2 },
  { id: 'st_mb_pending_l2',    name: 'Pending with L2',     category: 'in_progress', color: '#8B5CF6', order: 3 },
  { id: 'st_mb_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress', color: '#A855F7', order: 4 },
  { id: 'st_mb_pending_qa',    name: 'Pending with QA',     category: 'in_progress', color: '#06B6D4', order: 5 },
  { id: 'st_mb_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress', color: '#F59E0B', order: 6 },
  { id: 'st_mb_review',        name: 'Under Review',        category: 'in_progress', color: '#F97316', order: 7 },
  { id: 'st_mb_resolved',      name: 'Resolved',            category: 'done',        color: '#10B981', order: 8 },
  { id: 'st_mb_closed',        name: 'Closed',              category: 'done',        color: '#059669', order: 9 },
  { id: 'st_mb_done',          name: 'Done',                category: 'done',        color: '#16A34A', order: 10 },
  { id: 'st_mb_canceled',      name: 'Cancelled',           category: 'done',        color: '#6B7280', order: 11 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return MB_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('progress')  ? MB_STATUSES.find(s => s.id === 'st_mb_in_progress')   : null)
    || (n.includes('l2 bug')    ? MB_STATUSES.find(s => s.id === 'st_mb_pending_l2bug') : null)
    || (n.includes('l2')        ? MB_STATUSES.find(s => s.id === 'st_mb_pending_l2')    : null)
    || (n.includes('qa')        ? MB_STATUSES.find(s => s.id === 'st_mb_pending_qa')    : null)
    || (n.includes('l3')        ? MB_STATUSES.find(s => s.id === 'st_mb_waiting_l3')    : null)
    || (n.includes('review')    ? MB_STATUSES.find(s => s.id === 'st_mb_review')        : null)
    || (n.includes('resolved')  ? MB_STATUSES.find(s => s.id === 'st_mb_resolved')      : null)
    || (n.includes('closed')    ? MB_STATUSES.find(s => s.id === 'st_mb_closed')        : null)
    || (n.includes('done')      ? MB_STATUSES.find(s => s.id === 'st_mb_done')          : null)
    || (n.includes('cancel')    ? MB_STATUSES.find(s => s.id === 'st_mb_canceled')      : null)
    || (n === 'open'            ? MB_STATUSES.find(s => s.id === 'st_mb_open')          : null)
    || MB_STATUSES[0];
};

const mapType = (t) => {
  const n = (t || '').toLowerCase().replace(/[\s-]+/g, '');
  if (n === 'bug')       return 'bug';
  if (n === 'story')     return 'story';
  if (n === 'epic')      return 'epic';
  if (n.includes('sub')) return 'subtask';
  return 'task';
};

const mapPriority = (p) => {
  const n = (p || '').toLowerCase();
  if (n === 'highest') return 'highest';
  if (n === 'high')    return 'high';
  if (n === 'medium')  return 'medium';
  if (n === 'low')     return 'low';
  if (n === 'lowest')  return 'lowest';
  return 'medium';
};

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(' ');
  return '';
}

function extractFieldValue(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  if (Array.isArray(field)) return field.map(v => extractFieldValue(v)).filter(Boolean).join(', ');
  if (field.value) return field.value;
  if (field.name)  return field.name;
  if (field.content) return extractText(field);
  return '';
}

// ── members ───────────────────────────────────────────────────────────────────
const memberMap = new Map();
const appMembers = [];

const existingUsers = loadJson(USERS_SEED) || [];
const nameToEmail = new Map();
for (const u of existingUsers) {
  if (u.email) {
    const full = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase();
    if (full) nameToEmail.set(full, u.email);
  }
}

for (const m of jiraMembers) {
  const accountId = m.accountId || m.key || rid();
  const displayName = m.displayName || '';
  const email = (m.emailAddress || m.email || nameToEmail.get(displayName.toLowerCase()) || '').toLowerCase();
  const nameParts = displayName.trim().split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName  = nameParts.slice(1).join(' ');
  const appId = rid();
  const member = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['MBBOARD'] };
  memberMap.set(accountId, member);
  if (email) memberMap.set(email, member);
  appMembers.push(member);
}

const resolvePerson = (ju) => {
  if (!ju) return null;
  const aid = ju.accountId || ju.key || '';
  const email = (ju.emailAddress || ju.email || '').toLowerCase();
  const found = memberMap.get(aid) || (email ? memberMap.get(email) : null);
  if (found) return found;
  const displayName = ju.displayName || '';
  const lookedUpEmail = nameToEmail.get(displayName.toLowerCase()) || '';
  const nameParts = displayName.trim().split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName  = nameParts.slice(1).join(' ');
  const appId = rid();
  const newMember = { id: appId, jiraAccountId: aid, email: email || lookedUpEmail, firstName, lastName, displayName, role: 'agent', boards: ['MBBOARD'] };
  if (aid)   memberMap.set(aid, newMember);
  if (email || lookedUpEmail) memberMap.set(email || lookedUpEmail, newMember);
  appMembers.push(newMember);
  return newMember;
};

// ── convert issues ────────────────────────────────────────────────────────────
console.log('Converting issues …');
const convertedIssues = jiraIssues.map((ji) => {
  const f = ji.fields || {};
  const status   = statusByName(f.status?.name);
  const assignee = resolvePerson(f.assignee);
  const reporter = resolvePerson(f.reporter);

  const comments = (f.comment?.comments || []).map((c) => {
    const author = resolvePerson(c.author);
    return {
      id: rid(),
      body: extractText(c.body),
      authorId: author?.id || '',
      authorName: author ? `${author.firstName} ${author.lastName}`.trim() : 'Unknown',
      authorEmail: author?.email || '',
      createdAt: c.created,
      updatedAt: c.updated || c.created,
    };
  });

  return {
    id: rid(),
    key: ji.key,
    summary: f.summary || '(No summary)',
    description: extractText(f.description),
    type: mapType(f.issuetype?.name),
    workType: f.issuetype?.name || '',
    status,
    priority: mapPriority(f.priority?.name),
    spaceKey: 'MBBOARD',
    assignee: assignee ? { id: assignee.id, email: assignee.email, firstName: assignee.firstName, lastName: assignee.lastName, displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim() } : null,
    reporter: reporter ? { id: reporter.id, email: reporter.email, firstName: reporter.firstName, lastName: reporter.lastName, displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim() } : null,
    labels: f.labels || [],
    parentKey: f.parent?.key || null,
    comments,
    productType:      extractFieldValue(f.customfield_10203),
    combination:      extractFieldValue(f.customfield_10236),
    rootCause:        extractText(f.customfield_10059),
    fixDescription:   extractText(f.customfield_10402),
    manageClientName: extractFieldValue(f.customfield_11242),
    customerPlan:     extractFieldValue(f.customfield_11344),
    testEnvironment:  extractFieldValue(f.customfield_10037),
    createdAt: f.created || new Date().toISOString(),
    updatedAt: f.updated  || new Date().toISOString(),
  };
});
console.log(`  Converted: ${convertedIssues.length} issues`);

const statusCounts = {};
for (const i of convertedIssues) { statusCounts[i.status.name] = (statusCounts[i.status.name] || 0) + 1; }
console.log('  Status breakdown:', statusCounts);

// ── build space ───────────────────────────────────────────────────────────────
const mbSpace = {
  id: rid(),
  key: 'MBBOARD',
  name: 'Message Migration Backlogs',
  type: 'scrum',
  icon: null,
  description: 'Message Migration Backlogs board migrated from Jira (MB project)',
  statuses: MB_STATUSES,
  members: appMembers.map(m => ({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, role: m.role })),
  memberCount: appMembers.length,
  issueCount: convertedIssues.length,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceIdx = existingSpaces.findIndex(s => s.key === 'MBBOARD');
if (spaceIdx === -1) { existingSpaces.push(mbSpace); }
else { existingSpaces[spaceIdx] = { ...existingSpaces[spaceIdx], ...mbSpace }; }
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ MBBOARD space saved');

const existingIssues = loadJson(ISSUES_SEED) || [];
const withoutMB = existingIssues.filter(i => i.spaceKey !== 'MBBOARD');
saveJson(ISSUES_SEED, [...withoutMB, ...convertedIssues]);
console.log(`  ✓ Saved ${convertedIssues.length} MB issues (${withoutMB.length + convertedIssues.length} total)`);

let usersAdded = 0;
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, displayName: m.displayName, password: 'changeme123', role: 'agent', boards: ['MBBOARD'], isActive: true });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ MB migration complete! Restart the dev server to see Message Migration Backlogs board.\n');
