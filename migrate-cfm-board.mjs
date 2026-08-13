/**
 * migrate-cfm-board.mjs
 * Migrates CloudFuze Manage Board (CFM) from Jira into the app as "Service Management" board.
 * Run: node migrate-cfm-board.mjs
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
const JIRA_DATA   = path.join(__dirname, '..', 'jira_cfm_data.json');

const loadJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

// ── load source ───────────────────────────────────────────────────────────────
console.log('Loading jira_cfm_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_cfm_data.json not found! Run fetch-cfm.mjs first.'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── CFM statuses ──────────────────────────────────────────────────────────────
const CFM_STATUSES = [
  { id: 'st_cfm_open',          name: 'Open',                category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_cfm_todo',          name: 'To Do',               category: 'todo',        color: '#94A3B8', order: 1 },
  { id: 'st_cfm_in_progress',   name: 'In Progress',         category: 'in_progress', color: '#3B82F6', order: 2 },
  { id: 'st_cfm_pending_l2',    name: 'Pending with L2',     category: 'in_progress', color: '#8B5CF6', order: 3 },
  { id: 'st_cfm_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress', color: '#A855F7', order: 4 },
  { id: 'st_cfm_pending_qa',    name: 'Pending with QA',     category: 'in_progress', color: '#06B6D4', order: 5 },
  { id: 'st_cfm_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress', color: '#F59E0B', order: 6 },
  { id: 'st_cfm_future_event',  name: 'Future Event',        category: 'in_progress', color: '#EC4899', order: 7 },
  { id: 'st_cfm_review',        name: 'Under Review',        category: 'in_progress', color: '#F97316', order: 8 },
  { id: 'st_cfm_resolved',      name: 'Resolved',            category: 'done',        color: '#10B981', order: 9 },
  { id: 'st_cfm_closed',        name: 'Closed',              category: 'done',        color: '#059669', order: 10 },
  { id: 'st_cfm_done',          name: 'Done',                category: 'done',        color: '#16A34A', order: 11 },
  { id: 'st_cfm_canceled',      name: 'Cancelled',           category: 'done',        color: '#6B7280', order: 12 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return CFM_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('progress')    ? CFM_STATUSES.find(s => s.id === 'st_cfm_in_progress')   : null)
    || (n.includes('l2 bug')      ? CFM_STATUSES.find(s => s.id === 'st_cfm_pending_l2bug') : null)
    || (n.includes('l2')          ? CFM_STATUSES.find(s => s.id === 'st_cfm_pending_l2')    : null)
    || (n.includes('qa')          ? CFM_STATUSES.find(s => s.id === 'st_cfm_pending_qa')    : null)
    || (n.includes('l3')          ? CFM_STATUSES.find(s => s.id === 'st_cfm_waiting_l3')    : null)
    || (n.includes('future')      ? CFM_STATUSES.find(s => s.id === 'st_cfm_future_event')  : null)
    || (n.includes('review')      ? CFM_STATUSES.find(s => s.id === 'st_cfm_review')        : null)
    || (n.includes('resolved')    ? CFM_STATUSES.find(s => s.id === 'st_cfm_resolved')      : null)
    || (n.includes('closed')      ? CFM_STATUSES.find(s => s.id === 'st_cfm_closed')        : null)
    || (n.includes('done')        ? CFM_STATUSES.find(s => s.id === 'st_cfm_done')          : null)
    || (n.includes('cancel')      ? CFM_STATUSES.find(s => s.id === 'st_cfm_canceled')      : null)
    || (n === 'open'              ? CFM_STATUSES.find(s => s.id === 'st_cfm_open')          : null)
    || (n === 'to do'             ? CFM_STATUSES.find(s => s.id === 'st_cfm_todo')          : null)
    || CFM_STATUSES[0];
};

// ── issue type mapping ─────────────────────────────────────────────────────────
const mapType = (t) => {
  const n = (t || '').toLowerCase().replace(/[\s-]+/g, '');
  if (n === 'bug')                                               return 'bug';
  if (n === 'story')                                             return 'story';
  if (n === 'epic')                                              return 'epic';
  if (n === 'subtask' || n === 'sub-task')                       return 'subtask';
  if (n === 'demo')                                              return 'task';
  if (n === 'poc')                                               return 'task';
  if (n === 'emailedrequest' || n === 'emailed request')         return 'task';
  if (n === 'technicalassistance' || n === 'technical assistance') return 'task';
  if (n === 'securityassistance' || n === 'security assistance') return 'task';
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

// ── ADF text extractor ────────────────────────────────────────────────────────
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
  if (field.name) return field.name;
  if (field.content) return extractText(field);
  return '';
}

// ── build members map ─────────────────────────────────────────────────────────
const memberMap = new Map();
const appMembers = [];

for (const m of jiraMembers) {
  const accountId = m.accountId || m.key || rid();
  const displayName = m.displayName || '';
  const email = (m.emailAddress || m.email || '').toLowerCase();
  const nameParts = displayName.trim().split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName  = nameParts.slice(1).join(' ');
  const appId = rid();

  const member = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['CFMBOARD'] };
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
  const nameParts = displayName.trim().split(' ');
  const firstName = nameParts[0] || displayName;
  const lastName  = nameParts.slice(1).join(' ');
  const appId = rid();
  const newMember = { id: appId, jiraAccountId: aid, email, firstName, lastName, displayName, role: 'agent', boards: ['CFMBOARD'] };
  if (aid)   memberMap.set(aid, newMember);
  if (email) memberMap.set(email, newMember);
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
    spaceKey: 'CFMBOARD',
    assignee: assignee ? {
      id: assignee.id, email: assignee.email,
      firstName: assignee.firstName, lastName: assignee.lastName,
      displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim()
    } : null,
    reporter: reporter ? {
      id: reporter.id, email: reporter.email,
      firstName: reporter.firstName, lastName: reporter.lastName,
      displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim()
    } : null,
    labels: f.labels || [],
    parentKey: f.parent?.key || null,
    comments,
    productType: extractFieldValue(f.customfield_10203),
    combination: extractFieldValue(f.customfield_10236),
    manageClientName: extractFieldValue(f.customfield_11242),
    customerPlan: extractFieldValue(f.customfield_11344),
    testEnvironment: extractFieldValue(f.customfield_10037),
    rootCause: extractText(f.customfield_10059),
    fixDescription: extractText(f.customfield_10402),
    createdAt: f.created || new Date().toISOString(),
    updatedAt: f.updated  || new Date().toISOString(),
  };
});
console.log(`  Converted: ${convertedIssues.length} issues`);

// ── build space ───────────────────────────────────────────────────────────────
const cfmSpace = {
  id: rid(),
  key: 'CFMBOARD',
  name: 'Service Management',
  type: 'scrum',
  icon: '🛠️',
  description: 'CloudFuze Manage Board migrated from Jira (CFM project)',
  statuses: CFM_STATUSES,
  members: appMembers.map(m => ({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, role: m.role })),
  memberCount: appMembers.length,
  issueCount: convertedIssues.length,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

// Spaces
const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceIdx = existingSpaces.findIndex(s => s.key === 'CFMBOARD');
if (spaceIdx === -1) {
  existingSpaces.push(cfmSpace);
} else {
  existingSpaces[spaceIdx] = { ...existingSpaces[spaceIdx], ...cfmSpace };
}
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ CFMBOARD space saved');

// Issues — replace all CFMBOARD issues
const existingIssues = loadJson(ISSUES_SEED) || [];
const withoutCfm = existingIssues.filter(i => i.spaceKey !== 'CFMBOARD');
const merged = [...withoutCfm, ...convertedIssues];
saveJson(ISSUES_SEED, merged);
console.log(`  ✓ Saved ${convertedIssues.length} CFM issues (${merged.length} total in seed)`);

// Users
const existingUsers = loadJson(USERS_SEED) || [];
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
let usersAdded = 0;
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({
      id: m.id, email: m.email, firstName: m.firstName,
      lastName: m.lastName, displayName: m.displayName,
      password: 'changeme123', role: 'agent',
      boards: ['CFMBOARD'], isActive: true,
    });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ CFM migration complete! Restart the dev server to see Service Management board.\n');
