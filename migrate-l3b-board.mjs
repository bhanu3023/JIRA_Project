/**
 * migrate-l3b-board.mjs
 * Migrates L3 Board (L3B) from Jira into the app seed files.
 * Run: node migrate-l3b-board.mjs
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
const JIRA_DATA   = path.join(__dirname, '..', 'jira_l3b_data.json');

const loadJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

// ── load source ───────────────────────────────────────────────────────────────
console.log('Loading jira_l3b_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_l3b_data.json not found!'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── L3B statuses ──────────────────────────────────────────────────────────────
const L3B_STATUSES = [
  { id: 'st_l3b_open',             name: 'Open',                  category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_l3b_in_progress',      name: 'In Progress',           category: 'in_progress', color: '#3B82F6', order: 1 },
  { id: 'st_l3b_pending_qa',       name: 'Pending with QA',       category: 'in_progress', color: '#06B6D4', order: 2 },
  { id: 'st_l3b_waiting_presales', name: 'Waiting for Pre-Sales', category: 'in_progress', color: '#F97316', order: 3 },
  { id: 'st_l3b_reopen',           name: 'Reopen',                category: 'in_progress', color: '#EF4444', order: 4 },
  { id: 'st_l3b_resolved',         name: 'Resolved',              category: 'done',        color: '#10B981', order: 5 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return L3B_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('progress')   ? L3B_STATUSES.find(s => s.id === 'st_l3b_in_progress')      : null)
    || (n.includes('qa')         ? L3B_STATUSES.find(s => s.id === 'st_l3b_pending_qa')        : null)
    || (n.includes('pre-sales') || n.includes('presales') ? L3B_STATUSES.find(s => s.id === 'st_l3b_waiting_presales') : null)
    || (n.includes('reopen')     ? L3B_STATUSES.find(s => s.id === 'st_l3b_reopen')            : null)
    || (n.includes('resolved')   ? L3B_STATUSES.find(s => s.id === 'st_l3b_resolved')          : null)
    || L3B_STATUSES[0];
};

const mapType = (t) => {
  const n = (t || '').toLowerCase().replace(/\s+/g, '');
  if (n === 'bug')     return 'bug';
  if (n === 'story')   return 'story';
  if (n === 'epic')    return 'epic';
  if (n === 'sub-task' || n === 'subtask') return 'subtask';
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
  const member      = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['L3BOARD'] };
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
  // Unknown user — create on the fly
  const displayName = ju.displayName || '';
  const nameParts   = displayName.trim().split(' ');
  const firstName   = nameParts[0] || displayName;
  const lastName    = nameParts.slice(1).join(' ');
  const appId       = rid();
  const newMember   = { id: appId, jiraAccountId: aid, email, firstName, lastName, displayName, role: 'agent', boards: ['L3BOARD'] };
  if (aid)   memberMap.set(aid, newMember);
  if (email) memberMap.set(email, newMember);
  appMembers.push(newMember);
  return newMember;
};

// ── convert issues ────────────────────────────────────────────────────────────
console.log('Converting issues …');
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

  // Custom fields
  const productType    = f.customfield_10203?.value || null;
  const combination    = Array.isArray(f.customfield_10236) ? f.customfield_10236.map(o => o.value).filter(Boolean) : [];
  const rootCause      = extractText(f.customfield_10059);
  const fixDescription = extractText(f.customfield_10402);

  return {
    id:             rid(),
    key:            ji.key,
    summary:        f.summary || '(No summary)',
    description:    extractText(f.description),
    type:           mapType(f.issuetype?.name),
    status,
    priority:       mapPriority(f.priority?.name),
    spaceKey:       'L3BOARD',
    assignee:       assignee ? { id: assignee.id, email: assignee.email, firstName: assignee.firstName, lastName: assignee.lastName, displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim() } : null,
    reporter:       reporter ? { id: reporter.id, email: reporter.email, firstName: reporter.firstName, lastName: reporter.lastName, displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim() } : null,
    labels:         f.labels || [],
    parentKey:      f.parent?.key || null,
    comments,
    productType,
    combination,
    rootCause,
    fixDescription,
    createdAt:      f.created || new Date().toISOString(),
    updatedAt:      f.updated  || new Date().toISOString(),
  };
});
console.log(`  Converted: ${convertedIssues.length} issues`);

// ── build space ───────────────────────────────────────────────────────────────
const l3bSpace = {
  id:          rid(),
  key:         'L3BOARD',
  name:        'L3 - Board',
  type:        'scrum',
  icon:        '🔧',
  description: 'L3 Board migrated from Jira (cf2020.atlassian.net project L3B)',
  statuses:    L3B_STATUSES,
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
if (!spaceKeySet.has('L3BOARD')) {
  existingSpaces.push(l3bSpace);
} else {
  const idx = existingSpaces.findIndex(s => s.key === 'L3BOARD');
  existingSpaces[idx] = { ...existingSpaces[idx], ...l3bSpace };
}
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ L3BOARD space saved');

const existingIssues = loadJson(ISSUES_SEED) || [];
const existingKeys   = new Set(existingIssues.map(i => i.key));
let added = 0;
for (const issue of convertedIssues) {
  if (!existingKeys.has(issue.key)) {
    existingIssues.push(issue);
    existingKeys.add(issue.key);
    added++;
  }
}
saveJson(ISSUES_SEED, existingIssues);
console.log(`  ✓ Added ${added} issues (${existingIssues.length} total)`);

const existingUsers  = loadJson(USERS_SEED) || [];
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
let usersAdded = 0;
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, displayName: m.displayName, password: 'changeme123', role: 'agent', boards: ['L3BOARD'], isActive: true });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ L3B migration complete! Restart the dev server to see L3 - Board.\n');
