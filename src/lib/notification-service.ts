/**
 * notification-service.ts
 *
 * Jira-style email notifications for all ticket events.
 *
 * Events (same as Jira):
 *  - Issue Created        → assignee + reporter
 *  - Issue Assigned       → new assignee
 *  - Status Changed       → assignee + reporter
 *  - Comment Added        → assignee + reporter (not the commenter)
 *  - Issue Updated        → assignee + reporter
 *  - Issue Resolved       → reporter
 *  - Issue Deleted        → assignee + reporter
 */

import nodemailer from 'nodemailer';

// ── SMTP transporter (singleton) ──────────────────────────────────────────────
let _transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const user     = process.env.EMAIL_USER;
  const password = process.env.EMAIL_PASSWORD;
  if (!user || !password) return null;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.office365.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user, pass: password },
    tls:    { ciphers: 'SSLv3', rejectUnauthorized: false },
  });
  return _transporter;
}

const FROM_EMAIL = process.env.EMAIL_USER || 'leo@fuzebot.io';
const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'CloudFuze Support';
const APP_URL    = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';

// ── Priority colors (same as Jira) ────────────────────────────────────────────
const PRIORITY_COLOR: Record<string, string> = {
  highest: '#FF0000',
  high:    '#FF7452',
  medium:  '#FF991F',
  low:     '#2684FF',
  lowest:  '#00B8D9',
};

const STATUS_COLOR: Record<string, string> = {
  todo:        '#64748B',
  in_progress: '#3B82F6',
  done:        '#10B981',
};

// ── Email HTML template ───────────────────────────────────────────────────────
function buildEmailHtml(opts: {
  title:      string;
  issueKey:   string;
  issueSummary: string;
  spaceKey:   string;
  spaceName:  string;
  eventLabel: string;
  eventColor: string;
  fields:     Array<{ label: string; value: string; color?: string }>;
  comment?:   string;
  actionUrl:  string;
}) {
  const fieldsHtml = opts.fields.map(f => `
    <tr>
      <td style="padding:6px 12px;color:#666;font-size:13px;width:130px;vertical-align:top;white-space:nowrap">${f.label}</td>
      <td style="padding:6px 12px;font-size:13px;color:${f.color || '#333'};font-weight:${f.color ? '600' : '400'}">${f.value || '—'}</td>
    </tr>`).join('');

  const commentHtml = opts.comment ? `
    <div style="margin:16px 0;padding:12px 16px;background:#f0f4ff;border-left:3px solid #3B82F6;border-radius:0 4px 4px 0">
      <p style="margin:0 0 4px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Comment</p>
      <p style="margin:0;font-size:14px;color:#333;white-space:pre-wrap">${opts.comment}</p>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">

    <!-- Header -->
    <div style="background:#0052CC;padding:16px 24px;display:flex;align-items:center">
      <span style="color:white;font-size:18px;font-weight:bold">${FROM_NAME}</span>
    </div>

    <!-- Event banner -->
    <div style="background:${opts.eventColor};padding:10px 24px">
      <span style="color:white;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${opts.eventLabel}</span>
    </div>

    <!-- Issue title -->
    <div style="padding:20px 24px 8px">
      <a href="${opts.actionUrl}" style="text-decoration:none">
        <span style="font-size:12px;color:#0052CC;font-weight:600">${opts.issueKey}</span>
        <h2 style="margin:4px 0 0;font-size:18px;color:#172B4D;line-height:1.3">${opts.issueSummary}</h2>
      </a>
      <p style="margin:4px 0 0;font-size:12px;color:#888">${opts.spaceName} (${opts.spaceKey})</p>
    </div>

    <!-- Fields table -->
    <div style="padding:8px 24px">
      <table style="width:100%;border-collapse:collapse">
        ${fieldsHtml}
      </table>
    </div>

    ${commentHtml}

    <!-- CTA button -->
    <div style="padding:16px 24px 24px">
      <a href="${opts.actionUrl}"
         style="display:inline-block;background:#0052CC;color:white;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600">
        View Issue →
      </a>
    </div>

    <!-- Footer -->
    <div style="padding:12px 24px;background:#f4f5f7;border-top:1px solid #e8e8e8">
      <p style="margin:0;font-size:11px;color:#888">
        You received this because you are the assignee or reporter of this issue.<br/>
        ${APP_URL}
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Get a Graph-Mail-scoped token from the stored refresh token ───────────────
// getValidAccessToken() returns an IMAP-scoped token (aud: outlook.office365.com)
// which cannot call graph.microsoft.com/sendMail (403). We must explicitly
// exchange the refresh token for a Graph-scoped token.
async function getGraphMailToken(email: string): Promise<string | null> {
  try {
    const { getOAuthTokens } = await import('@/lib/oauth-service');
    const tokens = getOAuthTokens(email);
    if (!tokens?.refreshToken) return null;
    const clientId     = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
        scope:         'https://graph.microsoft.com/Mail.Send offline_access email openid profile',
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[Notification] Graph token refresh failed for ${email}: ${res.status} ${err.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.access_token || null;
  } catch (e: any) {
    console.error('[Notification] getGraphMailToken error:', e?.message);
    return null;
  }
}

// ── Send via Microsoft Graph API (OAuth fallback when SMTP not configured) ─────
async function sendViaGraph(opts: { from: string; to: string[]; subject: string; html: string; text: string; inReplyTo?: string }) {
  try {
    const { getOAuthTokens } = await import('@/lib/oauth-service');
    const tokens = getOAuthTokens(opts.from);
    if (!tokens) return false;
    // Always get a Graph-Mail-scoped token — IMAP tokens (aud: outlook.office365.com)
    // cannot call graph.microsoft.com/sendMail and return 403.
    const accessToken = await getGraphMailToken(opts.from);
    if (!accessToken) return false;

    for (const recipient of opts.to) {
      const message: any = {
        subject: opts.subject,
        body: { contentType: 'HTML', content: opts.html },
        toRecipients: [{ emailAddress: { address: recipient } }],
      };
      // Thread the email into the original conversation
      if (opts.inReplyTo) {
        message.internetMessageHeaders = [
          { name: 'In-Reply-To', value: opts.inReplyTo },
          { name: 'References',  value: opts.inReplyTo },
        ];
      }
      const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: false }),
      });
      if (res.ok || res.status === 202) {
        console.log(`[Notification] Sent via Graph: ${opts.subject} → ${recipient}`);
      } else {
        const err = await res.text().catch(() => '');
        console.error(`[Notification] Graph send failed for ${recipient}: ${res.status} ${err.slice(0, 200)}`);
      }
    }
    return true;
  } catch (e: any) {
    console.error('[Notification] Graph send error:', e?.message);
    return false;
  }
}

// ── Find best sender email (any connected OAuth account) ───────────────────────
async function getBestSenderEmail(): Promise<string | null> {
  try {
    const { getAllOAuthEmails } = await import('@/lib/oauth-service');
    const emails = getAllOAuthEmails();
    return emails[0] || null;
  } catch { return null; }
}

// ── Look up the inbox email address for a space (e.g. L1board@cloudfuze.com for CUSTM) ──
async function getInboxEmailForSpace(spaceKey: string): Promise<string | null> {
  if (!spaceKey) return null;
  try {
    const { pgPool: pool } = await import('@/lib/pg-pool');
    const row = await pool.query(
      `SELECT address FROM email_configs WHERE LOWER(space_key) = LOWER($1) LIMIT 1`,
      [spaceKey]
    );
    return row.rows[0]?.address || null;
  } catch { return null; }
}

// ── Look up emailthreadid + inbox email for a ticket in one query ──────────────
async function getTicketThreadInfo(issueKey: string): Promise<{ emailthreadid?: string; inboxEmail?: string }> {
  try {
    const { pgPool: pool } = await import('@/lib/pg-pool');
    const row = await pool.query(`
      SELECT i.emailthreadid, ec.address AS inbox_email
      FROM issues i
      JOIN spaces s ON i."spaceId" = s.id
      LEFT JOIN email_configs ec ON LOWER(ec.space_key) = LOWER(s.key)
      WHERE i.key = $1
      LIMIT 1
    `, [issueKey]);
    return {
      emailthreadid: row.rows[0]?.emailthreadid || undefined,
      inboxEmail:    row.rows[0]?.inbox_email    || undefined,
    };
  } catch { return {}; }
}

// ── Send helper ────────────────────────────────────────────────────────────────
// Priority: (1) the ticket's own linked mailbox via Graph — lands in a
// monitored inbox and threads correctly — (2) the single global SMTP
// account, (3) any other connected OAuth account. Previously the global SMTP
// branch always ran first (ignoring the ticket's own mailbox entirely) and
// unconditionally `return`ed even when the send failed, so a broken/blocked
// SMTP account (Microsoft 365 rejects legacy basic-auth SMTP for many
// tenants) silently dropped the notification instead of falling back —
// assignees and reporters got nothing, with no visible error.
async function sendNotification(to: string[], subject: string, html: string, text: string, inReplyTo?: string, fromEmail?: string) {
  const uniqueTo = Array.from(new Set(to.filter(Boolean)));
  if (!uniqueTo.length) return;

  // Local/dev environments reuse the SAME production SMTP and OAuth mailbox
  // credentials with no separate test account — there is nothing else
  // stopping a local test run from emailing a real customer. That already
  // happened once: a local test of the @mention notification path sent a
  // real "mentioned you" email to a real customer's inbox. Only the actual
  // production deployment (NODE_ENV=production) may send for real; every
  // other environment logs what would have been sent instead of sending it.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Notification] DEV MODE — would send "${subject}" to ${uniqueTo.join(', ')} (not actually sent)`);
    return;
  }

  if (fromEmail) {
    const sentViaTicketInbox = await sendViaGraph({ from: fromEmail, to: uniqueTo, subject, html, text, inReplyTo });
    if (sentViaTicketInbox) return;
  }

  const transporter = getTransporter();
  if (transporter) {
    try {
      const mailOpts: any = {
        from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to:      uniqueTo.join(', '),
        subject,
        html,
        text,
      };
      if (inReplyTo) {
        mailOpts.inReplyTo = inReplyTo;
        mailOpts.references = inReplyTo;
      }
      await transporter.sendMail(mailOpts);
      console.log(`[Notification] Sent "${subject}" to ${uniqueTo.join(', ')} via SMTP (${FROM_EMAIL})`);
      return;
    } catch (err: any) {
      console.error(`[Notification] SMTP send failed for "${subject}", trying OAuth fallback:`, err.message);
      // fall through instead of giving up — the notification still matters
    }
  }

  const senderEmail = await getBestSenderEmail();
  if (senderEmail) {
    const sent = await sendViaGraph({ from: senderEmail, to: uniqueTo, subject, html, text, inReplyTo });
    if (!sent) console.error(`[Notification] All send methods failed for "${subject}" to ${uniqueTo.join(', ')}`);
  } else {
    console.warn(`[Notification] Skipping "${subject}" — no working SMTP and no OAuth account connected`);
  }
}

function issueUrl(issueKey: string) {
  return `${APP_URL}/issues/${issueKey}`;
}

// ── Collect recipient emails (skip null/empty) ─────────────────────────────────
function recipients(...people: Array<{ email?: string | null } | null | undefined>): string[] {
  return Array.from(new Set(
    people
      .filter(Boolean)
      .map(p => (p?.email || '').toLowerCase().trim())
      .filter(e => e && e.includes('@'))
  ));
}

// ── Notification senders ──────────────────────────────────────────────────────

export async function notifyIssueCreated(issue: {
  key: string; cfKey?: string | null; summary: string; type: string; priority: string;
  spaceKey: string; spaceName: string;
  status: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  description?: string | null;
}) {
  const to = recipients(issue.assignee, issue.reporter);
  if (!to.length) return;

  const assigneeName = issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}`.trim() : 'Unassigned';
  const reporterName = issue.reporter ? `${issue.reporter.firstName} ${issue.reporter.lastName}`.trim() : 'Unknown';
  const displayKey = issue.cfKey || issue.key;
  const inboxEmail = await getInboxEmailForSpace(issue.spaceKey);

  const html = buildEmailHtml({
    title:        'Issue Created',
    issueKey:     displayKey,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'New Issue Created',
    eventColor:   '#0052CC',
    fields: [
      { label: 'Ticket #', value: displayKey },
      { label: 'Type',     value: issue.type },
      { label: 'Priority', value: issue.priority, color: PRIORITY_COLOR[issue.priority.toLowerCase()] },
      { label: 'Status',   value: issue.status.name, color: STATUS_COLOR[issue.status.category] },
      { label: 'Assignee', value: assigneeName },
      { label: 'Reporter', value: reporterName },
    ],
    actionUrl: issueUrl(issue.key),
  });

  await sendNotification(
    to,
    `[${displayKey}] ${issue.summary}`,
    html,
    `New issue created: ${displayKey} - ${issue.summary}\nAssignee: ${assigneeName}\nView: ${issueUrl(issue.key)}`,
    undefined,
    inboxEmail || undefined,
  );
}

export async function notifyIssueAssigned(issue: {
  key: string; summary: string; priority: string;
  spaceKey: string; spaceName: string;
  status: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  previousAssignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
}) {
  // Notify new assignee + reporter
  const to = recipients(issue.assignee, issue.reporter);
  if (!to.length) return;

  const assigneeName = issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}`.trim() : 'Unassigned';
  const prevName     = issue.previousAssignee ? `${issue.previousAssignee.firstName} ${issue.previousAssignee.lastName}`.trim() : 'Unassigned';
  const { emailthreadid, inboxEmail } = await getTicketThreadInfo(issue.key);

  const html = buildEmailHtml({
    title:        'Issue Assigned',
    issueKey:     issue.key,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'Issue Assigned',
    eventColor:   '#6554C0',
    fields: [
      { label: 'Assigned to',   value: assigneeName, color: '#0052CC' },
      { label: 'Previously',    value: prevName },
      { label: 'Priority',      value: issue.priority, color: PRIORITY_COLOR[issue.priority.toLowerCase()] },
      { label: 'Status',        value: issue.status.name },
    ],
    actionUrl: issueUrl(issue.key),
  });

  await sendNotification(
    to,
    `[${issue.key}] Assigned to ${assigneeName} - ${issue.summary}`,
    html,
    `${issue.key} has been assigned to ${assigneeName}.\nView: ${issueUrl(issue.key)}`,
    emailthreadid,
    inboxEmail,
  );
}

export async function notifyStatusChanged(issue: {
  key: string; summary: string; priority: string;
  spaceKey: string; spaceName: string;
  oldStatus: { name: string; category: string };
  newStatus: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  changedBy?: { email?: string | null; firstName?: string; lastName?: string } | null;
}) {
  const changerEmail = (issue.changedBy as any)?.email?.toLowerCase() || '';
  // Don't notify the person who made the change (no self-spam)
  const to = recipients(issue.assignee, issue.reporter).filter(e => e !== changerEmail);
  if (!to.length) return;

  const changedByName = issue.changedBy ? `${issue.changedBy.firstName} ${issue.changedBy.lastName}`.trim() : 'Someone';
  const isResolved = ['done'].includes(issue.newStatus.category);
  const assigneeName = issue.assignee ? `${issue.assignee.firstName} ${issue.assignee.lastName}`.trim() : 'Unassigned';
  const { emailthreadid, inboxEmail } = await getTicketThreadInfo(issue.key);

  const html = buildEmailHtml({
    title:        'Status Changed',
    issueKey:     issue.key,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   isResolved ? 'Issue Resolved' : 'Status Changed',
    eventColor:   isResolved ? '#10B981' : '#FF991F',
    fields: [
      { label: 'Status',      value: `${issue.oldStatus.name}  →  ${issue.newStatus.name}`, color: STATUS_COLOR[issue.newStatus.category] },
      { label: 'Assigned to', value: assigneeName, color: '#0052CC' },
      { label: 'Changed by',  value: changedByName },
      { label: 'Priority',    value: issue.priority, color: PRIORITY_COLOR[issue.priority.toLowerCase()] },
    ],
    actionUrl: issueUrl(issue.key),
  });

  const subject = isResolved
    ? `[${issue.key}] Resolved - ${issue.summary}`
    : `[${issue.key}] Status changed to "${issue.newStatus.name}" - ${issue.summary}`;

  await sendNotification(
    to,
    subject,
    html,
    `${issue.key} status changed: ${issue.oldStatus.name} → ${issue.newStatus.name}\nView: ${issueUrl(issue.key)}`,
    emailthreadid,
    inboxEmail,
  );
}

export async function notifyCommentAdded(issue: {
  key: string; summary: string;
  spaceKey: string; spaceName: string;
  status: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  comment: { body: string; author?: { email?: string | null; firstName?: string; lastName?: string } | null };
}) {
  const commenterEmail = (issue.comment.author?.email || '').toLowerCase();
  const reporterEmail  = (issue.reporter?.email || '').toLowerCase();
  // Assignee gets notified unless they wrote the comment
  const assigneeEmails = recipients(issue.assignee).filter(e => e !== commenterEmail);
  // Reporter (customer) gets notified unless THEY wrote the comment (no echo back)
  const reporterEmails = (reporterEmail && reporterEmail !== commenterEmail) ? [reporterEmail] : [];
  const to = Array.from(new Set([...assigneeEmails, ...reporterEmails])).filter(Boolean);
  if (!to.length) return;

  const { emailthreadid: sourceMessageId, inboxEmail } = await getTicketThreadInfo(issue.key);

  // Send a plain reply email — just the comment text, no ticket template
  // This looks like a normal email reply so the recipient can reply back
  const commentHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;">${issue.comment.body}</div>`;
  const commentText = issue.comment.body.replace(/<[^>]+>/g, '');

  await sendNotification(
    to,
    `Re: [${issue.key}] ${issue.summary}`,
    commentHtml,
    commentText,
    sourceMessageId,
    inboxEmail,
  );
}

export async function notifyIssueUpdated(issue: {
  key: string; summary: string; priority: string;
  spaceKey: string; spaceName: string;
  status: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  updatedBy?: { firstName?: string; lastName?: string } | null;
  changes: Array<{ field: string; from: string; to: string }>;
}) {
  const to = recipients(issue.assignee, issue.reporter);
  if (!to.length) return;

  const updatedByName = issue.updatedBy ? `${issue.updatedBy.firstName} ${issue.updatedBy.lastName}`.trim() : 'Someone';
  const { emailthreadid, inboxEmail } = await getTicketThreadInfo(issue.key);

  const changeFields = issue.changes.map(c => ({
    label: c.field,
    value: `${c.from || '(empty)'}  →  ${c.to || '(empty)'}`,
  }));

  const html = buildEmailHtml({
    title:        'Issue Updated',
    issueKey:     issue.key,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'Issue Updated',
    eventColor:   '#FF991F',
    fields: [
      { label: 'Updated by', value: updatedByName },
      ...changeFields,
    ],
    actionUrl: issueUrl(issue.key),
  });

  await sendNotification(
    to,
    `[${issue.key}] Updated by ${updatedByName} - ${issue.summary}`,
    html,
    `${issue.key} was updated by ${updatedByName}.\nView: ${issueUrl(issue.key)}`,
    emailthreadid,
    inboxEmail,
  );
}

export async function notifyIssueDeleted(issue: {
  key: string; summary: string;
  spaceKey: string; spaceName: string;
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  deletedBy?: { firstName?: string; lastName?: string } | null;
}) {
  const to = recipients(issue.assignee, issue.reporter);
  if (!to.length) return;

  const deletedByName = issue.deletedBy ? `${issue.deletedBy.firstName} ${issue.deletedBy.lastName}`.trim() : 'Someone';

  const html = buildEmailHtml({
    title:        'Issue Deleted',
    issueKey:     issue.key,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'Issue Deleted',
    eventColor:   '#EF4444',
    fields: [
      { label: 'Deleted by', value: deletedByName },
      { label: 'Board',      value: issue.spaceName },
    ],
    actionUrl: `${APP_URL}/spaces/${issue.spaceKey}`,
  });

  await sendNotification(
    to,
    `[${issue.key}] Deleted - ${issue.summary}`,
    html,
    `${issue.key} was deleted by ${deletedByName}.`,
  );
}

export async function notifyUnassignedTicket(opts: {
  issueKey: string;
  issueSummary: string;
  spaceKey: string;
  spaceName: string;
  department?: string | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  leadEmails: string[];
}) {
  if (!opts.leadEmails.length) return;

  const reporterName = opts.reporter
    ? `${opts.reporter.firstName || ''} ${opts.reporter.lastName || ''}`.trim() || opts.reporter.email || 'Unknown'
    : 'Unknown';
  const queueLabel = opts.department ? ` (Queue: ${opts.department})` : '';

  const html = buildEmailHtml({
    title:        'Unassigned Ticket',
    issueKey:     opts.issueKey,
    issueSummary: opts.issueSummary,
    spaceKey:     opts.spaceKey,
    spaceName:    opts.spaceName,
    eventLabel:   '⚠ Ticket Not Assigned',
    eventColor:   '#F59E0B',
    fields: [
      { label: 'Ticket',   value: opts.issueKey },
      { label: 'Board',    value: opts.spaceName + queueLabel },
      { label: 'Reporter', value: reporterName },
      { label: 'Assignee', value: 'None — needs attention', color: '#EF4444' },
    ],
    actionUrl: issueUrl(opts.issueKey),
  });

  await sendNotification(
    opts.leadEmails,
    `[${opts.issueKey}] Unassigned ticket needs attention - ${opts.issueSummary}`,
    html,
    `Ticket ${opts.issueKey} was created without an assignee${queueLabel}.\nPlease assign it: ${issueUrl(opts.issueKey)}`,
  );
  console.log(`[Notification] Unassigned alert for ${opts.issueKey} → leads: ${opts.leadEmails.join(', ')}`);
}

export async function notifyMentioned(opts: {
  mentionedEmail: string;
  mentionedName: string;
  mentionedBy: string;
  issueKey: string;
  issueSummary: string;
  spaceKey: string;
  spaceName: string;
  commentPreview: string;
}) {
  if (!opts.mentionedEmail) return;
  const html = buildEmailHtml({
    title:        'You were mentioned',
    issueKey:     opts.issueKey,
    issueSummary: opts.issueSummary,
    spaceKey:     opts.spaceKey,
    spaceName:    opts.spaceName,
    eventLabel:   'Mentioned',
    eventColor:   '#8B5CF6',
    fields: [
      { label: 'Mentioned by', value: opts.mentionedBy },
      { label: 'Board',        value: opts.spaceName },
    ],
    comment:   opts.commentPreview,
    actionUrl: issueUrl(opts.issueKey),
  });
  await sendNotification(
    [opts.mentionedEmail],
    `[${opts.issueKey}] ${opts.mentionedBy} mentioned you - ${opts.issueSummary}`,
    html,
    `${opts.mentionedBy} mentioned you in ${opts.issueKey}:\n\n${opts.commentPreview}\n\nView: ${issueUrl(opts.issueKey)}`,
  );
}

export async function notifySLABreach(opts: {
  issueKey: string;
  issueSummary: string;
  spaceKey: string;
  spaceName: string;
  slaName: string;
  minsLeft: number;
  assigneeEmails: string[];
}) {
  if (!opts.assigneeEmails.length) return;
  const inboxEmail = await getInboxEmailForSpace(opts.spaceKey);
  const isBreached = opts.minsLeft <= 0;
  const timeLabel  = isBreached ? 'SLA Breached' : `SLA breaching in ${opts.minsLeft} min`;
  const eventColor = isBreached ? '#EF4444' : '#F59E0B';

  const html = buildEmailHtml({
    title:        timeLabel,
    issueKey:     opts.issueKey,
    issueSummary: opts.issueSummary,
    spaceKey:     opts.spaceKey,
    spaceName:    opts.spaceName,
    eventLabel:   isBreached ? '🔴 SLA BREACHED' : `⚠ SLA Warning — ${opts.minsLeft} min left`,
    eventColor,
    fields: [
      { label: 'SLA Policy', value: opts.slaName },
      { label: 'Board',      value: opts.spaceName },
      { label: 'Status',     value: isBreached ? 'BREACHED' : `${opts.minsLeft} minutes remaining`, color: eventColor },
    ],
    actionUrl: issueUrl(opts.issueKey),
  });

  await sendNotification(
    opts.assigneeEmails,
    `[${opts.issueKey}] ${timeLabel}: ${opts.slaName} — ${opts.issueSummary}`,
    html,
    `${timeLabel} for ${opts.issueKey}.\nSLA: ${opts.slaName}\nView: ${issueUrl(opts.issueKey)}`,
    undefined,
    inboxEmail || undefined,
  );
  console.log(`[Notification] SLA breach alert for ${opts.issueKey} → ${opts.assigneeEmails.join(', ')}`);
}
