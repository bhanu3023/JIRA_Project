/**
 * POST /api/users/invite
 * Creates a user and sends them an invite email with a link to the login page.
 */
import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { pgPool as pool } from '@/lib/pg-pool';

export const runtime = 'nodejs';

let cachedAppUrl: string | null = null;
async function getAppUrl(): Promise<string> {
  if (cachedAppUrl) return cachedAppUrl;
  try {
    const res = await pool.query(`SELECT value FROM app_settings WHERE key = 'app_url'`);
    if (res.rows[0]?.value) {
      cachedAppUrl = res.rows[0].value.replace(/\/$/, '');
      return cachedAppUrl!;
    }
  } catch { /* fall through to env */ }
  cachedAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
  return cachedAppUrl;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      email: string;
      firstName: string;
      lastName: string;
      role: string;
      invitedBy?: string;
    };

    const { email, firstName, lastName, role, invitedBy } = body;
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });

    const APP_URL    = await getAppUrl();
    const FROM_EMAIL = process.env.EMAIL_USER;
    const FROM_PASS  = process.env.EMAIL_PASSWORD;
    const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'Neutara Technologies Ticketing';

    if (!FROM_EMAIL || !FROM_PASS) {
      return NextResponse.json({ ok: true, emailSent: false, reason: 'SMTP not configured' });
    }

    const smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const transporter = nodemailer.createTransport({
      host:   smtpHost,
      port:   smtpPort,
      secure: smtpPort === 465,
      auth:   { user: FROM_EMAIL, pass: FROM_PASS },
      tls:    { ciphers: 'SSLv3', rejectUnauthorized: false },
    });

    const loginUrl   = `${APP_URL}/auth/login`;
    const displayName = `${firstName || ''} ${lastName || ''}`.trim() || email;
    const inviterName = invitedBy || 'The Admin';

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">

    <!-- Header -->
    <div style="background:#0052CC;padding:20px 28px">
      <span style="color:white;font-size:20px;font-weight:bold">${FROM_NAME}</span>
    </div>

    <!-- Body -->
    <div style="padding:32px 28px">
      <h2 style="margin:0 0 8px;font-size:22px;color:#172B4D">You've been invited! 🎉</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6">
        Hi <strong>${displayName}</strong>,<br/><br/>
        <strong>${inviterName}</strong> has invited you to join <strong>${FROM_NAME}</strong>.
      </p>

      <p style="font-size:13px;color:#666;margin:0 0 20px">
        Click the button below to sign in with your Microsoft account:
      </p>

      <!-- CTA Button -->
      <a href="${loginUrl}"
         style="display:inline-block;background:#0052CC;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:0.2px">
        Sign in to Neutara →
      </a>

      <div style="margin-top:28px;padding:16px;background:#f8f9fa;border-radius:6px;border:1px solid #e8e8e8">
        <p style="margin:0;font-size:12px;color:#888">
          <strong>Sign in URL:</strong><br/>
          <a href="${loginUrl}" style="color:#0052CC;word-break:break-all">${loginUrl}</a>
        </p>
      </div>

      <p style="margin-top:20px;font-size:12px;color:#aaa">
        Use your <strong>Microsoft account</strong> (${email}) to sign in.<br/>
        If you have any issues, contact your administrator.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:14px 28px;background:#f4f5f7;border-top:1px solid #e8e8e8">
      <p style="margin:0;font-size:11px;color:#aaa">
        ${FROM_NAME} · ${APP_URL}<br/>
        This invite was sent to ${email}
      </p>
    </div>
  </div>
</body>
</html>`;

    // Fire-and-forget — return immediately, email sends in background
    transporter.sendMail({
      from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to:      email,
      subject: `You've been invited to ${FROM_NAME}`,
      html,
      text: `Hi ${displayName},\n\n${inviterName} has invited you to join ${FROM_NAME}.\n\nSign in here: ${loginUrl}\n\nUse your Microsoft account (${email}) to sign in.`,
    }).catch((err: unknown) => console.error('[Invite] Email send failed:', err));

    return NextResponse.json({ ok: true, emailSent: true });
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to send invite' }, { status: 500 });
  }
}
