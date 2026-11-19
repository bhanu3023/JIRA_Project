/**
 * POST /api/oauth/register -- OAuth dynamic client registration (RFC 7591).
 * Claude registers itself here once per connector. Only Claude's own
 * callback URLs are accepted (see isAllowedRedirectUri), and clients are
 * public (PKCE, no secret), so registering grants nothing by itself: a
 * person still has to sign in and approve on the consent page.
 */
import crypto from 'crypto';
import { pgPool as pool } from '@/lib/pg-pool';
import { ensureMcpTables, isAllowedRedirectUri, mcpEnabled } from '@/lib/mcp/store';
import { jsonRes, oauthError, preflight, readBody } from '@/lib/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!mcpEnabled()) return oauthError('temporarily_unavailable', 'The Claude connector is turned off.', 503);
  const body = await readBody(req);
  const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length) return oauthError('invalid_redirect_uri', 'redirect_uris is required');
  const bad = uris.filter((u) => !isAllowedRedirectUri(u));
  if (bad.length) return oauthError('invalid_redirect_uri', `Redirect URI not allowed: ${bad.join(', ')}`);

  await ensureMcpTables();
  const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
  const name = String(body.client_name || 'Claude').slice(0, 100);
  await pool.query(
    `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)`,
    [clientId, name, JSON.stringify(uris)],
  );
  return jsonRes({
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
}
export const OPTIONS = preflight;
