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
    const mode = searchParams.get('mode') || 'email';
    if (mode === 'login') {
      return NextResponse.redirect(
        new URL('/auth/login?oauth_error=MICROSOFT_CLIENT_ID+is+not+configured', req.url)
      );
    }
    const base = returnUrl.includes('?') ? returnUrl : `${returnUrl}?tab=email`;
    return NextResponse.redirect(
      new URL(`${base}&oauth_error=MICROSOFT_CLIENT_ID+is+not+configured+in+.env.local`, req.url)
    );
  }

  // Always use the configured public URL for redirectUri — must match Azure AD exactly.
  // Never compute from request headers (x-forwarded-host can differ between proxy layers).
  const appUrl      = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://neutaraticketing.cftools.live').replace(/\/$/, '');
  const redirectUri = `${appUrl}/api/auth/oauth/microsoft/callback`;
  const mode        = searchParams.get('mode') || 'email';
  const loginHint   = searchParams.get('loginHint') || '';
  const department  = searchParams.get('department') || '';
  // See the senderOnly comment in the callback route: refreshes this
  // account's OAuth token for outbound Graph sending without also
  // (re-)registering it as an inbound Connected email account.
  const senderOnly  = searchParams.get('senderOnly') === 'true';
  const state       = Buffer.from(JSON.stringify({ spaceKey, returnUrl, mode, loginHint, department, senderOnly, ts: Date.now() })).toString('base64url');

  return NextResponse.redirect(getMicrosoftAuthUrl(redirectUri, state, loginHint, mode === 'login' ? 'login' : 'email'));
}
