/**
 * POST /api/email/receive
 *
 * THE MAIN EMAIL WEBHOOK — handles both new tickets and threaded replies.
 * Creates issues directly in PostgreSQL so they appear on the board immediately.
 *
 * Thread detection order:
 *   1. In-Reply-To header  → look up in message index
 *   2. References header   → scan for [TICKET-ID] pattern
 *   3. Subject             → scan for [TICKET-ID] pattern
 *   → If match: append as COMMENT  (no new ticket)
 *   → If no match: create NEW ticket in PostgreSQL
 *
 * Body: { from, to, cc?, subject, body, messageId?, inReplyTo?, references?, attachments? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getValidAccessToken } from '@/lib/oauth-service';
import { stripQuotedContent, sanitizeEmailHtml } from '@/lib/email-service';

export const runtime = 'nodejs';

// ── In-memory message-ID → issue key index (survives hot-reload via globalThis) ──
declare global { var __emailMsgIndex: Map<string, string> | undefined; }
if (!globalThis.__emailMsgIndex) globalThis.__emailMsgIndex = new Map();

function rid() {
  return Math.random().toString(36).slice(2, 11);
}

/** Get a Graph-API-scoped token (different audience from IMAP token) */
async function getGraphToken(email: string): Promise<string | null> {
  const { getOAuthTokens } = await import('@/lib/oauth-service');
  const tokens = getOAuthTokens(email);
  if (!tokens?.refreshToken) return null;

  const clientId     = process.env.MICROSOFT_CLIENT_ID!;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET!;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      scope:         'https://graph.microsoft.com/Mail.Send offline_access',
    }),
  });
  if (!res.ok) {
    console.error('[AutoReply] Graph token refresh failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json();
  return data.access_token || null;
}

/** Send auto-reply — tries Graph API first, falls back to SMTP OAuth2 */
async function sendGraphAutoReply(opts: {
  toAddress: string;
  fromEmail: string;
  subject: string;
  issueKey: string;
  sk: string;
  messageId?: string;
}) {
  // Local/dev environments share the same production OAuth mailbox
  // credentials with no separate test account — nothing else stops a local
  // test from auto-replying to whoever "sent" the test email. Only the
  // actual production deployment may send for real. This guards the direct
  // Graph sendMail call below too, not just the sendAutoReply() fallbacks
  // (which are already guarded in email-service.ts).
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[AutoReply] DEV MODE — would reply to ${opts.fromEmail} for ticket ${opts.issueKey} (not actually sent)`);
    return;
  }

  // Try Graph token first; if consent not granted, fall back to IMAP access token via SMTP
  let accessToken = await getGraphToken(opts.toAddress);
  let useSmtpFallback = false;
  if (!accessToken) {
    const { getValidAccessToken } = await import('@/lib/oauth-service');
    accessToken = await getValidAccessToken(opts.toAddress).catch(() => null);
    useSmtpFallback = true;
  }
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
  const issueUrl = `${appUrl}/issues/${opts.issueKey}`;

  const domain   = opts.toAddress.split('@')[1] || 'cloudfuze.com';
  const fromName = process.env.EMAIL_FROM_NAME || 'CloudFuze Support';

  const autoReplyText = 'Thank you for contacting us. We have received your request and will get back to you shortly.';

  // If no OAuth Graph token — use OAuth IMAP token via SMTP (sends FROM the inbox email)
  if (!accessToken || useSmtpFallback) {
    if (accessToken) {
      // Send from the connected inbox email using OAuth SMTP
      const { sendAutoReply } = await import('@/lib/email-service');
      await sendAutoReply({
        smtp: { host: 'smtp.office365.com', port: 587, secure: false, user: opts.toAddress, password: '', oauthAccessToken: accessToken },
        from: opts.toAddress,
        to: opts.fromEmail,
        subject: opts.subject,
        issueKey: opts.issueKey,
        issueUrl,
        autoReplyText,
        inReplyTo: opts.messageId,
        references: opts.messageId,
        outboundMessageId: `<reply_${Date.now()}@${domain}>`,
      });
      console.log(`[AutoReply] Sent via OAuth SMTP (${opts.toAddress}) to ${opts.fromEmail} → ticket ${opts.issueKey}`);
    } else {
      // Last resort: configured SMTP credentials
      const smtpUser = process.env.EMAIL_USER;
      const smtpPass = process.env.EMAIL_PASSWORD;
      if (smtpUser && smtpPass) {
        const { sendAutoReply } = await import('@/lib/email-service');
        await sendAutoReply({
          smtp: { host: process.env.SMTP_HOST || 'smtp.office365.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, user: smtpUser, password: smtpPass },
          from: smtpUser,
          to: opts.fromEmail,
          subject: opts.subject,
          issueKey: opts.issueKey,
          issueUrl,
          autoReplyText,
          inReplyTo: opts.messageId,
          references: opts.messageId,
          outboundMessageId: `<reply_${Date.now()}@${domain}>`,
        });
        console.log(`[AutoReply] Sent via SMTP fallback (${smtpUser}) to ${opts.fromEmail} → ticket ${opts.issueKey}`);
      } else {
        console.warn('[AutoReply] No token and no SMTP credentials — skipping auto-reply');
      }
    }
    return;
  }

  const replySubject = `Re: ${opts.subject.replace(/^Re:\s*/i, '')} [${opts.issueKey}]`;

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="background:#0052CC;padding:16px 24px">
        <span style="color:white;font-size:18px;font-weight:bold">${fromName}</span>
      </div>
      <div style="background:#10B981;padding:8px 24px">
        <span style="color:white;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Ticket Created Successfully</span>
      </div>
      <div style="padding:24px;background:#f9f9f9">
        <p style="color:#333;font-size:14px;margin:0 0 16px">${autoReplyText}</p>
        <div style="margin:0 0 20px;padding:16px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;border-left:4px solid #0052CC">
          <p style="margin:0;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Your Support Ticket</p>
          <p style="margin:8px 0 0;font-size:22px;font-weight:bold;color:#0052CC">${opts.issueKey}</p>
          <p style="margin:6px 0 0;color:#555;font-size:13px">📌 ${opts.subject}</p>
          <p style="margin:12px 0 0">
            <a href="${issueUrl}" style="display:inline-block;background:#0052CC;color:white;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600">View Ticket →</a>
          </p>
        </div>
        <p style="color:#666;font-size:13px;margin:0 0 8px">Our team will review your request and get back to you as soon as possible.</p>
        <p style="color:#888;font-size:12px;margin:0">
          💬 <strong>Reply to this email</strong> to add a comment to your ticket.<br/>
          🔖 Ticket reference: <strong>${opts.issueKey}</strong>
        </p>
      </div>
      <div style="padding:12px 24px;background:#f0f0f0;border-top:1px solid #e0e0e0">
        <p style="margin:0;font-size:11px;color:#999">${fromName} · <a href="${appUrl}" style="color:#0052CC;text-decoration:none">${appUrl}</a></p>
      </div>
    </div>`;

  const message: any = {
    subject: replySubject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: opts.fromEmail.replace(/.*<(.+)>/, '$1').trim() } }],
  };

  // Add threading headers so it appears in the same thread
  if (opts.messageId) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: opts.messageId },
      { name: 'References',  value: opts.messageId },
    ];
  }

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (res.ok || res.status === 202) {
    console.log(`[AutoReply] Sent reply to ${opts.fromEmail} → ticket ${opts.issueKey}`);
  } else {
    const err = await res.text().catch(() => '');
    console.error(`[AutoReply] Graph API error ${res.status}:`, err);
  }
}

/** Extract ticket key like L1BOAR-123 from a string */
function extractTicketKey(text: string): string | null {
  const m = text?.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/);
  return m ? m[1] : null;
}

/** Determine spaceKey from the "to" email address */
function spaceKeyFromEmail(toEmail: string): string {
  // First check mock emailAddresses store
  try {
    const { getStore } = require('@/lib/jira-dev-mock') as any;
    // getStore is not exported, so we use the emailAddresses via processInboundEmail indirectly
  } catch {}
  // Derive from email prefix: l1board@... → L1BOAR (use first 6 chars of prefix)
  const prefix = toEmail.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Return full prefix — PostgreSQL will verify if space exists
  return prefix;
}

/**
 * Clean an email body for storage as a ticket description.
 * Preserves images (data: URLs), links, and formatting exactly as seen in the email.
 */
function cleanMimeBody(raw: string): string {
  if (!raw) return '';

  const looksLikeHtml = /<[a-zA-Z]/.test(raw);

  // If it looks like raw MIME (starts with a boundary or Content-* header),
  // strip all MIME structure first before deciding HTML vs plain text
  const looksLikeMime = /^--[^\s]|^content-type:/i.test(raw.trimStart());
  if (looksLikeMime) {
    // Extract body using the same robust MIME parser used by the IMAP poller
    const { stripQuotedContent: sqc } = require('@/lib/email-service');
    // Build a minimal RFC 2822 wrapper so extractBodyFromRawMessage can parse it
    // (It needs a blank-line separator at the top)
    const wrapped = '\r\n' + raw; // prepend fake blank header section
    // Fall through to plain-text path after stripping MIME
    const mimeStripped = raw
      .split('\n')
      .filter((line: string) => {
        const t = line.trim();
        if (/^--[^\s]/.test(t)) return false; // boundary lines
        if (/^content-(type|transfer-encoding|disposition|description|id):/i.test(t)) return false;
        if (/^mime-version:/i.test(t)) return false;
        if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(t)) return false; // base64 blobs
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!mimeStripped) return '';
    const autoLinkFn = (t: string) => {
      // Auto-link https?:// and www. URLs in plain text
      let out = t.replace(/(https?:\/\/[^\s<>"')\]]+)/gi, url => {
        const clean = url.replace(/[.,;!?]+$/, '');
        return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
      });
      out = out.replace(/(^|[\s(])(www\.[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}[^\s<>"')\]]*)/gi, (_, pre, url) => {
        const clean = url.replace(/[.,;!?]+$/, '');
        return `${pre}<a href="https://${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
      });
      return out;
    };
    return stripJiraNotificationLeakage(
      mimeStripped.split('\n\n')
        .map((p: string) => p.trim() ? `<p>${autoLinkFn(p.trim().replace(/\n/g, '<br/>'))}</p>` : '')
        .filter(Boolean).join('')
    );
  }

  if (looksLikeHtml) {
    // ── HTML body: full sanitize pipeline ─────────────────────────────────
    let h = sanitizeEmailHtml(raw);

    // Strip block-level elements (p, div, td, li) whose TEXT content
    // is purely a Jira notification line: "[KEY-NNN] ... - Jira"
    // BUT only if the block does NOT contain a real <a href="..."> link —
    // if it has a href link, the user intentionally included it and we must keep it.
    h = h.replace(
      /<(p|div|td|li|span)([^>]*)>([\s\S]*?)<\/\1>/gi,
      (full, tag, attrs, inner) => {
        // If the block contains a real hyperlink → always keep it
        if (/href=["']https?:/i.test(inner)) return full;
        const visible = inner.replace(/<[^>]+>/g, '').trim();
        // Pure Jira notification text with NO link: starts [KEY-NNN] ends - Jira
        if (/^\[?[A-Z][A-Z0-9]+-\d+\]/.test(visible) && /[-|]\s*Jira\s*$/.test(visible)) {
          return '';
        }
        return full;
      }
    );

    // Clean up orphan closing </a> tags — scan forward, remove any </a>
    // that has no matching opening <a ...> before it.
    h = h.replace(/(<\/a>\s*){2,}/gi, '</a>'); // deduplicate consecutive </a>
    let depth = 0;
    h = h.replace(/<\/?a[\s>]/gi, (tag) => {
      if (/^<a[\s>]/i.test(tag)) { depth++; return tag; }
      // closing </a>
      if (depth > 0) { depth--; return tag; }
      return ''; // orphan </a> — remove it
    });

    return h;
  }

  // ── Plain-text body ────────────────────────────────────────────────────
  // Strip quoted/forwarded content
  let text = stripQuotedContent(raw);

  // Strip Jira notification boilerplate lines
  text = stripJiraNotificationLeakage(text);

  // Remove stray base64 blobs
  text = text.split('\n')
    .filter(line => !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(line.trim()))
    .join('\n');

  // Collapse blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';

  // Auto-link URLs — catches https://, http://, and www. links
  const autoLink = (t: string) => {
    let out = t.replace(/(https?:\/\/[^\s<>"')\]]+)/gi, url => {
      const clean = url.replace(/[.,;!?]+$/, '');
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
    });
    out = out.replace(/(^|[\s(])(www\.[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}[^\s<>"')\]]*)/gi, (_, pre, url) => {
      const clean = url.replace(/[.,;!?]+$/, '');
      return `${pre}<a href="https://${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
    });
    return out;
  };

  return text.split('\n\n')
    .map(para => para.trim() ? `<p>${autoLink(para.trim().replace(/\n/g, '<br/>'))}</p>` : '')
    .filter(Boolean)
    .join('');
}

/**
 * Strip Jira notification email content that leaks into forwarded bodies.
 * Patterns like:
 *   [IN-2333] SkyTide | Chat - Teams | Space stuck in In-progress. - Jira
 *   [L1BOAR-45] Some issue title - Jira
 * These are standalone lines/paragraphs that are purely Jira email subjects.
 */
function stripJiraNotificationLeakage(text: string): string {
  if (!text) return text;

  // Remove standalone lines that match "[TICKET-NNN] ... - Jira" pattern
  // (Jira notification email subjects)
  const cleaned = text
    .split('\n')
    .filter(line => {
      const t = line.replace(/<[^>]+>/g, '').trim(); // strip HTML tags for matching
      // Pure Jira notification line: starts with [KEY-NNN] and ends with "- Jira" or "| Jira"
      if (/^\[?[A-Z][A-Z0-9]+-\d+\]/.test(t) && /[\-|]\s*Jira\s*$/.test(t)) return false;
      // Line that is just a ticket key like "[IN-2333]"
      if (/^\[?[A-Z][A-Z0-9]+-\d+\]?\s*$/.test(t)) return false;
      return true;
    })
    .join('\n');

  // Also strip whole <p> blocks that are purely Jira notification content
  return cleaned.replace(
    /<p[^>]*>\s*(?:<[^>]+>)*\s*\[?[A-Z][A-Z0-9]+-\d+\][\s\S]*?[\-|]\s*Jira\s*(?:<[^>]+>)*\s*<\/p>/gi,
    ''
  );
}

export async function POST(req: NextRequest) {
  let from = '', to = '', cc = '', subject = '', body = '', messageId = '', inReplyTo = '', references = '';
  let attachments: any[] = [];

  try {
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      from       = String(form.get('from')    || form.get('sender')    || '');
      to         = String(form.get('to')      || form.get('recipient') || '');
      cc         = String(form.get('cc')      || '');
      subject    = String(form.get('subject') || '(no subject)');
      // Prefer HTML body (preserves links) — fall back to plain text
      body       = String(form.get('body-html') || form.get('html') || form.get('text') || form.get('body-plain') || '');
      messageId  = String(form.get('message-id') || form.get('Message-Id') || '');
      inReplyTo  = String(form.get('in-reply-to') || '');
      references = String(form.get('references') || '');
    } else {
      const raw = await req.json().catch(() => ({})) as Record<string, unknown>;
      from       = String(raw.from       || '');
      to         = String(raw.to         || '');
      cc         = String(raw.cc         || '');
      subject    = String(raw.subject    || '(no subject)');
      // Prefer HTML body (has clickable links) over plain text
      body       = String(raw.bodyHtml || raw.body || '');
      messageId  = raw.messageId  ? String(raw.messageId)  : '';
      inReplyTo  = raw.inReplyTo  ? String(raw.inReplyTo)  : '';
      references = Array.isArray(raw.references) ? raw.references.join(' ') : String(raw.references || '');
      attachments = (raw.attachments as any[]) || [];
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: 'Failed to parse body' }, { status: 400 });
  }

  // Extract clean email address from "Display Name <email@domain>" format
  const extractEmail = (addr: string) => {
    const m = addr.match(/<([^>]+)>/);
    return (m ? m[1] : addr).trim().toLowerCase();
  };

  // Extract display name from "Display Name <email@domain>" format
  const extractDisplayName = (addr: string): string => {
    const m = addr.match(/^"?([^"<]+?)"?\s*</);
    return m ? m[1].trim() : '';
  };

  const toRaw     = to.trim();
  const toAddress = extractEmail(toRaw);
  const fromEmail = extractEmail(from);
  const fromDisplayName = extractDisplayName(from); // e.g. "QA Agent" from "QA Agent <qa@test.com>"
  const senderDomain = fromEmail.split('@')[1] || '';

  console.log(`[EmailReceive] to="${toRaw}" → toAddress="${toAddress}" from="${fromEmail}"`);

  // ── 1. Determine spaceKey + department from the "to" address ────────────
  let spaceKey = '';
  let emailDepartment: string | null = null;

  // 1a. In-memory mock store (fallback only — DB below takes priority)
  let mockSpaceKey = '';
  try {
    const mockModule = await import('@/lib/jira-dev-mock');
    const { getEmailAddressSpaceKey, getEmailAddressRecord } = mockModule as any;
    if (typeof getEmailAddressSpaceKey === 'function') {
      mockSpaceKey = getEmailAddressSpaceKey(toAddress) || '';
    }
    if (typeof getEmailAddressRecord === 'function') {
      const rec = getEmailAddressRecord(toAddress);
      if (rec?.department) emailDepartment = rec.department;
    }
  } catch {}

  // 1b. DB lookup — always runs, takes priority over mock store
  try {
    const { pgPool: pool } = await import('@/lib/pg-pool');
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});
    const dbRow = await pool.query(
      `SELECT space_key, department FROM email_configs WHERE LOWER(address) = $1 LIMIT 1`,
      [toAddress]
    );
    if (dbRow.rows[0]) {
      spaceKey = dbRow.rows[0].space_key;
      if (dbRow.rows[0].department) emailDepartment = dbRow.rows[0].department;
      console.log(`[EmailReceive] Found space via DB config: ${spaceKey}${emailDepartment ? ` dept:${emailDepartment}` : ''}`);
    }
  } catch (e) {
    console.error('[EmailReceive] DB lookup failed:', e);
  }

  // 1c. Fall back to mock store if DB had no match
  if (!spaceKey && mockSpaceKey) {
    spaceKey = mockSpaceKey;
    console.log(`[EmailReceive] Using mock store spaceKey: ${spaceKey}`);
  }

  // 1d. Derive from email local-part as last resort
  if (!spaceKey) {
    spaceKey = toAddress.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
    console.log(`[EmailReceive] Derived spaceKey from prefix: ${spaceKey}`);
  }

  // ── 2. Verify the space exists in PostgreSQL ──────────────────────────────
  const space = await db.space.findFirst({
    where: { key: { equals: spaceKey, mode: 'insensitive' } },
    include: { statuses: { orderBy: { order: 'asc' } } },
  });

  if (!space) {
    console.error(`[EmailWebhook] Space not found for key "${spaceKey}" (to: ${toAddress})`);
    // This lookup is deterministic on the recipient address — it will not
    // start succeeding on its own, only if an admin deliberately configures
    // a matching space later (rare). Marking it processed anyway (instead of
    // the normal "leave unprocessed, retry next poll" behavior for transient
    // failures) stops every poller cycle from re-fetching this same message
    // — attachments and all — forever. Without this, every personal/business
    // email in a polled inbox that will never map to a ticket space (payslips,
    // Teams notifications, unrelated threads) got re-processed every single
    // poll cycle across every mailbox, indefinitely — a continuously growing
    // background load that was severe enough to stall the whole app.
    if (messageId) {
      const mid = messageId.trim();
      const processedIds: Set<string> = (globalThis as any).__processedMsgIds || new Set();
      processedIds.add(mid);
      (globalThis as any).__processedMsgIds = processedIds;
      try {
        const { pgPool: pool } = await import('@/lib/pg-pool');
        await pool.query(
          `INSERT INTO processed_emails (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING`,
          [mid]
        );
      } catch { /* non-critical */ }
    }
    (globalThis as any).__lastWebhookResult = { ok: false, permanent: true };
    return NextResponse.json({ ok: false, permanent: true, reason: `No space found for ${toAddress} (spaceKey: ${spaceKey})` });
  }

  const sk = space.key; // use canonical key from DB

  // ── 3. Thread detection — is this a reply to an existing ticket? ──────────
  let existingTicketKey: string | null = null;

  // 3a. Check ticket key pattern in headers/subject (catches replies to auto-reply)
  const allHeaders = [inReplyTo, references, subject].join(' ');
  existingTicketKey = extractTicketKey(allHeaders);

  // 3b. If no ticket key found, check in-memory message-ID index
  //     This catches replies to the ORIGINAL inbound email (no [TICKET-KEY] in subject)
  if (!existingTicketKey && inReplyTo) {
    const fromIndex = globalThis.__emailMsgIndex!.get(inReplyTo.trim());
    if (fromIndex) existingTicketKey = fromIndex;
  }
  // Also scan all message IDs in References header
  if (!existingTicketKey && references) {
    for (const ref of references.split(/\s+/)) {
      const found = globalThis.__emailMsgIndex!.get(ref.trim());
      if (found) { existingTicketKey = found; break; }
    }
  }

  // 3c. Also search DB via raw SQL for issues whose emailThreadId matches inReplyTo or References
  if (!existingTicketKey) {
    const msgIdsToCheck = [inReplyTo, ...references.split(/\s+/)].map(s => s.trim()).filter(Boolean);
    if (msgIdsToCheck.length > 0) {
      try {
        const { pgPool: p } = await import('@/lib/pg-pool');
        for (const mid of msgIdsToCheck) {
          const res = await p.query(`SELECT key FROM issues WHERE "emailthreadid" = $1 LIMIT 1`, [mid]);
          if (res.rows[0]) { existingTicketKey = res.rows[0].key; break; }
        }
      } catch { /* non-critical */ }
    }
  }

  // 3d. Subject-based fallback: "Re: <summary>" → find ticket in same space with that summary
  //     Catches replies to the original email when no messageId is stored
  if (!existingTicketKey && /^re:/i.test(subject.trim())) {
    const baseSubject = subject.replace(/^(re:\s*)+/i, '').replace(/\s*\[.*?\]\s*$/, '').trim();
    if (baseSubject) {
      try {
        const { pgPool: p } = await import('@/lib/pg-pool');
        const res = await p.query(
          `SELECT i.key FROM issues i JOIN spaces s ON i."spaceId" = s.id WHERE s.key = $1 AND LOWER(i.summary) = LOWER($2) ORDER BY i."createdAt" DESC LIMIT 1`,
          [sk, baseSubject]
        );
        if (res.rows[0]) {
          existingTicketKey = res.rows[0].key;
          console.log(`[EmailWebhook] Subject match: "${baseSubject}" → ${existingTicketKey}`);
        }
      } catch { /* non-critical */ }
    }
  }

  // Verify the ticket actually exists
  if (existingTicketKey) {
    const existing = await db.issue.findUnique({ where: { key: existingTicketKey }, select: { key: true } });
    if (!existing) existingTicketKey = null;
  }

  const outboundMsgId = `<msg_${rid()}.${Date.now()}@cloudfuze.com>`;

  // ── 4a. REPLY: add comment to existing ticket ─────────────────────────────
  if (existingTicketKey) {
    // Find author
    const author = await db.user.findFirst({
      where: { email: { equals: fromEmail, mode: 'insensitive' } },
      select: { id: true },
    });

    const existingIssue = await db.issue.findUnique({ where: { key: existingTicketKey }, select: { id: true } });
    if (existingIssue) {
      // For reply comments: extract plain text → run text-based quote stripper
      // (more reliable than HTML parsing — Outlook's reply HTML structure varies,
      // but the plain-text From:/Sent:/To:/Subject: block is always consistent)
      let cleanBody: string;
      const isHtml = /<[a-zA-Z]/.test(body);
      if (isHtml) {
        const plainText = body
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s{2,}/g, ' ').replace(/ \n/g, '\n').replace(/\n /g, '\n')
          .trim();
        const stripped = stripQuotedContent(plainText);
        cleanBody = stripped.split(/\n\n+/)
          .map(p => p.trim() ? `<p>${p.trim().replace(/\n/g, '<br/>')}</p>` : '')
          .filter(Boolean).join('') || stripped;
      } else {
        cleanBody = stripQuotedContent(body);
      }
      if (cleanBody) {
        await db.comment.create({
          data: {
            id: rid(),
            body: cleanBody,
            issueId: existingIssue.id,
            authorId: author?.id ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    }

    console.log(`[EmailWebhook] Reply → comment added to ${existingTicketKey}`);
    (globalThis as any).__lastWebhookResult = { ok: true };
    return NextResponse.json({ ok: true, action: 'commented', issueKey: existingTicketKey });
  }

  // ── 4b. NEW TICKET: create in PostgreSQL ──────────────────────────────────
  // Guard: if this exact messageId was already processed (even if ticket was later deleted), skip
  if (messageId) {
    const mid = messageId.trim();
    // Check in-memory processedIds first (fastest)
    const processedIds: Set<string> = (globalThis as any).__processedMsgIds || new Set();
    if (processedIds.has(mid)) {
      console.log(`[EmailWebhook] Already processed messageId ${mid}, skipping`);
      return NextResponse.json({ ok: true, action: 'duplicate' });
    }
    // Also check persistent processed_emails table
    try {
      const { pgPool: pool } = await import('@/lib/pg-pool');
      const dup = await pool.query(`SELECT message_id FROM processed_emails WHERE message_id = $1 LIMIT 1`, [mid]);
      if (dup.rows[0]) {
        processedIds.add(mid);
        (globalThis as any).__processedMsgIds = processedIds;
        console.log(`[EmailWebhook] Duplicate messageId ${mid} found in processed_emails table, skipping`);
        return NextResponse.json({ ok: true, action: 'duplicate' });
      }
    } catch { /* non-critical */ }
  }

  const openStatus = space.statuses[0];

  // Resolve reporter by email — if not found, auto-create a guest user from sender info
  let reporter = await db.user.findFirst({
    where: { email: { equals: fromEmail, mode: 'insensitive' } },
    select: { id: true },
  });

  if (!reporter && fromEmail && fromEmail !== 'unknown@sender.com') {
    // Parse display name: "QA Agent" → firstName="QA", lastName="Agent"
    const nameParts = fromDisplayName
      ? fromDisplayName.split(/\s+/)
      : fromEmail.split('@')[0].split(/[._-]/);
    const firstName = nameParts[0] || fromEmail.split('@')[0];
    const lastName  = nameParts.slice(1).join(' ') || '';

    try {
      const newUser = await db.user.create({
        data: {
          id: `guest_${fromEmail.replace(/[^a-zA-Z0-9]/g, '_')}`,
          email: fromEmail.toLowerCase(),
          firstName,
          lastName,
          displayName: fromDisplayName || fromEmail,
          role: 'agent',
          password: '',
          isActive: true,
        },
        select: { id: true },
      });
      reporter = newUser;
      console.log(`[EmailReceive] Auto-created guest user for ${fromEmail}`);
    } catch {
      // User might have been created concurrently — try fetching again
      reporter = await db.user.findFirst({
        where: { email: { equals: fromEmail, mode: 'insensitive' } },
        select: { id: true },
      });
    }
  }

  // Compute next issue number — query by spaceId so we pick up ALL existing
  // tickets even if they use a different key prefix (e.g. PSM- vs PSMBOARD-)
  const allNums = await db.issue.findMany({
    where: { spaceId: space.id },
    select: { key: true },
  });
  const maxNum = allNums.reduce((max, i) => {
    const n = parseInt(i.key.split('-').pop() || '0', 10);
    return n > max ? n : max;
  }, 0);

  // Detect existing key prefix from tickets already in this space
  // e.g. if tickets are "SOPS-1", "SOPS-2" use "SOPS", not "SOPSBOARD"
  let keyPrefix = sk;
  if (allNums.length > 0) {
    // Find the most commonly used prefix among existing tickets
    const prefixCounts: Record<string, number> = {};
    for (const i of allNums) {
      const p = i.key.split('-').slice(0, -1).join('-');
      if (p) prefixCounts[p] = (prefixCounts[p] || 0) + 1;
    }
    const dominant = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant) keyPrefix = dominant[0];
  }

  const issueKey = `${keyPrefix}-${maxNum + 1}`;

  // Clean body — sanitize HTML, strip Outlook reading-pane junk, Jira notification
  // leakage, and forwarded/quoted content so only the sender's own words are stored.
  const cleanBody = cleanMimeBody(body);

  // RR-assign to the queue department linked to this email address
  let rrAssigneeId: string | null = null;
  try {
    const { getNextAgent, getDefaultDepartment } = await import('@/lib/rr-service');
    const dept = emailDepartment || await getDefaultDepartment(space.id);
    if (dept) {
      const agent = await getNextAgent(space.id, dept);
      if (agent) rrAssigneeId = agent.userId;
      if (!emailDepartment) emailDepartment = dept;
    }
  } catch { /* non-critical */ }

  const issue = await db.issue.create({
    data: {
      id: rid(),
      key: issueKey,
      summary: subject,
      description: cleanBody || null,
      type: 'task',
      priority: 'medium',
      spaceId: space.id,
      statusId: openStatus?.id ?? null,
      reporterId: reporter?.id ?? null,
      assigneeId: rrAssigneeId,
      customerName: senderDomain,
      clientName: senderDomain,
      labels: [],
    },
    include: { status: true, space: { select: { key: true, name: true } } },
  });

  // Set current_department via raw SQL (field not in Prisma schema)
  if (emailDepartment) {
    try {
      const { pgPool: p2 } = await import('@/lib/pg-pool');
      await p2.query(`UPDATE issues SET current_department = $1 WHERE key = $2`, [emailDepartment, issue.key]);
    } catch { /* non-critical */ }
  }

  // If no assignee was found via RR, alert leads + shift leads
  if (!rrAssigneeId) {
    try {
      const { getNextAgent: _, getDefaultDepartment: __, ...rrMod } = await import('@/lib/rr-service');
      const { getRrConfig } = rrMod as any;
      const { notifyUnassignedTicket } = await import('@/lib/notification-service');
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      // Find leads + shift leads for this space
      const leads = await prisma.spaceMember.findMany({
        where: { spaceId: space.id, role: { in: ['lead', 'shift_lead'] } },
        include: { user: { select: { email: true } } },
      });
      const leadEmails = leads.map((l: any) => l.user?.email).filter(Boolean) as string[];
      await prisma.$disconnect();
      if (leadEmails.length) {
        notifyUnassignedTicket({
          issueKey,
          issueSummary: subject,
          spaceKey: spaceKey,
          spaceName: space.name,
          department: emailDepartment,
          reporter: reporter ? { email: reporter.email, firstName: reporter.firstName ?? '', lastName: reporter.lastName ?? '' } : null,
          leadEmails,
        }).catch(() => {});
      }
    } catch { /* non-critical */ }
  }

  // Store original messageId for thread linking + mark as processed permanently
  if (messageId) {
    const mid = messageId.trim();
    globalThis.__emailMsgIndex!.set(mid, issueKey);
    // Add to in-memory processedIds so same-session re-deliveries are skipped instantly
    const processedIds: Set<string> = (globalThis as any).__processedMsgIds || new Set();
    processedIds.add(mid);
    (globalThis as any).__processedMsgIds = processedIds;
    try {
      const { pgPool: pool } = await import('@/lib/pg-pool');
      await pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS emailthreadid TEXT`).catch(() => {});
      // Save to issues table for thread detection
      await pool.query(`UPDATE issues SET emailthreadid = $1 WHERE key = $2`, [mid, issueKey]);
      // Save to persistent processed_emails table — survives ticket deletion & server restarts
      await pool.query(
        `INSERT INTO processed_emails (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING`,
        [mid]
      );
    } catch { /* non-critical */ }
  }

  // Update space issue count
  await db.space.update({ where: { id: space.id }, data: { issueCount: { increment: 1 } } });

  console.log(`[EmailWebhook] Created ${issueKey} in space ${sk} from ${fromEmail} (msgId: ${messageId || 'none'})`);

  // ── 5. Send auto-reply via Microsoft Graph API (no SMTP needed) ──────────
  sendGraphAutoReply({
    toAddress, fromEmail: from, subject, issueKey, sk,
    messageId: messageId || undefined,
  }).catch(err => console.error('[EmailWebhook] Auto-reply error:', err));

  (globalThis as any).__lastWebhookResult = { ok: true };
  return NextResponse.json({
    ok: true, action: 'created', issueKey,
    issueUrl: `/spaces/${sk}/issues/${issueKey}`,
    message: `Issue ${issueKey} created from email.`,
  });
}

// GET — health check
export async function GET() {
  return NextResponse.json({ ok: true, service: 'CloudFuze Email Webhook', version: '3.0' });
}
