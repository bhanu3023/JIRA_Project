/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Restarts all IMAP pollers from the email_configs DB table so emails
 * continue to create tickets after a server restart.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Small delay so the DB pool is ready
  await new Promise(res => setTimeout(res, 3000));

  try {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5432/neutara_db',
    });

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_configs (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        space_key TEXT NOT NULL, address TEXT NOT NULL,
        imap_host TEXT NOT NULL DEFAULT 'outlook.office365.com', imap_port INT NOT NULL DEFAULT 993,
        smtp_host TEXT NOT NULL DEFAULT 'smtp.office365.com',   smtp_port INT NOT NULL DEFAULT 587,
        password_enc TEXT, auto_reply BOOLEAN DEFAULT true,
        auto_reply_text TEXT, department TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(space_key, address)
      )
    `).catch(() => {});
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});

    const rows = await pool.query(
      `SELECT id, space_key, address, imap_host, imap_port, smtp_host, smtp_port, password_enc, auto_reply, auto_reply_text, department FROM email_configs`
    );
    await pool.end();

    if (rows.rows.length === 0) {
      console.log('[Startup] No email configs in DB — skipping poller init');
      return;
    }

    const { startImapPoller } = await import('@/lib/email-service');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
    const webhookUrl = `${appUrl}/api/email/receive`;

    for (const row of rows.rows) {
      if (!row.password_enc) {
        console.log(`[Startup] Skipping ${row.address} — no password stored (OAuth-only)`);
        continue;
      }
      try {
        const config = {
          imap: {
            host: row.imap_host,
            port: row.imap_port || 993,
            secure: true,
            user: row.address,
            password: row.password_enc,
          },
          smtp: {
            host: row.smtp_host,
            port: row.smtp_port || 587,
            secure: false,
            user: row.address,
            password: row.password_enc,
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
              from: email.from,
              to: email.to,
              cc: email.cc,
              subject: email.subject,
              body: email.body,
              messageId: email.messageId,
              inReplyTo: email.inReplyTo,
              references: email.references,
              attachments: email.attachments,
            }),
          }).catch(err => console.error('[Startup poller] Webhook error:', err));
        });

        console.log(`[Startup] Started IMAP poller for ${row.address} → space ${row.space_key}${row.department ? ` (dept: ${row.department})` : ''}`);
      } catch (err) {
        console.error(`[Startup] Failed to start poller for ${row.address}:`, err);
      }
    }

    console.log(`[Startup] Restored ${rows.rows.length} email poller(s) from DB`);
  } catch (err) {
    console.error('[Startup] Email poller init failed:', err);
  }
}
