/**
 * migrate-l2b-board.mjs
 * Migrates L2 Board (L2B) from Jira into the app seed files.
 * Run: node migrate-l2b-board.mjs
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
const JIRA_DATA   = path.join(__dirname, '..', 'jira_l2b_data.json');

const loadJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

// ── load source ───────────────────────────────────────────────────────────────
console.log('Loading jira_l2b_data.json …');
const jiraData = loadJson(JIRA_DATA);
if (!jiraData) { console.error('jira_l2b_data.json not found! Run fetch-l2b.mjs first.'); process.exit(1); }

const { issues: jiraIssues, members: jiraMembers } = jiraData;
console.log(`  Issues:  ${jiraIssues.length}`);
console.log(`  Members: ${jiraMembers.length}`);

// ── L2B statuses ──────────────────────────────────────────────────────────────
const L2B_STATUSES = [
  { id: 'st_l2b_open',               name: 'Open',                  category: 'todo',        color: '#64748B', order: 0 },
  { id: 'st_l2b_in_progress',        name: 'In Progress',           category: 'in_progress', color: '#3B82F6', order: 1 },
  { id: 'st_l2b_waiting_l1',         name: 'Waiting for L1',        category: 'in_progress', color: '#8B5CF6', order: 2 },
  { id: 'st_l2b_pending_qa',         name: 'Pending with QA',       category: 'in_progress', color: '#06B6D4', order: 3 },
  { id: 'st_l2b_waiting_presales',   name: 'Waiting for Pre-Sales', category: 'in_progress', color: '#F97316', order: 4 },
  { id: 'st_l2b_waiting_l3',         name: 'Waiting for L3',        category: 'in_progress', color: '#F59E0B', order: 5 },
  { id: 'st_l2b_pending_l3',         name: 'Pending with L3',       category: 'in_progress', color: '#A855F7', order: 6 },
  { id: 'st_l2b_waiting_customer',   name: 'Waiting for Customer',  category: 'in_progress', color: '#EC4899', order: 7 },
  { id: 'st_l2b_reopen',             name: 'Reopen',                category: 'in_progress', color: '#EF4444', order: 8 },
  { id: 'st_l2b_pending_infra',      name: 'Pending with Infra',    category: 'in_progress', color: '#14B8A6', order: 9 },
  { id: 'st_l2b_resolved',           name: 'Resolved',              category: 'done',        color: '#10B981', order: 10 },
];

const statusByName = (name) => {
  const n = (name || '').toLowerCase().trim();
  return L2B_STATUSES.find(s => s.name.toLowerCase() === n)
    || (n.includes('progress')   ? L2B_STATUSES.find(s => s.id === 'st_l2b_in_progress')      : null)
    || (n.includes('waiting for l1') || n === 'waiting for l1' ? L2B_STATUSES.find(s => s.id === 'st_l2b_waiting_l1') : null)
    || (n.includes('pre-sales') || n.includes('presales') ? L2B_STATUSES.find(s => s.id === 'st_l2b_waiting_presales') : null)
    || (n.includes('waiting for l3') ? L2B_STATUSES.find(s => s.id === 'st_l2b_waiting_l3')   : null)
    || (n.includes('pending with l3') || n.includes('pending l3') ? L2B_STATUSES.find(s => s.id === 'st_l2b_pending_l3') : null)
    || (n.includes('pending') && n.includes('qa') ? L2B_STATUSES.find(s => s.id === 'st_l2b_pending_qa') : null)
    || (n.includes('waiting') && n.includes('qa') ? L2B_STATUSES.find(s => s.id === 'st_l2b_pending_qa') : null)
    || (n.includes('customer')   ? L2B_STATUSES.find(s => s.id === 'st_l2b_waiting_customer') : null)
    || (n.includes('reopen')     ? L2B_STATUSES.find(s => s.id === 'st_l2b_reopen')           : null)
    || (n.includes('infra')      ? L2B_STATUSES.find(s => s.id === 'st_l2b_pending_infra')    : null)
    || (n.includes('resolved')   ? L2B_STATUSES.find(s => s.id === 'st_l2b_resolved')         : null)
    || L2B_STATUSES[0];
};

const mapType = (t) => {
  const n = (t || '').toLowerCase().replace(/\s+/g, '');
  if (n === 'bug')                    return 'bug';
  if (n === 'story')                  return 'story';
  if (n === 'epic')                   return 'epic';
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

  const member = { id: appId, jiraAccountId: accountId, email, firstName, lastName, displayName, role: 'agent', boards: ['L2BOARD'] };
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

  // Unknown user — create on the fly so ticket keeps its assignee
  const displayName = ju.displayName || '';
  const nameParts   = displayName.trim().split(' ');
  const firstName   = nameParts[0] || displayName;
  const lastName    = nameParts.slice(1).join(' ');
  const appId       = rid();
  const newMember   = { id: appId, jiraAccountId: aid, email, firstName, lastName, displayName, role: 'agent', boards: ['L2BOARD'] };
  if (aid)   memberMap.set(aid, newMember);
  if (email) memberMap.set(email, newMember);
  appMembers.push(newMember);
  return newMember;
};

// ── ADF text extractor ────────────────────────────────────────────────────────
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join('');
  return '';
}

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

  // ── Custom fields ─────────────────────────────────────────────────────────
  // Product Type (single select)
  const productType = f.customfield_10203?.value || null;
  // Combination (multi select)
  const combination = Array.isArray(f.customfield_10236)
    ? f.customfield_10236.map(o => o.value).filter(Boolean)
    : [];
  // Root Cause (ADF textarea)
  const rootCause = extractText(f.customfield_10059);
  // Fix Description (ADF textarea)
  const fixDescription = extractText(f.customfield_10402);
  // Project Manager (multi select)
  const projectManager = Array.isArray(f.customfield_11380)
    ? f.customfield_11380.map(o => o.value).filter(Boolean)
    : [];

  return {
    id:          rid(),
    key:         ji.key,
    summary:     f.summary || '(No summary)',
    description: extractText(f.description),
    type:        mapType(f.issuetype?.name),
    status,
    priority:    mapPriority(f.priority?.name),
    spaceKey:    'L2BOARD',
    assignee:    assignee ? { id: assignee.id, email: assignee.email, firstName: assignee.firstName, lastName: assignee.lastName, displayName: assignee.displayName || `${assignee.firstName} ${assignee.lastName}`.trim() } : null,
    reporter:    reporter ? { id: reporter.id, email: reporter.email, firstName: reporter.firstName, lastName: reporter.lastName, displayName: reporter.displayName || `${reporter.firstName} ${reporter.lastName}`.trim() } : null,
    labels:      f.labels || [],
    parentKey:   f.parent?.key || null,
    comments,
    // L2B-specific custom fields
    productType,
    combination,
    rootCause,
    fixDescription,
    projectManager,
    createdAt:   f.created || new Date().toISOString(),
    updatedAt:   f.updated  || new Date().toISOString(),
  };
});
console.log(`  Converted: ${convertedIssues.length} issues`);

// ── build space ───────────────────────────────────────────────────────────────
const L2B_CUSTOM_FIELDS = [
  {
    id: 'cf_l2b_product_type', key: 'productType', label: 'Product Type',
    type: 'select', spaceKey: 'L2BOARD',
    options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'],
  },
  {
    id: 'cf_l2b_combination', key: 'combination', label: 'Combination',
    type: 'multiselect', spaceKey: 'L2BOARD',
    options: [
      'Box - OneDrive','Box - SharePoint','Box - Teams','Box - Google Drive',
      'Dropbox - Onedrive','Dropbox - SharePoint','Dropbox - Google Drive',
      'MyDrive - Onedrive','MyDrive - SharePoint',
      'Shared Drive - Shared Drive','Shared Drive - Onedrive','Shared Drive - SharePoint',
      'Egnyte - Onedrive','Egnyte - SharePoint',
      'NFS - Onedrive','NFS - SharePoint',
      'Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Teams to Slack',
      'Gmail - Gmail','Gmail - Outlook','Outlook - Outlook',
      'Other','Others',
    ],
  },
  {
    id: 'cf_l2b_root_cause', key: 'rootCause', label: 'Root Cause',
    type: 'textarea', spaceKey: 'L2BOARD', options: [],
  },
  {
    id: 'cf_l2b_fix_description', key: 'fixDescription', label: 'Fix Description',
    type: 'textarea', spaceKey: 'L2BOARD', options: [],
  },
  {
    id: 'cf_l2b_project_manager', key: 'projectManager', label: 'Project Manager',
    type: 'multiselect', spaceKey: 'L2BOARD',
    options: ['Harika','Abhishek','Ajay Singh','Abhishikth','Raghu','Lakshmi Prasanna','Sri Ram','Chandra Mouli'],
  },
];

const l2bSpace = {
  id:           rid(),
  key:          'L2BOARD',
  name:         'L2 - Board',
  type:         'scrum',
  icon:         '🖥️',
  description:  'L2 Board migrated from Jira (cf2020.atlassian.net project L2B)',
  statuses:     L2B_STATUSES,
  customFields: L2B_CUSTOM_FIELDS,
  members:      appMembers.map(m => ({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, role: m.role })),
  memberCount:  appMembers.length,
  issueCount:   convertedIssues.length,
  createdAt:    new Date().toISOString(),
  updatedAt:    new Date().toISOString(),
};

// ── merge into seed files ─────────────────────────────────────────────────────
console.log('Merging into seed files …');

// Spaces
const existingSpaces = loadJson(SPACES_SEED) || [];
const spaceKeySet = new Set(existingSpaces.map(s => s.key));
if (!spaceKeySet.has('L2BOARD')) {
  existingSpaces.push(l2bSpace);
} else {
  const idx = existingSpaces.findIndex(s => s.key === 'L2BOARD');
  existingSpaces[idx] = { ...existingSpaces[idx], ...l2bSpace };
}
saveJson(SPACES_SEED, existingSpaces);
console.log('  ✓ L2BOARD space saved');

// Issues
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

// Users
const existingUsers  = loadJson(USERS_SEED) || [];
const existingEmails = new Set(existingUsers.map(u => (u.email || '').toLowerCase()));
let usersAdded = 0;
for (const m of appMembers) {
  const email = (m.email || '').toLowerCase();
  if (email && !existingEmails.has(email)) {
    existingUsers.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, displayName: m.displayName, password: 'changeme123', role: 'agent', boards: ['L2BOARD'], isActive: true });
    existingEmails.add(email);
    usersAdded++;
  }
}
saveJson(USERS_SEED, existingUsers);
console.log(`  ✓ Added ${usersAdded} new users`);

console.log('\n✅ L2B migration complete! Restart the dev server to see L2 - Board.\n');
