/**
 * /api/oauth/authorize -- the sign-in step of the Claude connector.
 *
 * GET:  validates the client, then sends the person to the app's normal
 *       login (Microsoft SSO) if they aren't signed in, and on to the
 *       consent page once they are.
 * POST: the consent page's Allow/Deny form. On Allow, creates a "Claude
 *       connection" (grant) and a one-time code, and returns the person to
 *       Claude. The session cookie is SameSite=Lax, so another site can't
 *       submit this form on someone's behalf; the Origin check is a second
 *       guard.
 */
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';
import { resolveSessionUserId } from '@/lib/jira-pg-api';
import { appBaseUrl, mcpEnabled, MCP_CODE_TTL_SEC, randomToken, sha256 } from '@/lib/mcp/store';
import { pickAuthorizeParams, redirectWith, toQuery, validateClient, validateRequest } from '@/lib/mcp/authorize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const page = (msg: string, status = 400) =>
  new NextResponse(`<!doctype html><meta charset="utf-8"><title>Claude connector</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>Can't connect Claude</h2><p>${msg.replace(/</g, '&lt;')}</p></body>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

export async function GET(req: NextRequest) {
  if (!mcpEnabled()) return page('The Claude connector is turned off by your admin.', 503);
  const p = pickAuthorizeParams((k) => req.nextUrl.searchParams.get(k));
  const client = await validateClient(p);
  if ('error' in client) return page(client.error);
  const reqErr = validateRequest(p);
  if (reqErr) return NextResponse.redirect(redirectWith(p.redirect_uri, { error: reqErr, state: p.state }));

  const base = appBaseUrl();
  const userId = await resolveSessionUserId(req.cookies.get('jira_session')?.value);
  if (!userId) {
    const back = `/api/oauth/authorize?${toQuery(p)}`;
    return NextResponse.redirect(`${base}/auth/login?next=${encodeURIComponent(back)}`);
  }
  return NextResponse.redirect(`${base}/auth/claude-connect?${toQuery(p)}`);
}

export async function POST(req: NextRequest) {
  if (!mcpEnabled()) return page('The Claude connector is turned off by your admin.', 503);
  const base = appBaseUrl();
  const origin = req.headers.get('origin');
  if (origin && origin !== base && origin !== new URL(req.url).origin) return page('Request came from an unexpected site.', 403);

  const form = await req.formData();
  const p = pickAuthorizeParams((k) => form.get(k) as string | null);
  const client = await validateClient(p);
  if ('error' in client) return page(client.error);
  const reqErr = validateRequest(p);
  if (reqErr) return NextResponse.redirect(redirectWith(p.redirect_uri, { error: reqErr, state: p.state }), 303);

  const userId = await resolveSessionUserId(req.cookies.get('jira_session')?.value);
  if (!userId) return NextResponse.redirect(`${base}/auth/login?next=${encodeURIComponent(`/api/oauth/authorize?${toQuery(p)}`)}`, 303);

  if (form.get('decision') !== 'allow') {
    return NextResponse.redirect(redirectWith(p.redirect_uri, { error: 'access_denied', state: p.state }), 303);
  }

  const grantId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mcp_grants (id, user_id, client_id, client_name) VALUES ($1,$2,$3,$4)`,
    [grantId, userId, p.client_id, client.clientName],
  );
  const code = randomToken('ntc_');
  await pool.query(
    `INSERT INTO mcp_oauth_codes (code_hash, client_id, user_id, grant_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' seconds')::interval)`,
    [sha256(code), p.client_id, userId, grantId, p.redirect_uri, p.code_challenge, p.scope, String(MCP_CODE_TTL_SEC)],
  );
  return NextResponse.redirect(redirectWith(p.redirect_uri, { code, state: p.state }), 303);
}
