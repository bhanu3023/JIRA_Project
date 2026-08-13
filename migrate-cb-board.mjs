/**
 * migrate-cb-board.mjs
 * Migrates Content Migration Backlog (CB) from Jira into the app.
 * Run: node migrate-cb-board.mjs
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
const JIRA_DATA   = path.join(__dirname, '..', 'jira_cb_data.json');

const loadJson = (file) => { try { let r = fs.readFileSync(file, 'utf8'); if (r.charCodeAt(0) === 0xFEFF) r = r.slice(1); return JSON.parse(r); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

console.log('Loading jira_cb_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_cb_data.json not found! Run fetch-cb.mjs first.'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── CB statuses ───────────────────────────────────────────────────────────────
const CB_STATUSES = [
  { id: 'st_cb_todo',          name: 'To Do',                     category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_cb_open',          name: 'Open',                      category: 'todo',        color: '#94A3B8', order: 1 },
  { id: 'st_cb_current_sprint',name: 'Current Sprint Feb 20th',   category: 'in_progress', color: '#6366F1', order: 2 },
  { id: 'st_cb_in_progress',   name: 'In Progress',               category: 'in_progress', color: '#3B82F6', order: 3 },
  { id: 'st_cb_pending_l2',    name: 'Pending with L2',           category: 'in_progress', color: '#8B5CF6', order: 4 },
  { id: 'st_cb_pending_l2bug', name: 'Pending with L2 Bug',       category: 'in_progress', color: '#A855F7', order: 5 },
  { id: 'st_cb_pending_qa',    name: 'Pending with QA',           category: 'in_progress', color: '#06B6D4', order: 6 },
  { id: 'st_cb_waiting_l3',    name: 'Waiting for L3',            category: 'in_progress', color: '#F59E0B', order: 7 },
  { id: 'st_cb_review',        name: 'Under Review',              category: 'in_progress', color: '#F97316', order: 8 },
  { id: 'st_cb_resolved',      name: 'Resolved',                  category: 'done',        color: '#10B981', order: 9 },
  { id: 'st_cb_closed',        name: 'Closed',                    category: 'done',        color: '#059669', order: 10 },
  { id: 'st_cb_done',          name: 'Done',                      category: 'done',        color: '#16A34A', order: 11 },
  { id: 'st_cb_canceled',      name: 'Cancelled',                 category: 'done',        color: '#6B7280', order: 12 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return CB_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('sprint')    ? CB_STATUSES.find(s => s.id === 'st_cb_current_sprint') : null)
    || (n.includes('progress')  ? CB_STATUSES.find(s => s.id === 'st_cb_in_progress')   : null)
    || (n.includes('l2 bug')    ? CB_STATUSES.find(s => s.id === 'st_cb_pending_l2bug') : null)
    || (n.includes('l2')        ? CB_STATUSES.find(s => s.id === 'st_cb_pending_l2')    : null)
    || (n.includes('qa')        ? CB_STATUSES.find(s => s.id === 'st_cb_pending_qa')    : null)
    || (n.includes('l3')        ? CB_STATUSES.find(s => s.id === 'st_cb_waiting_l3')    : null)
    || (n.includes('review')    ? CB_STATUSES.find(s => s.id === 'st_cb_review')        : null)
    || (n.includes('resolved')  ? CB_STATUSES.find(s => s.id === 'st_cb_resolved')      : null)
    || (n.includes('closed')    ? CB_STATUSES.find(s => s.id === 'st_cb_closed')        : null)
    || (n.includes('done')      ? CB_STATUSES.find(s => s.id === 'st_cb_done')          : null)
    || (n.includes('cancel')    ? CB_STATUSES.find(s => s.id === 'st_cb_canceled')      : null)
    || (n === 'open'            ? CB_STATUSES.find(s => s.id === 'st_cb_open')          : null)
    || CB_STATUSES[0];
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
  const member = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['CBBOARD'] };
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
  const newMember = { id: appId, jiraAccountId: aid, email: email || lookedUpEmail, firstName, lastName, displayName, role: 'agent', boards: ['CBBOARD'] };
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
    spaceKey: 'CBBOARD',
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
const cbSpace = {
  id: rid(),
  key: 'CBBOARD',
  name: 'Content Migration Backlog',
  type: 'scrum',
  icon: null,
  description: 'Content Migration Backlog board migrated from Jira (CB project)',
  statuses: CB_STATUSES,
  members: appMembers.map(m => ({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, role: m.role })),
  memberCount: appMembers.length,
  issueCount: convertedIssues.length,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceIdx = existingSpaces.findIndex(s => s.key === 'CBBOARD');
if (spaceIdx === -1) { existingSpaces.push(cbSpace); }
else { existingSpaces[spaceIdx] = { ...existingSpaces[spaceIdx], ...cbSpace }; }
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ CBBOARD space saved');

const existingIssues = loadJson(ISSUES_SEED) || [];
const withoutCB = existingIssues.filter(i => i.spaceKey !== 'CBBOARD');
saveJson(ISSUES_SEED, [...withoutCB, ...convertedIssues]);
console.log(`  ✓ Saved ${convertedIssues.length} CB issues (${withoutCB.length + convertedIssues.length} total)`);

let usersAdded = 0;
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, displayName: m.displayName, password: 'changeme123', role: 'agent', boards: ['CBBOARD'], isActive: true });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ CB migration complete! Restart the dev server to see Content Migration Backlog board.\n');
