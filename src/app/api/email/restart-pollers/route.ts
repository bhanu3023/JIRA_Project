/**
 * POST /api/email/restart-pollers
 * Reads all configs from email_configs DB and restarts any stopped pollers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { startImapPoller, isPollerActiveForEmail } from '@/lib/email-service';

export const runtime = 'nodejs';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5432/neutara_db';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const targetAddress = body.address ? String(body.address).toLowerCase() : null;

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
    if (!row.password_enc) {
      results.push({ address: row.address, status: 'skipped (OAuth — no stored password)' });
      continue;
    }

    // Skip if already running
    if (!targetAddress && isPollerActiveForEmail(row.address)) {
      results.push({ address: row.address, status: 'already running' });
      continue;
    }

    try {
      const config = {
        imap: { host: row.imap_host, port: row.imap_port || 993, secure: true, user: row.address, password: row.password_enc },
        smtp: { host: row.smtp_host, port: row.smtp_port || 587, secure: false, user: row.address, password: row.password_enc },
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

      results.push({ address: row.address, status: 'started' });
      console.log(`[RestartPollers] Started poller for ${row.address} → space ${row.space_key}`);
    } catch (err: any) {
      results.push({ address: row.address, status: `error: ${err.message}` });
    }
  }

  const started = results.filter(r => r.status === 'started').length;
  return NextResponse.json({ ok: true, started, results });
}
