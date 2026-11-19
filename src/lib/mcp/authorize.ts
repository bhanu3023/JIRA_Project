// Validation shared by GET/POST /api/oauth/authorize and the consent page.
import { pgPool as pool } from '@/lib/pg-pool';
import { ensureMcpTables, MCP_SCOPE } from './store';

export type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  response_type: string;
  resource?: string;
};

export const AUTHORIZE_KEYS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'response_type', 'resource'] as const;

export function pickAuthorizeParams(get: (k: string) => string | null | undefined): AuthorizeParams {
  const v = (k: string) => String(get(k) ?? '');
  return {
    client_id: v('client_id'),
    redirect_uri: v('redirect_uri'),
    code_challenge: v('code_challenge'),
    code_challenge_method: v('code_challenge_method') || 'S256',
    state: v('state'),
    scope: v('scope') || MCP_SCOPE,
    response_type: v('response_type'),
    resource: v('resource') || undefined,
  };
}

/**
 * Checks the request names a registered client and one of ITS redirect URIs.
 * Returns the client's name, or an error message. Until this passes we must
 * never redirect anywhere (an unchecked redirect_uri would leak codes).
 */
export async function validateClient(p: AuthorizeParams): Promise<{ clientName: string } | { error: string }> {
  if (!p.client_id || !p.redirect_uri) return { error: 'Missing client_id or redirect_uri.' };
  await ensureMcpTables();
  const r = await pool.query(`SELECT client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1`, [p.client_id]);
  const row = r.rows[0];
  if (!row) return { error: 'Unknown client. Remove the connector in Claude and add it again.' };
  const uris: string[] = Array.isArray(row.redirect_uris) ? row.redirect_uris : [];
  if (!uris.includes(p.redirect_uri)) return { error: 'This redirect address is not registered for the client.' };
  return { clientName: row.client_name || 'Claude' };
}

/** Errors that ARE safe to send back to the (already validated) redirect_uri. */
export function validateRequest(p: AuthorizeParams): string | null {
  if (p.response_type !== 'code') return 'unsupported_response_type';
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'invalid_request';
  return null;
}

export function redirectWith(uri: string, params: Record<string, string>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

export function toQuery(p: AuthorizeParams) {
  const q = new URLSearchParams();
  for (const k of AUTHORIZE_KEYS) { const v = (p as any)[k]; if (v) q.set(k, v); }
  return q.toString();
}
