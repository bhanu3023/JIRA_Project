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
  // Only the httpOnly session cookie authenticates here now -- this used to
  // also accept the same session JWT via a literal Authorization header,
  // preferred over the cookie. This file doesn't support personal API
  // tokens at all (only ever verifies the "eyJ" session-JWT format), so
  // that header path existed purely to replay the exact token the cookie
  // already carries. Anyone who ever captured that raw JWT value (a proxy/
  // debugging tool, a misconfigured log, etc.) could send it straight back
  // as `Authorization: Bearer <stolen jwt>` from curl/Postman/anywhere,
  // fully equivalent to stealing the session but with none of the
  // httpOnly/SameSite protections a real cookie gets. Confirmed via a
  // security audit. The cookie is sent automatically by the browser on
  // every same-origin request, so legitimate callers are unaffected.
  const token = readSessionCookie(req);
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
