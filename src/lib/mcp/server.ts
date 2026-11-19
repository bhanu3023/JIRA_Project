/**
 * Read-only MCP server for the Claude Desktop connector.
 *
 * Every tool reads through the app's own GET handlers (handleJiraPgApi) as
 * the signed-in person, using their read-only `ntm_` token. So:
 *   - each person sees exactly what the app already lets them see
 *     (space membership, worklog/MBR grants, KB team visibility, ...);
 *   - nothing here can write: the method is always GET, and the API itself
 *     refuses anything but GET on an allowlist for `ntm_` tokens
 *     (see MCP_READ_PATHS in ./store.ts).
 */
import fs from 'fs/promises';
import nodePath from 'path';
import { NextRequest } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleJiraPgApi } from '@/lib/jira-pg-api';
import { appBaseUrl, logMcpCall } from './store';

const MAX_ROWS = 200;
const MAX_STR = 4000;

type Ctx = { token: string; userId: string };

class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** GET an app API path as the signed-in user. Always GET -- never anything else. */
async function appGet(ctx: Ctx, path: string, query: Record<string, string | number | boolean | undefined | null> = {}): Promise<any> {
  const url = new URL(`${appBaseUrl()}/api/${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const req = new NextRequest(url, { method: 'GET', headers: { authorization: `Bearer ${ctx.token}`, 'user-agent': 'claude-mcp-connector' } });
  const res = await handleJiraPgApi(req, path.split('/').filter(Boolean), 'GET');
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error || `Request failed (${res.status})`;
    if (res.status === 403 || res.status === 404) throw new AppError(res.status, `${msg} -- you may not have access to this in the app.`);
    throw new AppError(res.status, msg);
  }
  return body;
}

/** Drops heavy/irrelevant fields and truncates long text so answers fit in Claude's context. */
const DROP_KEYS = new Set(['avatarUrl', 'avatar', '_links', 'reactions', 'customFieldValues', 'password', 'canAccessAnywhere', 'managerIds']);
function slim(v: any, depth = 0): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    const s = /<[a-z][\s\S]*>/i.test(v) ? v.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : v;
    return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}… [truncated]` : s;
  }
  if (Array.isArray(v)) return v.slice(0, MAX_ROWS).map((x) => slim(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 6) return '[…]';
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEYS.has(k) || (typeof val === 'string' && val.startsWith('data:'))) continue;
      out[k] = slim(val, depth + 1);
    }
    return out;
  }
  return v;
}

const personName = (u: any) => (u ? (u.displayName || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || null) : null);

/** "2026-11-19" or "2026-11-19 14:00" or ISO -> Date, read as IST when no offset is given. */
function parseIst(s: string, endOfDay = false): Date {
  const t = s.trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(t)) return new Date(t);
  const m = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return new Date(NaN);
  const time = m[2] ? `${m[2].padStart(2, '0')}:${m[3]}:00` : (endOfDay ? '23:59:59' : '00:00:00');
  return new Date(`${m[1]}T${time}+05:30`);
}
const toIst = (iso: string | null | undefined) => {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')} IST`;
};

/** Resolves people names/emails to user ids (the issues filter takes ids). */
async function resolveUserIds(ctx: Ctx, names: string): Promise<{ ids: string[]; unmatched: string[] }> {
  const wanted = names.split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return { ids: [], unmatched: [] };
  const users: any[] = await appGet(ctx, 'users');
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const w of wanted) {
    if (w.toLowerCase() === 'me') { ids.push(ctx.userId); continue; }
    const lw = w.toLowerCase();
    const hits = users.filter((u) => (u.email || '').toLowerCase() === lw || (personName(u) || '').toLowerCase() === lw);
    const fuzzy = hits.length ? hits : users.filter((u) => (personName(u) || '').toLowerCase().includes(lw));
    if (fuzzy.length) ids.push(...fuzzy.slice(0, 5).map((u) => u.id)); else unmatched.push(w);
  }
  return { ids, unmatched };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const dateRange = (from?: string, to?: string) => {
  if (!from && !to) return undefined;
  const f = (from || '2000-01-01').slice(0, 10);
  const t = (to || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)).slice(0, 10);
  return `between:${f}:${t}`;
};

function summarizeIssue(i: any) {
  return {
    key: i.cfKey || i.key,
    summary: i.summary,
    status: i.status?.name ?? i.status,
    statusCategory: i.status?.category,
    priority: i.priority,
    type: i.type,
    department: i.currentDepartment ?? i.current_department ?? null,
    assignee: personName(i.assignee),
    reporter: personName(i.reporter),
    space: i.spaceKey,
    customer: i.customerName ?? i.clientName ?? null,
    productType: i.productType ?? null,
    created: toIst(i.createdAt),
    updated: toIst(i.updatedAt),
    resolved: toIst(i.resolvedAt),
    slaBreached: i.slaBreached ?? i.sla_breached ?? undefined,
    link: `${appBaseUrl()}/issues/${i.cfKey || i.key}`,
  };
}

const GUIDE_FILES: Record<string, string> = {
  overview: 'app-guide.md',
  'queues-and-sla-internals': 'queues-departments-sla-guide.md',
  'queue-dev': 'queues/dev.md',
  'queue-migration': 'queues/migration.md',
  'queue-qa': 'queues/qa.md',
  'queue-infra': 'queues/infra.md',
  'queue-pre-sales': 'queues/pre-sales.md',
  'queues-index': 'queues/README.md',
};

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: 'neutara-ticketing', version: '1.0.0' },
    {
      instructions: [
        'Read-only access to the Neutara Ticketing app (a Jira-like service desk), as the signed-in person.',
        'Tickets have keys like CF-35038. Tickets move between departments (queues) such as Dev, Migration, QA, Infra, Pre-Sales; each department has its own SLA clock.',
        'All times you show should be in IST (Asia/Kolkata); tool inputs accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" in IST.',
        'You cannot create, edit, assign, comment on or resolve anything -- if asked, explain it must be done in the app at ' + appBaseUrl() + '.',
        'For "how does X work" questions, call app_guide first. If a tool says access is denied, the person does not have that access in the app.',
      ].join('\n'),
    },
  );

  // Wraps a tool handler with audit logging + friendly errors.
  const wrap = <A,>(tool: string, fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      const data = await fn(args);
      logMcpCall(ctx.userId, tool, args, true);
      return ok(data);
    } catch (e: any) {
      logMcpCall(ctx.userId, tool, args, false);
      return fail(e instanceof AppError ? e.message : `Something went wrong: ${e?.message || e}`);
    }
  };

  server.registerTool('whoami', {
    title: 'Who am I',
    description: 'The signed-in person: name, email, role and what extra reports they can see. Use to answer "my tickets" style questions.',
    annotations: READ_ONLY,
  }, wrap('whoami', async () => {
    const me = await appGet(ctx, 'auth/me');
    return { id: me.id, name: personName(me), email: me.email, role: me.role, canViewWorklogReports: !!me.can_view_worklog, canViewMbr: !!me.can_view_mbr };
  }));

  server.registerTool('search_tickets', {
    title: 'Search tickets',
    description: 'Find tickets by text, space, status, department (queue), assignee, reporter, priority, dates, SLA breach or overdue. Returns up to `limit` tickets (max 100) plus the total count. Dates are YYYY-MM-DD (IST). Assignee/reporter accept names, emails or "me".',
    inputSchema: {
      text: z.string().optional().describe('Words in the summary/description, or a ticket key'),
      spaceKey: z.string().optional().describe('Space (board) key, e.g. TESTIN'),
      department: z.string().optional().describe('Current department/queue, e.g. Dev, Migration, QA'),
      statusCategory: z.enum(['todo', 'in_progress', 'done']).optional(),
      status: z.string().optional().describe('Exact status name, e.g. "In Progress"'),
      assignee: z.string().optional().describe('Comma-separated names/emails, or "me"'),
      reporter: z.string().optional().describe('Comma-separated names/emails, or "me"'),
      priority: z.string().optional().describe('highest, high, medium, low, lowest'),
      createdFrom: z.string().optional(), createdTo: z.string().optional(),
      updatedFrom: z.string().optional(), updatedTo: z.string().optional(),
      resolvedFrom: z.string().optional(), resolvedTo: z.string().optional(),
      slaBreached: z.boolean().optional().describe('Only tickets that breached SLA'),
      overdue: z.boolean().optional().describe('Only tickets past their due date'),
      customerName: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
    },
    annotations: READ_ONLY,
  }, wrap('search_tickets', async (a: any) => {
    const notes: string[] = [];
    let assignees: string | undefined;
    let reporters: string | undefined;
    if (a.assignee) {
      const r = await resolveUserIds(ctx, a.assignee);
      if (r.unmatched.length) notes.push(`No person matched: ${r.unmatched.join(', ')}`);
      if (!r.ids.length) return { total: 0, tickets: [], notes };
      assignees = r.ids.join(',');
    }
    if (a.reporter) {
      const r = await resolveUserIds(ctx, a.reporter);
      if (r.unmatched.length) notes.push(`No person matched: ${r.unmatched.join(', ')}`);
      if (!r.ids.length) return { total: 0, tickets: [], notes };
      reporters = r.ids.join(',');
    }
    const res = await appGet(ctx, 'issues', {
      q: a.text, spaceKey: a.spaceKey, dept: a.department, statusCategory: a.statusCategory, status: a.status,
      assignees, reporters, priority: a.priority,
      createdRange: dateRange(a.createdFrom, a.createdTo),
      updatedRange: dateRange(a.updatedFrom, a.updatedTo),
      resolvedRange: dateRange(a.resolvedFrom, a.resolvedTo),
      slaBreached: a.slaBreached ? 'true' : undefined,
      overdue: a.overdue ? 'true' : undefined,
      customerName: a.customerName,
      limit: a.limit ?? 50, page: a.page ?? 1,
    });
    const list: any[] = Array.isArray(res) ? res : (res?.issues || []);
    return { total: res?.total ?? list.length, page: res?.page ?? a.page ?? 1, totalPages: res?.totalPages, tickets: list.map((i) => slim(summarizeIssue(i))), notes: notes.length ? notes : undefined };
  }));

  server.registerTool('get_ticket', {
    title: 'Get ticket',
    description: 'Full details of one ticket: description, status, department, assignee, SLA per department (goal, time spent, breached or not, paused), sub-tasks and links. Use for "why did X breach SLA", "who has X", "what is X about".',
    inputSchema: { key: z.string().describe('Ticket key, e.g. CF-35038') },
    annotations: READ_ONLY,
  }, wrap('get_ticket', async ({ key }: { key: string }) => {
    const i = await appGet(ctx, `issues/${encodeURIComponent(key.trim())}`);
    const { comments, activity, attachments, ...rest } = i || {};
    return {
      ...slim(rest),
      ...summarizeIssue(i),
      sla: slim(i?.sla),
      attachments: Array.isArray(attachments) ? attachments.map((x: any) => x.filename || x.name).slice(0, 50) : undefined,
      commentCount: Array.isArray(comments) ? comments.length : undefined,
      historyCount: Array.isArray(activity) ? activity.length : undefined,
      hint: 'Use get_ticket_history for status/department/assignee/SLA events and get_ticket_comments for the conversation.',
    };
  }));

  server.registerTool('get_ticket_history', {
    title: 'Ticket history',
    description: 'Chronological history of a ticket: status changes, department handoffs, assignee changes, SLA started/paused/resumed/breached/resolved events, priority changes. Optionally filter by field.',
    inputSchema: {
      key: z.string(),
      fields: z.array(z.string()).optional().describe('e.g. ["status","department","assignee","sla","priority"]'),
    },
    annotations: READ_ONLY,
  }, wrap('get_ticket_history', async ({ key, fields }: { key: string; fields?: string[] }) => {
    const i = await appGet(ctx, `issues/${encodeURIComponent(key.trim())}`);
    const want = fields?.length ? new Set(fields.map((f) => f.toLowerCase())) : null;
    const rows = (Array.isArray(i?.activity) ? i.activity : [])
      .filter((h: any) => !want || want.has(String(h.field || '').toLowerCase()))
      .map((h: any) => ({ at: toIst(h.createdAt), field: h.field, from: h.oldValue, to: h.newValue, by: h.authorName }))
      .sort((x: any, y: any) => String(x.at).localeCompare(String(y.at)));
    return { key: i?.cfKey || key, events: slim(rows) };
  }));

  server.registerTool('get_ticket_comments', {
    title: 'Ticket comments',
    description: 'Comments on a ticket (oldest first), including internal notes the person can see.',
    inputSchema: { key: z.string() },
    annotations: READ_ONLY,
  }, wrap('get_ticket_comments', async ({ key }: { key: string }) => {
    const res = await appGet(ctx, `issues/${encodeURIComponent(key.trim())}/comments`);
    const list: any[] = Array.isArray(res) ? res : (res?.comments || []);
    return list.map((c) => ({ at: toIst(c.createdAt), author: personName(c.author) || c.authorName, internal: !!c.isInternal, body: slim(c.body) }));
  }));

  server.registerTool('get_ticket_worklogs', {
    title: 'Ticket time logged',
    description: 'Time logged against one ticket: who, when, how long, and the note.',
    inputSchema: { key: z.string() },
    annotations: READ_ONLY,
  }, wrap('get_ticket_worklogs', async ({ key }: { key: string }) => slim(await appGet(ctx, `issues/${encodeURIComponent(key.trim())}/worklogs`))));

  server.registerTool('list_worklogs', {
    title: 'Ticket worklog report',
    description: 'Time logged on tickets across people, for a date range (the Worklog page). Only available to admins and people granted worklog access in the app. Filter by person, space or department (queue members).',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD (IST)'),
      to: z.string().describe('YYYY-MM-DD (IST)'),
      person: z.string().optional().describe('Name, email or "me"'),
      spaceKey: z.string().optional(),
      department: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, wrap('list_worklogs', async (a: any) => {
    let userId: string | undefined;
    if (a.person) {
      const r = await resolveUserIds(ctx, a.person);
      if (!r.ids.length) return { error: `No person matched "${a.person}"` };
      userId = r.ids[0];
    }
    const res = await appGet(ctx, 'worklogs', { from: parseIst(a.from).toISOString(), to: parseIst(a.to, true).toISOString(), userId, spaceKey: a.spaceKey, dept: a.department });
    return slim(res);
  }));

  server.registerTool('list_activity_worklogs', {
    title: 'Activity worklog (non-ticket work)',
    description: 'The "Ticket Worklog" tab: what people logged as daily activities (meetings, automation, KB writing, client calls, etc.), with hours. Filter by person, date range, space and department/queue.',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD (IST)'),
      to: z.string().describe('YYYY-MM-DD (IST)'),
      person: z.string().optional().describe('Name, email or "me"'),
      spaceKey: z.string().optional(),
      department: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, wrap('list_activity_worklogs', async (a: any) => {
    let userId: string | undefined;
    if (a.person) {
      const r = await resolveUserIds(ctx, a.person);
      if (!r.ids.length) return { error: `No person matched "${a.person}"` };
      userId = r.ids[0];
    }
    const res = await appGet(ctx, 'activity-worklogs', { from: parseIst(a.from).toISOString(), to: parseIst(a.to, true).toISOString(), userId, spaceKey: a.spaceKey, dept: a.department });
    return slim(res);
  }));

  server.registerTool('assignments_in_window', {
    title: 'Tickets assigned per person in a time window',
    description: 'Which tickets were assigned to each person between two times, optionally only while the ticket was in a given department (e.g. Dev). Built from assignee history, so a ticket later handed on still counts. Example: "tickets assigned to each person in Dev after 2 pm today" -> department "Dev", from "<today> 14:00". Times are IST. Max window 93 days.',
    inputSchema: {
      from: z.string().describe('Start, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" in IST'),
      to: z.string().optional().describe('End (default: now), same format'),
      department: z.string().optional().describe('Department/queue at the moment of assignment, e.g. Dev'),
      person: z.string().optional().describe('Only this person (name contains)'),
    },
    annotations: READ_ONLY,
  }, wrap('assignments_in_window', async (a: any) => {
    const from = parseIst(a.from);
    const to = a.to ? parseIst(a.to, !/\d:\d\d/.test(a.to)) : new Date();
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new AppError(400, 'from/to must look like 2026-11-19 or 2026-11-19 14:00');
    const res = await appGet(ctx, 'reports/assignments', { from: from.toISOString(), to: to.toISOString(), dept: a.department, assignee: a.person });
    return {
      window: `${toIst(res.from)} → ${toIst(res.to)}`,
      department: res.dept,
      totalAssignments: res.total,
      people: (res.people || []).map((p: any) => ({
        person: p.person,
        count: p.count,
        tickets: p.tickets.slice(0, MAX_ROWS).map((t: any) => ({ ...t, assignedAt: toIst(t.assignedAt), link: `${appBaseUrl()}/issues/${t.ticket}` })),
      })),
    };
  }));

  server.registerTool('department_queue_summary', {
    title: 'Department queue summary',
    description: 'Counts for one department queue in a space (open, in progress, resolved, breached, per person). Admin only in the app.',
    inputSchema: {
      spaceKey: z.string(),
      department: z.string(),
      range: z.string().optional().describe('"all" (default), "withinLast:7:days", or "between:YYYY-MM-DD:YYYY-MM-DD"'),
    },
    annotations: READ_ONLY,
  }, wrap('department_queue_summary', async (a: any) => slim(await appGet(ctx, `spaces/${encodeURIComponent(a.spaceKey.toUpperCase())}/dept-queue/summary`, { dept: a.department, range: a.range }))));

  server.registerTool('sla_report', {
    title: 'Resolution SLA report',
    description: 'SLA performance for Migration/Dev tickets created in a date range (met vs breached, by department/product type). Managers and admins only in the app.',
    inputSchema: {
      from: z.string().optional().describe('YYYY-MM-DD'),
      to: z.string().optional().describe('YYYY-MM-DD'),
      department: z.string().optional(),
      productType: z.string().optional().describe('Content Migration, Message Migration or Email Migration'),
    },
    annotations: READ_ONLY,
  }, wrap('sla_report', async (a: any) => slim(await appGet(ctx, 'reports/resolution-sla', { dateFrom: a.from, dateTo: a.to, dept: a.department, productType: a.productType }))));

  server.registerTool('search_kb', {
    title: 'Search knowledge base',
    description: 'Search published KB articles (or release notes) the person can read. Returns titles, authors, dates and ids; use get_kb_article for the full text.',
    inputSchema: {
      text: z.string().optional(),
      kind: z.enum(['kb', 'release']).optional().describe('kb (default) or release notes'),
    },
    annotations: READ_ONLY,
  }, wrap('search_kb', async (a: any) => {
    const list: any[] = await appGet(ctx, 'kb/articles', { q: a.text, kind: a.kind });
    return list.slice(0, 50).map((x) => ({ id: x.id, title: x.title, author: x.authorName, published: toIst(x.publishedAt), updated: toIst(x.updatedAt), teams: x.teams }));
  }));

  server.registerTool('get_kb_article', {
    title: 'Read KB article',
    description: 'Full text of one KB article by id (from search_kb).',
    inputSchema: { id: z.string() },
    annotations: READ_ONLY,
  }, wrap('get_kb_article', async ({ id }: { id: string }) => slim(await appGet(ctx, `kb/articles/${encodeURIComponent(id)}`))));

  server.registerTool('list_spaces', {
    title: 'List spaces',
    description: 'Spaces (boards/projects) the person can see, with their keys.',
    annotations: READ_ONLY,
  }, wrap('list_spaces', async () => {
    const res = await appGet(ctx, 'spaces');
    const list: any[] = Array.isArray(res) ? res : (res?.spaces || []);
    return list.map((s) => ({ key: s.key, name: s.name, type: s.type }));
  }));

  server.registerTool('find_people', {
    title: 'Find people',
    description: 'Look up team members by name or email (name, email, role, active).',
    inputSchema: { query: z.string().optional() },
    annotations: READ_ONLY,
  }, wrap('find_people', async ({ query }: { query?: string }) => {
    const users: any[] = await appGet(ctx, 'users');
    const q = (query || '').toLowerCase();
    return users
      .filter((u) => !q || (personName(u) || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .slice(0, 100)
      .map((u) => ({ name: personName(u), email: u.email, role: u.role, status: u.status }));
  }));

  server.registerTool('app_guide', {
    title: 'How the app works',
    description: `Explains how the ticketing app works (tickets, departments/queues, handoffs, round robin, SLA rules, worklogs, KB). Topics: ${Object.keys(GUIDE_FILES).join(', ')}. Start with "overview".`,
    inputSchema: { topic: z.enum(Object.keys(GUIDE_FILES) as [string, ...string[]]).optional() },
    annotations: READ_ONLY,
  }, wrap('app_guide', async ({ topic }: { topic?: string }) => {
    const file = GUIDE_FILES[topic || 'overview'];
    const text = await fs.readFile(nodePath.join(process.cwd(), 'docs', file), 'utf8').catch(() => null);
    if (!text) throw new AppError(404, `Guide "${topic}" is not available on this server.`);
    return { topic: topic || 'overview', otherTopics: Object.keys(GUIDE_FILES), text };
  }));

  return server;
}
