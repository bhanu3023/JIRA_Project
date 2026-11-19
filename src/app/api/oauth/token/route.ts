/**
 * POST /api/oauth/token -- exchanges a one-time code (with its PKCE
 * verifier) or a refresh token for a read-only access token. Refresh tokens
 * rotate: each one works once.
 */
import crypto from 'crypto';
import { pgPool as pool } from '@/lib/pg-pool';
import { ensureMcpTables, issueTokenPair, mcpEnabled, sha256 } from '@/lib/mcp/store';
import { jsonRes, oauthError, preflight, readBody } from '@/lib/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export async function POST(req: Request) {
  if (!mcpEnabled()) return oauthError('temporarily_unavailable', 'The Claude connector is turned off.', 503);
  await ensureMcpTables();
  const b = await readBody(req);
  const clientId = String(b.client_id || '');

  if (b.grant_type === 'authorization_code') {
    const code = String(b.code || '');
    const verifier = String(b.code_verifier || '');
    if (!code || !verifier) return oauthError('invalid_request', 'code and code_verifier are required');
    // Atomically claim the code so it can only ever be used once.
    const r = await pool.query(
      `UPDATE mcp_oauth_codes SET used = TRUE
        WHERE code_hash = $1 AND used = FALSE AND expires_at > NOW()
        RETURNING client_id, user_id, grant_id, redirect_uri, code_challenge`,
      [sha256(code)],
    );
    const row = r.rows[0];
    if (!row) return oauthError('invalid_grant', 'Code is invalid, expired or already used');
    if (clientId && clientId !== row.client_id) return oauthError('invalid_grant', 'Code was issued to a different client');
    if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri mismatch');
    const a = Buffer.from(s256(verifier));
    const e = Buffer.from(String(row.code_challenge));
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return oauthError('invalid_grant', 'PKCE verification failed');
    return jsonRes(await issueTokenPair(row.user_id, row.client_id, row.grant_id));
  }

  if (b.grant_type === 'refresh_token') {
    const rt = String(b.refresh_token || '');
    if (!rt) return oauthError('invalid_request', 'refresh_token is required');
    const r = await pool.query(
      `UPDATE mcp_refresh_tokens t SET used = TRUE
         FROM mcp_grants g
        WHERE t.token_hash = $1 AND t.used = FALSE AND t.expires_at > NOW()
          AND g.id = t.grant_id AND g.revoked = FALSE
        RETURNING t.user_id, t.client_id, t.grant_id`,
      [sha256(rt)],
    );
    const row = r.rows[0];
    if (!row) return oauthError('invalid_grant', 'Refresh token is invalid, expired, revoked or already used');
    if (clientId && clientId !== row.client_id) return oauthError('invalid_grant', 'Token was issued to a different client');
    const u = await pool.query(`SELECT "isActive" FROM users WHERE id = $1`, [row.user_id]);
    if (!u.rows[0]?.isActive) return oauthError('invalid_grant', 'Account is deactivated');
    return jsonRes(await issueTokenPair(row.user_id, row.client_id, row.grant_id));
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}
export const OPTIONS = preflight;
