/**
 * POST /api/email/restart-pollers
 * Reads all configs from email_configs DB and restarts any stopped pollers.
 * Supports both password-based and OAuth-based (Microsoft/Google) connections.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { startImapPoller, isPollerActiveForEmail } from '@/lib/email-service';
import { getOAuthTokens, getValidAccessToken, storeOAuthTokens, type OAuthTokens } from '@/lib/oauth-service';

export const runtime = 'nodejs';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';

/** Load OAuth tokens directly from DB and merge into in-memory store */
async function loadOAuthTokensFromDB(): Promise<void> {
  try {
    const pool = new Pool({ connectionString: DB_URL });
    const rows = await pool.query(`SELECT email, tokens_json FROM oauth_tokens`).catch(() => ({ rows: [] as any[] }));
    await pool.end();
    for (const row of rows.rows) {
      try {
        const tokens = JSON.parse(row.tokens_json) as OAuthTokens;
        // Only load into memory if not already there (don't overwrite fresher in-memory tokens)
        if (!getOAuthTokens(row.email)) {
          storeOAuthTokens(row.email, tokens);
        }
      } catch {}
    }
    console.log(`[RestartPollers] Pre-loaded ${rows.rows.length} OAuth token(s) from DB`);
  } catch (e) {
    console.error('[RestartPollers] Failed to load OAuth tokens from DB:', e);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const targetAddress = body.address ? String(body.address).toLowerCase() : null;

  // Ensure OAuth tokens are in memory before we check them below.
  // This is critical on startup: the async DB load in oauth-service may not have
  // completed yet when instrumentation.ts calls us 5 seconds after boot.
  await loadOAuthTokensFromDB();

  const pool = new Pool({ connectionString: DB_URL });
  let rows: any[] = [];
  try {
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});
    const res = await pool.query(
      `SELECT id, space_key, address, imap_host, imap_port, smtp_host, smtp_port, password_enc, auto_reply, auto_reply_text, department FROM email_configs`
    );
    rows = res.rows;
  } finally {
    await pool.end();
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'No email configs found in DB' });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('host')}`;
  const webhookUrl = `${appUrl}/api/email/receive`;

  const results: { address: string; status: string }[] = [];

  for (const row of rows) {
    if (targetAddress && row.address.toLowerCase() !== targetAddress) continue;

    // Skip if already running (unless explicitly targeting this address)
    if (!targetAddress && isPollerActiveForEmail(row.address)) {
      results.push({ address: row.address, status: 'already running' });
      continue;
    }

    // Try OAuth tokens first (Microsoft/Google accounts have no stored password)
    let oauthAccessToken: string | undefined;
    let oauthRefreshToken: string | undefined;
    let oauthProvider: string | undefined;

    const stored = getOAuthTokens(row.address.toLowerCase());
    if (stored) {
      try {
        oauthAccessToken = await getValidAccessToken(row.address.toLowerCase()) ?? stored.accessToken;
        oauthRefreshToken = stored.refreshToken;
        oauthProvider = stored.provider || 'microsoft';
      } catch {}
    }

    const isOAuth = !!oauthAccessToken;

    if (!isOAuth && !row.password_enc) {
      results.push({ address: row.address, status: 'skipped — no password and no OAuth token stored' });
      continue;
    }

    // For Microsoft/Office365 OAuth accounts, always use the correct host
    const imapHost = isOAuth && (oauthProvider === 'microsoft' || row.imap_host?.includes('outlook'))
      ? 'outlook.office365.com'
      : (row.imap_host || 'imap.gmail.com');
    const smtpHost = isOAuth && (oauthProvider === 'microsoft' || row.smtp_host?.includes('office365'))
      ? 'smtp.office365.com'
      : (row.smtp_host || 'smtp.gmail.com');

    try {
      const config = {
        imap: {
          host: imapHost,
          port: row.imap_port || 993,
          secure: true,
          user: row.address,
          password: isOAuth ? '' : row.password_enc,
          oauthAccessToken: isOAuth ? oauthAccessToken : undefined,
          oauthRefreshToken: isOAuth ? oauthRefreshToken : undefined,
          oauthProvider: isOAuth ? oauthProvider as any : undefined,
        },
        smtp: {
          host: smtpHost,
          port: row.smtp_port || 587,
          secure: false,
          user: row.address,
          password: isOAuth ? '' : row.password_enc,
          oauthAccessToken: isOAuth ? oauthAccessToken : undefined,
        },
        spaceKey: row.space_key,
        address: row.address,
        autoReply: row.auto_reply ?? true,
        autoReplyText: row.auto_reply_text || 'Thank you for contacting us. We have received your request and will get back to you shortly.',
        webhookUrl,
      };

      startImapPoller(config, async (email) => {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: email.from, to: email.to, cc: email.cc,
            subject: email.subject, body: email.body,
            messageId: email.messageId, inReplyTo: email.inReplyTo,
            references: email.references, attachments: email.attachments,
          }),
        }).catch(() => {});
      });

      results.push({ address: row.address, status: isOAuth ? 'started (OAuth)' : 'started (password)' });
      console.log(`[RestartPollers] Started poller for ${row.address} → space ${row.space_key} via ${isOAuth ? 'OAuth' : 'password'}`);
    } catch (err: any) {
      results.push({ address: row.address, status: `error: ${err.message}` });
    }
  }

  const started = results.filter(r => r.status.startsWith('started')).length;
  return NextResponse.json({ ok: true, started, results });
}
