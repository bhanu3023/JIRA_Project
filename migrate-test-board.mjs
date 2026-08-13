/**
 * migrate-test-board.mjs
 * Migrates QA Projects (TEST) from Jira into the app seed files.
 * Run: node migrate-test-board.mjs
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
const JIRA_DATA   = path.join(__dirname, '..', 'jira_test_data.json');

const loadJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

console.log('Loading jira_test_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_test_data.json not found!'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── TEST board statuses ───────────────────────────────────────────────────────
const TEST_STATUSES = [
  { id: 'st_test_todo',        name: 'To Do',        category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_test_inprogress',  name: 'In Progress',  category: 'in_progress', color: '#3B82F6', order: 1 },
  { id: 'st_test_qa_review',   name: 'QA Review',    category: 'in_progress', color: '#06B6D4', order: 2 },
  { id: 'st_test_code_review', name: 'Code Review',  category: 'in_progress', color: '#8B5CF6', order: 3 },
  { id: 'st_test_resolved',    name: 'Resolved',     category: 'done',        color: '#10B981', order: 4 },
  { id: 'st_test_canceled',    name: 'Canceled',     category: 'done',        color: '#EF4444', order: 5 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  if (n.includes('progress'))    return TEST_STATUSES.find(s => s.id === 'st_test_inprogress');
  if (n.includes('qa'))          return TEST_STATUSES.find(s => s.id === 'st_test_qa_review');
  if (n.includes('code'))        return TEST_STATUSES.find(s => s.id === 'st_test_code_review');
  if (n.includes('resolved'))    return TEST_STATUSES.find(s => s.id === 'st_test_resolved');
  if (n.includes('cancel'))      return TEST_STATUSES.find(s => s.id === 'st_test_canceled');
  if (n === 'to do' || n === 'open') return TEST_STATUSES[0];
  return TEST_STATUSES[0];
};

const mapType = (t) => {
  const n = (t || '').toLowerCase().replace(/[\s-]+/g, '');
  if (n === 'bug')           return 'bug';
  if (n === 'story')         return 'story';
  if (n === 'epic')          return 'epic';
  if (n === 'subtask' || n === 'subtest' || n === 'subtestexecution') return 'subtask';
  if (n === 'testplan')      return 'test_plan';
  if (n === 'test')          return 'test';
  if (n === 'testexecution') return 'test_execution';
  if (n === 'testset')       return 'test_set';
  if (n === 'precondition')  return 'precondition';
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

// ADF text extractor
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join('');
  return '';
}

// ── build members map ─────────────────────────────────────────────────────────
const memberMap = new Map();
const appMembers = [];

for (const m of jiraMembers) {
  const accountId   = m.accountId || m.key || rid();
  const displayName = m.displayName || '';
  const email       = (m.emailAddress || m.email || '').toLowerCase();
  const nameParts   = displayName.trim().split(' ');
  const firstName   = nameParts[0] || displayName;
  const lastName    = nameParts.slice(1).join(' ');
  const appId       = rid();
  const member      = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['TESTBOARD'] };
  memberMap.set(accountId, member);
  if (email) memberMap.set(email, member);
  appMembers.push(member);
}

const resolvePerson = (ju) => {
  if (!ju) return null;
  const aid   = ju.accountId || ju.key || '';
  const email = (ju.emailAddress || ju.email || '').toLowerCase();
  const found = memberMap.get(aid) || (email ? memberMap.get(email) : null);
  if (found) return found;
  const displayName = ju.displayName || '';
  const nameParts   = displayName.trim().split(' ');
  const firstName   = nameParts[0] || displayName;
  const lastName    = nameParts.slice(1).join(' ');
  const appId       = rid();
  const newMember   = { id: appId, jiraAccountId: aid, email, firstName, lastName, displayName, role: 'agent', boards: ['TESTBOARD'] };
  if (aid)   memberMap.set(aid, newMember);
  if (email) memberMap.set(email, newMember);
  appMembers.push(newMember);
  return newMember;
};

// ── convert issues ────────────────────────────────────────────────────────────
console.log('Converting issues …');
let done = 0;
const convertedIssues = jiraIssues.map((ji) => {
  const f        = ji.fields || {};
  const status   = statusByName(f.status?.name);
  const assignee = resolvePerson(f.assignee);
  const reporter = resolvePerson(f.reporter);

  const comments = (f.comment?.comments || []).map((c) => {
    const author = resolvePerson(c.author);
    return {
      id:          rid(),
      body:        extractText(c.body),
      authorId:    author?.id || '',
      authorName:  author ? `${author.firstName} ${author.lastName}`.trim() : 'Unknown',
      authorEmail: author?.email || '',
      createdAt:   c.created,
      updatedAt:   c.updated || c.created,
    };
  });

  const productType      = f.customfield_10203?.value || null;
  const combination      = Array.isArray(f.customfield_10236) ? f.customfield_10236.map(o => o.value).filter(Boolean) : [];
  const testEnvironment  = extractText(f.customfield_10037) || (typeof f.customfield_10037 === 'string' ? f.customfield_10037 : null);
  const manageClientName = Array.isArray(f.customfield_11242) ? f.customfield_11242.map(o => o.value || o.name || o).filter(Boolean) : (f.customfield_11242?.value || null);
  const customerPlan     = Array.isArray(f.customfield_11344) ? f.customfield_11344.map(o => o.value || o.name || o).filter(Boolean) : (f.customfield_11344?.value || null);
  const description      = extractText(f.description);
  const workType         = f.issuetype?.name || 'Task';

  done++;
  if (done % 5000 === 0) console.log(`  Processed ${done}/${jiraIssues.length}`);

  return {
    id:             rid(),
    key:            ji.key,
    summary:        f.summary || '(No summary)',
    description,
    type:           mapType(workType),
    workType,
    status,
    priority:       mapPriority(f.priority?.name),
    spaceKey:       'TESTBOARD',
    assignee:       assignee ? { id: assignee.id, email: assignee.email, firstName: assignee.firstName, lastName: assignee.lastName, displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim() } : null,
    reporter:       reporter ? { id: reporter.id, email: reporter.email, firstName: reporter.firstName, lastName: reporter.lastName, displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim() } : null,
    labels:         f.labels || [],
    parentKey:      f.parent?.key || null,
    comments,
    productType,
    combination,
    testEnvironment,
    manageClientName,
    customerPlan,
    createdAt:      f.created || new Date().toISOString(),
    updatedAt:      f.updated  || new Date().toISOString(),
  };
});
console.log(`  Converted: ${convertedIssues.length} issues`);

// ── build space ───────────────────────────────────────────────────────────────
const testSpace = {
  id:          rid(),
  key:         'TESTBOARD',
  name:        'QA Projects - Test Board',
  type:        'scrum',
  icon:        '🧪',
  description: 'QA Projects Test Board migrated from Jira (cf2020.atlassian.net project TEST)',
  statuses:    TEST_STATUSES,
  members:     appMembers.map(m => ({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, role: m.role })),
  memberCount: appMembers.length,
  issueCount:  convertedIssues.length,
  createdAt:   new Date().toISOString(),
  updatedAt:   new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceKeySet = new Set(existingSpaces.map(s => s.key));
if (!spaceKeySet.has('TESTBOARD')) {
  existingSpaces.push(testSpace);
} else {
  const idx = existingSpaces.findIndex(s => s.key === 'TESTBOARD');
  existingSpaces[idx] = { ...existingSpaces[idx], ...testSpace };
}
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ TESTBOARD space saved');

// Remove old TESTBOARD issues, replace with freshly converted ones
const existingIssues = (loadJson(ISSUES_SEED) || []).filter(i => i.spaceKey !== 'TESTBOARD');
for (const issue of convertedIssues) existingIssues.push(issue);
saveJson(ISSUES_SEED, existingIssues);
console.log(`  ✓ Replaced TESTBOARD issues. Total: ${existingIssues.length}`);

const existingUsers  = loadJson(USERS_SEED) || [];
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
let usersAdded = 0;
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, displayName: m.displayName, password: 'changeme123', role: 'agent', boards: ['TESTBOARD'], isActive: true });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ TEST Board migration complete! Restart the dev server to see QA Projects - Test Board.\n');
