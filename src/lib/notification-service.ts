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

// ── Send via Microsoft Graph API (OAuth fallback when SMTP not configured) ─────
async function sendViaGraph(opts: { from: string; to: string[]; subject: string; html: string; text: string }) {
  try {
    const { getValidAccessToken, getOAuthTokens } = await import('@/lib/oauth-service');
    const tokens = getOAuthTokens(opts.from);
    if (!tokens) return false;
    const accessToken = await getValidAccessToken(opts.from).catch(() => null);
    if (!accessToken) return false;

    for (const recipient of opts.to) {
      const message = {
        subject: opts.subject,
        body: { contentType: 'HTML', content: opts.html },
        toRecipients: [{ emailAddress: { address: recipient } }],
      };
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

// ── Send helper ────────────────────────────────────────────────────────────────
async function sendNotification(to: string[], subject: string, html: string, text: string) {
  const uniqueTo = Array.from(new Set(to.filter(Boolean)));
  if (!uniqueTo.length) return;

  // Try SMTP first (if configured)
  const transporter = getTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to:      uniqueTo.join(', '),
        subject,
        html,
        text,
      });
      console.log(`[Notification] Sent "${subject}" to ${uniqueTo.join(', ')}`);
    } catch (err: any) {
      console.error(`[Notification] Failed to send "${subject}":`, err.message);
    }
    return;
  }

  // SMTP not configured — fall back to OAuth (Microsoft Graph API)
  const senderEmail = await getBestSenderEmail();
  if (senderEmail) {
    await sendViaGraph({ from: senderEmail, to: uniqueTo, subject, html, text });
  } else {
    console.warn(`[Notification] Skipping "${subject}" — no SMTP credentials and no OAuth account connected`);
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

  const html = buildEmailHtml({
    title:        'Issue Created',
    issueKey:     displayKey,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'New Issue Created',
    eventColor:   '#0052CC',
    fields: [
      { label: 'Ticket #', value: `${displayKey} (${issue.key})` },
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
    `New issue created: ${displayKey} (${issue.key}) - ${issue.summary}\nAssignee: ${assigneeName}\nView: ${issueUrl(issue.key)}`,
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
  );
}

export async function notifyStatusChanged(issue: {
  key: string; summary: string; priority: string;
  spaceKey: string; spaceName: string;
  oldStatus: { name: string; category: string };
  newStatus: { name: string; category: string };
  assignee?: { email?: string | null; firstName?: string; lastName?: string } | null;
  reporter?: { email?: string | null; firstName?: string; lastName?: string } | null;
  changedBy?: { firstName?: string; lastName?: string } | null;
}) {
  const to = recipients(issue.assignee, issue.reporter);
  if (!to.length) return;

  const changedByName = issue.changedBy ? `${issue.changedBy.firstName} ${issue.changedBy.lastName}`.trim() : 'Someone';
  const isResolved = ['done'].includes(issue.newStatus.category);

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
  // Always notify the reporter (they are the customer who sent the email).
  // Only skip the commenter from the assignee side (agents don't need self-notifications).
  const commenterEmail = (issue.comment.author?.email || '').toLowerCase();
  const reporterEmail  = (issue.reporter?.email || '').toLowerCase();
  const assigneeEmails = recipients(issue.assignee).filter(e => e !== commenterEmail);
  const reporterEmails = reporterEmail ? [reporterEmail] : [];
  const to = Array.from(new Set([...assigneeEmails, ...reporterEmails])).filter(Boolean);
  if (!to.length) return;

  const authorName = issue.comment.author
    ? `${issue.comment.author.firstName} ${issue.comment.author.lastName}`.trim()
    : 'Someone';

  const html = buildEmailHtml({
    title:        'Comment Added',
    issueKey:     issue.key,
    issueSummary: issue.summary,
    spaceKey:     issue.spaceKey,
    spaceName:    issue.spaceName,
    eventLabel:   'New Comment',
    eventColor:   '#3B82F6',
    fields: [
      { label: 'Commented by', value: authorName },
      { label: 'Status',       value: issue.status.name },
    ],
    comment:   issue.comment.body.slice(0, 500) + (issue.comment.body.length > 500 ? '…' : ''),
    actionUrl: issueUrl(issue.key),
  });

  await sendNotification(
    to,
    `[${issue.key}] ${authorName} commented - ${issue.summary}`,
    html,
    `${authorName} commented on ${issue.key}:\n\n${issue.comment.body}\n\nView: ${issueUrl(issue.key)}`,
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
