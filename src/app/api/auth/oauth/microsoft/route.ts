/**
 * GET /api/auth/oauth/microsoft?spaceKey=INFRA&returnUrl=/spaces/INFRA/settings?tab=email
 * Redirects user to Microsoft OAuth consent screen.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getMicrosoftAuthUrl } from '@/lib/oauth-service';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const spaceKey  = searchParams.get('spaceKey')  || 'INFRA';
  const returnUrl = searchParams.get('returnUrl') || `/spaces/${spaceKey}/settings?tab=email`;

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    // Redirect back with error
    const base = returnUrl.includes('?') ? returnUrl : `${returnUrl}?tab=email`;
    return NextResponse.redirect(
      new URL(`${base}&oauth_error=MICROSOFT_CLIENT_ID+is+not+configured+in+.env.local`, req.url)
    );
  }

  // Behind a reverse proxy (nginx), req.url is localhost:port internally.
  // Use x-forwarded headers to reconstruct the public URL, falling back to env var.
  const fwdHost  = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
  const appUrl   = fwdHost
    ? `${fwdProto}://${fwdHost}`
    : (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin);
  const redirectUri = `${appUrl}/api/auth/oauth/microsoft/callback`;
  const mode        = searchParams.get('mode') || 'email';
  const loginHint   = searchParams.get('loginHint') || '';
  const department  = searchParams.get('department') || '';
  const state       = Buffer.from(JSON.stringify({ spaceKey, returnUrl, mode, loginHint, department, ts: Date.now() })).toString('base64url');

  return NextResponse.redirect(getMicrosoftAuthUrl(redirectUri, state, loginHint));
}
