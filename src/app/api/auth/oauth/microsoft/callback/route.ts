/**
 * GET /api/auth/oauth/microsoft/callback
 * Microsoft redirects here after the user picks an account.
 *
 * Two modes (determined by state.mode):
 *   "login"  — authenticate the user, set JWT, redirect to dashboard
 *   "email"  — connect email/IMAP for a space (original behaviour)
 */
import { NextRequest, NextResponse } from 'next/server';
import { exchangeMicrosoftCode, storeOAuthTokens } from '@/lib/oauth-service';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

function makeToken(userId: string, extra?: { email?: string; firstName?: string; lastName?: string; avatarUrl?: string }): string {
  const jwt    = require('jsonwebtoken');
  const crypto = require('crypto');
  const SECRET  = process.env.JWT_SECRET || 'NeutaraTech_SecureKey_2024_ab12f83079d8cadd0eb5678dc3d6aca6a5f65ed4d21646496093895b2ab4edfc';
  const TTL     = 24 * 30; // hours -- keep the session alive for 30 days, matching Jira's behavior of not forcing re-login on every visit
  const payload = { sub: userId, ...extra, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TTL * 3600 };
  const token   = jwt.sign(payload, SECRET, { algorithm: 'HS256' });
  // persist session (non-blocking)
  const hash    = crypto.createHash('sha256').update(token).digest('hex');
  const exp     = new Date(Date.now() + TTL * 3600 * 1000);
  db.$executeRawUnsafe(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING`,
    hash, userId, exp
  ).catch(() => {});
  return token;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state') || '';
  const error = searchParams.get('error');

  // Always use the configured public URL for redirectUri — must match Azure AD exactly.
  // Never compute from request headers (x-forwarded-host can differ between proxy layers).
  const appUrl       = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://neutaraticketing.cftools.live').replace(/\/$/, '');
  // For internal server→server fetches use localhost (reachable within Docker network)
  const internalPort = process.env.PORT || '3000';
  const internalBase = `http://localhost:${internalPort}`;

  // Decode state
  let spaceKey   = 'INFRA';
  let returnUrl  = `/spaces/INFRA/settings?tab=email`;
  let mode       = 'email'; // 'login' | 'email'
  let department = '';
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
    spaceKey   = parsed.spaceKey   || spaceKey;
    returnUrl  = parsed.returnUrl  || returnUrl;
    mode       = parsed.mode       || mode;
    department = parsed.department || '';
  } catch {}

  const failUrl = `${appUrl}${mode === 'login' ? '/auth/login' : returnUrl}?oauth_error=${encodeURIComponent(error || 'unknown_error')}`;
  if (error || !code) return NextResponse.redirect(failUrl);

  // redirectUri must match what was registered in Azure AD
  const redirectUri = `${appUrl}/api/auth/oauth/microsoft/callback`;
  console.log(`[OAuthCallback] mode=${mode} redirectUri=${redirectUri}`);
  const result = await exchangeMicrosoftCode(code, redirectUri, mode === 'login' ? 'login' : 'email');
  if (!result) {
    console.error(`[OAuthCallback] exchangeMicrosoftCode returned null for mode=${mode} redirectUri=${redirectUri}`);
    return NextResponse.redirect(`${appUrl}/auth/login?oauth_error=token_exchange_failed&debug_uri=${encodeURIComponent(redirectUri)}`);
  }

  // ── LOGIN MODE: look up user directly in DB, mint JWT locally ─────────────
  if (mode === 'login') {
    const rawEmail = result.email.toLowerCase().trim();
    const crypto = require('crypto');
    const devId = crypto.createHash('sha256').update(rawEmail).digest('hex').slice(0, 24);
    const nameParts = (result.name || rawEmail.split('@')[0]).split(' ');
    // Do NOT include avatarUrl in the JWT — profile photos are 100-200KB base64
    // which makes the JWT enormous and breaks the redirect URL (missing_token error).
    const devTokenExtras = {
      email: rawEmail,
      firstName: nameParts[0] || rawEmail.split('@')[0],
      lastName: nameParts.slice(1).join(' ') || '',
    };

    try {
      let user = await db.user.findUnique({ where: { email: rawEmail } });
      if (!user) {
        const localPart = rawEmail.split('@')[0];
        const candidates = await db.user.findMany({ where: { email: { startsWith: localPart + '@' } }, take: 1 });
        user = candidates[0] ?? null;
      }
      // Activate invited user on first Microsoft login + update avatar (both non-blocking)
      if (user && !user.isActive) {
        db.$executeRawUnsafe(
          `UPDATE users SET "isActive"=true, status='active' WHERE id=$1`,
          user.id
        ).catch(() => {});
        user = { ...user, isActive: true };
      }
      if (user && result.avatarUrl) {
        db.$executeRawUnsafe(`UPDATE users SET "avatarUrl" = $1 WHERE id = $2`, result.avatarUrl, user.id).catch(() => {});
      }
      if (!user && process.env.NODE_ENV === 'development') {
        // DB is up but user not found — still allow login locally with real identity
        const token = makeToken(devId, devTokenExtras);
        return NextResponse.redirect(
          `${appUrl}/auth/oauth-callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(returnUrl || '/dashboard')}`
        );
      }
      if (!user) {
        const msg = encodeURIComponent(`No account found for ${rawEmail}. Contact your administrator.`);
        return NextResponse.redirect(`${appUrl}/auth/login?oauth_error=${msg}`);
      }
      const token = makeToken(user.id, devTokenExtras);
      return NextResponse.redirect(
        `${appUrl}/auth/oauth-callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(returnUrl || '/dashboard')}`
      );
    } catch (e: any) {
      console.error('[OAuthCallback] Login error:', e);
      // DB unreachable — fall back to identity-only token in dev
      if (process.env.NODE_ENV === 'development') {
        const token = makeToken(devId, devTokenExtras);
        return NextResponse.redirect(
          `${appUrl}/auth/oauth-callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(returnUrl || '/dashboard')}`
        );
      }
      return NextResponse.redirect(`${appUrl}/auth/login?oauth_error=server_error`);
    }
  }

  // ── EMAIL MODE: register address + start IMAP poller ─────────────────────
  storeOAuthTokens(result.email, { ...result.tokens, spaceKey });

  try {
    await fetch(`${internalBase}/api/email-addresses/${spaceKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address: result.email, requestType: 'Emailed request', isReplyTo: false, autoReply: true }),
    });
  } catch {}

  try {
    const connectRes = await fetch(`${internalBase}/api/email/connect`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email: result.email, oauthAccessToken: result.tokens.accessToken,
        oauthRefreshToken: result.tokens.refreshToken, oauthProvider: 'microsoft',
        imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com',
        spaceKey, department: department || undefined, autoReply: true, appUrl: internalBase,
      }),
    });
    const cd = await connectRes.json().catch(() => ({}));
    console.log(`[OAuthCallback] Email connect ${result.email} → ${spaceKey}:`, (cd as any)?.ok, (cd as any)?.message || (cd as any)?.error);
  } catch (e) {
    console.error(`[OAuthCallback] Failed to start poller for ${result.email}:`, e);
  }

  fetch(`${internalBase}/api/email/reconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});

  const successUrl = `${appUrl}${returnUrl}${returnUrl.includes('?') ? '&' : '?'}oauth_success=1&oauth_email=${encodeURIComponent(result.email)}&oauth_name=${encodeURIComponent(result.name || '')}`;
  return NextResponse.redirect(successUrl);
}
