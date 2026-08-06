import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// ── File-based persistence ────────────────────────────────────────────────────
const PERSIST_FILE        = path.join(process.cwd(), '.jira-custom-fields.json');
const ISSUES_SEED_FILE    = path.join(process.cwd(), '.jira-issues-seed.json');
const SPACES_SEED_FILE    = path.join(process.cwd(), '.jira-spaces-seed.json');
const USERS_SEED_FILE     = path.join(process.cwd(), '.jira-users-seed.json');
const DELETED_SPACES_FILE = path.join(process.cwd(), '.jira-deleted-spaces.json');

let _deletedSpacesCache: { mtime: number; data: Set<string> } | null = null;

function loadDeletedSpaces(): Set<string> {
  try {
    if (!fs.existsSync(DELETED_SPACES_FILE)) return new Set();
    const mtime = fs.statSync(DELETED_SPACES_FILE).mtimeMs;
    if (_deletedSpacesCache && _deletedSpacesCache.mtime === mtime) return _deletedSpacesCache.data;
    const raw = fs.readFileSync(DELETED_SPACES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const data = new Set(parsed.map((k: string) => k.toUpperCase()));
      _deletedSpacesCache = { mtime, data };
      return data;
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveDeletedSpaces(keys: Set<string>) {
  try {
    fs.writeFileSync(DELETED_SPACES_FILE, JSON.stringify(Array.from(keys)), 'utf-8');
    _deletedSpacesCache = null; // invalidate
  } catch { /* ignore */ }
}

// ── Mtime-based seed caches — re-parse only when the file changes on disk ─────
const _seedCache: Record<string, { mtime: number; data: Record<string, unknown>[] }> = {};

function loadJsonCached(filePath: string): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const mtime = fs.statSync(filePath).mtimeMs;
    if (_seedCache[filePath] && _seedCache[filePath].mtime === mtime) {
      return _seedCache[filePath].data;
    }
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _seedCache[filePath] = { mtime, data: parsed };
      return parsed;
    }
  } catch { /* ignore */ }
  return [];
}

function invalidateSeedCache(filePath: string) {
  delete _seedCache[filePath];
}

function loadIssuesSeed(): Record<string, unknown>[] { return loadJsonCached(ISSUES_SEED_FILE); }

function saveIssuesSeed(issues: Record<string, unknown>[]) {
  try {
    fs.writeFileSync(ISSUES_SEED_FILE, JSON.stringify(issues, null, 2), 'utf-8');
    invalidateSeedCache(ISSUES_SEED_FILE);
  } catch { /* ignore */ }
}

function loadSpacesSeed(): Record<string, unknown>[] { return loadJsonCached(SPACES_SEED_FILE); }

function saveSpacesSeed(spaces: Record<string, unknown>[]) {
  try {
    fs.writeFileSync(SPACES_SEED_FILE, JSON.stringify(spaces, null, 2), 'utf-8');
    invalidateSeedCache(SPACES_SEED_FILE);
  } catch { /* ignore */ }
}

function loadUsersSeed(): Record<string, unknown>[] { return loadJsonCached(USERS_SEED_FILE); }

function loadPersistedFields(): Array<Record<string, unknown>> {
  return loadJsonCached(PERSIST_FILE) as Array<Record<string, unknown>>;
}

function savePersistedFields(fields: Array<Record<string, unknown>>) {
  try {
    // Persist user-created fields AND system fields that have spaceIds assigned
    // (so space assignments on built-in fields survive server restarts)
    const toSave = fields.filter(f => {
      if (f.source !== 'system') return true; // always save non-system fields
      // Save system fields only when they have space assignments to preserve
      return Array.isArray(f.spaceIds) && (f.spaceIds as unknown[]).length > 0;
    });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    invalidateSeedCache(PERSIST_FILE);
  } catch { /* ignore */ }
}

// ── Default system fields (always present) ───────────────────────────────────
const SYSTEM_FIELDS: Array<Record<string, unknown>> = [
  { id: 'cf_summary',     name: 'Summary',      fieldType: 'text',        fieldTypeLabel: 'Text',        source: 'system', required: true,  boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_description', name: 'Description',  fieldType: 'rich_text',   fieldTypeLabel: 'Rich text',   source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_type',        name: 'Type',         fieldType: 'issue_type',  fieldTypeLabel: 'Issue type',  source: 'system', required: true,  boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_priority',    name: 'Priority',     fieldType: 'priority',    fieldTypeLabel: 'Priority',    source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_status',      name: 'Status',       fieldType: 'status',      fieldTypeLabel: 'Status',      source: 'system', required: true,  boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_assignee',    name: 'Assignee',     fieldType: 'user',        fieldTypeLabel: 'User',        source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_reporter',    name: 'Reporter',     fieldType: 'user',        fieldTypeLabel: 'User',        source: 'system', required: true,  boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_labels',      name: 'Labels',       fieldType: 'labels',      fieldTypeLabel: 'Labels',      source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_sprint',      name: 'Sprint',       fieldType: 'sprint',      fieldTypeLabel: 'Sprint',      source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_story_points',name: 'Story Points', fieldType: 'number',      fieldTypeLabel: 'Number',      source: 'custom', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_due_date',    name: 'Due Date',     fieldType: 'date',        fieldTypeLabel: 'Date',        source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_parent',      name: 'Parent',       fieldType: 'issue_link',  fieldTypeLabel: 'Issue link',  source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
  { id: 'cf_attachments', name: 'Attachments',  fieldType: 'attachment',  fieldTypeLabel: 'Attachment',  source: 'system', required: false, boardsUsedIn: 'All boards', isDeleted: false, spaceIds: [] },
];

/** Compute live SLA instances for an issue from the space's active SLA policies */
function computeIssueSLAs(issue: any, policies: any[]): any[] {
  if (!policies || policies.length === 0) return [];
  const priority = (issue.priority || 'medium').toLowerCase();
  const isResolved = issue.status?.category === 'done';

  return policies
    .filter((p: any) => p.status === 'active')
    .map((policy: any) => {
      let durationMs = 8 * 60 * 60 * 1000; // default 8h
      for (const goal of (policy.goals || [])) {
        if (goal.isPriorityGroup && goal.priorityRows) {
          const row = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
          if (row?.timeValue) {
            const val = parseFloat(row.timeValue);
            const unit = (row.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        } else if (goal.timeValue) {
          const val = parseFloat(goal.timeValue);
          const unit = (goal.timeUnit || 'hours').toLowerCase();
          durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
          break;
        }
      }
      const startedAt = issue.createdAt || new Date().toISOString();
      const dueTime = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
      const isBreached = !isResolved && new Date(dueTime) < new Date();
      return {
        id: `sla_${policy.id}_${issue.key}`,
        policyId: policy.id,
        policyName: policy.name || 'SLA',
        dueTime,
        isBreached,
        isCompleted: isResolved,
        startedAt,
        goalDurationMs: durationMs,
      };
    });
}

/** In-memory dev API when no standalone server runs on :4000. Survives HMR via globalThis. */
declare global {
  // eslint-disable-next-line no-var
  var __jiraDevMock: JiraDevMockStore | undefined;
}

type MockUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  organizationId: string;
  isActive?: boolean;
  avatarUrl?: string;
  password: string;
};

type MockSpace = {
  id: string;
  name: string;
  key: string;
  description?: string;
  type: 'scrum' | 'kanban' | 'service_desk';
  icon?: string;
  leadId?: string;
  leadName?: string;
  issueCount?: number;
  memberCount?: number;
  members: Array<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
    role: string;
  }>;
  statuses: Array<{
    id: string;
    name: string;
    category: 'todo' | 'in_progress' | 'done';
    color: string;
    position: number;
  }>;
  createdAt?: string;
};

type MockIssue = Record<string, unknown>;

function nowIso() {
  return new Date().toISOString();
}

function rid() {
  return `m_${Math.random().toString(36).slice(2, 12)}`;
}

function encodeToken(userId: string) {
  return `dev.${Buffer.from(JSON.stringify({ sub: userId }), 'utf8').toString('base64url')}`;
}

function decodeToken(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  const t = auth.slice(7).trim();
  // Legacy dev. tokens (base64url encoded)
  if (t.startsWith('dev.')) {
    try {
      const payload = JSON.parse(Buffer.from(t.slice(4), 'base64url').toString('utf8')) as { sub: string };
      return payload.sub || null;
    } catch { return null; }
  }
  // New JWT tokens (eyJ...) — signature already verified by jira-pg-api.ts before delegating here;
  // just extract the `sub` claim from the payload (middle segment).
  if (t.startsWith('eyJ')) {
    try {
      const parts = t.split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub: string; exp?: number };
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload.sub || null;
    } catch { return null; }
  }
  // Personal API tokens (nta_...) — just accept them as-is; jira-pg-api resolves the userId
  // before delegating, but if we land here directly, treat token holder as authenticated.
  if (t.startsWith('nta_')) return t; // fallback: use token itself as a key
  return null;
}

function defaultStatuses() {
  return [
    { id: 'st_todo', name: 'To Do', category: 'todo' as const, color: '#64748B', position: 0 },
    { id: 'st_prog', name: 'In Progress', category: 'in_progress' as const, color: '#3B82F6', position: 1 },
    { id: 'st_done', name: 'Done', category: 'done' as const, color: '#10B981', position: 2 },
  ];
}

function buildIssue(
  key: string,
  space: MockSpace,
  partial: Partial<MockIssue> & { summary: string },
): MockIssue {
  const status = (partial.status as { id: string; name: string; category: string; color: string }) || {
    id: 'st_todo',
    name: 'To Do',
    category: 'todo',
    color: '#64748B',
  };
  const n = parseInt(key.split('-')[1] || '1', 10) || 1;
  // Destructure known fields and keep the rest as extra (custom) fields
  const {
    id, summary: _s, description, type, priority, status: _st,
    assignee, reporter, parent, parentId, sprintId, sprintName,
    storyPoints, dueDate, resolvedAt, position, comments, labels,
    attachments, links, children, activity, sla, createdAt, updatedAt,
    ...extraFields
  } = partial as any;

  return {
    // spread extra fields first (customerName, clientName, projectManager, etc.)
    ...extraFields,
    id: id || rid(),
    key,
    issueNumber: n,
    summary: partial.summary,
    description: description ?? '',
    type: type ?? 'task',
    priority: priority ?? 'medium',
    status,
    spaceKey: space.key,
    spaceName: space.name,
    spaceId: space.id,
    assignee: assignee ?? null,
    reporter: reporter ?? null,
    parent: parent ?? null,
    parentId,
    sprintId,
    sprintName,
    storyPoints,
    dueDate,
    resolvedAt,
    position: position ?? 0,
    commentCount: (comments as unknown[] | undefined)?.length ?? 0,
    attachmentCount: (attachments as unknown[] | undefined)?.length ?? 0,
    comments: comments ?? [],
    labels: labels ?? [],
    attachments: attachments ?? [],
    links: links ?? [],
    children: children ?? [],
    activity: activity ?? [],
    sla: sla ?? [],
    createdAt: createdAt ?? nowIso(),
    updatedAt: updatedAt ?? nowIso(),
  };
}

class JiraDevMockStore {
  orgId = 'org_demo';
  users = new Map<string, MockUser>();
  spaces = new Map<string, MockSpace>();
  issues = new Map<string, MockIssue>();
  sprints = new Map<string, Record<string, unknown>>();
  workflows = new Map<string, { id: string; name?: string; spaceKey: string; statuses: unknown[]; transitions: unknown[] }>();
  labels = new Map<string, Array<Record<string, unknown>>>();
  automation = new Map<string, Array<Record<string, unknown>>>();
  notifications: Array<Record<string, unknown>> = [];
  customFields: Array<Record<string, unknown>> = [
    // System fields + any previously saved user-created fields are merged in seed()
  ];
  customFieldValues = new Map<string, Record<string, string>>();
  slas = new Map<string, Array<Record<string, unknown>>>();
  issueLinks = new Map<string, Record<string, unknown>>();
  emailLogs = new Map<string, Array<Record<string, unknown>>>();  // spaceKey -> email log entries
  // emailAddresses: address -> { spaceKey, requestType, autoReply, autoReplyText, enabled }
  emailAddresses = new Map<string, Record<string, unknown>>();
  filters: Array<Record<string, unknown>> = [];
  // Thread tracking: messageId -> ticketKey
  emailMessageIndex = new Map<string, string>();
  // ticketKey -> { messageIds[], lastMessageId, references[], outboundMessageId }
  emailTicketThread = new Map<string, {
    messageIds: string[];
    lastMessageId: string;
    outboundMessageId: string;
    references: string[];
  }>();

  constructor() {
    this.seed();
    this.loadSeedFiles();
  }

  loadSeedFiles() {
    // Load persisted spaces from migration
    const seedSpaces = loadSpacesSeed();
    for (const sp of seedSpaces) {
      const key = String(sp.key || '').toUpperCase();
      if (key && !this.spaces.has(key)) {
        this.spaces.set(key, sp as any);
      }
    }
    // Load persisted issues from migration
    const seedIssues = loadIssuesSeed();
    for (const issue of seedIssues) {
      const key = String((issue as any).key || '');
      if (key && !this.issues.has(key)) {
        this.issues.set(key, issue as any);
      }
    }
    // Update space issue counts
    this.spaces.forEach((sp: any) => {
      const spKey = String(sp.key || '').toUpperCase();
      const count = Array.from(this.issues.values()).filter((i: any) => String(i.spaceKey || '').toUpperCase() === spKey).length;
      if (count > 0) sp.issueCount = count;
    });

    // ── Load migrated users into user management + space members ─────────────
    const seedUsers = loadUsersSeed();
    for (const u of seedUsers) {
      const uid = String(u.id || '');
      if (!uid || this.users.has(uid)) continue;
      const orgId = this.orgId;
      this.users.set(uid, {
        ...(u as any),
        organizationId: orgId,
        password: String(u.password || 'changeme123'),
        isActive: true,
      });
    }
    // Add users as members of their respective spaces (handled later per-space block below)

    // ── Ensure L1BOAR workflow exists with all real Jira statuses ──────────────
    if (this.spaces.has('L1BOAR') && !this.workflows.has('wf_l1boar')) {
      const L1_STATUSES = [
        { id: 'st_opened',           name: 'Opened',               category: 'in_progress' as const, color: '#64748B', order: 0 },
        { id: 'st_in_progress',      name: 'In Progress',          category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_waiting_customer', name: 'Waiting for Customer', category: 'in_progress' as const, color: '#F59E0B', order: 2 },
        { id: 'st_waiting_l2',       name: 'Waiting for L2',       category: 'in_progress' as const, color: '#F97316', order: 3 },
        { id: 'st_pending_l2',       name: 'Pending with L2',      category: 'in_progress' as const, color: '#8B5CF6', order: 4 },
        { id: 'st_pending_qa',       name: 'Pending with QA',      category: 'in_progress' as const, color: '#06B6D4', order: 5 },
        { id: 'st_pending_infra',    name: 'Pending with Infra',   category: 'in_progress' as const, color: '#6366F1', order: 6 },
        { id: 'st_reopen',           name: 'Reopen',               category: 'in_progress' as const, color: '#EF4444', order: 7 },
        { id: 'st_resolved',         name: 'Resolved',             category: 'done'        as const, color: '#10B981', order: 8 },
        { id: 'st_closed',           name: 'Closed',               category: 'done'        as const, color: '#059669', order: 9 },
      ];
      // Build transitions: every status → every other status (full mesh)
      const transitions: unknown[] = [];
      for (const from of L1_STATUSES) {
        for (const to of L1_STATUSES) {
          if (from.id !== to.id) {
            transitions.push({ id: `tr_l1_${from.id}_${to.id}`, fromStatusId: from.id, toStatusId: to.id, name: `→ ${to.name}` });
          }
        }
      }
      this.workflows.set('wf_l1boar', {
        id: 'wf_l1boar',
        name: 'L1 Board Workflow',
        spaceKey: 'L1BOAR',
        statuses: L1_STATUSES,
        transitions,
      });
      // Also update the space's statuses array so dropdowns reflect them
      const sp = this.spaces.get('L1BOAR') as any;
      if (sp) sp.statuses = L1_STATUSES;
    }

    // ── Ensure QABOAR workflow exists with all real Jira statuses ─────────────
    if (this.spaces.has('QABOAR') && !this.workflows.has('wf_qaboar')) {
      const QAB_STATUSES = [
        { id: 'st_qab_opened',      name: 'Opened',           category: 'in_progress' as const, color: '#64748B', order: 0 },
        { id: 'st_qab_in_progress', name: 'In Progress',      category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_qab_pending_dev', name: 'Pending-with-Dev', category: 'in_progress' as const, color: '#8B5CF6', order: 2 },
        { id: 'st_qab_waiting_l2',  name: 'Waiting for L2',   category: 'in_progress' as const, color: '#F97316', order: 3 },
        { id: 'st_qab_waiting_l3',  name: 'Waiting for L3',   category: 'in_progress' as const, color: '#F59E0B', order: 4 },
        { id: 'st_qab_pending_l2',  name: 'Pending with L2',  category: 'in_progress' as const, color: '#06B6D4', order: 5 },
        { id: 'st_qab_resolved',    name: 'Resolved',         category: 'done'        as const, color: '#10B981', order: 6 },
      ];
      const qabTransitions: unknown[] = [];
      for (const from of QAB_STATUSES) {
        for (const to of QAB_STATUSES) {
          if (from.id !== to.id) {
            qabTransitions.push({ id: `tr_qab_${from.id}_${to.id}`, fromStatusId: from.id, toStatusId: to.id, name: `→ ${to.name}` });
          }
        }
      }
      this.workflows.set('wf_qaboar', {
        id: 'wf_qaboar',
        name: 'Quality Analyst Workflow',
        spaceKey: 'QABOAR',
        statuses: QAB_STATUSES,
        transitions: qabTransitions,
      });
      const qabSp = this.spaces.get('QABOAR') as any;
      if (qabSp) qabSp.statuses = QAB_STATUSES;
    }

    // ── Ensure INFRABOARD workflow exists ──────────────────────────────────────
    if (this.spaces.has('INFRABOARD') && !this.workflows.has('wf_infraboard')) {
      const IB_STATUSES = [
        { id: 'st_ib_open',              name: 'Open',                       category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_ib_in_progress',       name: 'In Progress',                category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_ib_pending_dev',       name: 'Pending with dev',           category: 'in_progress' as const, color: '#8B5CF6', order: 2 },
        { id: 'st_ib_pending_qa',        name: 'Pending with QA',            category: 'in_progress' as const, color: '#06B6D4', order: 3 },
        { id: 'st_ib_pending_migration', name: 'Pending with Migration',     category: 'in_progress' as const, color: '#F97316', order: 4 },
        { id: 'st_ib_waiting_migration', name: 'Waiting for Migration Team', category: 'in_progress' as const, color: '#F59E0B', order: 5 },
        { id: 'st_ib_reopen',            name: 'Reopen',                     category: 'in_progress' as const, color: '#EF4444', order: 6 },
        { id: 'st_ib_resolved',          name: 'Resolved',                   category: 'done'        as const, color: '#10B981', order: 7 },
        { id: 'st_ib_closed',            name: 'Closed',                     category: 'done'        as const, color: '#059669', order: 8 },
      ];
      const ibTransitions: unknown[] = [];
      for (const from of IB_STATUSES) {
        for (const to of IB_STATUSES) {
          if (from.id !== to.id) {
            ibTransitions.push({ id: `tr_ib_${from.id}_${to.id}`, fromStatusId: from.id, toStatusId: to.id, name: `→ ${to.name}` });
          }
        }
      }
      this.workflows.set('wf_infraboard', {
        id: 'wf_infraboard',
        name: 'Infra Board Workflow',
        spaceKey: 'INFRABOARD',
        statuses: IB_STATUSES,
        transitions: ibTransitions,
      });
      const ibSp = this.spaces.get('INFRABOARD') as any;
      if (ibSp) ibSp.statuses = IB_STATUSES;
    }

    // ── Ensure PSMBOARD workflow exists ───────────────────────────────────────
    if (this.spaces.has('PSMBOARD') && !this.workflows.has('wf_psmboard')) {
      const PSM_STATUSES = [
        { id: 'st_psm_open',          name: 'Open',                category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_psm_in_progress',   name: 'In Progress',         category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_psm_pending_l2',    name: 'Pending with L2',     category: 'in_progress' as const, color: '#8B5CF6', order: 2 },
        { id: 'st_psm_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress' as const, color: '#A855F7', order: 3 },
        { id: 'st_psm_pending_qa',    name: 'Pending with QA',     category: 'in_progress' as const, color: '#06B6D4', order: 4 },
        { id: 'st_psm_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress' as const, color: '#F59E0B', order: 5 },
        { id: 'st_psm_future_event',  name: 'Future Event',         category: 'in_progress' as const, color: '#EC4899', order: 6 },
        { id: 'st_psm_resolved',      name: 'Resolved',             category: 'done'        as const, color: '#10B981', order: 7 },
        { id: 'st_psm_closed',        name: 'Closed',               category: 'done'        as const, color: '#059669', order: 8 },
      ];
      const psmTransitions: unknown[] = [];
      for (const from of PSM_STATUSES) {
        for (const to of PSM_STATUSES) {
          if (from.id !== to.id) {
            psmTransitions.push({ id: `tr_psm_${from.id}_${to.id}`, fromStatusId: from.id, toStatusId: to.id, name: `→ ${to.name}` });
          }
        }
      }
      this.workflows.set('wf_psmboard', {
        id: 'wf_psmboard', name: 'Pre-Sales Management Workflow', spaceKey: 'PSMBOARD',
        statuses: PSM_STATUSES, transitions: psmTransitions,
      });
      const psmSp = this.spaces.get('PSMBOARD') as any;
      if (psmSp) psmSp.statuses = PSM_STATUSES;
    }

    // ── Ensure L2BOARD workflow exists ────────────────────────────────────────
    if (this.spaces.has('L2BOARD') && !this.workflows.has('wf_l2board')) {
      const L2B_STATUSES = [
        { id: 'st_l2b_open',             name: 'Open',                  category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_l2b_in_progress',      name: 'In Progress',           category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_l2b_waiting_l1',       name: 'Waiting for L1',        category: 'in_progress' as const, color: '#8B5CF6', order: 2 },
        { id: 'st_l2b_pending_qa',       name: 'Pending with QA',       category: 'in_progress' as const, color: '#06B6D4', order: 3 },
        { id: 'st_l2b_waiting_presales', name: 'Waiting for Pre-Sales', category: 'in_progress' as const, color: '#F97316', order: 4 },
        { id: 'st_l2b_waiting_l3',       name: 'Waiting for L3',        category: 'in_progress' as const, color: '#F59E0B', order: 5 },
        { id: 'st_l2b_pending_l3',       name: 'Pending with L3',       category: 'in_progress' as const, color: '#A855F7', order: 6 },
        { id: 'st_l2b_waiting_customer', name: 'Waiting for Customer',  category: 'in_progress' as const, color: '#EC4899', order: 7 },
        { id: 'st_l2b_reopen',           name: 'Reopen',                category: 'in_progress' as const, color: '#EF4444', order: 8 },
        { id: 'st_l2b_pending_infra',    name: 'Pending with Infra',    category: 'in_progress' as const, color: '#14B8A6', order: 9 },
        { id: 'st_l2b_resolved',         name: 'Resolved',              category: 'done'        as const, color: '#10B981', order: 10 },
      ];
      const l2bStatusIds = L2B_STATUSES.map(s => s.id);
      const l2bTransitions = l2bStatusIds.flatMap(from =>
        l2bStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${L2B_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_l2board', {
        id: 'wf_l2board', name: 'L2 Board Workflow', spaceKey: 'L2BOARD',
        statuses: L2B_STATUSES, transitions: l2bTransitions,
      });
      const l2bSp = this.spaces.get('L2BOARD') as any;
      if (l2bSp) l2bSp.statuses = L2B_STATUSES;
    }

    // ── Ensure TESTBOARD workflow exists ─────────────────────────────────────
    if (this.spaces.has('TESTBOARD') && !this.workflows.has('wf_testboard')) {
      const TEST_STATUSES = [
        { id: 'st_test_todo',        name: 'To Do',        category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_test_inprogress',  name: 'In Progress',  category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_test_qa_review',   name: 'QA Review',    category: 'in_progress' as const, color: '#06B6D4', order: 2 },
        { id: 'st_test_code_review', name: 'Code Review',  category: 'in_progress' as const, color: '#8B5CF6', order: 3 },
        { id: 'st_test_resolved',    name: 'Resolved',     category: 'done'        as const, color: '#10B981', order: 4 },
        { id: 'st_test_canceled',    name: 'Canceled',     category: 'done'        as const, color: '#EF4444', order: 5 },
      ];
      const testStatusIds = TEST_STATUSES.map(s => s.id);
      const testTransitions = testStatusIds.flatMap(from =>
        testStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${TEST_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_testboard', {
        id: 'wf_testboard', name: 'Test Board Workflow', spaceKey: 'TESTBOARD',
        statuses: TEST_STATUSES, transitions: testTransitions,
      });
      const testSp = this.spaces.get('TESTBOARD') as any;
      if (testSp) testSp.statuses = TEST_STATUSES;
    }

    // ── Ensure L3BOARD workflow exists ────────────────────────────────────────
    if (this.spaces.has('L3BOARD') && !this.workflows.has('wf_l3board')) {
      const L3B_STATUSES = [
        { id: 'st_l3b_open',             name: 'Open',                  category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_l3b_in_progress',      name: 'In Progress',           category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_l3b_pending_qa',       name: 'Pending with QA',       category: 'in_progress' as const, color: '#06B6D4', order: 2 },
        { id: 'st_l3b_waiting_presales', name: 'Waiting for Pre-Sales', category: 'in_progress' as const, color: '#F97316', order: 3 },
        { id: 'st_l3b_reopen',           name: 'Reopen',                category: 'in_progress' as const, color: '#EF4444', order: 4 },
        { id: 'st_l3b_resolved',         name: 'Resolved',              category: 'done'        as const, color: '#10B981', order: 5 },
      ];
      const l3bStatusIds = L3B_STATUSES.map(s => s.id);
      const l3bTransitions = l3bStatusIds.flatMap(from =>
        l3bStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${L3B_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_l3board', {
        id: 'wf_l3board', name: 'L3 Board Workflow', spaceKey: 'L3BOARD',
        statuses: L3B_STATUSES, transitions: l3bTransitions,
      });
      const l3bSp = this.spaces.get('L3BOARD') as any;
      if (l3bSp) l3bSp.statuses = L3B_STATUSES;
    }

    // ── Ensure CFMBOARD (Service Management) workflow exists ─────────────────
    if (this.spaces.has('CFMBOARD') && !this.workflows.has('wf_cfmboard')) {
      const CFM_STATUSES = [
        { id: 'st_cfm_open',          name: 'Open',                category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_cfm_todo',          name: 'To Do',               category: 'todo'        as const, color: '#94A3B8', order: 1 },
        { id: 'st_cfm_in_progress',   name: 'In Progress',         category: 'in_progress' as const, color: '#3B82F6', order: 2 },
        { id: 'st_cfm_pending_l2',    name: 'Pending with L2',     category: 'in_progress' as const, color: '#8B5CF6', order: 3 },
        { id: 'st_cfm_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress' as const, color: '#A855F7', order: 4 },
        { id: 'st_cfm_pending_qa',    name: 'Pending with QA',     category: 'in_progress' as const, color: '#06B6D4', order: 5 },
        { id: 'st_cfm_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress' as const, color: '#F59E0B', order: 6 },
        { id: 'st_cfm_future_event',  name: 'Future Event',        category: 'in_progress' as const, color: '#EC4899', order: 7 },
        { id: 'st_cfm_review',        name: 'Under Review',        category: 'in_progress' as const, color: '#F97316', order: 8 },
        { id: 'st_cfm_resolved',      name: 'Resolved',            category: 'done'        as const, color: '#10B981', order: 9 },
        { id: 'st_cfm_closed',        name: 'Closed',              category: 'done'        as const, color: '#059669', order: 10 },
        { id: 'st_cfm_done',          name: 'Done',                category: 'done'        as const, color: '#16A34A', order: 11 },
        { id: 'st_cfm_canceled',      name: 'Cancelled',           category: 'done'        as const, color: '#6B7280', order: 12 },
      ];
      const cfmStatusIds = CFM_STATUSES.map(s => s.id);
      const cfmTransitions = cfmStatusIds.flatMap(from =>
        cfmStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${CFM_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_cfmboard', {
        id: 'wf_cfmboard', name: 'Service Management Workflow', spaceKey: 'CFMBOARD',
        statuses: CFM_STATUSES, transitions: cfmTransitions,
      });
      const cfmSp = this.spaces.get('CFMBOARD') as any;
      if (cfmSp) cfmSp.statuses = CFM_STATUSES;
    }

    // ── Ensure EBBOARD (Email Migration Backlogs) workflow exists ─────────────
    if (this.spaces.has('EBBOARD') && !this.workflows.has('wf_ebboard')) {
      const EB_STATUSES = [
        { id: 'st_eb_todo',          name: 'To Do',               category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_eb_open',          name: 'Open',                category: 'todo'        as const, color: '#94A3B8', order: 1 },
        { id: 'st_eb_in_progress',   name: 'In Progress',         category: 'in_progress' as const, color: '#3B82F6', order: 2 },
        { id: 'st_eb_pending_l2',    name: 'Pending with L2',     category: 'in_progress' as const, color: '#8B5CF6', order: 3 },
        { id: 'st_eb_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress' as const, color: '#A855F7', order: 4 },
        { id: 'st_eb_pending_qa',    name: 'Pending with QA',     category: 'in_progress' as const, color: '#06B6D4', order: 5 },
        { id: 'st_eb_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress' as const, color: '#F59E0B', order: 6 },
        { id: 'st_eb_review',        name: 'Under Review',        category: 'in_progress' as const, color: '#F97316', order: 7 },
        { id: 'st_eb_resolved',      name: 'Resolved',            category: 'done'        as const, color: '#10B981', order: 8 },
        { id: 'st_eb_closed',        name: 'Closed',              category: 'done'        as const, color: '#059669', order: 9 },
        { id: 'st_eb_done',          name: 'Done',                category: 'done'        as const, color: '#16A34A', order: 10 },
        { id: 'st_eb_canceled',      name: 'Cancelled',           category: 'done'        as const, color: '#6B7280', order: 11 },
      ];
      const ebStatusIds = EB_STATUSES.map(s => s.id);
      const ebTransitions = ebStatusIds.flatMap(from =>
        ebStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${EB_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_ebboard', {
        id: 'wf_ebboard', name: 'Email Migration Backlogs Workflow', spaceKey: 'EBBOARD',
        statuses: EB_STATUSES, transitions: ebTransitions,
      });
      const ebSp = this.spaces.get('EBBOARD') as any;
      if (ebSp) ebSp.statuses = EB_STATUSES;
    }

    // ── Ensure MBBOARD (Message Migration Backlogs) workflow exists ──────────────
    if (this.spaces.has('MBBOARD') && !this.workflows.has('wf_mbboard')) {
      const MB_STATUSES = [
        { id: 'st_mb_todo',          name: 'To Do',               category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_mb_open',          name: 'Open',                category: 'todo'        as const, color: '#94A3B8', order: 1 },
        { id: 'st_mb_in_progress',   name: 'In Progress',         category: 'in_progress' as const, color: '#3B82F6', order: 2 },
        { id: 'st_mb_pending_l2',    name: 'Pending with L2',     category: 'in_progress' as const, color: '#8B5CF6', order: 3 },
        { id: 'st_mb_pending_l2bug', name: 'Pending with L2 Bug', category: 'in_progress' as const, color: '#A855F7', order: 4 },
        { id: 'st_mb_pending_qa',    name: 'Pending with QA',     category: 'in_progress' as const, color: '#06B6D4', order: 5 },
        { id: 'st_mb_waiting_l3',    name: 'Waiting for L3',      category: 'in_progress' as const, color: '#F59E0B', order: 6 },
        { id: 'st_mb_review',        name: 'Under Review',        category: 'in_progress' as const, color: '#F97316', order: 7 },
        { id: 'st_mb_resolved',      name: 'Resolved',            category: 'done'        as const, color: '#10B981', order: 8 },
        { id: 'st_mb_closed',        name: 'Closed',              category: 'done'        as const, color: '#059669', order: 9 },
        { id: 'st_mb_done',          name: 'Done',                category: 'done'        as const, color: '#16A34A', order: 10 },
        { id: 'st_mb_canceled',      name: 'Cancelled',           category: 'done'        as const, color: '#6B7280', order: 11 },
      ];
      const mbStatusIds = MB_STATUSES.map(s => s.id);
      const mbTransitions = mbStatusIds.flatMap(from =>
        mbStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${MB_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_mbboard', {
        id: 'wf_mbboard', name: 'Message Migration Backlogs Workflow', spaceKey: 'MBBOARD',
        statuses: MB_STATUSES, transitions: mbTransitions,
      });
      const mbSp = this.spaces.get('MBBOARD') as any;
      if (mbSp) mbSp.statuses = MB_STATUSES;
    }

    // ── Ensure CBBOARD (Content Migration Backlog) workflow exists ─────────────
    if (this.spaces.has('CBBOARD') && !this.workflows.has('wf_cbboard')) {
      const CB_STATUSES = [
        { id: 'st_cb_todo',          name: 'To Do',                   category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_cb_open',          name: 'Open',                    category: 'todo'        as const, color: '#94A3B8', order: 1 },
        { id: 'st_cb_current_sprint',name: 'Current Sprint Feb 20th', category: 'in_progress' as const, color: '#6366F1', order: 2 },
        { id: 'st_cb_in_progress',   name: 'In Progress',             category: 'in_progress' as const, color: '#3B82F6', order: 3 },
        { id: 'st_cb_pending_l2',    name: 'Pending with L2',         category: 'in_progress' as const, color: '#8B5CF6', order: 4 },
        { id: 'st_cb_pending_l2bug', name: 'Pending with L2 Bug',     category: 'in_progress' as const, color: '#A855F7', order: 5 },
        { id: 'st_cb_pending_qa',    name: 'Pending with QA',         category: 'in_progress' as const, color: '#06B6D4', order: 6 },
        { id: 'st_cb_waiting_l3',    name: 'Waiting for L3',          category: 'in_progress' as const, color: '#F59E0B', order: 7 },
        { id: 'st_cb_review',        name: 'Under Review',            category: 'in_progress' as const, color: '#F97316', order: 8 },
        { id: 'st_cb_resolved',      name: 'Resolved',                category: 'done'        as const, color: '#10B981', order: 9 },
        { id: 'st_cb_closed',        name: 'Closed',                  category: 'done'        as const, color: '#059669', order: 10 },
        { id: 'st_cb_done',          name: 'Done',                    category: 'done'        as const, color: '#16A34A', order: 11 },
        { id: 'st_cb_canceled',      name: 'Cancelled',               category: 'done'        as const, color: '#6B7280', order: 12 },
      ];
      const cbStatusIds = CB_STATUSES.map(s => s.id);
      const cbTransitions = cbStatusIds.flatMap(from =>
        cbStatusIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${CB_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_cbboard', {
        id: 'wf_cbboard', name: 'Content Migration Backlog Workflow', spaceKey: 'CBBOARD',
        statuses: CB_STATUSES, transitions: cbTransitions,
      });
      const cbSp = this.spaces.get('CBBOARD') as any;
      if (cbSp) cbSp.statuses = CB_STATUSES;
    }

    // ── Ensure SOPSBOARD (Sales Operation) workflow exists ────────────────────
    if (this.spaces.has('SOPSBOARD') && !this.workflows.has('wf_sopsboard')) {
      const SOPS_STATUSES = [
        { id: 'st_sops_open',        name: 'Open',        category: 'todo'        as const, color: '#64748B', order: 0 },
        { id: 'st_sops_in_progress', name: 'In Progress', category: 'in_progress' as const, color: '#3B82F6', order: 1 },
        { id: 'st_sops_resolved',    name: 'Resolved',    category: 'done'        as const, color: '#10B981', order: 2 },
        { id: 'st_sops_closed',      name: 'Closed',      category: 'done'        as const, color: '#059669', order: 3 },
        { id: 'st_sops_done',        name: 'Done',        category: 'done'        as const, color: '#16A34A', order: 4 },
      ];
      const sopsIds = SOPS_STATUSES.map(s => s.id);
      const sopsTransitions = sopsIds.flatMap(from =>
        sopsIds.filter(to => to !== from).map(to => ({ from, to, name: `Move to ${SOPS_STATUSES.find(s => s.id === to)?.name}` }))
      );
      this.workflows.set('wf_sopsboard', {
        id: 'wf_sopsboard', name: 'Sales Operation Workflow', spaceKey: 'SOPSBOARD',
        statuses: SOPS_STATUSES, transitions: sopsTransitions,
      });
      const sopsSp = this.spaces.get('SOPSBOARD') as any;
      if (sopsSp) sopsSp.statuses = SOPS_STATUSES;
    }

    // Add users as members of all migrated spaces
    for (const spaceKey of ['L1BOAR', 'QABOAR', 'INFRABOARD', 'PSMBOARD', 'L2BOARD', 'L3BOARD', 'TESTBOARD', 'CFMBOARD', 'EBBOARD', 'MBBOARD', 'CBBOARD', 'SOPSBOARD']) {
      const sp = this.spaces.get(spaceKey) as any;
      if (!sp) continue;
      if (!Array.isArray(sp.members)) sp.members = [];
      const existingEmails = new Set(sp.members.map((m: any) => String(m.email || '').toLowerCase()));
      // pull from both seed users and in-memory users
      const allUsersList = [
        ...seedUsers,
        ...Array.from(this.users.values()),
      ] as any[];
      const spaceUsers = allUsersList.filter((u: any) =>
        Array.isArray(u.boards) && u.boards.includes(spaceKey)
      );
      for (const u of spaceUsers) {
        const email = String(u.email || '').toLowerCase();
        if (!email || existingEmails.has(email)) continue;
        sp.members.push({ id: String(u.id || ''), email: u.email, firstName: u.firstName, lastName: u.lastName, role: 'agent' });
        existingEmails.add(email);
      }
      sp.memberCount = sp.members.length;
    }
  }

  seed() {
    const admin: MockUser = {
      id: 'u_admin',
      email: 'admin@jira.com',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      organizationId: this.orgId,
      password: 'admin123',
      isActive: true,
    };
    this.users.set(admin.id, admin);

    // Skip hardcoded spaces that the user has deleted
    const deletedSpaceKeys = loadDeletedSpaces();

    const space: MockSpace = {
      id: 's_infra',
      name: 'Infrastructure',
      key: 'INFRA',
      description: 'Demo space (local dev API)',
      type: 'service_desk',
      issueCount: 1,
      memberCount: 1,
      members: [
        {
          id: 'sm1',
          email: admin.email,
          firstName: admin.firstName,
          lastName: admin.lastName,
          role: 'admin',
        },
      ],
      statuses: defaultStatuses(),
      createdAt: nowIso(),
    };
    if (!deletedSpaceKeys.has('INFRA')) {
      this.spaces.set(space.key.toUpperCase(), { ...space, key: space.key.toUpperCase() });
      const issue = buildIssue('INFRA-1', this.spaces.get('INFRA') ?? (space as any), {
        summary: 'Welcome — local API mock is running',
        type: 'story',
        priority: 'high',
        status: { id: 'st_prog', name: 'In Progress', category: 'in_progress', color: '#3B82F6' },
        reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email },
        assignee: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email },
      });
      this.issues.set('INFRA-1', issue);

      // Seed additional demo issues for a richer Summary dashboard
      const demoIssues: Array<Parameters<typeof buildIssue>[2] & { key: string }> = [
        { key: 'INFRA-2', summary: 'Cannot access VPN from remote locations', type: 'bug',   priority: 'highest', status: { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: null, createdAt: new Date(Date.now() - 2*86400000).toISOString() },
        { key: 'INFRA-3', summary: 'Provision new developer laptop for onboarding', type: 'task',  priority: 'medium',  status: { id: 'st_prog', name: 'In Progress', category: 'in_progress', color: '#3B82F6' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, createdAt: new Date(Date.now() - 3*86400000).toISOString() },
        { key: 'INFRA-4', summary: 'SSL certificate renewal for api.cloudfuze.com', type: 'task',  priority: 'high',    status: { id: 'st_done', name: 'Done', category: 'done', color: '#10B981' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, createdAt: new Date(Date.now() - 5*86400000).toISOString(), updatedAt: new Date(Date.now() - 1*86400000).toISOString() },
        { key: 'INFRA-5', summary: 'Network latency spikes in us-east-1 region', type: 'bug',   priority: 'high',    status: { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: null, createdAt: new Date(Date.now() - 1*86400000).toISOString() },
        { key: 'INFRA-6', summary: 'Upgrade PostgreSQL from 14 to 16', type: 'epic',  priority: 'medium',  status: { id: 'st_prog', name: 'In Progress', category: 'in_progress', color: '#3B82F6' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, createdAt: new Date(Date.now() - 8*86400000).toISOString() },
        { key: 'INFRA-7', summary: 'Set up automated backup verification pipeline', type: 'story', priority: 'low',     status: { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: null, createdAt: new Date(Date.now() - 6*86400000).toISOString() },
        { key: 'INFRA-8', summary: 'Email notifications not sending from CI pipeline', type: 'bug',   priority: 'medium',  status: { id: 'st_done', name: 'Done', category: 'done', color: '#10B981' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, createdAt: new Date(Date.now() - 4*86400000).toISOString(), updatedAt: new Date(Date.now() - 0.5*86400000).toISOString() },
        { key: 'INFRA-9', summary: 'Configure WAF rules for new API endpoints', type: 'task',  priority: 'highest', status: { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }, reporter: { id: admin.id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email }, assignee: null, createdAt: new Date(Date.now() - 0.5*86400000).toISOString() },
      ];
      for (const di of demoIssues) {
        const { key, ...rest } = di;
        this.issues.set(key, buildIssue(key, this.spaces.get('INFRA')!, rest));
      }
    }

    if (!deletedSpaceKeys.has('INFRA')) {
      this.workflows.set('wf_infra', {
        id: 'wf_infra',
        name: 'Default workflow',
        spaceKey: 'INFRA',
        statuses: [
          { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B', order: 0 },
          { id: 'st_prog', name: 'In Progress', category: 'in_progress', color: '#3B82F6', order: 1 },
          { id: 'st_done', name: 'Done', category: 'done', color: '#10B981', order: 2 },
        ],
        transitions: [
          { id: 'tr_1', fromStatusId: 'st_todo', toStatusId: 'st_prog', name: 'Start Progress' },
          { id: 'tr_2', fromStatusId: 'st_prog', toStatusId: 'st_done', name: 'Done'           },
          { id: 'tr_3', fromStatusId: 'st_prog', toStatusId: 'st_todo', name: 'Stop Progress'  },
          { id: 'tr_4', fromStatusId: 'st_done', toStatusId: 'st_prog', name: 'Reopen'         },
        ],
      });

      this.labels.set('INFRA', []);
      this.automation.set('INFRA', []);
      this.slas.set('INFRA', [
      {
        id: 'sla_default_1',
        name: 'Time to first response',
        status: 'active',
        startCondition: 'issue_created',
        goals: [
          {
            id: 'g_tfr_1',
            isPriorityGroup: true,
            priorityRows: [
              { priority: 'highest', timeValue: '4',  timeUnit: 'hours' },
              { priority: 'high',    timeValue: '8',  timeUnit: 'hours' },
              { priority: 'medium',  timeValue: '16', timeUnit: 'hours' },
              { priority: 'low',     timeValue: '24', timeUnit: 'hours' },
              { priority: 'lowest',  timeValue: '48', timeUnit: 'hours' },
            ],
          },
        ],
        createdAt: nowIso(),
      },
      {
        id: 'sla_default_2',
        name: 'Time to resolution',
        status: 'active',
        startCondition: 'issue_created',
        goals: [
          {
            id: 'g_tr_1',
            isPriorityGroup: true,
            priorityRows: [
              { priority: 'highest', timeValue: '4',  timeUnit: 'hours' },
              { priority: 'high',    timeValue: '8',  timeUnit: 'hours' },
              { priority: 'medium',  timeValue: '3',  timeUnit: 'days'  },
              { priority: 'low',     timeValue: '5',  timeUnit: 'days'  },
              { priority: 'lowest',  timeValue: '10', timeUnit: 'days'  },
            ],
          },
        ],
        createdAt: nowIso(),
      },
      ]);
      this.emailLogs.set('INFRA', []);
      // Register default email address for INFRA space
      this.emailAddresses.set('infra@cloudfuze.com', {
        id: 'email_infra_1',
        address: 'infra@cloudfuze.com',
        spaceKey: 'INFRA',
        requestType: 'Emailed request',
        isReplyTo: true,
        autoReply: true,
        autoReplyText: 'Thank you for contacting us. We have received your request and will get back to you shortly.',
        enabled: true,
        createdAt: nowIso(),
      });
    } // end !deletedSpaceKeys.has('INFRA')

    this.notifications.push({
      id: 'n1',
      type: 'SYSTEM',
      title: 'Local development',
      message: 'Using embedded /api mock (no server on port 4000).',
      isRead: false,
      createdAt: nowIso(),
    });

    // ── Custom fields: system fields + persisted user-created fields ──
    const persisted = loadPersistedFields();
    const systemIds = new Set(SYSTEM_FIELDS.map(f => f.id as string));
    // Build a lookup of persisted fields so we can restore spaceIds on system fields
    const persistedById = new Map(persisted.map(f => [f.id as string, f]));
    // System fields: use canonical definition but restore any persisted spaceIds (so space
    // assignments survive server restarts even for system/built-in fields)
    const systemFieldsMerged = SYSTEM_FIELDS.map(f => {
      const saved = persistedById.get(f.id as string);
      const spaceIds = saved && Array.isArray(saved.spaceIds) ? saved.spaceIds : (f.spaceIds || []);
      return { ...f, spaceIds };
    });
    // User-created fields: skip those whose id collides with a system field
    const userFields = persisted.filter(f => !systemIds.has(f.id as string));
    this.customFields = [...systemFieldsMerged, ...userFields];
  }
}

const DEFAULT_SLA_POLICIES: Array<Record<string, unknown>> = [
  {
    id: 'sla_default_1',
    name: 'Time to first response',
    status: 'active',
    startCondition: 'issue_created',
    goals: [
      {
        id: 'g_tfr_1',
        isPriorityGroup: true,
        priorityRows: [
          { priority: 'highest', timeValue: '4',  timeUnit: 'hours' },
          { priority: 'high',    timeValue: '8',  timeUnit: 'hours' },
          { priority: 'medium',  timeValue: '16', timeUnit: 'hours' },
          { priority: 'low',     timeValue: '24', timeUnit: 'hours' },
          { priority: 'lowest',  timeValue: '48', timeUnit: 'hours' },
        ],
      },
    ],
  },
  {
    id: 'sla_default_2',
    name: 'Time to resolution',
    status: 'active',
    startCondition: 'issue_created',
    goals: [
      {
        id: 'g_tr_1',
        isPriorityGroup: true,
        priorityRows: [
          { priority: 'highest', timeValue: '4',  timeUnit: 'hours' },
          { priority: 'high',    timeValue: '8',  timeUnit: 'hours' },
          { priority: 'medium',  timeValue: '3',  timeUnit: 'days'  },
          { priority: 'low',     timeValue: '5',  timeUnit: 'days'  },
          { priority: 'lowest',  timeValue: '10', timeUnit: 'days'  },
        ],
      },
    ],
  },
];

function getStore() {
  if (!globalThis.__jiraDevMock) globalThis.__jiraDevMock = new JiraDevMockStore();
  const s = globalThis.__jiraDevMock;

  // HMR-safe: sync any new spaces/issues from seed that aren't yet in memory
  // (happens when seed files are updated while the server is running)
  const _deletedKeys = loadDeletedSpaces();
  const seedSpaces = loadSpacesSeed();
  for (const sp of seedSpaces) {
    const key = String(sp.key || '').toUpperCase();
    if (!key || _deletedKeys.has(key)) continue;
    if (!s.spaces.has(key)) {
      s.spaces.set(key, sp as any);
    } else {
      // Always sync icon + name + type + description from seed so live edits take effect without full restart
      const existing = s.spaces.get(key)!;
      s.spaces.set(key, { ...existing, icon: (sp as any).icon ?? null, name: (sp as any).name ?? existing.name, type: (sp as any).type ?? existing.type, description: (sp as any).description ?? existing.description });
    }
  }
  // Only sync seed issues if in-memory count is behind seed count (avoids full scan every request)
  const seedIssues = loadIssuesSeed();
  if (seedIssues.length > s.issues.size) {
    for (const issue of seedIssues) {
      const key = String((issue as any).key || '');
      if (key && !s.issues.has(key)) s.issues.set(key, issue as any);
    }
  }

  // Migration: backfill default SLAs for any service_desk space that has none
  for (const [spaceKey, space] of Array.from(s.spaces.entries())) {
    if (space.type === 'service_desk' && !s.slas.get(spaceKey)?.length) {
      s.slas.set(spaceKey, DEFAULT_SLA_POLICIES.map(p => ({ ...p, createdAt: nowIso() })));
    }
  }

  // Migration: backfill default transitions for any workflow that has none
  for (const wf of Array.from(s.workflows.values())) {
    if ((wf.transitions as unknown[]).length === 0 && (wf.statuses as unknown[]).length >= 2) {
      const sts = wf.statuses as { id: string; category: string }[];
      const todos      = sts.filter((x) => x.category === 'todo');
      const inProgress = sts.filter((x) => x.category === 'in_progress');
      const done       = sts.filter((x) => x.category === 'done');
      const tr: unknown[] = [];
      for (const t of todos)      for (const p of inProgress) tr.push({ id: rid(), fromStatusId: t.id, toStatusId: p.id, name: 'Start Progress' });
      for (const p of inProgress) for (const d of done)       tr.push({ id: rid(), fromStatusId: p.id, toStatusId: d.id, name: 'Done'           });
      for (const p of inProgress) for (const t of todos)      tr.push({ id: rid(), fromStatusId: p.id, toStatusId: t.id, name: 'Stop Progress'  });
      for (const d of done)       for (const p of inProgress) tr.push({ id: rid(), fromStatusId: d.id, toStatusId: p.id, name: 'Reopen'         });
      (wf.transitions as unknown[]).push(...tr);
    }
  }

  return s;
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const t = await req.text();
    if (!t) return {};
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleJiraDevMock(req: NextRequest, segments: string[], method: string): Promise<NextResponse> {
  const s = getStore();
  const auth = req.headers.get('authorization');
  const userId = decodeToken(auth);
  const url = new URL(req.url);

  const path = segments.join('/');

  // ── Auth (no token) ─────────────────────────────────────────────
  if (path === 'auth/login' && method === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const user = Array.from(s.users.values()).find((u) => u.email.toLowerCase() === email);
    if (!user || user.password !== password) {
      return json({ error: 'Invalid email or password' }, 401);
    }
    return json({
      token: encodeToken(user.id),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
        avatarUrl: user.avatarUrl,
        isActive: user.isActive !== false,
      },
    });
  }

  if (path === 'auth/register' && method === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').toLowerCase().trim();
    if (Array.from(s.users.values()).some((u) => u.email.toLowerCase() === email)) {
      return json({ error: 'Email already registered' }, 400);
    }
    const id = rid();
    const user: MockUser = {
      id,
      email,
      firstName: String(body.firstName || 'User'),
      lastName: String(body.lastName || ''),
      role: 'developer',
      organizationId: s.orgId,
      password: String(body.password || ''),
      isActive: true,
    };
    s.users.set(id, user);
    return json({
      token: encodeToken(id),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  }

  if (path === 'auth/me' && method === 'GET') {
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const user = s.users.get(userId);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    return json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      organizationId: user.organizationId,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive !== false,
    });
  }

  // Some paths are public — external mail services & internal pollers don't carry auth tokens
  const isPublicPath =
    path.startsWith('auth/') ||
    path === 'email/receive' ||
    path.startsWith('email-logs/') ||
    path === 'stats';
  // Internal admin operations (bulk sync, migrations) bypass auth
  const isInternalAdmin = req.headers.get('x-internal-admin') === 'cf-admin-sync-2024';
  if (!userId && !isPublicPath && !isInternalAdmin) {
    return json({ error: 'Unauthorized' }, 401);
  }
  // For internal admin calls, use first admin user as userId
  const effectiveUserId = userId || (isInternalAdmin ? Array.from(s.users.values()).find(u => u.role === 'admin')?.id : undefined);

  // ── Public stats (no auth needed — shown on login page) ─────────────
  if (path === 'stats' && method === 'GET') {
    const totalTickets = Array.from(s.spaces.values()).reduce((sum, sp) => {
      return sum + Array.from(s.issues.values()).filter((i: any) => i.spaceKey === sp.key).length;
    }, 0);
    return json({
      totalTickets,
      totalAgents: s.users.size,
      totalBoards: s.spaces.size,
    });
  }

  // ── Users ─────────────────────────────────────────────────────────
  if (path === 'users' && method === 'GET') {
    return json(
      Array.from(s.users.values()).map((u) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        organizationId: u.organizationId,
        isActive: u.isActive !== false,
        avatarUrl: u.avatarUrl,
        createdAt: nowIso(),
      })),
    );
  }

  if (path === 'users' && method === 'POST') {
    const body = await readJson(req);
    const id = rid();
    const user: MockUser = {
      id,
      email: String(body.email || '').toLowerCase(),
      firstName: String(body.firstName || ''),
      lastName: String(body.lastName || ''),
      role: String(body.role || 'developer'),
      organizationId: s.orgId,
      password: String(body.password || 'changeme'),
      isActive: true,
    };
    s.users.set(id, user);
    return json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      organizationId: user.organizationId,
      isActive: true,
    });
  }

  const userPatch = path.match(/^users\/([^/]+)$/);
  if (userPatch && method === 'PATCH') {
    const id = userPatch[1];
    const body = await readJson(req);
    const u = s.users.get(id);
    if (!u) return json({ error: 'Not found' }, 404);
    if (body.role !== undefined) u.role = String(body.role);
    if (body.isActive !== undefined) u.isActive = Boolean(body.isActive);
    if (body.firstName !== undefined) u.firstName = String(body.firstName);
    if (body.lastName !== undefined) u.lastName = String(body.lastName);
    return json({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      isActive: u.isActive !== false,
    });
  }

  // ── Spaces ───────────────────────────────────────────────────────
  if (path === 'spaces' && method === 'GET') {
    return json(Array.from(s.spaces.values()));
  }

  if (path === 'spaces' && method === 'POST') {
    const body = await readJson(req);
    const key = String(body.key || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!key || s.spaces.has(key)) return json({ error: 'Invalid or duplicate space key' }, 400);
    const sp: MockSpace = {
      id: rid(),
      name: String(body.name || key),
      key,
      description: String(body.description || ''),
      type: (body.type as MockSpace['type']) || 'kanban',
      issueCount: 0,
      memberCount: 1,
      members: (() => {
        const u = s.users.get(userId!)!;
        return [
          {
            id: rid(),
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            role: 'admin',
          },
        ];
      })(),
      statuses: defaultStatuses(),
      createdAt: nowIso(),
    };
    s.spaces.set(key, sp);
    s.labels.set(key, []);
    s.automation.set(key, []);
    s.slas.set(key, []);
    return json(sp);
  }

  const spaceKeyMatch = path.match(/^spaces\/([^/]+)$/);
  if (spaceKeyMatch && method === 'GET') {
    const key = spaceKeyMatch[1].toUpperCase();
    const sp = s.spaces.get(key);
    if (!sp) return json({ error: 'Space not found' }, 404);
    // Always return live statuses + transitions from the associated workflow
    // so that newly-added workflow statuses appear in ticket dropdowns
    const wf = Array.from(s.workflows.values()).find((w) => w.spaceKey === key);
    if (wf) {
      return json({ ...sp, key, statuses: wf.statuses, transitions: wf.transitions });
    }
    return json({ ...sp, key });
  }

  if (spaceKeyMatch && method === 'PATCH') {
    const key = spaceKeyMatch[1].toUpperCase();
    const sp = s.spaces.get(key);
    if (!sp) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    if (body.name !== undefined) sp.name = String(body.name);
    if (body.description !== undefined) sp.description = String(body.description);
    if (body.icon !== undefined) sp.icon = String(body.icon);
    if (body.type !== undefined) sp.type = String(body.type) as 'scrum' | 'kanban' | 'service_desk';
    // Persist changes so they survive server restarts
    saveSpacesSeed(Array.from(s.spaces.values()) as Record<string, unknown>[]);
    return json(sp);
  }

  if (spaceKeyMatch && method === 'DELETE') {
    const key = spaceKeyMatch[1].toUpperCase();
    s.spaces.delete(key);
    // Persist deleted space key so hardcoded spaces won't be recreated on restart
    const deletedKeys = loadDeletedSpaces();
    deletedKeys.add(key);
    saveDeletedSpaces(deletedKeys);
    // Persist: remove from spaces seed
    saveSpacesSeed(Array.from(s.spaces.values()) as Record<string, unknown>[]);
    // Also remove all issues belonging to this space from the issues seed
    const remainingIssues: Record<string, unknown>[] = [];
    s.issues.forEach((issue: any) => {
      if ((issue.spaceKey || '').toUpperCase() !== key) {
        remainingIssues.push(issue as Record<string, unknown>);
      }
    });
    // Remove from in-memory store too
    s.issues.forEach((_: any, issueKey: string) => {
      const issue = s.issues.get(issueKey) as any;
      if (issue && (issue.spaceKey || '').toUpperCase() === key) {
        s.issues.delete(issueKey);
      }
    });
    saveIssuesSeed(remainingIssues);
    return json({ ok: true });
  }

  const spaceMembers = path.match(/^spaces\/([^/]+)\/members$/);
  if (spaceMembers && method === 'POST') {
    const key = spaceMembers[1].toUpperCase();
    const sp = s.spaces.get(key);
    if (!sp) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const uid = String(body.userId || '');
    const u = s.users.get(uid);
    if (!u) return json({ error: 'User not found' }, 404);
    sp.members.push({
      id: rid(),
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: String(body.role || 'developer'),
    });
    sp.memberCount = sp.members.length;
    return json(sp);
  }

  // ── Issues list / CRUD ───────────────────────────────────────────
  if (path === 'issues' && method === 'GET') {
    const assignee   = url.searchParams.get('assignee');   // user id
    const reporter   = url.searchParams.get('reporter');   // user id
    const spaceKey   = url.searchParams.get('spaceKey');
    const spaceKeys  = url.searchParams.get('spaceKeys');  // comma-separated keys
    const typeParam  = url.searchParams.get('type');       // comma-separated types
    const statusParam= url.searchParams.get('status');     // comma-separated status names
    const priorityParam = url.searchParams.get('priority');// comma-separated priorities
    const assignees  = url.searchParams.get('assignees');  // comma-separated user ids
    const reporters  = url.searchParams.get('reporters');  // comma-separated user ids
    const searchQ    = url.searchParams.get('q');          // text search
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    // Allow higher limits for filter page (up to 2000)
    const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    let list = Array.from(s.issues.values()) as any[];

    // Space filters
    if (spaceKey) {
      list = list.filter((i) => (i.spaceKey || '').toUpperCase() === spaceKey.toUpperCase());
    } else if (spaceKeys) {
      const keys = spaceKeys.split(',').map((k) => k.trim().toUpperCase());
      list = list.filter((i) => keys.includes((i.spaceKey || '').toUpperCase()));
    }

    // Assignee filters — match by ID or email or "Firstname Lastname" (handles migrated issues)
    /**
     * Multi-key person matching — handles Jira-migrated IDs/names accurately.
     *
     * Priority (highest → lowest):
     *  1. Exact app ID
     *  2. Exact email  ← most reliable for migrated data
     *  3. Exact full name  "Arun Kumar"
     *  4. Exact displayName / accountName from Jira
     *  5. firstName-only token  — only when the issue's own first name exactly equals the token
     *     (prevents "Arun" matching "Varun" via substring)
     */
    const matchPerson = (person: any, ids: string[]) => {
      if (!person) return false;

      // All string identifiers from the issue's person object
      const personId      = (person.id          || '').trim();
      const personEmail   = (person.email        || '').trim().toLowerCase();
      const personDisplay = (person.displayName  || person.name || '').trim().toLowerCase();
      const personFirst   = (person.firstName    || '').trim().toLowerCase();
      const personLast    = (person.lastName     || '').trim().toLowerCase();
      const personFull    = [personFirst, personLast].filter(Boolean).join(' ');

      return ids.some((raw) => {
        const v = raw.trim();
        const vl = v.toLowerCase();

        // 1. Exact ID (case-sensitive)
        if (v === personId) return true;

        // 2. Exact email
        if (personEmail && vl === personEmail) return true;

        // 3. Exact full name
        if (personFull && vl === personFull) return true;

        // 4. Exact displayName
        if (personDisplay && vl === personDisplay) return true;

        // 5. Exact first name — only if the token IS a first name (no spaces) and
        //    the issue person's firstName exactly matches (prevents "Arun" → "Varun")
        if (personFirst && !vl.includes(' ') && vl === personFirst) return true;

        return false;
      });
    };

    const matchAssignee = (issue: any, ids: string[]) => matchPerson(issue.assignee, ids);

    if (assignees) {
      const ids = assignees.split(',').map((x) => x.trim()).filter(Boolean);
      list = list.filter((i) => matchAssignee(i, ids));
    } else if (assignee) {
      list = list.filter((i) => matchAssignee(i, [assignee]));
    }

    // Reporter filters — same multi-key matching
    const matchReporter = (issue: any, ids: string[]) => matchPerson(issue.reporter, ids);
    if (reporters) {
      const ids = reporters.split(',').map((x) => x.trim()).filter(Boolean);
      list = list.filter((i) => matchReporter(i, ids));
    } else if (reporter) {
      list = list.filter((i) => matchReporter(i, [reporter]));
    }

    // Type filter
    if (typeParam) {
      const types = typeParam.split(',').map((t) => t.trim().toLowerCase());
      list = list.filter((i) => types.includes((i.type || '').toLowerCase()));
    }

    // Status filter
    if (statusParam) {
      const statuses = statusParam.split(',').map((s) => s.trim().toLowerCase());
      list = list.filter((i) => statuses.includes((i.status?.name || '').toLowerCase()));
    }

    // Priority filter
    if (priorityParam) {
      const priorities = priorityParam.split(',').map((p) => p.trim().toLowerCase());
      list = list.filter((i) => priorities.includes((i.priority || '').toLowerCase()));
    }

    // Labels filter
    const labelsParam = url.searchParams.get('labels');
    if (labelsParam) {
      const labels = labelsParam.split(',').map((l) => l.trim().toLowerCase());
      list = list.filter((i) => {
        const issueLabels: string[] = (i.labels || []).map((l: any) =>
          (typeof l === 'string' ? l : l.name || '').toLowerCase(),
        );
        return labels.some((l) => issueLabels.includes(l));
      });
    }

    // ── Custom field server-side filters (work across ALL issues) ────────────
    const combinationParam    = url.searchParams.get('combination');
    const productTypeParam    = url.searchParams.get('productType');
    const workTypeParam       = url.searchParams.get('workType');
    const environmentParam    = url.searchParams.get('environment');
    const rootCauseParam      = url.searchParams.get('rootCause');
    const customerNameParam   = url.searchParams.get('customerName');
    const clientNameParam     = url.searchParams.get('clientName');
    const projectManagerParam = url.searchParams.get('projectManager');

    const multiMatch = (val: string | string[], param: string) => {
      const filterVals = param.split(',').map(v => v.trim().toLowerCase());
      const issueVals = Array.isArray(val)
        ? val.map(v => String(v).toLowerCase())
        : [(val || '').toLowerCase()];
      return filterVals.some(fv => issueVals.some(iv => iv === fv || iv.includes(fv)));
    };
    if (combinationParam)    list = list.filter(i => multiMatch(i.combination,     combinationParam));
    if (productTypeParam)    list = list.filter(i => multiMatch(i.productType,     productTypeParam));
    if (workTypeParam)       list = list.filter(i => multiMatch(i.workType,        workTypeParam));
    if (environmentParam)    list = list.filter(i => multiMatch(i.testEnvironment, environmentParam));
    if (rootCauseParam)      list = list.filter(i => multiMatch(i.rootCause,       rootCauseParam));
    if (customerNameParam)   list = list.filter(i => (i.customerName || i.manageClientName || '').toLowerCase().includes(customerNameParam.toLowerCase()));
    if (clientNameParam)     list = list.filter(i => multiMatch(i.clientName,      clientNameParam));
    if (projectManagerParam) list = list.filter(i => multiMatch(i.projectManager,  projectManagerParam));

    // Text search
    if (searchQ) {
      const q = searchQ.toLowerCase();
      list = list.filter((i) =>
        (i.summary || '').toLowerCase().includes(q) ||
        (i.key || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q),
      );
    }

    // Date range helper — supports preset strings + new Jira-style encoded filters
    const parseDateRange = (range: string): { from: Date; to: Date } => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // withinLast:N:unit  → from = now - N units, to = now
      if (range.startsWith('withinLast:')) {
        const [, ns, unit] = range.split(':');
        const n = parseInt(ns, 10) || 7;
        const f = new Date(now);
        if (unit === 'weeks')       f.setDate(f.getDate() - n * 7);
        else if (unit === 'months') f.setMonth(f.getMonth() - n);
        else                        f.setDate(f.getDate() - n);
        return { from: f, to: now };
      }

      // moreThan:N:unit  → from = epoch, to = now - N units
      if (range.startsWith('moreThan:')) {
        const [, ns, unit] = range.split(':');
        const n = parseInt(ns, 10) || 7;
        const t = new Date(now);
        if (unit === 'weeks')       t.setDate(t.getDate() - n * 7);
        else if (unit === 'months') t.setMonth(t.getMonth() - n);
        else                        t.setDate(t.getDate() - n);
        return { from: new Date(0), to: t };
      }

      // between:YYYY-MM-DD:YYYY-MM-DD
      if (range.startsWith('between:')) {
        const parts = range.split(':');
        const from = parts[1] ? new Date(parts[1]) : new Date(0);
        const to   = parts[2] ? new Date(parts[2] + 'T23:59:59') : now;
        return { from, to };
      }

      // In-range presets
      switch (range) {
        case 'today':     return { from: startOfToday, to: now };
        case 'yesterday': { const y = new Date(startOfToday); y.setDate(y.getDate() - 1); const ye = new Date(startOfToday); return { from: y, to: ye }; }
        case '7d':        { const f = new Date(startOfToday); f.setDate(f.getDate() - 7);  return { from: f, to: now }; }
        case '30d':       { const f = new Date(startOfToday); f.setDate(f.getDate() - 30); return { from: f, to: now }; }
        case '90d':       { const f = new Date(startOfToday); f.setDate(f.getDate() - 90); return { from: f, to: now }; }
        default:          return { from: new Date(0), to: now };
      }
    };

    const createdRange = url.searchParams.get('createdRange');
    const updatedRange = url.searchParams.get('updatedRange');

    if (createdRange) {
      const { from, to } = parseDateRange(createdRange);
      list = list.filter((i) => {
        const d = new Date(i.createdAt || 0);
        return d >= from && d <= to;
      });
    }
    if (updatedRange) {
      const { from, to } = parseDateRange(updatedRange);
      list = list.filter((i) => {
        const d = new Date(i.updatedAt || i.createdAt || 0);
        return d >= from && d <= to;
      });
    }

    // Sort descending by ticket number (e.g. L1BOAR-5617 before L1BOAR-1)
    list.sort((a: any, b: any) => {
      const numA = parseInt(String(a.key || '').split('-').pop() || '0', 10);
      const numB = parseInt(String(b.key || '').split('-').pop() || '0', 10);
      return numB - numA;
    });
    const total = list.length;
    const slice = list.slice((page - 1) * limit, page * limit);
    return json({ issues: slice, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
  }

  if (path === 'issues' && method === 'POST') {
    const body = await readJson(req);
    const sk = String(body.spaceKey || '').toUpperCase();
    const sp = s.spaces.get(sk);
    if (!sp) return json({ error: 'Space not found' }, 404);
    const nums = Array.from(s.issues.keys())
      .filter((k) => k.startsWith(`${sk}-`))
      .map((k) => parseInt(k.split('-')[1], 10))
      .filter((n) => !Number.isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const key = `${sk}-${next}`;
    const reporter = s.users.get(userId!)!;
    const stId = String(body.statusId || 'st_todo');
    const st = sp.statuses.find((x) => x.id === stId) || sp.statuses[0];
    const statusObj = { id: st.id, name: st.name, category: st.category, color: st.color };
    let assignee: Record<string, unknown> | null = null;
    if (body.assigneeId) {
      const a = s.users.get(String(body.assigneeId));
      if (a) assignee = { id: a.id, firstName: a.firstName, lastName: a.lastName, email: a.email };
    }
    const issue = buildIssue(key, sp, {
      summary: String(body.summary || 'Untitled'),
      description: String(body.description || ''),
      type: body.type || 'task',
      priority: body.priority || 'medium',
      status: statusObj,
      reporter: { id: reporter.id, firstName: reporter.firstName, lastName: reporter.lastName, email: reporter.email },
      assignee,
      storyPoints: body.storyPoints !== undefined ? Number(body.storyPoints) : undefined,
      dueDate: body.dueDate ? String(body.dueDate) : undefined,
      sprintId: body.sprintId ? String(body.sprintId) : undefined,
      // Custom fields passed during creation (import, email, etc.)
      ...(body.customerName   !== undefined && { customerName:   body.customerName }),
      ...(body.clientName     !== undefined && { clientName:     body.clientName }),
      ...(body.projectManager !== undefined && { projectManager: body.projectManager }),
      ...(body.productType    !== undefined && { productType:    body.productType }),
      ...(body.combination    !== undefined && { combination:    body.combination }),
      ...(body.workType       !== undefined && { workType:       body.workType }),
      ...(body.environment    !== undefined && { environment:    body.environment }),
      ...(body.rootCause      !== undefined && { rootCause:      body.rootCause }),
    } as any);
    s.issues.set(key, issue);
    sp.issueCount = Array.from(s.issues.values()).filter((i) => (i as { spaceKey?: string }).spaceKey === sk).length;
    return json(issue);
  }

  const issueKeyMatch = path.match(/^issues\/([^/]+)$/);
  if (issueKeyMatch && method === 'GET') {
    const key = issueKeyMatch[1].toUpperCase();
    const issue = s.issues.get(key);
    if (!issue) return json({ error: 'Issue not found' }, 404);
    // Dynamically compute SLA instances from space's active policies
    const spKey = String((issue as any).spaceKey || '').toUpperCase();
    const policies = s.slas.get(spKey) || [];
    const computedSLAs = computeIssueSLAs(issue, policies);
    // Merge with inherited SLA from automation (if target space has no SLA policies configured)
    const inheritedSLA: any[] = (issue as any)._inheritedSLA || [];
    const mergedSLAs = computedSLAs.length > 0
      ? computedSLAs
      : inheritedSLA.length > 0
        ? inheritedSLA
        : ((issue as any).sla || []);
    // Attach custom field values to issue response
    const cfVals = s.customFieldValues.get(String((issue as any).id || key)) || {};
    return json({ ...issue, sla: mergedSLAs, customFieldValues: cfVals });
  }

  if (issueKeyMatch && method === 'PATCH') {
    const key = issueKeyMatch[1].toUpperCase();
    const issue = s.issues.get(key) as Record<string, unknown> | undefined;
    if (!issue) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const sp = s.spaces.get(String(issue.spaceKey).toUpperCase());
    if (body.summary !== undefined) issue.summary = body.summary;
    if (body.description !== undefined) issue.description = body.description;
    if (body.type !== undefined) issue.type = body.type;
    if (body.priority !== undefined) issue.priority = body.priority;
    if (body.statusId !== undefined) {
      // Look up status from the workflow first (includes newly-added statuses),
      // then fall back to the space's statuses
      const spKey = String((issue as any).spaceKey || '').toUpperCase();
      const wf = Array.from(s.workflows.values()).find((w) => w.spaceKey === spKey);
      const allStatuses: any[] = wf
        ? (wf.statuses as any[])
        : (sp?.statuses as any[] || []);
      const st = allStatuses.find((x: any) => x.id === String(body.statusId));
      if (st) {
        issue.status = { id: st.id, name: st.name, category: st.category, color: st.color };

        // ── Run flow automation rules for this space ────────────────────────────
        const flowRules = (s.automation.get(spKey) || []) as any[];
        for (const rule of flowRules) {
          if (!rule.enabled) continue;
          const triggerStatuses: string[] = (rule.trigger?.statuses || []).map((x: string) => x.toLowerCase());
          const conditionStatus: string = (rule.condition?.status || '').toLowerCase();
          const newStatusName = st.name.toLowerCase();
          // Trigger matches if new status is in the trigger list
          if (!triggerStatuses.includes(newStatusName)) continue;
          // Condition matches if status equals condition
          if (conditionStatus && newStatusName !== conditionStatus) continue;
          // Execute: create a new issue in the target space
          const targetSk = String(rule.createAction?.spaceKey || '').toUpperCase();
          const targetSp = s.spaces.get(targetSk);
          if (!targetSp) continue;
          const nums2 = Array.from(s.issues.keys())
            .filter((k) => k.startsWith(`${targetSk}-`))
            .map((k) => parseInt(k.split('-')[1], 10))
            .filter((n) => !Number.isNaN(n));
          const nextNum = (nums2.length ? Math.max(...nums2) : 0) + 1;
          const newKey = `${targetSk}-${nextNum}`;
          const wfTarget = Array.from(s.workflows.values()).find((w) => w.spaceKey === targetSk);
          const targetStatuses: any[] = wfTarget ? (wfTarget.statuses as any[]) : (targetSp.statuses as any[] || []);
          const defaultSt = targetStatuses[0] || { id: 'st_todo', name: 'To Do', category: 'todo', color: '#6b7280' };
          const reporter = s.users.get(userId!) || ({ id: 'system', firstName: 'System', lastName: 'Auto', email: '' } as any);
          // Apply copyFields — carry over selected field values from original issue
          const copyFields: string[] = Array.isArray(rule.copyFields) ? rule.copyFields : ['summary', 'priority', 'description'];
          const copySummary    = copyFields.includes('summary')     ? `[AUTO] ${String(issue.summary || '')} (from ${key})` : `[AUTO] from ${key}`;
          const copyDesc       = copyFields.includes('description') ? String((issue as any).description || '') : `Auto-created from ${key} when status changed to ${st.name}.`;
          const copyPriority   = copyFields.includes('priority')    ? String((issue as any).priority || 'medium') : 'medium';
          const copyAssignee   = copyFields.includes('assignee')    ? ((issue as any).assignee || null) : null;
          const copyDueDate    = copyFields.includes('dueDate')     ? ((issue as any).dueDate || undefined) : undefined;
          const copyStoryPts   = copyFields.includes('storyPoints') ? ((issue as any).storyPoints || undefined) : undefined;
          const copySprintId   = copyFields.includes('sprintId')    ? ((issue as any).sprintId || undefined) : undefined;
          const copyType       = copyFields.includes('type')        ? String((issue as any).type || rule.createAction?.workType || 'task').toLowerCase()
                                                                    : String(rule.createAction?.workType || 'task').toLowerCase();
          const newIssue = buildIssue(newKey, targetSp, {
            summary: copySummary,
            description: copyDesc,
            type: copyType,
            priority: copyPriority,
            status: { id: defaultSt.id, name: defaultSt.name, category: defaultSt.category, color: defaultSt.color },
            reporter: { id: reporter.id, firstName: reporter.firstName, lastName: reporter.lastName, email: reporter.email },
            assignee: copyAssignee,
            dueDate: copyDueDate,
            storyPoints: copyStoryPts,
            sprintId: copySprintId,
          });
          s.issues.set(newKey, newIssue);
          targetSp.issueCount = Array.from(s.issues.values()).filter((i) => (i as any).spaceKey === targetSk).length;

          // ── Copy cf_* custom field values to the new ticket ─────────────────
          const cfFieldsToCopy = copyFields.filter((fid: string) => fid.startsWith('cf_'));
          if (cfFieldsToCopy.length > 0) {
            const srcIssueId  = String((issue as any).id || key);
            const newIssueId  = String((newIssue as any).id || newKey);
            const srcCfValues = s.customFieldValues.get(srcIssueId) || s.customFieldValues.get(key) || {};
            const srcSLAs     = computeIssueSLAs(issue, s.slas.get(spKey) || []);
            const newCfValues: Record<string, string> = { ...(s.customFieldValues.get(newIssueId) || {}) };

            for (const fid of cfFieldsToCopy) {
              const bareId = fid.slice(3); // e.g. "cf_summary" → "summary"

              // ── 1. Find the field definition ────────────────────────────────
              const cfDef = s.customFields.find((cf: any) =>
                cf.id === fid || cf.id === bareId || `cf_${cf.id}` === fid
              ) as any;
              const cfName = cfDef ? String(cfDef.name || '').toLowerCase() : bareId.toLowerCase();

              // ── 2. Register field in target space so it shows in L2 issue detail ──
              if (cfDef) {
                const currentSpaceIds: string[] = Array.isArray(cfDef.spaceIds) ? [...cfDef.spaceIds] : [];
                if (!currentSpaceIds.includes(targetSp.id)) {
                  cfDef.spaceIds = [...currentSpaceIds, targetSp.id];
                  // Also persist the update
                  const idx = s.customFields.findIndex((cf: any) => cf.id === cfDef.id);
                  if (idx !== -1) s.customFields[idx] = cfDef;
                }
              }

              // ── 3. Determine value to copy ──────────────────────────────────
              // SLA fields: compute from source issue's SLA status
              const isResolutionField = cfName.includes('resolution');
              const isResponseField   = cfName.includes('response');
              if (isResolutionField || isResponseField) {
                const keyword = isResolutionField ? 'resolution' : 'response';
                const sla = srcSLAs.find((sl: any) => sl.name?.toLowerCase().includes(keyword));
                if (sla) {
                  newCfValues[fid] = sla.breached ? 'Yes' : 'No';
                  if (sla.breachTime) newCfValues[`${fid}_deadline`] = new Date(sla.breachTime).toLocaleString();
                }
                continue; // handled — skip generic copy below
              }

              // System built-in field? Copy directly from the issue object
              const systemMap: Record<string, string> = {
                summary:      String(issue.summary    || ''),
                description:  String((issue as any).description || ''),
                type:         String(issue.type        || ''),
                priority:     String((issue as any).priority    || ''),
                status:       String((issue as any).status?.name || ''),
                assignee:     (issue as any).assignee  ? `${(issue as any).assignee.firstName} ${(issue as any).assignee.lastName}` : '',
                reporter:     (issue as any).reporter  ? `${(issue as any).reporter.firstName} ${(issue as any).reporter.lastName}` : '',
                labels:       JSON.stringify((issue as any).labels || []),
                sprint:       String((issue as any).sprintId    || ''),
                story_points: String((issue as any).storyPoints || ''),
                due_date:     String((issue as any).dueDate     || ''),
              };

              if (bareId in systemMap && systemMap[bareId]) {
                newCfValues[fid] = systemMap[bareId];
                continue;
              }

              // User-created custom field: copy stored value from source
              if (srcCfValues[cfDef?.id] !== undefined) {
                newCfValues[fid] = srcCfValues[cfDef.id];
              } else if (srcCfValues[fid] !== undefined) {
                newCfValues[fid] = srcCfValues[fid];
              }
            }

            // Store by new issue's UUID — this is what GET /custom-fields/issue/:id/values queries
            s.customFieldValues.set(newIssueId, newCfValues);
          }

          // Also copy SLA policies from source space to new ticket — target ticket inherits
          // the same SLA goals so SLA timers start fresh on the new ticket automatically.
          // Store the source issue's SLA breach times as a reference on the new ticket.
          const srcSLAPoliciesForRef = s.slas.get(spKey) || [];
          const srcSLARef = computeIssueSLAs(issue, srcSLAPoliciesForRef);
          if (srcSLARef.length > 0) {
            (newIssue as any)._inheritedSLA = srcSLARef.map((sl: any) => ({
              name: sl.name,
              breachTime: sl.breachTime,
              breached: sl.breached,
              remainingMs: sl.remainingMs,
            }));
          }

          // Link: add a link from original issue → new issue
          const linkId = rid();
          const origLinks = ((issue.links || []) as any[]);
          const newLinks  = ((newIssue.links || []) as any[]);
          const linkObj = {
            id: linkId,
            type: 'created by automation',
            source: { key, summary: String(issue.summary), type: String(issue.type) },
            target: { key: newKey, summary: String(newIssue.summary), type: String(newIssue.type) },
          };
          origLinks.push(linkObj);
          newLinks.push({ ...linkObj, source: linkObj.target, target: linkObj.source, type: 'automation source' });
          issue.links = origLinks;
          newIssue.links = newLinks;

          // Notify
          s.notifications.unshift({
            id: rid(),
            title: `Automation: New ticket ${newKey} created`,
            message: `Rule "${rule.name}" created ${newKey} in ${targetSk} and linked it to ${key}`,
            issueKey: newKey,
            isRead: false,
            createdAt: nowIso(),
          });
        }
      }
    }
    if (body.assigneeId !== undefined) {
      if (!body.assigneeId) issue.assignee = null;
      else {
        const a = s.users.get(String(body.assigneeId));
        if (a) issue.assignee = { id: a.id, firstName: a.firstName, lastName: a.lastName, email: a.email };
      }
    }
    // ── Board-specific custom fields (L2BOARD + L1BOAR) ───────────────────────
    if (body.productType    !== undefined) issue.productType    = body.productType;
    if (body.combination    !== undefined) issue.combination    = body.combination;
    if (body.rootCause      !== undefined) issue.rootCause      = body.rootCause;
    if (body.fixDescription !== undefined) issue.fixDescription = body.fixDescription;
    if (body.projectManager    !== undefined) issue.projectManager    = body.projectManager;
    if (body.customerName      !== undefined) issue.customerName      = body.customerName;
    if (body.clientName        !== undefined) issue.clientName        = body.clientName;
    if (body.testEnvironment   !== undefined) issue.testEnvironment   = body.testEnvironment;
    if (body.manageClientName  !== undefined) issue.manageClientName  = body.manageClientName;
    if (body.customerPlan      !== undefined) issue.customerPlan      = body.customerPlan;
    if (body.testStatus        !== undefined) issue.testStatus        = body.testStatus;
    if (body.workType          !== undefined) issue.workType          = body.workType;
    issue.updatedAt = nowIso();
    // Persist custom field changes to seed for boards that have them
    const spKeyForCF = ((issue as any).spaceKey || '').toUpperCase();
    if (['L2BOARD','L1BOAR','QABOAR','INFRABOARD','L3BOARD','TESTBOARD','CFMBOARD','EBBOARD','MBBOARD','CBBOARD'].includes(spKeyForCF)) {
      saveIssuesSeed(Array.from(s.issues.values()) as Record<string, unknown>[]);
    }
    return json(issue);
  }

  if (issueKeyMatch && method === 'DELETE') {
    const key = issueKeyMatch[1].toUpperCase();
    const issue = s.issues.get(key) as any | undefined;
    if (issue) {
      s.issues.delete(key);
      // Update space issue count
      if (issue.spaceKey) {
        const sp = s.spaces.get(String(issue.spaceKey).toUpperCase());
        if (sp) sp.issueCount = Array.from(s.issues.values()).filter((i: any) => i.spaceKey === issue.spaceKey).length;
      }
      // Clean up custom field values for this issue
      s.customFieldValues.delete(String(issue.id || key));
      // Cascade: remove all links in other issues that reference this deleted key
      s.issues.forEach((otherIssue: any) => {
        if (Array.isArray(otherIssue.links)) {
          otherIssue.links = otherIssue.links.filter(
            (lnk: any) => lnk.source?.key !== key && lnk.target?.key !== key
          );
        }
      });
    }
    return json({ ok: true });
  }

  const issueComments = path.match(/^issues\/([^/]+)\/comments$/);
  if (issueComments && method === 'POST') {
    const key = issueComments[1].toUpperCase();
    const issue = s.issues.get(key) as Record<string, unknown> | undefined;
    if (!issue) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const author = s.users.get(userId!)!;
    const c = {
      id: rid(),
      body: String(body.body || ''),
      isInternal: Boolean(body.isInternal),
      author: { id: author.id, firstName: author.firstName, lastName: author.lastName, email: author.email },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const comments = (issue.comments as unknown[]) || [];
    comments.push(c);
    issue.comments = comments;
    issue.commentCount = comments.length;
    issue.updatedAt = nowIso();
    return json(c);
  }

  const issueLinksPost = path.match(/^issues\/([^/]+)\/links$/);
  if (issueLinksPost && method === 'POST') {
    const key = issueLinksPost[1].toUpperCase();
    const issue = s.issues.get(key) as Record<string, unknown> | undefined;
    if (!issue) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const targetKey = String(body.targetKey || '').toUpperCase();
    const target = s.issues.get(targetKey) as { summary?: string; type?: string } | undefined;
    const id = rid();
    const link = {
      id,
      type: String(body.linkType || 'relates'),
      source: { key, summary: String(issue.summary), type: String(issue.type) },
      target: { key: targetKey, summary: String(target?.summary || targetKey), type: String(target?.type || 'task') },
    };
    s.issueLinks.set(id, link);
    const links = (issue.links as unknown[]) || [];
    links.push(link);
    issue.links = links;
    return json(link);
  }

  const issueAttach = path.match(/^issues\/([^/]+)\/attachments$/);
  if (issueAttach && method === 'POST') {
    const key = issueAttach[1].toUpperCase();
    const issue = s.issues.get(key) as Record<string, unknown> | undefined;
    if (!issue) return json({ error: 'Not found' }, 404);
    const author = s.users.get(userId!)!;
    const att = {
      id: rid(),
      filename: 'upload.bin',
      originalName: 'upload.bin',
      mimeType: 'application/octet-stream',
      size: 0,
      url: `/uploads/mock`,
      uploader: { firstName: author.firstName, lastName: author.lastName },
      createdAt: nowIso(),
    };
    const attachments = (issue.attachments as unknown[]) || [];
    attachments.push(att);
    issue.attachments = attachments;
    issue.attachmentCount = attachments.length;
    return json(att);
  }

  const issueLinkDel = path.match(/^issues\/links\/([^/]+)$/);
  if (issueLinkDel && method === 'DELETE') {
    const lid = issueLinkDel[1];
    s.issueLinks.delete(lid);
    for (const iss of Array.from(s.issues.values())) {
      const rec = iss as Record<string, unknown>;
      const links = (rec.links as Array<{ id?: string }>) || [];
      rec.links = links.filter((x) => x.id !== lid);
    }
    return json({ ok: true });
  }

  // ── Sprints ──────────────────────────────────────────────────────
  if (path === 'sprints' && method === 'GET') {
    const sk = url.searchParams.get('spaceKey');
    const list = Array.from(s.sprints.values()).filter((sp) => !sk || String(sp.spaceKey) === sk.toUpperCase());
    return json(list);
  }

  if (path === 'sprints' && method === 'POST') {
    const body = await readJson(req);
    const id = rid();
    const sprint = {
      id,
      name: String(body.name || 'Sprint'),
      goal: String(body.goal || ''),
      status: 'planning',
      spaceKey: String(body.spaceKey || '').toUpperCase(),
      startDate: body.startDate ? String(body.startDate) : undefined,
      endDate: body.endDate ? String(body.endDate) : undefined,
      issueCount: 0,
      totalPoints: 0,
      completedCount: 0,
      createdAt: nowIso(),
    };
    s.sprints.set(id, sprint);
    return json(sprint);
  }

  const sprintPatch = path.match(/^sprints\/([^/]+)$/);
  if (sprintPatch && method === 'PATCH') {
    const id = sprintPatch[1];
    const sp = s.sprints.get(id);
    if (!sp) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    Object.assign(sp, body);
    return json(sp);
  }

  const sprintComplete = path.match(/^sprints\/([^/]+)\/complete$/);
  if (sprintComplete && method === 'POST') {
    const id = sprintComplete[1];
    const sp = s.sprints.get(id);
    if (!sp) return json({ error: 'Not found' }, 404);
    sp.status = 'completed';
    return json(sp);
  }

  // ── Workflows (minimal) ─────────────────────────────────────────
  if (path === 'workflows' && method === 'GET') {
    const sk = url.searchParams.get('spaceKey')?.toUpperCase();
    const wf = Array.from(s.workflows.values()).filter((w) => !sk || w.spaceKey === sk);
    return json(wf);
  }

  const wfStatuses = path.match(/^workflows\/([^/]+)\/statuses$/);
  if (wfStatuses && method === 'GET') {
    const wfId = wfStatuses[1];
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ statuses: [], transitions: [] });
    return json({ statuses: wf.statuses, transitions: wf.transitions });
  }

  if (wfStatuses && method === 'POST') {
    const wfId = wfStatuses[1];
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const st = {
      id: rid(),
      name: String(body.name || 'Status'),
      category: String(body.category || 'todo'),
      color: String(body.color || '#64748B'),
      order: (wf.statuses as { order?: number }[]).length,
    };
    (wf.statuses as unknown[]).push(st);
    return json(st);
  }

  const wfStatusPatch = path.match(/^workflows\/([^/]+)\/statuses\/([^/]+)$/);
  if (wfStatusPatch && method === 'PATCH') {
    const [, wfId, stId] = wfStatusPatch;
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const st = (wf.statuses as Record<string, unknown>[]).find((x) => x.id === stId);
    if (!st) return json({ error: 'Not found' }, 404);
    if (body.name !== undefined) st.name = body.name;
    if (body.category !== undefined) st.category = body.category;
    if (body.color !== undefined) st.color = body.color;
    return json(st);
  }

  const wfStatusDel = path.match(/^workflows\/([^/]+)\/statuses\/([^/]+)$/);
  if (wfStatusDel && method === 'DELETE') {
    const [, wfId, stId] = wfStatusDel;
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ error: 'Not found' }, 404);
    wf.statuses = (wf.statuses as { id: string }[]).filter((x) => x.id !== stId);
    return json({ ok: true });
  }

  const wfTransDel = path.match(/^workflows\/([^/]+)\/transitions\/([^/]+)$/);
  if (wfTransDel && method === 'DELETE') {
    const [, wfId, trId] = wfTransDel;
    const wf = s.workflows.get(wfId);
    if (wf) wf.transitions = (wf.transitions as { id: string }[]).filter((t) => t.id !== trId);
    return json({ ok: true });
  }

  const wfReorder = path.match(/^workflows\/([^/]+)\/statuses\/reorder$/);
  if (wfReorder && method === 'PUT') {
    return json({ ok: true });
  }

  const wfDefaults = path.match(/^workflows\/([^/]+)\/transitions\/defaults$/);
  if (wfDefaults && method === 'POST') {
    const wfId = wfDefaults[1];
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ error: 'Not found' }, 404);
    type TrRow = { fromStatusId: string; toStatusId: string };
    const sts = wf.statuses as { id: string; category: string }[];
    const todos      = sts.filter((x) => x.category === 'todo');
    const inProgress = sts.filter((x) => x.category === 'in_progress');
    const done       = sts.filter((x) => x.category === 'done');
    const existing   = wf.transitions as TrRow[];
    const hasTr      = (f: string, t: string) => existing.some((x) => x.fromStatusId === f && x.toStatusId === t);
    const created: unknown[] = [];
    for (const t of todos)      for (const p of inProgress) if (!hasTr(t.id, p.id)) { const r = { id: rid(), fromStatusId: t.id, toStatusId: p.id, name: 'Start Progress' }; created.push(r); }
    for (const p of inProgress) for (const d of done)       if (!hasTr(p.id, d.id)) { const r = { id: rid(), fromStatusId: p.id, toStatusId: d.id, name: 'Done'           }; created.push(r); }
    for (const p of inProgress) for (const t of todos)      if (!hasTr(p.id, t.id)) { const r = { id: rid(), fromStatusId: p.id, toStatusId: t.id, name: 'Stop Progress'  }; created.push(r); }
    for (const d of done)       for (const p of inProgress) if (!hasTr(d.id, p.id)) { const r = { id: rid(), fromStatusId: d.id, toStatusId: p.id, name: 'Reopen'         }; created.push(r); }
    (wf.transitions as unknown[]).push(...created);
    return json({ created: created.length, transitions: wf.transitions });
  }

  const wfTransPost = path.match(/^workflows\/([^/]+)\/transitions$/);
  if (wfTransPost && method === 'POST') {
    const wfId = wfTransPost[1];
    const wf = s.workflows.get(wfId);
    if (!wf) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    const tr = {
      id: rid(),
      fromStatusId: String(body.fromStatusId || ''),
      toStatusId:   String(body.toStatusId   || ''),
      name:         String(body.name         || ''),
    };
    (wf.transitions as unknown[]).push(tr);
    return json(tr);
  }

  // ── Labels, automation, notifications ─────────────────────────────
  if (path === 'labels' && method === 'GET') {
    const sk = url.searchParams.get('spaceKey')?.toUpperCase() || '';
    return json(s.labels.get(sk) || []);
  }

  if (path === 'labels' && method === 'POST') {
    const body = await readJson(req);
    const sk = String(body.spaceKey || '').toUpperCase();
    const arr = s.labels.get(sk) || [];
    const lab = { id: rid(), name: String(body.name || 'label'), color: String(body.color || '#3B82F6') };
    arr.push(lab);
    s.labels.set(sk, arr);
    return json(lab);
  }

  if (path === 'automation' && method === 'GET') {
    const sk = url.searchParams.get('spaceKey')?.toUpperCase() || '';
    return json(s.automation.get(sk) || []);
  }

  if (path === 'automation' && method === 'POST') {
    const body = (await readJson(req)) as Record<string, unknown>;
    const sk = String(body.spaceKey || '').toUpperCase();
    const rule = { id: rid(), ...body };
    const existing = s.automation.get(sk) || [];
    existing.push(rule);
    s.automation.set(sk, existing);
    return json(rule);
  }

  const autoPatch = path.match(/^automation\/([^/]+)$/);
  if (autoPatch && method === 'PATCH') {
    const id = autoPatch[1];
    const body = (await readJson(req)) as Record<string, unknown>;
    // Update the rule across all spaces
    let found = false;
    s.automation.forEach((rules, sk) => {
      if (found) return;
      const idx = (rules as any[]).findIndex((r: any) => r.id === id);
      if (idx !== -1) {
        (rules as any[])[idx] = { ...(rules as any[])[idx], ...body };
        s.automation.set(sk, rules);
        found = true;
      }
    });
    return json({ id, ...body });
  }

  const autoDel = path.match(/^automation\/([^/]+)$/);
  if (autoDel && method === 'DELETE') {
    const id = autoDel[1];
    s.automation.forEach((rules, sk) => {
      const filtered = (rules as any[]).filter((r: any) => r.id !== id);
      if (filtered.length !== (rules as any[]).length) s.automation.set(sk, filtered);
    });
    return json({ ok: true });
  }

  // ── Flow automation upsert: PUT /automation/flow/:spaceKey ───────────────────
  const autoFlowPut = path.match(/^automation\/flow\/([^/]+)$/);
  if (autoFlowPut && method === 'PUT') {
    const sk = autoFlowPut[1].toUpperCase();
    const body = (await readJson(req)) as Record<string, unknown>;
    const id = String(body.id || rid());
    const existing = (s.automation.get(sk) || []) as any[];
    const idx = existing.findIndex((r: any) => r.id === id);
    const rule = { ...body, id, spaceKey: sk };
    if (idx !== -1) existing[idx] = rule; else existing.push(rule);
    s.automation.set(sk, existing);
    return json(rule);
  }

  if (path === 'notifications' && method === 'GET') {
    const unread = s.notifications.filter((n) => !n.isRead).length;
    return json({ notifications: s.notifications, unreadCount: unread });
  }

  const notRead = path.match(/^notifications\/([^/]+)\/read$/);
  if (notRead && method === 'PATCH') {
    const n = s.notifications.find((x) => x.id === notRead[1]);
    if (n) n.isRead = true;
    return json({ ok: true });
  }

  // ── Persist seed (called by migration script after bulk import) ──────────────
  if (path === 'admin/persist-seed' && method === 'POST') {
    saveIssuesSeed(Array.from(s.issues.values()) as Record<string, unknown>[]);
    saveSpacesSeed(Array.from(s.spaces.values()) as Record<string, unknown>[]);
    return json({ ok: true, issues: s.issues.size, spaces: s.spaces.size });
  }

  if (path === 'notifications/read-all' && method === 'POST') {
    s.notifications.forEach((n) => {
      n.isRead = true;
    });
    return json({ ok: true });
  }

  // ── Filters ─────────────────────────────────────────────────────
  // Guard: ensure filters array exists (handles old globalThis instances after HMR)
  if (!Array.isArray(s.filters)) s.filters = [];

  if (path === 'filters' && method === 'GET') {
    return json(s.filters);
  }
  if (path === 'filters' && method === 'POST') {
    const body = await readJson(req);
    const ownerUser = s.users.get(userId || '');
    const filter = {
      id: rid(),
      name: String(body.name || 'Untitled filter'),
      description: String(body.description || ''),
      criteria: body.criteria || {},
      ownerId: userId,
      ownerName: ownerUser ? `${ownerUser.firstName} ${ownerUser.lastName}` : 'Unknown',
      starred: false,
      starredBy: [] as string[],
      viewers: [] as string[],
      editors: [] as string[],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    s.filters.push(filter);
    return json(filter);
  }
  if (path.match(/^filters\/([^/]+)$/) && method === 'PATCH') {
    if (!Array.isArray(s.filters)) s.filters = [];
    const filterId = path.split('/')[1];
    const filter = s.filters.find((f: any) => f.id === filterId);
    if (!filter) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    Object.assign(filter, body, { updatedAt: nowIso() });
    return json(filter);
  }
  if (path.match(/^filters\/([^/]+)$/) && method === 'DELETE') {
    const filterId = path.split('/')[1];
    const idx = s.filters.findIndex((f: any) => f.id === filterId);
    if (idx !== -1) s.filters.splice(idx, 1);
    return json({ ok: true });
  }
  if (path.match(/^filters\/([^/]+)\/star$/) && method === 'POST') {
    const filterId = path.split('/')[1];
    const filter = s.filters.find((f: any) => f.id === filterId) as any;
    if (filter) {
      if (!filter.starredBy) filter.starredBy = [];
      if (!filter.starredBy.includes(userId)) filter.starredBy.push(userId);
      filter.starred = filter.ownerId === userId ? true : filter.starred;
    }
    return json({ ok: true });
  }
  if (path.match(/^filters\/([^/]+)\/star$/) && method === 'DELETE') {
    const filterId = path.split('/')[1];
    const filter = s.filters.find((f: any) => f.id === filterId) as any;
    if (filter) {
      filter.starredBy = (filter.starredBy || []).filter((id: string) => id !== userId);
      if (filter.ownerId === userId) filter.starred = false;
    }
    return json({ ok: true });
  }

  // ── Reports ─────────────────────────────────────────────────────
  if (path === 'reports/dashboard' && method === 'GET') {
    return json({
      totalIssues: s.issues.size,
      byStatus: [],
      byPriority: [],
      byType: [],
      byAssignee: [],
      slaBreaches: 0,
      trend: [],
      recentActivity: [],
    } satisfies Record<string, unknown>);
  }

  if (path === 'reports/burndown' && method === 'GET') {
    return json({
      totalPoints: 10,
      dailyProgress: [
        { date: nowIso(), pointsCompleted: 2 },
        { date: nowIso(), pointsCompleted: 5 },
      ],
    });
  }

  if (path === 'reports/velocity' && method === 'GET') {
    return json([]);
  }

  if (path === 'reports/user-performance' && method === 'GET') {
    return json(
      Array.from(s.users.values()).map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`,
        totalAssigned: 0,
        completed: 0,
        inProgress: 0,
        avgResolutionHours: 0,
      })),
    );
  }

  // ── Custom fields ─────────────────────────────────────────────────
  if (path === 'custom-fields' && method === 'GET') {
    // Always reload from disk so all worker processes see the latest fields
    const persisted = loadPersistedFields();
    const systemIds = new Set(SYSTEM_FIELDS.map(f => f.id as string));
    const persistedById = new Map(persisted.map(f => [f.id as string, f]));
    const systemFieldsMerged = SYSTEM_FIELDS.map(f => {
      const saved = persistedById.get(f.id as string);
      const spaceIds = saved && Array.isArray(saved.spaceIds) ? saved.spaceIds : (f.spaceIds || []);
      return { ...f, spaceIds };
    });
    const userFields = persisted.filter(f => !systemIds.has(f.id as string));
    const allFields = [...systemFieldsMerged, ...userFields];
    // Keep in-memory store in sync
    s.customFields = allFields;
    return json(allFields.filter((f) => !f.isDeleted));
  }

  if (path === 'custom-fields' && method === 'POST') {
    const body = await readJson(req);
    const f = { id: rid(), ...body, source: 'custom', isDeleted: false, createdAt: nowIso() };
    s.customFields.push(f);
    savePersistedFields(s.customFields); // persist immediately
    return json(f);
  }

  const cfPatch = path.match(/^custom-fields\/([^/]+)$/);
  if (cfPatch && (method === 'PATCH' || method === 'DELETE')) {
    const id = cfPatch[1];
    const f = s.customFields.find((x) => x.id === id);
    if (!f) return json({ error: 'Not found' }, 404);
    if (method === 'DELETE') {
      // System fields cannot be deleted — soft-delete only for custom
      if (f.source === 'system') return json({ error: 'System fields cannot be deleted' }, 403);
      f.isDeleted = true;
      savePersistedFields(s.customFields); // persist immediately
      return json({ ok: true });
    }
    Object.assign(f, await readJson(req));
    savePersistedFields(s.customFields); // persist immediately
    return json(f);
  }

  const cfSpaces = path.match(/^custom-fields\/([^/]+)\/spaces$/);
  if (cfSpaces && method === 'PUT') {
    const id = cfSpaces[1];
    const f = s.customFields.find((x) => x.id === id);
    if (!f) return json({ error: 'Not found' }, 404);
    const body = await readJson(req);
    f.spaceIds = Array.isArray(body.spaceIds) ? body.spaceIds : [];
    if (Array.isArray(body.createIssueSpaceIds)) {
      (f as any).createIssueSpaceIds = body.createIssueSpaceIds;
    }
    savePersistedFields(s.customFields);
    return json({ ok: true, spaceIds: f.spaceIds, createIssueSpaceIds: (f as any).createIssueSpaceIds || [] });
  }

  if (cfSpaces && method === 'GET') {
    const id = cfSpaces[1];
    const f = s.customFields.find((x) => x.id === id);
    if (!f) return json({ error: 'Not found' }, 404);
    return json({ spaceIds: f.spaceIds || [], createIssueSpaceIds: (f as any).createIssueSpaceIds || [] });
  }

  const cfIssueVals = path.match(/^custom-fields\/issue\/([^/]+)\/values$/);
  if (cfIssueVals && method === 'GET') {
    const issueId = cfIssueVals[1];
    return json(Object.entries(s.customFieldValues.get(issueId) || {}).map(([fieldId, value]) => ({ fieldId, value })));
  }

  const cfIssueValPut = path.match(/^custom-fields\/issue\/([^/]+)\/values\/([^/]+)$/);
  if (cfIssueValPut && method === 'PUT') {
    const [, issueId, fieldId] = cfIssueValPut;
    const body = await readJson(req);
    const m = s.customFieldValues.get(issueId) || {};
    m[fieldId] = String(body.value ?? '');
    s.customFieldValues.set(issueId, m);
    return json({ ok: true });
  }

  // ── SLA ───────────────────────────────────────────────────────────
  const slaList = path.match(/^sla\/([^/]+)$/);
  if (slaList && method === 'GET') {
    return json(s.slas.get(slaList[1].toUpperCase()) || []);  // always 200
  }

  if (slaList && method === 'POST') {
    const sk = slaList[1].toUpperCase();
    const body = await readJson(req);
    const arr = s.slas.get(sk) || [];
    const row = { id: rid(), ...body };
    arr.push(row);
    s.slas.set(sk, arr);
    return json(row);
  }

  const slaItem = path.match(/^sla\/([^/]+)\/([^/]+)$/);
  if (slaItem && method === 'PATCH') {
    return json({ id: slaItem[2], ok: true });
  }

  if (slaItem && method === 'DELETE') {
    return json({ ok: true });
  }

  // ══════════════════════════════════════════════════════════════════
  // EMAIL SYSTEM — same pipeline as Jira/Atlassian
  //
  //  Flow:  Customer sends email → MX/mail service receives it
  //         → POSTs to POST /api/email/receive (webhook)
  //         → We look up which space owns that "to" address
  //         → Create issue, log entry, optional auto-reply
  //
  //  For local dev we simulate via the "Send test email" panel which
  //  calls POST /api/email/receive directly.
  //
  //  In production: point SendGrid / Mailgun / AWS SES Inbound Parse
  //  to  https://yourapp.com/api/email/receive
  // ══════════════════════════════════════════════════════════════════

  // ── GET /email-addresses/:spaceKey  (list registered addresses) ──
  const emailAddrList = path.match(/^email-addresses\/([^/]+)$/);
  if (emailAddrList && method === 'GET') {
    const sk = emailAddrList[1].toUpperCase();
    const list = Array.from(s.emailAddresses.values()).filter((a: any) => a.spaceKey === sk);
    return json(list);
  }

  // ── POST /email-addresses/:spaceKey  (register a new address) ────
  if (emailAddrList && method === 'POST') {
    const sk = emailAddrList[1].toUpperCase();
    // Note: space existence is NOT checked here — spaces may live in PostgreSQL
    const body = await readJson(req);
    const address = String(body.address || '').toLowerCase().trim();
    if (!address) return json({ error: 'address required' }, 400);
    if (s.emailAddresses.has(address)) return json({ error: 'Address already registered' }, 409);
    const record = {
      id: rid(),
      address,
      spaceKey: sk,
      requestType: String(body.requestType || 'Emailed request'),
      isReplyTo: body.isReplyTo === true,
      autoReply: body.autoReply !== false,
      autoReplyText: String(body.autoReplyText || 'Thank you for contacting us. We will get back to you shortly.'),
      enabled: true,
      department: body.department ? String(body.department) : null,
      createdAt: nowIso(),
    };
    s.emailAddresses.set(address, record);
    return json(record);
  }

  // ── DELETE /email-addresses/:spaceKey/:addressId  (remove) ───────
  const emailAddrDel = path.match(/^email-addresses\/([^/]+)\/([^/]+)$/);
  if (emailAddrDel && method === 'DELETE') {
    const id = emailAddrDel[2];
    for (const [addr, rec] of Array.from(s.emailAddresses.entries())) {
      if ((rec as any).id === id) { s.emailAddresses.delete(addr); break; }
    }
    return json({ ok: true });
  }

  // ── PATCH /email-addresses/:spaceKey/:addressId  (update settings) ──
  if (emailAddrDel && method === 'PATCH') {
    const id = emailAddrDel[2];
    const body = await readJson(req);
    let patchedAddress: string | null = null;
    for (const [addr, rec] of Array.from(s.emailAddresses.entries())) {
      if ((rec as any).id === id) {
        Object.assign(rec, body);
        patchedAddress = addr;
        break;
      }
    }
    // Persist department change to DB so email/receive picks it up
    if (patchedAddress && 'department' in body) {
      try {
        const { pgPool: pool } = await import('@/lib/pg-pool');
        await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`);
        await pool.query(
          `UPDATE email_configs SET department = $1 WHERE LOWER(address) = $2`,
          [body.department ?? null, patchedAddress.toLowerCase()]
        );
      } catch { /* non-critical — in-memory store still updated */ }
    }
    return json({ ok: true });
  }

  // ── GET /email-logs/:spaceKey  ────────────────────────────────────
  const emailLogsGet = path.match(/^email-logs\/([^/]+)$/);
  if (emailLogsGet && method === 'GET') {
    const sk = emailLogsGet[1].toUpperCase();
    return json(s.emailLogs.get(sk) || []);
  }

  // ── POST /email/receive  ── THE MAIN WEBHOOK ──────────────────────
  // This is what SendGrid / Mailgun / AWS SES posts to when an email arrives.
  // Body: { from, to, subject, body, attachments? }
  if (path === 'email/receive' && method === 'POST') {
    const body = await readJson(req);
    const toAddress  = String(body.to  || '').toLowerCase().trim();
    const fromEmail  = String(body.from || 'customer@example.com').trim();
    const subject    = String(body.subject || 'Support request').trim();
    const emailBody  = String(body.body || '').trim();
    const attachments = (body.attachments as any[]) || [];

    // Look up which space owns this "to" address
    let addrRecord = s.emailAddresses.get(toAddress) as any;
    if (!addrRecord) {
      // Auto-register unknown address: derive spaceKey from email prefix
      // e.g. l1board@cloudfuze.com → L1BOARD
      const autoPrefix = toAddress.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
      addrRecord = {
        id: `email_auto_${Date.now()}`,
        address: toAddress,
        spaceKey: autoPrefix,
        requestType: 'Emailed request',
        isReplyTo: false,
        autoReply: true,
        autoReplyText: 'Thank you for contacting us. We have received your request and will get back to you shortly.',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      s.emailAddresses.set(toAddress, addrRecord);
      console.log(`[processInboundEmail] Auto-registered ${toAddress} → space ${autoPrefix}`);
    }
    if (!addrRecord.enabled) {
      return json({ ok: false, reason: 'Email channel disabled' });
    }

    const sk = String(addrRecord.spaceKey).toUpperCase();
    let sp = s.spaces.get(sk);
    if (!sp) {
      // Space may live in PostgreSQL — create a minimal fallback in memory
      sp = { key: sk, name: sk, statuses: [{ id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }], members: [], issueCount: 0 } as any;
      s.spaces.set(sk, sp!);
    }

    // Build the issue
    const admin = s.users.get('u_admin') || Array.from(s.users.values())[0];
    const nums = Array.from(s.issues.keys())
      .filter((k) => k.startsWith(`${sk}-`))
      .map((k) => parseInt(k.split('-')[1], 10))
      .filter((n) => !Number.isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const issueKey = `${sk}-${next}`;
    const statusObj = sp.statuses[0]
      ? { id: sp.statuses[0].id, name: sp.statuses[0].name, category: sp.statuses[0].category, color: sp.statuses[0].color }
      : { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' };

    const issue = buildIssue(issueKey, sp, {
      summary: subject,
      description: emailBody
        ? `*Received via email from ${fromEmail}*\n\n${emailBody}`
        : `*Received via email from ${fromEmail}*`,
      type: 'service_request',
      priority: 'medium',
      status: statusObj,
      reporter: {
        id: `email_${fromEmail}`,
        firstName: fromEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).split(' ')[0] || fromEmail.split('@')[0],
        lastName:  fromEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).split(' ').slice(1).join(' ') || '',
        email: fromEmail,
      },
      attachments: attachments.map((a: any) => ({ id: rid(), name: a.filename || 'attachment', url: a.url || '', size: a.size || 0 })),
    });
    s.issues.set(issueKey, issue);
    sp.issueCount = (sp.issueCount || 0) + 1;

    // Log the email
    const logs = s.emailLogs.get(sk) || [];
    const logEntry = {
      id: rid(),
      from: fromEmail,
      to: toAddress,
      subject,
      body: emailBody,
      issue: issueKey,
      time: nowIso(),
      status: 'created',
      autoReplySent: addrRecord.autoReply,
    };
    logs.unshift(logEntry);
    s.emailLogs.set(sk, logs);

    // "Send" auto-reply (simulated — in production you'd call SendGrid/SES here)
    const autoReply = addrRecord.autoReply ? {
      to: fromEmail,
      from: toAddress,
      subject: `Re: ${subject}`,
      body: addrRecord.autoReplyText,
      issueKey,
      issueUrl: `/issues/${issueKey}`,
    } : null;

    return json({
      ok: true,
      issueKey,
      issueUrl: `/issues/${issueKey}`,
      log: logEntry,
      autoReply,
      message: `Issue ${issueKey} created from email. ${addrRecord.autoReply ? 'Auto-reply sent.' : ''}`,
    });
  }

  // ── Legacy: POST /email-ingest/:spaceKey (kept for backward compat) ──
  const emailIngest = path.match(/^email-ingest\/([^/]+)$/);
  if (emailIngest && method === 'POST') {
    const sk = emailIngest[1].toUpperCase();
    const sp = s.spaces.get(sk);
    if (!sp) return json({ error: 'Space not found' }, 404);
    const body = await readJson(req);
    // Find the reply-to address for this space, or use a default
    const replyTo = Array.from(s.emailAddresses.values()).find((a: any) => a.spaceKey === sk && a.isReplyTo) as any;
    const toAddress = replyTo?.address || `${sk.toLowerCase()}@cloudfuze.com`;
    // Forward to the main webhook
    const fromEmail = String(body.from || 'customer@example.com');
    const subject   = String(body.subject || 'Support request');
    const emailBody = String(body.body || '');
    const admin     = s.users.get('u_admin') || Array.from(s.users.values())[0];
    const nums = Array.from(s.issues.keys())
      .filter((k) => k.startsWith(`${sk}-`))
      .map((k) => parseInt(k.split('-')[1], 10))
      .filter((n) => !Number.isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    const key = `${sk}-${next}`;
    const issue = buildIssue(key, sp, {
      summary: subject,
      description: emailBody ? `*From: ${fromEmail}*\n\n${emailBody}` : `*From: ${fromEmail}*`,
      type: 'service_request', priority: 'medium',
      status: sp.statuses[0] ? { id: sp.statuses[0].id, name: sp.statuses[0].name, category: sp.statuses[0].category, color: sp.statuses[0].color } : { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' },
      reporter: {
        id: `email_${fromEmail}`,
        firstName: fromEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).split(' ')[0] || fromEmail.split('@')[0],
        lastName:  fromEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).split(' ').slice(1).join(' ') || '',
        email: fromEmail,
      },
    });
    s.issues.set(key, issue);
    sp.issueCount = (sp.issueCount || 0) + 1;
    const logs = s.emailLogs.get(sk) || [];
    const logEntry = { id: rid(), from: fromEmail, to: toAddress, subject, issue: key, time: nowIso(), status: 'created', autoReplySent: true };
    logs.unshift(logEntry);
    s.emailLogs.set(sk, logs);
    return json({ ok: true, issue: key, issueKey: key, log: logEntry });
  }

  // ── Search ────────────────────────────────────────────────────────
  if (path === 'search' && method === 'POST') {
    const body = await readJson(req);
    const q = String(body.jql || '').toLowerCase().trim();
    let list = Array.from(s.issues.values());
    if (q) {
      // Subsequence check: all chars of `sub` appear in `str` in order
      // e.g. "infa1" is a subsequence of "infra1" (skips the 'r')
      const isSubseq = (sub: string, str: string): boolean => {
        let si = 0;
        for (let i = 0; i < str.length && si < sub.length; i++) {
          if (str[i] === sub[si]) si++;
        }
        return si === sub.length;
      };

      // Levenshtein distance for short strings (handles 1-2 char mistakes)
      const levenshtein = (a: string, b: string): number => {
        const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
          Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
        );
        for (let i = 1; i <= a.length; i++)
          for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1]
              ? dp[i-1][j-1]
              : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        return dp[a.length][b.length];
      };

      const fuzzyKey = (issueKey: string): boolean => {
        const k = issueKey.toLowerCase();
        if (k.includes(q)) return true;

        // Prefix match: "infr" matches "infra-1"
        const [kPre = '', kNum = ''] = k.split('-');
        const [qPre = '', qNum = ''] = q.split('-');
        const numOk = !qNum || kNum === qNum || kNum.startsWith(qNum);

        // Key prefix starts with query prefix or vice versa
        if ((kPre.startsWith(qPre) || qPre.startsWith(kPre)) && numOk) return true;

        // Subsequence on key without hyphen: "infa1" ⊆ "infra1"
        const kFlat = k.replace('-', '');
        const qFlat = q.replace('-', '');
        if (isSubseq(qFlat, kFlat) && numOk) return true;

        // Levenshtein on prefix only: distance ≤ 2 for longer keys, ≤ 1 for short
        const maxDist = qPre.length <= 4 ? 1 : 2;
        if (levenshtein(qPre, kPre) <= maxDist && numOk) return true;

        return false;
      };

      // Fuzzy summary match: all words of query appear somewhere in summary
      const fuzzySummary = (summary: string): boolean => {
        if (summary.includes(q)) return true;
        const words = q.split(/\s+/).filter(Boolean);
        return words.length > 1 && words.every(w => summary.includes(w));
      };

      list = list.filter((i: any) => {
        const summary = String(i.summary || '').toLowerCase();
        const key     = String(i.key     || '');
        const type    = String(i.type    || '').toLowerCase();
        return fuzzySummary(summary) || fuzzyKey(key) || type.includes(q);
      });
    }
    return json({ issues: list.slice(0, 20), total: list.length, page: 1, totalPages: 1 });
  }

  return json(
    {
      error: `Dev mock: unhandled ${method} /${path}`,
      hint: 'Set NEXT_PUBLIC_API_URL=http://localhost:4000/api if you use the real Jira API server.',
    },
    501,
  );
}

// ── Direct email processing (bypasses HTTP layer — called from receive/route.ts) ──

export interface EmailAttachment {
  filename?: string;
  contentType?: string;
  size?: number;
  content?: string;   // base64 encoded content
  url?: string;
}

export interface InboundEmailData {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body?: string;
  // RFC 2822 threading headers
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];   // space/comma separated or array
  attachments?: EmailAttachment[];
}

export interface InboundEmailResult {
  ok: boolean;
  action?: 'created' | 'comment_added';
  issueKey?: string;
  issueUrl?: string;
  message?: string;
  reason?: string;
  autoReply?: {
    to: string;
    from: string;
    subject: string;
    body: string;
    issueKey: string;
    issueUrl: string;
    // Threading headers to include in the outbound SMTP reply
    inReplyTo: string;
    references: string;
    outboundMessageId: string;
  } | null;
  log?: Record<string, unknown>;
}

/** Parse References header — may be space/comma separated or an array */
function parseReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs.map(r => r.trim()).filter(Boolean);
  return refs.split(/[\s,]+/).map(r => r.trim()).filter(Boolean);
}

/** Generate a RFC 2822 Message-ID */
function generateMessageId(domain = 'cloudfuze.com'): string {
  return `<${rid()}.${Date.now()}@${domain}>`;
}

/** Extract ticket key from subject, e.g. "[INFRA-42]" or "Re: ... [INFRA-42]" */
function extractTicketKeyFromSubject(subject: string): string | null {
  const m = subject.match(/\[([A-Z]+-\d+)\]/);
  return m ? m[1] : null;
}

export function processInboundEmail(data: InboundEmailData): InboundEmailResult {
  const s = getStore();

  const toAddress  = String(data.to   || '').toLowerCase().trim();
  const fromEmail  = String(data.from || 'customer@example.com').trim();
  const cc         = String(data.cc   || '').trim();
  const subject    = String(data.subject || 'Support request').trim();
  const emailBody  = String(data.body || '').trim();
  const incomingMessageId = data.messageId ? String(data.messageId).trim() : generateMessageId();
  const inReplyTo  = data.inReplyTo ? String(data.inReplyTo).trim() : '';
  const references = parseReferences(data.references);
  const attachments = data.attachments || [];

  // ── 1. Look up which space owns this "to" address ────────────────
  const addrRecord = s.emailAddresses.get(toAddress) as any;
  if (!addrRecord) {
    return { ok: false, reason: `No space registered for ${toAddress}` };
  }
  if (!addrRecord.enabled) {
    return { ok: false, reason: 'Email channel disabled' };
  }
  const sk = String(addrRecord.spaceKey).toUpperCase();
  // Space may live in PostgreSQL — create a minimal fallback if not in memory
  let sp = s.spaces.get(sk);
  if (!sp) {
    sp = {
      key: sk, name: sk,
      statuses: [{ id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' }],
      members: [], issueCount: 0,
    } as any;
    s.spaces.set(sk, sp);
  }

  // ── 2. Thread detection — is this a reply to an existing ticket? ─
  let existingTicketKey: string | null = null;

  // 2a. Check In-Reply-To header against our message index
  if (!existingTicketKey && inReplyTo) {
    existingTicketKey = s.emailMessageIndex.get(inReplyTo) || null;
  }

  // 2b. Check each entry in References header
  if (!existingTicketKey && references.length > 0) {
    for (const ref of references) {
      const found = s.emailMessageIndex.get(ref);
      if (found) { existingTicketKey = found; break; }
    }
  }

  // 2c. Check subject for [TICKET-ID] pattern
  if (!existingTicketKey) {
    const fromSubject = extractTicketKeyFromSubject(subject);
    if (fromSubject && s.issues.has(fromSubject)) {
      existingTicketKey = fromSubject;
    }
  }

  // ── 3a. REPLY → append as comment to existing ticket ────────────
  if (existingTicketKey) {
    const issue = s.issues.get(existingTicketKey) as Record<string, unknown> | undefined;
    if (!issue) {
      // Ticket key was found in index but issue missing — fall through to create new
      existingTicketKey = null;
    } else {
      // Build attachments list
      const attachList = attachments.map(a => ({
        id: rid(), name: a.filename || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        size: a.size || 0, url: a.url || '',
      }));

      // Add comment
      const comment: Record<string, unknown> = {
        id: rid(),
        body: emailBody
          ? `**Reply from ${fromEmail}**${cc ? ` (CC: ${cc})` : ''}\n\n${emailBody}`
          : `**Reply from ${fromEmail}**`,
        isInternal: false,
        source: 'email',
        emailMeta: {
          from: fromEmail, to: toAddress, cc,
          messageId: incomingMessageId, inReplyTo, references,
          subject,
        },
        attachments: attachList,
        author: { id: 'email', firstName: fromEmail.split('@')[0], lastName: '', email: fromEmail },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const comments = (issue.comments as unknown[]) || [];
      comments.push(comment);
      issue.comments = comments;
      issue.commentCount = comments.length;
      issue.updatedAt = nowIso();

      // Add any new attachments to ticket level too
      if (attachList.length > 0) {
        const existing = (issue.attachments as unknown[]) || [];
        issue.attachments = [...existing, ...attachList];
        issue.attachmentCount = (issue.attachments as unknown[]).length;
      }

      // Index the incoming message ID
      s.emailMessageIndex.set(incomingMessageId, existingTicketKey);

      // Update thread record
      const thread = s.emailTicketThread.get(existingTicketKey) || {
        messageIds: [], lastMessageId: '', outboundMessageId: '', references: [],
      };
      thread.messageIds.push(incomingMessageId);
      thread.lastMessageId = incomingMessageId;
      const refSet = new Set<string>([...thread.references, ...references, incomingMessageId]);
      thread.references = Array.from(refSet);
      const outboundMsgId = generateMessageId();
      thread.outboundMessageId = outboundMsgId;
      s.emailTicketThread.set(existingTicketKey, thread);

      // Log
      const logs = s.emailLogs.get(sk) || [];
      const logEntry: Record<string, unknown> = {
        id: rid(), from: fromEmail, to: toAddress, cc, subject,
        body: emailBody, issue: existingTicketKey,
        time: nowIso(), status: 'comment_added',
        messageId: incomingMessageId, inReplyTo, references,
        autoReplySent: addrRecord.autoReply,
      };
      logs.unshift(logEntry);
      s.emailLogs.set(sk, logs);

      // Build threading references for outbound reply
      const replyReferences = [...thread.references].join(' ');

      const autoReply = addrRecord.autoReply ? {
        to: fromEmail, from: toAddress,
        subject: `Re: ${subject.replace(/^Re:\s*/i, '')} [${existingTicketKey}]`,
        body: `Your reply has been added to ticket ${existingTicketKey}. Our team will respond shortly.`,
        issueKey: existingTicketKey,
        issueUrl: `/issues/${existingTicketKey}`,
        inReplyTo: incomingMessageId,
        references: replyReferences,
        outboundMessageId: outboundMsgId,
      } : null;

      return {
        ok: true, action: 'comment_added',
        issueKey: existingTicketKey,
        issueUrl: `/issues/${existingTicketKey}`,
        log: logEntry, autoReply,
        message: `Reply appended as comment to ${existingTicketKey}.`,
      };
    }
  }

  // ── 3b. NEW email → create ticket ───────────────────────────────
  const admin = s.users.get('u_admin') || Array.from(s.users.values())[0];
  const nums = Array.from(s.issues.keys())
    .filter((k) => k.startsWith(`${sk}-`))
    .map((k) => parseInt(k.split('-')[1], 10))
    .filter((n) => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const issueKey = `${sk}-${next}`;
  const statusObj = sp.statuses[0]
    ? { id: sp.statuses[0].id, name: sp.statuses[0].name, category: sp.statuses[0].category, color: sp.statuses[0].color }
    : { id: 'st_todo', name: 'To Do', category: 'todo', color: '#64748B' };

  const attachList = attachments.map(a => ({
    id: rid(), name: a.filename || 'attachment',
    contentType: a.contentType || 'application/octet-stream',
    size: a.size || 0, url: a.url || '',
  }));

  // Extract sender email and domain
  // e.g. "John Smith <john.smith@microsoft.com>" → senderEmail=john.smith@microsoft.com, senderDomain=microsoft.com
  const senderEmail = fromEmail.includes('<') ? (fromEmail.match(/<([^>]+)>/)?.[1] || fromEmail) : fromEmail;
  const senderDomain = senderEmail.split('@')[1] || '';

  // Extract display name for reporter field (used in comments/author)
  let senderDisplayName = '';
  const displayNameMatch = fromEmail.match(/^"?([^"<]+)"?\s*</);
  if (displayNameMatch) {
    senderDisplayName = displayNameMatch[1].trim();
  } else {
    const localPart = senderEmail.split('@')[0] || '';
    senderDisplayName = localPart
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  // Customer Name = sender's domain (the part after @)
  // e.g. john@microsoft.com → "microsoft.com"
  const customerName = senderDomain;

  const issue = buildIssue(issueKey, sp, {
    summary: subject,
    description: emailBody
      ? `*Received via email from ${senderEmail}*${cc ? ` *(CC: ${cc})*` : ''}\n\n---\n\n${emailBody}`
      : `*Received via email from ${senderEmail}*`,
    type: 'service_request',
    priority: 'medium',
    status: statusObj,
    reporter: {
      id: `email_${senderEmail}`,
      firstName: senderDisplayName.split(' ')[0] || senderDisplayName,
      lastName:  senderDisplayName.split(' ').slice(1).join(' ') || '',
      email:     senderEmail,
    },
    attachments: attachList,
    customerName,
    clientName: senderDomain,
    // Store email metadata on the issue itself
    emailMeta: {
      from: senderEmail, to: toAddress, cc,
      messageId: incomingMessageId,
      inReplyTo, references,
      subject,
    },
  } as any);
  s.issues.set(issueKey, issue);
  (sp as any).issueCount = ((sp as any).issueCount || 0) + 1;

  // Index message ID → ticket
  s.emailMessageIndex.set(incomingMessageId, issueKey);
  // Also index any references the customer sent (forward-threading)
  for (const ref of references) {
    if (!s.emailMessageIndex.has(ref)) s.emailMessageIndex.set(ref, issueKey);
  }

  // Create thread record
  const outboundMsgId = generateMessageId();
  s.emailTicketThread.set(issueKey, {
    messageIds: [incomingMessageId],
    lastMessageId: incomingMessageId,
    outboundMessageId: outboundMsgId,
    references: [incomingMessageId, ...references],
  });

  // Log
  const logs = s.emailLogs.get(sk) || [];
  const logEntry: Record<string, unknown> = {
    id: rid(), from: fromEmail, to: toAddress, cc, subject,
    body: emailBody, issue: issueKey, time: nowIso(),
    status: 'created', messageId: incomingMessageId, inReplyTo, references,
    autoReplySent: addrRecord.autoReply,
  };
  logs.unshift(logEntry);
  s.emailLogs.set(sk, logs);

  const autoReply = addrRecord.autoReply ? {
    to: fromEmail, from: toAddress,
    subject: `Re: ${subject} [${issueKey}]`,
    body: addrRecord.autoReplyText,
    issueKey, issueUrl: `/issues/${issueKey}`,
    inReplyTo: incomingMessageId,
    references: incomingMessageId,
    outboundMessageId: outboundMsgId,
  } : null;

  return {
    ok: true, action: 'created',
    issueKey, issueUrl: `/issues/${issueKey}`,
    log: logEntry, autoReply,
    message: `Issue ${issueKey} created from email.${addrRecord.autoReply ? ' Auto-reply sent.' : ''}`,
  };
}

/** Directly register an email address in the in-memory store (no auth required).
 *  Used by the reconnect endpoint to restore registrations after server restart. */
export function registerEmailAddress(address: string, spaceKey: string, opts: { autoReply?: boolean; requestType?: string } = {}) {
  const s = getStore();
  const key = address.toLowerCase().trim();
  // Always update — ensures spaceKey is correct even if previously registered with wrong value
  s.emailAddresses.set(key, {
    id: `email_auto_${Date.now()}`,
    address: key,
    spaceKey: spaceKey.toUpperCase(),
    requestType: opts.requestType || 'Emailed request',
    isReplyTo: false,
    autoReply: opts.autoReply !== false,
    autoReplyText: 'Thank you for contacting us. We have received your request and will get back to you shortly.',
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  console.log(`[MockStore] Registered email ${key} → space ${spaceKey.toUpperCase()}`);
}

/** Look up the spaceKey for a registered email address */
export function getEmailAddressSpaceKey(address: string): string | null {
  const s = getStore();
  const record = s.emailAddresses.get(address.toLowerCase().trim()) as any;
  return record?.spaceKey || null;
}

export function getEmailAddressRecord(address: string): Record<string, unknown> | null {
  const s = getStore();
  return (s.emailAddresses.get(address.toLowerCase().trim()) as any) || null;
}
