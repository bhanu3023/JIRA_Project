// Standalone SMTP connectivity/auth test -- bypasses the app's notification
// pipeline entirely (no 10-minute failure cooldown, no OAuth fallback, no
// dependency on triggering a real ticket action). Uses the exact same
// EMAIL_USER/EMAIL_PASSWORD/SMTP_* env vars the running app uses.
//
// Usage:
//   node test-smtp.mjs                          # just verify login (no email sent)
//   node test-smtp.mjs you@example.com           # also send a real test email

import nodemailer from 'nodemailer';

const user = process.env.EMAIL_USER;
const password = process.env.EMAIL_PASSWORD;
const host = process.env.SMTP_HOST || 'smtp.office365.com';
const port = parseInt(process.env.SMTP_PORT || '587');
const secure = process.env.SMTP_SECURE === 'true';

console.log(`Testing SMTP as: ${user}`);
console.log(`Host: ${host}:${port}  secure=${secure}`);

if (!user || !password) {
  console.error('EMAIL_USER or EMAIL_PASSWORD is not set in this process -- nothing to test.');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass: password },
  tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
});

try {
  await transporter.verify();
  console.log('LOGIN OK -- SMTP authentication succeeded.');
} catch (e) {
  console.error('LOGIN FAILED:', e.message);
  console.error(e);
  process.exit(1);
}

const sendTo = process.argv[2];
if (sendTo) {
  try {
    const info = await transporter.sendMail({
      from: `"SMTP Test" <${user}>`,
      to: sendTo,
      subject: 'Neutara Ticketing SMTP test',
      text: 'If you received this, SMTP is working correctly.',
    });
    console.log('SEND OK:', info.messageId);
  } catch (e) {
    console.error('SEND FAILED:', e.message);
    console.error(e);
    process.exit(1);
  }
} else {
  console.log('(no recipient given -- skipped actually sending an email, login check only)');
}
