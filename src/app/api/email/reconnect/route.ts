/**
 * POST /api/email/reconnect
 * Reads all stored OAuth tokens and restarts IMAP pollers for any email
 * that has a token but no active poller. Called automatically on page load.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAllOAuthEmails, getValidAccessToken, getOAuthTokens, reloadTokensFromDisk } from '@/lib/oauth-service';
import { startImapPoller, isPollerActiveForEmail } from '@/lib/email-service';
import { registerEmailAddress } from '@/lib/jira-dev-mock';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
  const webhookUrl = `${appUrl}/api/email/receive`;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const spaceKeyHint = String(body.spaceKey || '').toUpperCase();

  // Sync in-memory token store from disk (picks up spaceKey and other updates)
  reloadTokensFromDisk();

  // Ensure persistent processed_emails table exists and pre-load all processed message IDs
  try {
    const { pgPool: pool } = await import('@/lib/pg-pool');

    // Create the table if it doesn't exist (survives ticket deletions)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_emails (
        message_id TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Also backfill any existing emailthreadids not yet in the table
    await pool.query(`
      INSERT INTO processed_emails (message_id)
      SELECT "emailthreadid" FROM issues WHERE "emailthreadid" IS NOT NULL
      ON CONFLICT (message_id) DO NOTHING
    `);

    // Load ALL processed message IDs from the dedicated table
    const res = await pool.query(`SELECT message_id FROM processed_emails`);

    // Always REPLACE the in-memory set with the DB contents so any emails that
    // failed (webhook returned ok:false) and were wrongly added to in-memory
    // get a fresh retry on the next poll cycle.
    const processedIds: Set<string> = new Set();
    res.rows.forEach((r: any) => { if (r.message_id) processedIds.add(r.message_id); });
    (globalThis as any).__processedMsgIds = processedIds;
    (globalThis as any).__processedMsgIdsLoaded = true;
    console.log(`[Reconnect] Reloaded ${processedIds.size} processed message IDs from DB (in-memory reset)`);
  } catch (e) { console.error('[Reconnect] Failed to pre-load processed IDs:', e); }

  const emails = getAllOAuthEmails();
  const started: string[] = [];

  // Process mailboxes in bounded-concurrency batches instead of one at a
  // time. getValidAccessToken() below does a real network round trip to
  // Microsoft's OAuth endpoint whenever a token needs refreshing — several
  // accounts are permanently stuck in a consent-required failure state, so
  // they retry that full round trip on every single call. Awaiting 35+ of
  // these sequentially could take tens of seconds, all while this request
  // (fired automatically on every page's first load per session, see
  // RootLayoutClient) holds open DB connections that compete with whatever
  // page the user actually just loaded (e.g. the Filters page's own query).
  const RECONNECT_CONCURRENCY = 6;
  async function processInBatches<T>(items: T[], worker: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += RECONNECT_CONCURRENCY) {
      await Promise.all(items.slice(i, i + RECONNECT_CONCURRENCY).map(worker));
    }
  }

  await processInBatches(emails, async (email) => {
    const tokens = getOAuthTokens(email);
    if (!tokens) return;

    // Determine spaceKey: hint → stored in token → derive from email prefix
    const prefix = email.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const spaceKey = spaceKeyHint || tokens.spaceKey || prefix;

    // Always re-register the email address directly in the mock store (no auth needed)
    registerEmailAddress(email, spaceKey, { autoReply: true });

    // Skip if already running with the correct spaceKey
    if (isPollerActiveForEmail(email)) {
      console.log(`[Reconnect] Poller already active for ${email} → space ${spaceKey}`);
      return;
    }

    try {
      const accessToken = await getValidAccessToken(email);
      if (!accessToken) return;

      startImapPoller(
        {
          imap: {
            host: tokens.provider === 'google' ? 'imap.gmail.com' : 'outlook.office365.com',
            port: 993,
            secure: true,
            user: email,
            password: '',
            oauthAccessToken:  accessToken,
            oauthRefreshToken: tokens.refreshToken,
            oauthProvider:     tokens.provider,
          },
          smtp: {
            host: tokens.provider === 'google' ? 'smtp.gmail.com' : 'smtp.office365.com',
            port: tokens.provider === 'google' ? 587 : 587,
            secure: false,
            user: email,
            password: '',
            oauthAccessToken: accessToken,
          },
          spaceKey,
          address: email,
          autoReply: true,
          autoReplyText: 'Thank you for contacting us. We have received your request and will get back to you shortly.',
          webhookUrl,
        },
        async (parsedEmail) => {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: parsedEmail.from, to: parsedEmail.to, cc: parsedEmail.cc,
              subject: parsedEmail.subject, body: parsedEmail.body,
              messageId: parsedEmail.messageId, inReplyTo: parsedEmail.inReplyTo,
              references: parsedEmail.references, attachments: parsedEmail.attachments,
            }),
          }).catch(() => {});
        }
      );

      started.push(email);
      console.log(`[Reconnect] Started poller for ${email} → space ${spaceKey}`);
    } catch (err) {
      console.error(`[Reconnect] Failed for ${email}:`, err);
    }
  });

  // ── Load ALL boards' email configs from DB and restart any missing pollers ──
  try {
    const { pgPool: pool2 } = await import('@/lib/pg-pool');

    // Ensure table exists (in case it was never created yet)
    await pool2.query(`
      CREATE TABLE IF NOT EXISTS email_configs (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        space_key       TEXT NOT NULL,
        address         TEXT NOT NULL,
        imap_host       TEXT NOT NULL DEFAULT 'outlook.office365.com',
        imap_port       INT  NOT NULL DEFAULT 993,
        smtp_host       TEXT NOT NULL DEFAULT 'smtp.office365.com',
        smtp_port       INT  NOT NULL DEFAULT 587,
        password_enc    TEXT,
        auto_reply      BOOLEAN DEFAULT true,
        auto_reply_text TEXT DEFAULT 'Thank you for contacting us. We have received your request and will get back to you shortly.',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(space_key, address)
      )
    `);

    const dbResult = await pool2.query('SELECT * FROM email_configs ORDER BY created_at');

    // Same bounded-concurrency treatment as the loop above — each row can
    // also trigger a real OAuth token refresh network call.
    await processInBatches(dbResult.rows, async (row: any) => {
      const emailAddr: string = row.address;

      // Skip if already running
      if (isPollerActiveForEmail(emailAddr)) {
        console.log(`[Reconnect] DB poller already active for ${emailAddr} → space ${row.space_key}`);
        return;
      }

      // Try to get OAuth token first
      let accessToken: string | undefined;
      let oauthProvider: string | undefined;
      let refreshToken: string | undefined;
      try {
        const { getValidAccessToken: gvat, getOAuthTokens: got } = await import('@/lib/oauth-service');
        const stored = got(emailAddr);
        if (stored) {
          accessToken   = await gvat(emailAddr) ?? stored.accessToken ?? undefined;
          oauthProvider = stored.provider;
          refreshToken  = stored.refreshToken;
        }
      } catch {}

      const hasPassword = !!(row.password_enc);
      if (!accessToken && !hasPassword) {
        console.log(`[Reconnect] No credentials for ${emailAddr} — skipping`);
        return;
      }

      const isOAuth = !!accessToken;

      // Re-register in mock store
      registerEmailAddress(emailAddr, row.space_key, { autoReply: row.auto_reply });

      startImapPoller(
        {
          imap: {
            host:              row.imap_host,
            port:              row.imap_port,
            secure:            true,
            user:              emailAddr,
            password:          isOAuth ? '' : (row.password_enc || ''),
            oauthAccessToken:  accessToken,
            oauthRefreshToken: refreshToken,
            oauthProvider:     oauthProvider as any,
          },
          smtp: {
            host:             row.smtp_host,
            port:             row.smtp_port,
            secure:           false,
            user:             emailAddr,
            password:         isOAuth ? '' : (row.password_enc || ''),
            oauthAccessToken: accessToken,
          },
          spaceKey:      row.space_key,
          address:       emailAddr,
          autoReply:     row.auto_reply,
          autoReplyText: row.auto_reply_text,
          webhookUrl,
        },
        async (parsedEmail) => {
          await fetch(webhookUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: parsedEmail.from, to: parsedEmail.to, cc: parsedEmail.cc,
              subject: parsedEmail.subject, body: parsedEmail.body,
              messageId: parsedEmail.messageId, inReplyTo: parsedEmail.inReplyTo,
              references: parsedEmail.references, attachments: parsedEmail.attachments,
            }),
          }).catch(() => {});
        }
      );

      started.push(emailAddr);
      console.log(`[Reconnect] ✅ Started DB-configured poller for ${emailAddr} → space ${row.space_key}`);
    });
  } catch (e) {
    console.error('[Reconnect] Failed to load DB email configs:', e);
  }

  return NextResponse.json({ ok: true, started, total: emails.length });
}

export async function GET() {
  const emails = getAllOAuthEmails();
  return NextResponse.json({ oauthEmails: emails });
}
