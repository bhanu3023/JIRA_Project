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

pool.query(`CREATE TABLE IF NOT EXISTS kb_articles (
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
)`).then(() => pool.query(`CREATE INDEX IF NOT EXISTS kb_articles_status_idx ON kb_articles(status)`)).catch(() => {});

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
    canManage,
  };
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

  // GET kb/articles?q=&scope=all|mine|drafts
  if (path === 'kb/articles' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const myTeams = await getUserTeamKeys(userId);
    const where: string[] = [];
    const params: any[] = [];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };

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
      where.push(`(title ILIKE ${like} OR body_html ILIKE ${like})`);
    }
    const rows = await pool.query(
      `SELECT * FROM kb_articles WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`,
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
      `INSERT INTO kb_articles (id, title, body_html, author_id, author_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, title.slice(0, 300), sanitizeKbHtml(String(body.bodyHtml || '')), userId, displayNameOf(currentUser)],
    );
    return json(formatArticle(row.rows[0], await loadTeams(), true, true), 201);
  }

  const m = path.match(/^kb\/articles\/([^/]+)(?:\/(publish|access))?$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const id = m[1];
  const action = m[2] || null;

  const existing = await pool.query(`SELECT * FROM kb_articles WHERE id = $1`, [id]);
  const article = existing.rows[0];
  // Unreadable articles answer 404, not 403, so their existence isn't leaked.
  if (!article) return json({ error: 'Article not found' }, 404);
  const myTeams = await getUserTeamKeys(userId);
  if (!canRead(article, myTeams)) return json({ error: 'Article not found' }, 404);

  if (!action && method === 'GET') {
    return json(formatArticle(article, await loadTeams(), canManage(article), true));
  }

  if (!canManage(article)) {
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
    return json({ ok: true });
  }

  // POST kb/articles/:id/publish  {visibility, teams}
  if (action === 'publish' && method === 'POST') {
    const access = await parseAccess(await req.json().catch(() => ({})));
    if ('error' in access) return json({ error: access.error }, 400);
    const row = await pool.query(
      `UPDATE kb_articles SET status = 'published', visibility = $2, teams = $3,
         published_at = COALESCE(published_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, access.visibility, access.teams],
    );
    return json(formatArticle(row.rows[0], await loadTeams(), true, true));
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
