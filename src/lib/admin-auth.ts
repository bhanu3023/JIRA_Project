// Shared admin-only auth check for the small, separate route handlers under
// src/app/api/admin/* (bulk-write endpoints like fix-space-types,
// bulk-patch, jira-field-sync/comment-sync/link-sync, auto-link-boards,
// sync-board-fields). These used to be gated ONLY by a static shared secret
// (`process.env.ADMIN_BULK_SECRET || 'cf-admin-sync-2024'`) with no real
// login/session check at all -- and that exact hardcoded fallback string was
// also embedded directly in client-side page source (settings/import pages),
// so any site visitor could read it from the browser bundle/devtools and
// call these endpoints directly, e.g. bulk-changing every space's type with
// zero authentication. Confirmed via a security audit.
//
// This instead requires a real, currently-valid admin session -- the same
// Bearer JWT + user_sessions check jira-pg-api.ts's resolveUserId() does,
// kept small and independent here rather than importing the whole
// monolithic jira-pg-api.ts module (which runs its own startup side effects
// on import) just for this one helper.
import { db } from '@/lib/db';
import { pgPool as pool } from '@/lib/pg-pool';

// Reads the jira_session cookie from a raw Cookie header -- these routes
// type their request as plain Request (not NextRequest), so no .cookies
// convenience accessor is available; this mirrors what jira-pg-api.ts's
// resolveUserId cookie fallback does with req.cookies.get(...).
function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith('jira_session='));
  return match ? decodeURIComponent(match.slice('jira_session='.length)) : null;
}

export async function requireAdmin(req: Request): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  // Prefer the Authorization header (explicit callers) but fall back to the
  // httpOnly session cookie, same as jira-pg-api.ts's resolveUserId -- a
  // cookie-based session (no token in localStorage at all) would otherwise
  // send an empty/missing Authorization header here and get rejected.
  const headerAuth = req.headers.get('authorization');
  // A literal "Bearer " with nothing after it (sent by a cookie-based
  // session whose frontend call still unconditionally attaches
  // `Bearer ${localStorage.getItem('jira_token') || ''}`) must NOT win over
  // a real cookie -- .slice(7).trim() on it is an empty string, which is
  // falsy, so the `||` below already falls through to the cookie correctly.
  const headerToken = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7).trim() : '';
  const token = headerToken || readSessionCookie(req);
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };
  if (!token.startsWith('eyJ')) return { ok: false, status: 401, error: 'Unauthorized' };

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required and must not be empty.');
  }

  let userId: string;
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string; exp: number };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, status: 401, error: 'Unauthorized' };
    userId = payload.sub;
  } catch {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  try {
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await pool.query(
      `SELECT is_revoked, expires_at FROM user_sessions WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const sess = session.rows[0];
    if (!sess || sess.is_revoked || new Date(sess.expires_at) < new Date()) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  } catch {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!user || !user.isActive || user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  return { ok: true, userId };
}
