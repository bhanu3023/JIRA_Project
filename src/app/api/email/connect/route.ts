/**
 * POST /api/email/connect   — test + start real IMAP polling
 * GET  /api/email/connect   — check connection status
 * DELETE /api/email/connect — stop polling
 */

import { NextRequest, NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';
import {
  startImapPoller,
  stopImapPoller,
  stopImapPollerForEmail,
  testImapConnection,
  testSmtpConnection,
  getEmailConfigFromEnv,
  getActivePollers,
  isPollerActiveForEmail,
  type EmailConfig,
} from '@/lib/email-service';


export const runtime = 'nodejs';

export async function GET() {
  const config = getEmailConfigFromEnv();
  const activePollers = getActivePollers();
  return NextResponse.json({
    configured:    !!config,
    pollerActive:  activePollers.length > 0,
    activePollers, // [{email, spaceKey}, ...]
    address:       config?.address   || null,
    spaceKey:      config?.spaceKey  || null,
    imapHost:      config?.imap.host || null,
    smtpHost:      config?.smtp.host || null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  // "app_only" — no per-mailbox sign-in or password at all. Uses the
  // tenant-wide Graph client-credentials token (see getGraphAppOnlyToken in
  // oauth-service.ts), which requires the Azure app registration to have
  // admin-consented Application permissions (Mail.Read/Mail.Send) and
  // MICROSOFT_TENANT_ID configured — real prerequisites this endpoint can't
  // satisfy on its own, so a config can be saved here even before they're in
  // place; the poller just logs and skips until the token becomes available.
  const isAppOnly = body.authMode === 'app_only';

  // If no access token provided but email is known, look it up from the OAuth store
  let resolvedAccessToken  = body.oauthAccessToken  as string | undefined;
  let resolvedRefreshToken = body.oauthRefreshToken as string | undefined;
  let resolvedProvider     = body.oauthProvider     as string | undefined;
  if (!isAppOnly && !resolvedAccessToken && body.email) {
    try {
      const { getValidAccessToken, getOAuthTokens } = await import('@/lib/oauth-service');
      const stored = getOAuthTokens(String(body.email));
      if (stored) {
        resolvedAccessToken  = await getValidAccessToken(String(body.email)) ?? stored.accessToken;
        resolvedRefreshToken = stored.refreshToken;
        resolvedProvider     = stored.provider;
      }
    } catch {}
  }

  const isOAuth = !!(resolvedAccessToken);

  const config: EmailConfig = {
    imap: {
      host:         body.imapHost   || process.env.IMAP_HOST     || 'imap.gmail.com',
      port:         parseInt(body.imapPort || process.env.IMAP_PORT || '993'),
      secure:       body.imapSecure ?? (process.env.IMAP_SECURE  !== 'false'),
      user:         body.email      || process.env.EMAIL_USER     || '',
      password:          (isOAuth || isAppOnly) ? '' : (body.password || process.env.EMAIL_PASSWORD || ''),
      oauthAccessToken:  resolvedAccessToken  || undefined,
      oauthRefreshToken: resolvedRefreshToken || undefined,
      oauthProvider:     resolvedProvider     as any || undefined,
      appOnly:           isAppOnly || undefined,
    },
    smtp: {
      host:     body.smtpHost   || process.env.SMTP_HOST     || 'smtp.gmail.com',
      port:     parseInt(body.smtpPort || process.env.SMTP_PORT || '587'),
      secure:   body.smtpSecure ?? (process.env.SMTP_SECURE  === 'true'),
      user:     body.email      || process.env.EMAIL_USER     || '',
      password: (isOAuth || isAppOnly) ? '' : (body.password || process.env.EMAIL_PASSWORD || ''),
      oauthAccessToken: resolvedAccessToken || undefined,
      appOnly:          isAppOnly || undefined,
    },
    spaceKey:      body.spaceKey      || process.env.EMAIL_SPACE_KEY || 'INFRA',
    address:       body.email         || process.env.EMAIL_USER      || '',
    autoReply:     body.autoReply     ?? true,
    autoReplyText: body.autoReplyText || 'Thank you for contacting us. We have received your request and will get back to you shortly.',
    webhookUrl:    `${body.appUrl || 'http://localhost:8080'}/api/email/receive`,
  };

  if (!config.imap.user) {
    return NextResponse.json({ ok: false, error: 'Email address is required.' }, { status: 400 });
  }
  if (!isOAuth && !isAppOnly && !config.imap.password) {
    return NextResponse.json({ ok: false, error: 'Password is required (or use OAuth).' }, { status: 400 });
  }

  // testOnly=true: verify credentials and return without saving or starting poller
  if (body.testOnly) {
    if (isAppOnly) {
      const { getGraphAppOnlyToken } = await import('@/lib/oauth-service');
      const token = await getGraphAppOnlyToken();
      if (!token) {
        return NextResponse.json({ ok: false, error: 'App-only access isn\'t set up yet — needs MICROSOFT_TENANT_ID and admin-consented Application permissions (Mail.Read) in Azure AD.' });
      }
      // A token can be issued successfully even with zero Application
      // permissions actually granted (client-credentials doesn't fail just
      // because the scope ended up empty) — the "roles" claim in the token
      // itself is the only reliable way to tell whether admin consent for
      // Mail.Read really took effect, vs. was only added-but-not-consented
      // or added as the wrong (Delegated) permission type.
      let hasMailRead = false;
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        hasMailRead = (payload.roles || []).some((r: string) => r === 'Mail.Read' || r === 'Mail.ReadWrite');
      } catch {}
      if (!hasMailRead) {
        return NextResponse.json({ ok: false, error: 'Token issued, but it has no Mail.Read permission on it. In Azure AD, check the app\'s API permissions: Mail.Read/Mail.Send need to be under "Application" (not "Delegated"), with admin consent actually clicked — it must say "Granted for cloudfuze.com".' });
      }
      // Confirm this specific mailbox actually resolves — a plain
      // Distribution List has no inbox at all and will 404 here no matter
      // how correct the permissions are.
      const mbRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.imap.user)}/mailFolders/Inbox`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!mbRes.ok) {
        return NextResponse.json({ ok: false, error: `"${config.imap.user}" isn't a real mailbox Graph can read (${mbRes.status}). If this is a plain Distribution List, it has no inbox — ask IT to convert it to a Shared Mailbox (same address) first.` });
      }
      return NextResponse.json({ ok: true, message: 'Tenant app-only access works for this mailbox.' });
    }
    if (isOAuth) return NextResponse.json({ ok: true, message: 'OAuth token is valid.' });
    const imapTest = await testImapConnection(config.imap);
    if (!imapTest.ok) {
      return NextResponse.json({ ok: false, error: imapTest.error || 'IMAP connection failed. Check credentials.' });
    }
    return NextResponse.json({ ok: true, message: `Connected to ${config.imap.host}. ${imapTest.unread ?? 0} unread emails found.`, unread: imapTest.unread });
  }

  // For OAuth/app-only connections, skip IMAP/SMTP tests (handled by their own token
  // paths). For password connections we also skip hard-failing — Microsoft 365 has
  // disabled basic auth for IMAP so the test always fails even with valid credentials.
  // The poller itself will handle connection retries gracefully once started.
  let unreadCount = 0;
  if (!isOAuth && !isAppOnly && process.env.SKIP_IMAP_TEST !== 'false') {
    const imapTest = await testImapConnection(config.imap);
    if (imapTest.ok) {
      unreadCount = imapTest.unread ?? 0;
      // Only test SMTP if IMAP passed
      await testSmtpConnection(config.smtp);
    }
    // Do NOT hard-fail — just log and continue starting the poller
    if (!imapTest.ok) {
      console.warn(`[EmailConnect] IMAP pre-test failed for ${config.imap.user}: ${imapTest.error} — starting poller anyway`);
    }
  }

  const webhookUrl = config.webhookUrl;

  startImapPoller(config, async (email) => {
    // Forward to our webhook — includes all threading headers
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:        email.from,
        to:          email.to,
        cc:          email.cc,
        subject:     email.subject,
        body:        email.body,
        messageId:   email.messageId,
        inReplyTo:   email.inReplyTo,
        references:  email.references,
        attachments: email.attachments,
      }),
    });
  });

  // Persist config to DB so it survives server restarts
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_configs (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        space_key    TEXT NOT NULL,
        address      TEXT NOT NULL,
        imap_host    TEXT NOT NULL DEFAULT 'outlook.office365.com',
        imap_port    INT  NOT NULL DEFAULT 993,
        smtp_host    TEXT NOT NULL DEFAULT 'smtp.office365.com',
        smtp_port    INT  NOT NULL DEFAULT 587,
        password_enc TEXT,
        auto_reply   BOOLEAN DEFAULT true,
        auto_reply_text TEXT DEFAULT 'Thank you for contacting us. We have received your request and will get back to you shortly.',
        department   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(space_key, address)
      )
    `);
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`);
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS auth_mode TEXT DEFAULT 'password'`);
    const dept = body.department || (config as any).department || null;
    await pool.query(`
      INSERT INTO email_configs (space_key, address, imap_host, imap_port, smtp_host, smtp_port, password_enc, auto_reply, auto_reply_text, department, auth_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (space_key, address) DO UPDATE SET
        imap_host=EXCLUDED.imap_host, smtp_host=EXCLUDED.smtp_host,
        imap_port=EXCLUDED.imap_port, smtp_port=EXCLUDED.smtp_port,
        password_enc=EXCLUDED.password_enc, auto_reply=EXCLUDED.auto_reply,
        auto_reply_text=EXCLUDED.auto_reply_text,
        department=EXCLUDED.department,
        auth_mode=EXCLUDED.auth_mode
    `, [
      config.spaceKey, config.address,
      config.imap.host, config.imap.port,
      config.smtp.host, config.smtp.port,
      isOAuth ? null : (config.imap.password || null),
      config.autoReply, config.autoReplyText, dept,
      isAppOnly ? 'app_only' : (isOAuth ? 'oauth' : 'password'),
    ]);
    console.log(`[EmailConnect] Saved config for ${config.address} → space ${config.spaceKey}`);
  } catch (e) {
    console.error('[EmailConnect] Failed to persist email config to DB:', e);
  }

  // app_only is always SAVED above regardless of whether it's actually
  // ready yet (the user asked for "add it, I'll deal with whether it works
  // separately" instead of this call refusing to save on a failed check) —
  // but still worth telling them up front if tickets won't actually start
  // flowing, instead of a silent "Connected!" that isn't true yet. Best
  // effort only: never fails the save itself.
  let warning: string | undefined;
  if (isAppOnly) {
    try {
      const { getGraphAppOnlyToken } = await import('@/lib/oauth-service');
      const token = await getGraphAppOnlyToken();
      if (!token) {
        warning = 'Saved, but tenant app-only access isn\'t set up yet (missing MICROSOFT_TENANT_ID or Azure admin consent) — no tickets will trigger until that\'s fixed.';
      } else {
        const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        const hasMailRead = (payload.roles || []).some((r: string) => r === 'Mail.Read' || r === 'Mail.ReadWrite');
        if (!hasMailRead) {
          warning = 'Saved, but the Azure app doesn\'t have Mail.Read as an Application permission with admin consent yet — no tickets will trigger until that\'s granted.';
        } else {
          const mbRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.imap.user)}/mailFolders/Inbox`, { headers: { Authorization: `Bearer ${token}` } });
          if (!mbRes.ok) {
            warning = `Saved, but "${config.imap.user}" isn't a real mailbox Graph can read (${mbRes.status}) — if it's a plain Distribution List, ask IT to convert it to a Shared Mailbox first.`;
          }
        }
      }
    } catch (e: any) {
      warning = `Saved, but couldn't verify readiness: ${e?.message || e}`;
    }
  }

  return NextResponse.json({
    ok: true,
    message: `Connected! Polling ${config.imap.user} every 30 seconds for space ${config.spaceKey}.`,
    unread:        unreadCount,
    address:       config.address,
    spaceKey:      config.spaceKey,
    activePollers: getActivePollers(),
    warning,
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email');
  if (email) {
    stopImapPollerForEmail(email);
    // Remove from DB
    try {
      await pool.query('DELETE FROM email_configs WHERE address = $1', [email]);
    } catch (e) {
      console.error('[EmailConnect] Failed to delete email config from DB:', e);
    }
    return NextResponse.json({ ok: true, message: `Poller stopped for ${email}`, activePollers: getActivePollers() });
  }
  stopImapPoller();
  return NextResponse.json({ ok: true, message: 'All email pollers stopped.' });
}
