/**
 * kb-api.ts
 * KB Articles: any logged-in user can write an article, save it as a draft,
 * and publish it either to the whole organization or to specific teams.
 *
 * "Teams" are the existing department queues (custom_queues.queues[]) --
 * there is no separate teams table. A queue with the same name in several
 * spaces counts as one team (keyed by its lower-cased name), and a user is
 * in a team if their id is in that queue's memberIds in any space.
 *
 * Only the author and admins can edit, delete, or change who has access.
 * Drafts are visible only to their author and to admins.
 *
 * Publishing needs approval: a non-admin's "publish" submits the article
 * (status 'pending') to their managers -- users.manager_ids, set by an admin
 * in Settings > Users; a user can have several, and any one of them may
 * approve -- or, if they have no manager, to any admin. Only once an
 * approver approves does it go live and notify the chosen audience.
 * Admins publish directly. A rejected article goes back to draft with the
 * approver's note.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';
import { db } from '@/lib/db';
import { mentionedIds, plainMentions } from '@/lib/kb-mentions';
import { notifyKbApproval, notifyKbArticlePublished } from '@/lib/notification-service';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_QA_CHARS = 4000;
const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const kbSchemaReady = pool.query(`CREATE TABLE IF NOT EXISTS kb_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'teams',
  teams TEXT[] NOT NULL DEFAULT '{}',
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ
)`)
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS kb_articles_status_idx ON kb_articles(status)`))
  // Uploaded documents. Bytes live on disk under uploads/kb/<articleId>/,
  // which the public uploads route refuses to serve (see jira-pg-api.ts) --
  // they're only reachable through kb/articles/:id/files/:fileId below.
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS kb_files (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT,
    size BIGINT,
    storage_path TEXT NOT NULL,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS kb_files_article_idx ON kb_files(article_id)`))
  // Reader questions, answered by the author (or an admin). Plain text only.
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS kb_questions (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
    asker_id TEXT NOT NULL,
    asker_name TEXT,
    question TEXT NOT NULL,
    answer TEXT,
    answered_by_id TEXT,
    answered_by_name TEXT,
    answered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS kb_questions_article_idx ON kb_questions(article_id)`))
  // What the reader was looking at when they asked: the document open at the
  // time and, optionally, the passage they selected.
  .then(() => pool.query(`ALTER TABLE kb_questions
    ADD COLUMN IF NOT EXISTS file_id TEXT,
    ADD COLUMN IF NOT EXISTS file_name TEXT,
    ADD COLUMN IF NOT EXISTS quote TEXT`))
  // Release notes are KB articles with kind = 'release': same drafts, access,
  // documents and questions, just listed separately.
  .then(() => pool.query(`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'kb'`))
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS kb_articles_kind_idx ON kb_articles(kind)`))
  // Approval workflow. approver_id was the manager the request went to (now
  // approver_ids, below); review_note is the reason given when changes were
  // requested.
  .then(() => pool.query(`ALTER TABLE kb_articles
    ADD COLUMN IF NOT EXISTS approver_id TEXT,
    ADD COLUMN IF NOT EXISTS approver_name TEXT,
    ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_note TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT`))
  .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id TEXT`))
  // A user can have several managers, and a pending article waits on all of
  // them. The single-id columns above are superseded; move anything still in
  // them over (and clear them, so this runs once).
  .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_ids TEXT[] NOT NULL DEFAULT '{}'`))
  .then(() => pool.query(`UPDATE users SET manager_ids = ARRAY[manager_id], manager_id = NULL WHERE manager_id IS NOT NULL`))
  .then(() => pool.query(`ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS approver_ids TEXT[] NOT NULL DEFAULT '{}'`))
  .then(() => pool.query(`UPDATE kb_articles SET approver_ids = ARRAY[approver_id], approver_id = NULL WHERE approver_id IS NOT NULL`))
  .catch((e) => { console.error('[kb] schema setup failed:', e?.message || e); });

// Same row the bell in Header.tsx polls for. KB_* notifications carry the
// article id in issueKey; Header routes those to /kb instead of /issues.
type KbNotificationType = 'KB_QUESTION' | 'KB_ANSWER' | 'KB_MENTION' | 'KB_APPROVAL' | 'KB_APPROVED' | 'KB_REJECTED';

async function notify(userId: string, type: KbNotificationType, title: string, message: string, articleId: string) {
  if (!userId) return;
  try {
    await db.notification.create({ data: { userId, type, title, message, issueKey: articleId } });
  } catch { /* fire-and-forget */ }
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function kbDir(articleId: string) {
  const safeId = articleId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `uploads/kb/${safeId}`;
}

function formatFile(row: any) {
  return { id: row.id, filename: row.filename, mime: row.mime, size: Number(row.size || 0), createdAt: row.created_at };
}

// Anyone who can read the article may answer an open question. Once answered,
// only whoever wrote that answer, the author, or an admin can change it, so one
// reader can't overwrite another's answer.
function canEditAnswer(row: any, viewerId: string, viewerCanManage: boolean) {
  return viewerCanManage || !row.answer || row.answered_by_id === viewerId;
}

function formatQuestion(row: any, viewerId: string, viewerCanManage: boolean) {
  return {
    id: row.id,
    question: row.question,
    fileId: row.file_id || null,
    fileName: row.file_name || null,
    quote: row.quote || null,
    askerId: row.asker_id,
    askerName: row.asker_name,
    createdAt: row.created_at,
    answer: row.answer,
    answeredById: row.answered_by_id,
    answeredByName: row.answered_by_name,
    answeredAt: row.answered_at,
    canDelete: viewerCanManage || row.asker_id === viewerId,
    canAnswer: canEditAnswer(row, viewerId, viewerCanManage),
  };
}

function parseKind(value: unknown): 'kb' | 'release' {
  return value === 'release' ? 'release' : 'kb';
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function rid() {
  return `kb_${Math.random().toString(36).slice(2, 12)}`;
}

// ── Teams (department queues, merged across spaces by name) ──────────────────

type Team = { key: string; name: string; memberIds: Set<string> };
let _teamsCache: { teams: Map<string, Team>; exp: number } | null = null;

async function loadTeams(): Promise<Map<string, Team>> {
  const now = Date.now();
  if (_teamsCache && _teamsCache.exp > now) return _teamsCache.teams;
  const rows = await pool.query(`SELECT queues FROM custom_queues`);
  const teams = new Map<string, Team>();
  for (const row of rows.rows) {
    for (const q of (row.queues || []) as any[]) {
      const name = String(q?.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const team = teams.get(key) || { key, name, memberIds: new Set<string>() };
      for (const id of (Array.isArray(q.memberIds) ? q.memberIds : [])) team.memberIds.add(String(id));
      teams.set(key, team);
    }
  }
  _teamsCache = { teams, exp: now + 60_000 };
  return teams;
}

async function getUserTeamKeys(userId: string): Promise<string[]> {
  const teams = await loadTeams();
  return Array.from(teams.values()).filter((t) => t.memberIds.has(userId)).map((t) => t.key);
}

// Same rule as canRead inside handleKbApi, for some other user.
function userCanRead(article: any, user: { id: string; role?: string | null }, teams: Map<string, Team>) {
  if (user.role === 'admin' || article.author_id === user.id) return true;
  if (article.status !== 'published') return false;
  if (article.visibility === 'org') return true;
  return (article.teams || []).some((k: string) => teams.get(k)?.memberIds.has(user.id));
}

// Notifies everyone newly @mentioned in `text` (compared with `previous`, so
// editing an answer doesn't re-notify). Mentions of people who can't read the
// article are ignored -- the link would only show them "not found".
async function notifyMentions(
  article: any,
  text: string,
  previous: string | null,
  actor: { id: string; name: string },
  where: 'question' | 'answer',
  alreadyNotified: string[] = [],
) {
  const before = mentionedIds(previous);
  const ids = Array.from(mentionedIds(text)).filter((id) => id !== actor.id && !before.has(id) && !alreadyNotified.includes(id));
  if (!ids.length) return;
  const [users, teams] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, role: true } }),
    loadTeams(),
  ]);
  for (const u of users) {
    if (!userCanRead(article, u, teams)) continue;
    await notify(
      u.id,
      'KB_MENTION',
      `${actor.name} mentioned you in ${where === 'question' ? 'a question' : 'an answer'} on "${clip(article.title, 80)}"`,
      clip(plainMentions(text), 140),
      article.id,
    );
  }
}

// ── HTML sanitizing ──────────────────────────────────────────────────────────
// Stored HTML is rendered with dangerouslySetInnerHTML, so strip anything
// that can run script before it ever reaches the table. The page also runs an
// allowlist sanitizer at render time (src/lib/kb-sanitize.ts).
export function sanitizeKbHtml(html: string): string {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  h = h.replace(/<\/?(script|style|iframe|object|embed|noscript|template|svg|math|link|meta|base|form|input|button|textarea|select)\b[^>]*>/gi, '');
  h = h.replace(/[\s/]+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  h = h.replace(/\s+(href|src|action|formaction|xlink:href)\s*=\s*("\s*(javascript|vbscript|data:text)[^"]*"|'\s*(javascript|vbscript|data:text)[^']*'|(javascript|vbscript)[^\s>]*)/gi, '');
  return h;
}

function excerptOf(html: string, max = 220): string {
  const text = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function displayNameOf(user: any): string {
  if (!user) return 'Unknown';
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return user.displayName || full || user.email || 'Unknown';
}

function formatArticle(row: any, teams: Map<string, Team>, canManage: boolean, includeBody: boolean, canApprove = false) {
  const teamKeys: string[] = row.teams || [];
  return {
    id: row.id,
    kind: parseKind(row.kind),
    title: row.title,
    ...(includeBody ? { bodyHtml: row.body_html } : { excerpt: excerptOf(row.body_html) }),
    status: row.status,
    visibility: row.visibility,
    teams: teamKeys.map((k) => ({ key: k, name: teams.get(k)?.name || k })),
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    fileCount: Number(row.file_count || 0),
    questionCount: Number(row.question_count || 0),
    openQuestionCount: Number(row.open_question_count || 0),
    // Approval: who it's waiting on (null name = any admin; several managers
    // are joined with "or") while pending, and
    // the approver's note after changes were requested.
    approverName: row.status === 'pending' ? row.approver_name || null : null,
    submittedAt: row.status === 'pending' ? row.submitted_at : null,
    reviewNote: row.status === 'draft' ? row.review_note || null : null,
    reviewedByName: row.status === 'draft' && row.review_note ? row.reviewed_by_name || null : null,
    canManage,
    canApprove,
  };
}

type Approver = { id: string; name: string; email: string };

// Who approves `authorId`'s articles: their managers (users.manager_ids) that
// are active users other than themselves. Empty = any admin.
async function resolveApprovers(authorId: string): Promise<Approver[]> {
  const ids: string[] = (await pool.query(`SELECT manager_ids FROM users WHERE id = $1`, [authorId])).rows[0]?.manager_ids || [];
  const others = ids.filter((id) => id && id !== authorId);
  if (!others.length) return [];
  const managers = await db.user.findMany({ where: { id: { in: others }, isActive: true } });
  return managers
    .map((m) => ({ id: m.id, name: displayNameOf(m), email: m.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function approverNames(approvers: Approver[]): string | null {
  return approvers.length ? approvers.map((a) => a.name).join(' or ') : null;
}

async function activeAdmins() {
  return db.user.findMany({ where: { isActive: true, role: 'admin' }, select: { id: true, email: true } });
}

// Asks `reviewers` to approve a pending article: bell notification + email.
async function requestApproval(article: any, reviewers: { id: string; email: string }[]) {
  const recipients = reviewers.filter((r) => r.id !== article.author_id);
  if (!recipients.length) return;
  const authorName = article.author_name || 'Someone';
  const kindLabel = article.kind === 'release' ? 'release note' : 'article';
  for (const r of recipients) {
    await notify(r.id, 'KB_APPROVAL', `${authorName} needs your approval to publish the ${kindLabel} "${clip(article.title, 80)}"`, excerptOf(article.body_html, 140), article.id);
  }
  notifyKbApproval({
    recipientEmails: recipients.map((r) => r.email),
    event: 'requested', articleId: article.id, title: article.title,
    kind: article.kind === 'release' ? 'release' : 'article', actorName: authorName,
  }).catch((e) => console.error('[KB] Approval request email failed:', e?.message || e));
}

/**
 * Called when an author's managers change. Their pending articles move to the
 * new managers (or to any admin when none are left), and whoever newly has to
 * approve one is asked to, so a request never sits with someone who is no
 * longer responsible for it.
 */
export async function rerouteKbApprovals(authorId: string) {
  await kbSchemaReady;
  const pending = (await pool.query(`SELECT * FROM kb_articles WHERE author_id = $1 AND status = 'pending'`, [authorId])).rows;
  if (!pending.length) return;
  const approvers = await resolveApprovers(authorId);
  const ids = approvers.map((a) => a.id);
  for (const article of pending) {
    await pool.query(
      `UPDATE kb_articles SET approver_ids = $2, approver_name = $3 WHERE id = $1 AND status = 'pending'`,
      [article.id, ids, approverNames(approvers)],
    );
    const before = new Set<string>(article.approver_ids || []);
    // Admins were already asked when it had no manager, so going back to
    // admins only notifies them if it had been with a manager until now.
    const reviewers = approvers.length
      ? approvers.filter((a) => !before.has(a.id))
      : before.size ? await activeAdmins() : [];
    await requestApproval(article, reviewers);
  }
}

// Announces a newly published article by email and in-app notification,
// naming who published it and linking straight to the article. Recipients
// follow the access chosen at publish time: "Entire organization" goes to
// every active user; specific teams go only to those teams' members. Runs
// fire-and-forget -- callers don't wait on hundreds of individual email sends.
function announcePublished(published: any) {
  (async () => {
    try {
      const users = await db.user.findMany({ where: { isActive: true }, select: { id: true, email: true } });
      let recipients = users;
      if (published.visibility !== 'org') {
        const teams = await loadTeams();
        const memberIds = new Set<string>();
        for (const key of (published.teams || []) as string[]) {
          teams.get(key)?.memberIds.forEach((memberId) => memberIds.add(memberId));
        }
        recipients = users.filter((u) => memberIds.has(u.id));
      }
      if (!recipients.length) return;
      const typeLabel = published.kind === 'release' ? 'Release Note' : 'KB Article';
      await db.notification.createMany({
        data: recipients.map((u) => ({
          userId: u.id,
          type: 'KB_PUBLISHED',
          title: `New ${typeLabel}: ${published.title}`,
          message: `Published by ${published.author_name}`,
          issueKey: published.id,
        })),
      });
      await notifyKbArticlePublished({
        articleId: published.id,
        title: published.title,
        kind: published.kind === 'release' ? 'release' : 'article',
        authorName: published.author_name,
        summary: excerptOf(published.body_html, 200),
        recipientEmails: recipients.map((u) => u.email),
      });
    } catch (e: any) {
      console.error('[KB] Publish announcement failed:', e?.message || e);
    }
  })();
}

// Per-article counts, joined onto every article row we return.
const COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM kb_files f WHERE f.article_id = a.id) AS file_count,
  (SELECT COUNT(*) FROM kb_questions q WHERE q.article_id = a.id) AS question_count,
  (SELECT COUNT(*) FROM kb_questions q WHERE q.article_id = a.id AND q.answer IS NULL) AS open_question_count`;

async function loadArticle(id: string) {
  const res = await pool.query(`SELECT a.*, ${COUNT_COLUMNS} FROM kb_articles a WHERE a.id = $1`, [id]);
  return res.rows[0] || null;
}

// Validates a {visibility, teams} payload; returns normalized values or an error.
async function parseAccess(body: any): Promise<{ visibility: 'org' | 'teams'; teams: string[] } | { error: string }> {
  const visibility = body?.visibility === 'org' ? 'org' : body?.visibility === 'teams' ? 'teams' : null;
  if (!visibility) return { error: "visibility must be 'org' or 'teams'" };
  if (visibility === 'org') return { visibility, teams: [] };
  const known = await loadTeams();
  const requested: string[] = Array.isArray(body?.teams) ? body.teams.map((t: any) => String(t).trim().toLowerCase()) : [];
  const teams = Array.from(new Set(requested.filter(Boolean)));
  if (teams.length === 0) return { error: 'Choose at least one team' };
  const unknown = teams.filter((t) => !known.has(t));
  if (unknown.length) return { error: `Unknown team(s): ${unknown.join(', ')}` };
  return { visibility, teams };
}

/**
 * Handles every `kb/...` route. Returns null for paths it doesn't own so the
 * caller can keep matching. The caller has already rejected unauthenticated
 * requests.
 */
export async function handleKbApi(
  req: NextRequest,
  path: string,
  method: string,
  url: URL,
  ctx: { userId: string; currentUser: any; isAdmin: boolean },
): Promise<NextResponse | null> {
  if (path !== 'kb' && !path.startsWith('kb/')) return null;
  const { userId, currentUser, isAdmin } = ctx;
  if (!userId) return json({ error: 'Unauthorized' }, 401);
  await kbSchemaReady;

  // By explicit request: every migration_manager role user gets the same
  // "Awaiting my approval" access as an admin, not just whoever happens to
  // be set as someone's actual manager_id -- the same fallback this
  // codebase already relies on elsewhere (Filters' assignee picker,
  // my-dashboard, the Home dashboard's Migration Manager section) wherever
  // the manager_id hierarchy itself isn't a reliable source of truth for
  // who actually holds this role. A migration_manager approving a pending
  // article they didn't personally submit is never their own article
  // (row.author_id !== userId already guards that for every path here).
  const isMigrationManager = currentUser?.role === 'migration_manager';
  const canManage = (row: any) => isAdmin || row.author_id === userId;
<<<<<<< HEAD
  // A pending article waits on any of its author's managers (approver_ids),
  // or any admin when the author has no manager.
  const canApprove = (row: any) =>
    row.status === 'pending' && row.author_id !== userId && (isAdmin || (row.approver_ids || []).includes(userId));
=======
  // A pending article waits on its manager (approver_id), any admin when
  // the author has no manager, or any migration_manager role user.
  const canApprove = (row: any) =>
    row.status === 'pending' && row.author_id !== userId &&
    (isAdmin || isMigrationManager || (!!row.approver_id && row.approver_id === userId));
>>>>>>> a2c0caa5b8dbec955e44dfbe3b647b7e50e0f0dc
  const canRead = (row: any, myTeams: string[]) =>
    canManage(row) ||
    canApprove(row) ||
    (row.status === 'published' &&
      (row.visibility === 'org' || (row.teams || []).some((t: string) => myTeams.includes(t))));

  // GET kb/me -- how publishing works for the current user: admins publish
  // directly; everyone else submits to `approvers` (empty = any admin).
  // `reviews` is true when the user may have articles to approve.
  if (path === 'kb/me' && method === 'GET') {
    const approvers = isAdmin ? [] : await resolveApprovers(userId);
    const reportCount = Number((await pool.query(`SELECT COUNT(*) FROM users WHERE $1 = ANY(manager_ids)`, [userId])).rows[0]?.count || 0);
    return json({
      publishesDirectly: isAdmin,
<<<<<<< HEAD
      approvers: approvers.map((a) => ({ id: a.id, name: a.name })),
      reviews: isAdmin || reportCount > 0,
=======
      approver: approver ? { id: approver.id, name: approver.name } : null,
      reviews: isAdmin || isMigrationManager || reportCount > 0,
>>>>>>> a2c0caa5b8dbec955e44dfbe3b647b7e50e0f0dc
    });
  }

  // GET kb/teams -- every team a writer can publish to (names only, no member ids)
  if (path === 'kb/teams' && method === 'GET') {
    const teams = await loadTeams();
    return json(
      Array.from(teams.values())
        .map((t) => ({ key: t.key, name: t.name, memberCount: t.memberIds.size }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  // GET kb/articles?kind=kb|release&q=&scope=all|mine|drafts|approvals
  if (path === 'kb/articles' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const myTeams = await getUserTeamKeys(userId);
    const where: string[] = [];
    const params: any[] = [];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    where.push(`a.kind = ${p(parseKind(url.searchParams.get('kind')))}`);

    if (scope === 'approvals') {
      // Articles waiting on me: as the author's manager, as an admin, or as
      // any migration_manager role user (same blanket access canApprove and
      // kb/me's `reviews` flag already grant them above) -- without this,
      // the "Awaiting my approval" tab correctly appeared for a migration
      // manager (reviews: true) but the list itself stayed narrowed to only
      // articles where THEY specifically were the assigned approver_id,
      // same as an ordinary manager, leaving it empty for everyone except
      // whoever happened to be set as that particular author's manager.
      where.push(`status = 'pending' AND author_id <> ${p(userId)}`);
<<<<<<< HEAD
      if (!isAdmin) where.push(`${p(userId)} = ANY(approver_ids)`);
=======
      if (!isAdmin && !isMigrationManager) where.push(`approver_id = ${p(userId)}`);
>>>>>>> a2c0caa5b8dbec955e44dfbe3b647b7e50e0f0dc
    } else if (scope === 'drafts') {
      // Drafts include the ones submitted and waiting for approval.
      where.push(`status IN ('draft', 'pending')`);
      if (!isAdmin) where.push(`author_id = ${p(userId)}`);
    } else if (scope === 'mine') {
      where.push(`author_id = ${p(userId)}`);
    } else if (isAdmin) {
      where.push(`status = 'published'`);
    } else {
      where.push(`status = 'published' AND (author_id = ${p(userId)} OR visibility = 'org' OR teams && ${p(myTeams)}::text[])`);
    }
    if (q) {
      const like = p(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(a.title ILIKE ${like} OR a.body_html ILIKE ${like}
        OR EXISTS (SELECT 1 FROM kb_files f WHERE f.article_id = a.id AND f.filename ILIKE ${like}))`);
    }
    const rows = await pool.query(
      `SELECT a.*, ${COUNT_COLUMNS} FROM kb_articles a WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT 500`,
      params,
    );
    const teams = await loadTeams();
    return json(rows.rows.map((r) => formatArticle(r, teams, canManage(r), false, canApprove(r))));
  }

  // POST kb/articles -- create a draft
  if (path === 'kb/articles' && method === 'POST') {
    const body: any = await req.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    if (!title) return json({ error: 'Title is required' }, 400);
    const id = rid();
    const row = await pool.query(
      `INSERT INTO kb_articles (id, kind, title, body_html, author_id, author_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, parseKind(body.kind), title.slice(0, 300), sanitizeKbHtml(String(body.bodyHtml || '')), userId, displayNameOf(currentUser)],
    );
    return json(formatArticle(row.rows[0], await loadTeams(), true, true), 201);
  }

  // kb/articles/:id
  // kb/articles/:id/(publish|access)
  // kb/articles/:id/(approve|reject|withdraw)
  // kb/articles/:id/files[/:fileId]
  // kb/articles/:id/questions[/:qid[/answer]]
  // kb/articles/:id/people?q=
  const m = path.match(/^kb\/articles\/([^/]+)(?:\/(publish|access|approve|reject|withdraw|files|questions|people)(?:\/([^/]+)(?:\/(answer))?)?)?$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const id = m[1];
  const action = m[2] || null;
  const subId = m[3] || null;
  const subAction = m[4] || null;
  if (subId && action !== 'files' && action !== 'questions') return json({ error: 'Not found' }, 404);
  if (subAction && action !== 'questions') return json({ error: 'Not found' }, 404);

  const article = await loadArticle(id);
  // Unreadable articles answer 404, not 403, so their existence isn't leaked.
  if (!article) return json({ error: 'Article not found' }, 404);
  const myTeams = await getUserTeamKeys(userId);
  if (!canRead(article, myTeams)) return json({ error: 'Article not found' }, 404);
  const manager = canManage(article);
  // While an article waits for approval its author can't change it -- the
  // approver should publish exactly what they reviewed. Withdrawing the
  // request puts it back to draft for editing. Admins aren't held to this.
  const lockedForReview = article.status === 'pending' && !isAdmin;

  if (!action && method === 'GET') {
    const files = await pool.query(`SELECT * FROM kb_files WHERE article_id = $1 ORDER BY created_at`, [id]);
    return json({ ...formatArticle(article, await loadTeams(), manager, true, canApprove(article)), files: files.rows.map(formatFile) });
  }

  // ── Approval ─────────────────────────────────────────────────────────────
  if ((action === 'approve' || action === 'reject' || action === 'withdraw') && method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // POST kb/articles/:id/approve -- the approver publishes it to the
  // audience the author chose, and that audience is notified.
  if (action === 'approve') {
    if (!canApprove(article)) return json({ error: 'Only the author’s manager or an admin can approve this' }, 403);
    const approverName = displayNameOf(currentUser);
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'published', published_at = COALESCE(published_at, NOW()), updated_at = NOW(),
         review_note = NULL, reviewed_by_name = $2
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, approverName],
    );
    const published = row.rows[0];
    if (!published) return json({ error: 'This is no longer waiting for approval' }, 409);
    announcePublished(published);
    const kindLabel = published.kind === 'release' ? 'release note' : 'article';
    await notify(published.author_id, 'KB_APPROVED', `${approverName} approved your ${kindLabel} "${clip(published.title, 80)}"`, 'It is now published.', id);
    const author = await db.user.findUnique({ where: { id: published.author_id }, select: { email: true } });
    notifyKbApproval({
      recipientEmails: author?.email ? [author.email] : [],
      event: 'approved', articleId: id, title: published.title,
      kind: published.kind === 'release' ? 'release' : 'article', actorName: approverName,
    }).catch((e) => console.error('[KB] Approval email failed:', e?.message || e));
    return json(formatArticle({ ...article, ...published }, await loadTeams(), manager, true, false));
  }

  // POST kb/articles/:id/reject {note} -- back to the author's drafts with a reason.
  if (action === 'reject') {
    if (!canApprove(article)) return json({ error: 'Only the author’s manager or an admin can review this' }, 403);
    const body: any = await req.json().catch(() => ({}));
    const note = String(body.note || '').trim();
    if (!note) return json({ error: 'Tell the author what needs to change' }, 400);
    if (note.length > MAX_QA_CHARS) return json({ error: `Notes are limited to ${MAX_QA_CHARS} characters` }, 400);
    const reviewerName = displayNameOf(currentUser);
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'draft', review_note = $2, reviewed_by_name = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, note, reviewerName],
    );
    const updated = row.rows[0];
    if (!updated) return json({ error: 'This is no longer waiting for approval' }, 409);
    const kindLabel = updated.kind === 'release' ? 'release note' : 'article';
    await notify(updated.author_id, 'KB_REJECTED', `${reviewerName} requested changes to your ${kindLabel} "${clip(updated.title, 80)}"`, clip(note, 140), id);
    const author = await db.user.findUnique({ where: { id: updated.author_id }, select: { email: true } });
    notifyKbApproval({
      recipientEmails: author?.email ? [author.email] : [],
      event: 'rejected', articleId: id, title: updated.title,
      kind: updated.kind === 'release' ? 'release' : 'article', actorName: reviewerName, note,
    }).catch((e) => console.error('[KB] Rejection email failed:', e?.message || e));
    return json(formatArticle({ ...article, ...updated }, await loadTeams(), manager, true, false));
  }

  // POST kb/articles/:id/withdraw -- the author takes back a pending request.
  if (action === 'withdraw') {
    if (!manager) return json({ error: 'Only the author or an admin can withdraw this' }, 403);
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'draft', review_note = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id],
    );
    if (!row.rows[0]) return json({ error: 'This is not waiting for approval' }, 409);
    return json(formatArticle({ ...article, ...row.rows[0] }, await loadTeams(), true, true, false));
  }

  // ── People to @mention ───────────────────────────────────────────────────
  // GET kb/articles/:id/people?q= -- any reader. Only people who can read this
  // article are suggested, so a mention always leads somewhere they can open.
  if (action === 'people' && !subId && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const [users, teams] = await Promise.all([
      db.user.findMany({
        where: { isActive: true },
        select: { id: true, firstName: true, lastName: true, displayName: true, email: true, role: true, avatarUrl: true },
      }),
      loadTeams(),
    ]);
    const matches = users
      .filter((u) => u.id !== userId && userCanRead(article, u, teams))
      .map((u) => ({ id: u.id, name: displayNameOf(u), email: u.email }))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .sort((a, b) => {
        // Names that start with what was typed come first.
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    return json(matches);
  }
  if (action === 'people') return json({ error: 'Method not allowed' }, 405);

  // ── Files ────────────────────────────────────────────────────────────────
  if (action === 'files') {
    const nodePath = await import('path');
    const fs = await import('fs/promises');
    const uploadsRoot = nodePath.resolve(process.cwd(), 'uploads');

    // GET kb/articles/:id/files/:fileId -- any reader
    if (subId && method === 'GET') {
      const row = (await pool.query(`SELECT * FROM kb_files WHERE id = $1 AND article_id = $2`, [subId, id])).rows[0];
      if (!row) return json({ error: 'File not found' }, 404);
      const filePath = nodePath.resolve(process.cwd(), row.storage_path);
      if (!filePath.startsWith(uploadsRoot)) return json({ error: 'File not found' }, 404);
      const buf = await fs.readFile(filePath).catch(() => null);
      if (!buf) return json({ error: 'File is missing on the server' }, 404);
      const asciiName = String(row.filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      // Only types that can't carry script are served as themselves (that's
      // what the page previews). Anything else -- HTML, SVG, whatever the
      // browser claimed on upload -- goes out as an opaque download.
      const previewable = INLINE_MIME.has(String(row.mime || '').toLowerCase());
      return new NextResponse(buf, {
        headers: {
          'Content-Type': previewable ? row.mime : 'application/octet-stream',
          'Content-Length': String(buf.length),
          'Content-Disposition': `${previewable ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (!manager) return json({ error: 'Only the author or an admin can change documents' }, 403);
    if (lockedForReview) return json({ error: 'Waiting for approval. Withdraw the request to make changes.' }, 409);

    // POST kb/articles/:id/files  (multipart field "file")
    if (!subId && method === 'POST') {
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof Blob)) return json({ error: 'No file provided' }, 400);
      if (file.size > MAX_FILE_BYTES) return json({ error: 'File too large (max 50 MB)' }, 413);
      const originalName = String((file as any).name || 'document').slice(0, 255);
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'document';
      const fileId = rid();
      const relPath = `${kbDir(id)}/${fileId}-${safeName}`;
      const absPath = nodePath.resolve(process.cwd(), relPath);
      await fs.mkdir(nodePath.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, Buffer.from(await file.arrayBuffer()));
      const row = await pool.query(
        `INSERT INTO kb_files (id, article_id, filename, mime, size, storage_path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [fileId, id, originalName, file.type || null, file.size, relPath, userId],
      );
      await pool.query(`UPDATE kb_articles SET updated_at = NOW() WHERE id = $1`, [id]);
      return json(formatFile(row.rows[0]), 201);
    }

    // DELETE kb/articles/:id/files/:fileId
    if (subId && method === 'DELETE') {
      const row = (await pool.query(`DELETE FROM kb_files WHERE id = $1 AND article_id = $2 RETURNING *`, [subId, id])).rows[0];
      if (!row) return json({ error: 'File not found' }, 404);
      const filePath = nodePath.resolve(process.cwd(), row.storage_path);
      if (filePath.startsWith(uploadsRoot)) await fs.unlink(filePath).catch(() => {});
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  }

  // ── Questions ────────────────────────────────────────────────────────────
  if (action === 'questions') {
    // GET kb/articles/:id/questions -- every reader sees the whole thread
    if (!subId && method === 'GET') {
      const rows = await pool.query(`SELECT * FROM kb_questions WHERE article_id = $1 ORDER BY created_at`, [id]);
      return json(rows.rows.map((r) => formatQuestion(r, userId, manager)));
    }

    // POST kb/articles/:id/questions {question, fileId?, quote?}
    if (!subId && method === 'POST') {
      if (article.status !== 'published') return json({ error: 'Questions open once the article is published' }, 400);
      const body: any = await req.json().catch(() => ({}));
      const question = String(body.question || '').trim();
      if (!question) return json({ error: 'Type a question first' }, 400);
      if (question.length > MAX_QA_CHARS) return json({ error: `Questions are limited to ${MAX_QA_CHARS} characters` }, 400);
      const quote = body.quote ? clip(String(body.quote).replace(/\s+/g, ' ').trim(), 1000) || null : null;
      let fileId: string | null = null;
      let fileName: string | null = null;
      if (body.fileId) {
        const f = (await pool.query(`SELECT id, filename FROM kb_files WHERE id = $1 AND article_id = $2`, [String(body.fileId), id])).rows[0];
        if (f) { fileId = f.id; fileName = f.filename; }
      }
      const askerName = displayNameOf(currentUser);
      const row = await pool.query(
        `INSERT INTO kb_questions (id, article_id, asker_id, asker_name, question, file_id, file_name, quote)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [rid(), id, userId, askerName, question, fileId, fileName, quote],
      );
      if (article.author_id !== userId) {
        await notify(
          article.author_id,
          'KB_QUESTION',
          `${askerName} asked a question on "${clip(article.title, 80)}"${fileName ? ` (${clip(fileName, 40)})` : ''}`,
          clip(plainMentions(question), 140),
          id,
        );
      }
      // The author already got the "asked a question" notification above.
      await notifyMentions(article, question, null, { id: userId, name: askerName }, 'question', [article.author_id]);
      return json(formatQuestion(row.rows[0], userId, manager), 201);
    }

    if (!subId) return json({ error: 'Method not allowed' }, 405);
    const q = (await pool.query(`SELECT * FROM kb_questions WHERE id = $1 AND article_id = $2`, [subId, id])).rows[0];
    if (!q) return json({ error: 'Question not found' }, 404);

    // PUT kb/articles/:id/questions/:qid/answer {answer} -- any reader; see canEditAnswer
    if (subAction === 'answer' && method === 'PUT') {
      if (article.status !== 'published') return json({ error: 'Answers open once the article is published' }, 400);
      if (!canEditAnswer(q, userId, manager)) {
        return json({ error: 'Only the person who answered, the author, or an admin can change this answer' }, 403);
      }
      const body: any = await req.json().catch(() => ({}));
      const answer = String(body.answer || '').trim();
      if (!answer) return json({ error: 'Type an answer first' }, 400);
      if (answer.length > MAX_QA_CHARS) return json({ error: `Answers are limited to ${MAX_QA_CHARS} characters` }, 400);
      const answererName = displayNameOf(currentUser);
      const firstAnswer = !q.answer;
      const row = await pool.query(
        `UPDATE kb_questions SET answer = $2, answered_by_id = $3, answered_by_name = $4, answered_at = NOW()
         WHERE id = $1 RETURNING *`,
        [subId, answer, userId, answererName],
      );
      const notified: string[] = [];
      if (q.asker_id !== userId) {
        notified.push(q.asker_id);
        await notify(
          q.asker_id,
          'KB_ANSWER',
          `${answererName} ${firstAnswer ? 'answered' : 'updated the answer to'} your question on "${clip(article.title, 80)}"`,
          clip(plainMentions(answer), 140),
          id,
        );
      }
      // Now that readers answer too, let the author know what's being said
      // about their article.
      if (firstAnswer && article.author_id !== userId && article.author_id !== q.asker_id) {
        notified.push(article.author_id);
        await notify(
          article.author_id,
          'KB_ANSWER',
          `${answererName} answered ${q.asker_name || 'a reader'}'s question on "${clip(article.title, 80)}"`,
          clip(plainMentions(answer), 140),
          id,
        );
      }
      await notifyMentions(article, answer, q.answer, { id: userId, name: answererName }, 'answer', notified);
      return json(formatQuestion(row.rows[0], userId, manager));
    }

    // DELETE kb/articles/:id/questions/:qid -- author, admin, or the asker
    if (!subAction && method === 'DELETE') {
      if (!manager && q.asker_id !== userId) return json({ error: 'You can only delete your own questions' }, 403);
      await pool.query(`DELETE FROM kb_questions WHERE id = $1`, [subId]);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  }

  if (!manager) {
    return json({ error: 'Only the author or an admin can change this article' }, 403);
  }

  if (!action && method === 'PUT') {
    if (lockedForReview) return json({ error: 'Waiting for approval. Withdraw the request to make changes.' }, 409);
    const body: any = await req.json().catch(() => ({}));
    const title = body.title !== undefined ? String(body.title).trim() : article.title;
    if (!title) return json({ error: 'Title is required' }, 400);
    const bodyHtml = body.bodyHtml !== undefined ? sanitizeKbHtml(String(body.bodyHtml)) : article.body_html;
    const row = await pool.query(
      `UPDATE kb_articles SET title = $2, body_html = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, title.slice(0, 300), bodyHtml],
    );
    return json(formatArticle(row.rows[0], await loadTeams(), true, true));
  }

  if (!action && method === 'DELETE') {
    await pool.query(`DELETE FROM kb_articles WHERE id = $1`, [id]);
    // Rows in kb_files/kb_questions cascade; the documents on disk don't.
    try {
      const nodePath = await import('path');
      const fs = await import('fs/promises');
      await fs.rm(nodePath.resolve(process.cwd(), kbDir(id)), { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
    return json({ ok: true });
  }

  // POST kb/articles/:id/publish  {visibility, teams}
  // Admins publish straight away. Anyone else submits the article for
  // approval: it goes to 'pending' with the chosen audience saved, and is
  // published -- and that audience notified -- only when the approver approves.
  if (action === 'publish' && method === 'POST') {
    if (lockedForReview) return json({ error: 'This is already waiting for approval' }, 409);
    const access = await parseAccess(await req.json().catch(() => ({})));
    if ('error' in access) return json({ error: access.error }, 400);

    // Already live: this only changes who can read it (same as PATCH access),
    // and doesn't re-announce it.
    if (article.status === 'published') {
      const row = await pool.query(
        `UPDATE kb_articles SET visibility = $2, teams = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, access.visibility, access.teams],
      );
      return json(formatArticle({ ...article, ...row.rows[0] }, await loadTeams(), true, true));
    }

    if (isAdmin) {
      const row = await pool.query(
        `UPDATE kb_articles SET status = 'published', visibility = $2, teams = $3,
           published_at = COALESCE(published_at, NOW()), updated_at = NOW(), review_note = NULL
         WHERE id = $1 RETURNING *`,
        [id, access.visibility, access.teams],
      );
      const published = row.rows[0];
      announcePublished(published);
      return json(formatArticle({ ...article, ...published }, await loadTeams(), true, true));
    }

    const approvers = await resolveApprovers(article.author_id);
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'pending', visibility = $2, teams = $3, approver_ids = $4, approver_name = $5,
         submitted_at = NOW(), review_note = NULL, reviewed_by_name = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, access.visibility, access.teams, approvers.map((a) => a.id), approverNames(approvers)],
    );
    const pending = row.rows[0];

    // Tell whoever has to approve it: every one of the author's managers, or
    // every admin when the author has no manager set.
    await requestApproval(pending, approvers.length ? approvers : await activeAdmins());

    return json(formatArticle({ ...article, ...pending }, await loadTeams(), true, true));
  }

  // PATCH kb/articles/:id/access  {visibility, teams} -- add/remove teams or go org-wide
  if (action === 'access' && method === 'PATCH') {
    if (lockedForReview) return json({ error: 'Waiting for approval. Withdraw the request to make changes.' }, 409);
    const access = await parseAccess(await req.json().catch(() => ({})));
    if ('error' in access) return json({ error: access.error }, 400);
    const row = await pool.query(
      `UPDATE kb_articles SET visibility = $2, teams = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, access.visibility, access.teams],
    );
    return json(formatArticle(row.rows[0], await loadTeams(), true, true));
  }

  return json({ error: 'Method not allowed' }, 405);
}
