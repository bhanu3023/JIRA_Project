/**
 * saved-filters-api.ts
 * Saved filters for the Filters page, stored in Postgres (the `filters`
 * table from the Prisma schema). These used to fall through to
 * jira-dev-mock.ts, which kept them in server memory only -- every restart
 * or deploy wiped them -- and let anyone edit or delete anyone's filter.
 *
 * Everyone can see and star every saved filter (unchanged); only the owner
 * or an admin can rename, change or delete one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';

// Matches the Prisma model's mapping, so this is a no-op wherever
// `prisma db push` already created the table.
const schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  criteria JSONB NOT NULL DEFAULT '{}',
  "ownerId" TEXT,
  "ownerName" TEXT,
  "starredBy" TEXT[] NOT NULL DEFAULT '{}',
  "spaceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
)`).catch((e) => { console.error('[filters] schema setup failed:', e?.message || e); });

const MAX_NAME = 200;
const MAX_CRITERIA_BYTES = 20_000;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function rid() {
  return `flt_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

function format(row: any, viewerId: string) {
  const starredBy: string[] = row.starredBy || [];
  return {
    id: row.id,
    name: row.name,
    criteria: row.criteria || {},
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    starred: starredBy.includes(viewerId),
    starredBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Only a plain object of known-small size is accepted as criteria.
function parseCriteria(value: unknown): Record<string, unknown> | { error: string } {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'criteria must be an object' };
  if (JSON.stringify(value).length > MAX_CRITERIA_BYTES) return { error: 'criteria is too large' };
  return value as Record<string, unknown>;
}

/**
 * Handles `filters`, `filters/:id` and `filters/:id/star`. Returns null for
 * paths it doesn't own. The caller has already authenticated the request.
 */
export async function handleSavedFiltersApi(
  req: NextRequest,
  path: string,
  method: string,
  ctx: { userId: string; currentUser: any; isAdmin: boolean },
): Promise<NextResponse | null> {
  const m = path.match(/^filters(?:\/([^/]+)(?:\/(star))?)?$/);
  if (!m) return null;
  const { userId, currentUser, isAdmin } = ctx;
  if (!userId) return json({ error: 'Unauthorized' }, 401);
  await schemaReady;
  const id = m[1] || null;
  const star = m[2] === 'star';

  if (!id && method === 'GET') {
    const rows = await pool.query(`SELECT * FROM filters ORDER BY "updatedAt" DESC LIMIT 1000`);
    return json(rows.rows.map((r) => format(r, userId)));
  }

  if (!id && method === 'POST') {
    const body: any = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'Name is required' }, 400);
    const criteria = parseCriteria(body.criteria);
    if ('error' in criteria) return json({ error: criteria.error }, 400);
    const ownerName = `${currentUser?.firstName || ''} ${currentUser?.lastName || ''}`.trim() || currentUser?.email || 'Unknown';
    const row = await pool.query(
      `INSERT INTO filters (id, name, criteria, "ownerId", "ownerName") VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [rid(), name.slice(0, MAX_NAME), JSON.stringify(criteria), userId, ownerName],
    );
    return json(format(row.rows[0], userId), 201);
  }

  if (!id) return json({ error: 'Method not allowed' }, 405);
  const existing = (await pool.query(`SELECT * FROM filters WHERE id = $1`, [id])).rows[0];
  if (!existing) return json({ error: 'Filter not found' }, 404);

  if (star) {
    if (method === 'POST') {
      const row = await pool.query(
        `UPDATE filters SET "starredBy" = array_append(array_remove("starredBy", $2), $2) WHERE id = $1 RETURNING *`,
        [id, userId],
      );
      return json(format(row.rows[0], userId));
    }
    if (method === 'DELETE') {
      const row = await pool.query(
        `UPDATE filters SET "starredBy" = array_remove("starredBy", $2) WHERE id = $1 RETURNING *`,
        [id, userId],
      );
      return json(format(row.rows[0], userId));
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  const canManage = isAdmin || existing.ownerId === userId;

  if (method === 'PATCH') {
    if (!canManage) return json({ error: 'Only the owner or an admin can change this filter' }, 403);
    const body: any = await req.json().catch(() => ({}));
    // Only name and criteria can change -- never the owner or star list.
    const name = body.name !== undefined ? String(body.name).trim().slice(0, MAX_NAME) : existing.name;
    if (!name) return json({ error: 'Name is required' }, 400);
    let criteria = existing.criteria || {};
    if (body.criteria !== undefined) {
      const parsed = parseCriteria(body.criteria);
      if ('error' in parsed) return json({ error: parsed.error }, 400);
      criteria = parsed;
    }
    const row = await pool.query(
      `UPDATE filters SET name = $2, criteria = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id, name, JSON.stringify(criteria)],
    );
    return json(format(row.rows[0], userId));
  }

  if (method === 'DELETE') {
    if (!canManage) return json({ error: 'Only the owner or an admin can delete this filter' }, 403);
    await pool.query(`DELETE FROM filters WHERE id = $1`, [id]);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
