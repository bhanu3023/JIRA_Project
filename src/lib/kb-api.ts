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
 */

import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';
import { db } from '@/lib/db';
import { mentionedIds, plainMentions } from '@/lib/kb-mentions';
import { notifyKbArticlePublished } from '@/lib/notification-service';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_QA_CHARS = 4000;
const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const kbSchemaReady = pool.query(`CREATE TABLE IF NOT EXISTS kb_articles (
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
  .catch((e) => { console.error('[kb] schema setup failed:', e?.message || e); });

// Same row the bell in Header.tsx polls for. KB_* notifications carry the
// article id in issueKey; Header routes those to /kb instead of /issues.
async function notify(userId: string, type: 'KB_QUESTION' | 'KB_ANSWER' | 'KB_MENTION', title: string, message: string, articleId: string) {
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

function formatArticle(row: any, teams: Map<string, Team>, canManage: boolean, includeBody: boolean) {
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
    canManage,
  };
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

  const canManage = (row: any) => isAdmin || row.author_id === userId;
  const canRead = (row: any, myTeams: string[]) =>
    canManage(row) ||
    (row.status === 'published' &&
      (row.visibility === 'org' || (row.teams || []).some((t: string) => myTeams.includes(t))));

  // GET kb/teams -- every team a writer can publish to (names only, no member ids)
  if (path === 'kb/teams' && method === 'GET') {
    const teams = await loadTeams();
    return json(
      Array.from(teams.values())
        .map((t) => ({ key: t.key, name: t.name, memberCount: t.memberIds.size }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  // GET kb/articles?kind=kb|release&q=&scope=all|mine|drafts
  if (path === 'kb/articles' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const myTeams = await getUserTeamKeys(userId);
    const where: string[] = [];
    const params: any[] = [];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    where.push(`a.kind = ${p(parseKind(url.searchParams.get('kind')))}`);

    if (scope === 'drafts') {
      where.push(`status = 'draft'`);
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
    return json(rows.rows.map((r) => formatArticle(r, teams, canManage(r), false)));
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
  // kb/articles/:id/files[/:fileId]
  // kb/articles/:id/questions[/:qid[/answer]]
  // kb/articles/:id/people?q=
  const m = path.match(/^kb\/articles\/([^/]+)(?:\/(publish|access|files|questions|people)(?:\/([^/]+)(?:\/(answer))?)?)?$/);
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

  if (!action && method === 'GET') {
    const files = await pool.query(`SELECT * FROM kb_files WHERE article_id = $1 ORDER BY created_at`, [id]);
    return json({ ...formatArticle(article, await loadTeams(), manager, true), files: files.rows.map(formatFile) });
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
  if (action === 'publish' && method === 'POST') {
    const access = await parseAccess(await req.json().catch(() => ({})));
    if ('error' in access) return json({ error: access.error }, 400);
    // Only true the FIRST time this article goes live -- publishing again
    // after an edit (status was already 'published') shouldn't re-announce
    // it to the whole org a second time. published_at is already
    // COALESCE'd to preserve the original publish moment for exactly this
    // reason; this mirrors that same "first time only" rule for the
    // announcement itself.
    const wasAlreadyPublished = (await pool.query(`SELECT status FROM kb_articles WHERE id = $1`, [id])).rows[0]?.status === 'published';
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'published', visibility = $2, teams = $3,
         published_at = COALESCE(published_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, access.visibility, access.teams],
    );
    const published = row.rows[0];

    // By explicit request: every KB article/Release Note publish announces
    // to EVERYONE with access to the app (not just the author's team or
    // whoever happens to be watching), by email and in-app notification,
    // naming who published it and linking straight to the article. Runs
    // fire-and-forget -- the publish response doesn't wait on hundreds of
    // individual email sends.
    if (!wasAlreadyPublished) {
      (async () => {
        try {
          const recipients = await db.user.findMany({ where: { isActive: true }, select: { id: true, email: true } });
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

    return json(formatArticle(published, await loadTeams(), true, true));
  }

  // PATCH kb/articles/:id/access  {visibility, teams} -- add/remove teams or go org-wide
  if (action === 'access' && method === 'PATCH') {
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
