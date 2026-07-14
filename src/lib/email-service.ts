/**
 * email-service.ts
 *
 * Real email pipeline — IMAP polling (read) + nodemailer SMTP (send).
 *
 * Threading is fully RFC 2822 compliant:
 *   INBOUND:  extracts Message-ID, In-Reply-To, References from each email
 *             → passed to processInboundEmail() for thread detection
 *   OUTBOUND: auto-reply includes Message-ID, In-Reply-To, References
 *             so the customer's mail client threads replies correctly
 */

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

// ─── Config ───────────────────────────────────────────────────────────────────
export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    // OAuth fields (when using OAuth instead of password)
    oauthAccessToken?:  string;
    oauthRefreshToken?: string;
    oauthProvider?:     'microsoft' | 'google';
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    oauthAccessToken?: string;
  };
  spaceKey: string;
  address: string;
  autoReply: boolean;
  autoReplyText: string;
  webhookUrl: string;
}

export function getEmailConfigFromEnv(): EmailConfig | null {
  const user = process.env.EMAIL_USER;
  const password = process.env.EMAIL_PASSWORD;
  if (!user || !password) return null;

  return {
    imap: {
      host:     process.env.IMAP_HOST   || 'outlook.office365.com',
      port:     parseInt(process.env.IMAP_PORT || '993'),
      secure:   process.env.IMAP_SECURE !== 'false',
      user, password,
    },
    smtp: {
      host:     process.env.SMTP_HOST   || 'smtp.office365.com',
      port:     parseInt(process.env.SMTP_PORT || '587'),
      secure:   process.env.SMTP_SECURE === 'true',
      user, password,
    },
    spaceKey:      process.env.EMAIL_SPACE_KEY       || 'INFRA',
    address:       user,
    autoReply:     process.env.EMAIL_AUTO_REPLY      !== 'false',
    autoReplyText: process.env.EMAIL_AUTO_REPLY_TEXT || 'Thank you for contacting us. We have received your request and will get back to you shortly.',
    webhookUrl:    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/api/email/receive`
      : 'http://localhost:8080/api/email/receive',
  };
}

// ─── SMTP: Send auto-reply with full threading headers ────────────────────────
export async function sendAutoReply(opts: {
  smtp: EmailConfig['smtp'];
  from: string;
  to: string;
  subject: string;
  issueKey: string;
  issueUrl: string;
  autoReplyText: string;
  // RFC 2822 threading
  inReplyTo?: string;
  references?: string;
  outboundMessageId?: string;
}) {
  const smtpAuth: any = opts.smtp.oauthAccessToken
    ? { type: 'OAuth2', user: opts.smtp.user, accessToken: opts.smtp.oauthAccessToken }
    : { user: opts.smtp.user, pass: opts.smtp.password };

  const transporter = nodemailer.createTransport({
    host:   opts.smtp.host,
    port:   opts.smtp.port,
    secure: opts.smtp.secure,
    auth:   smtpAuth,
    tls:    { rejectUnauthorized: false },
  });

  // Ensure subject has ticket ID
  const subject = opts.subject.includes(`[${opts.issueKey}]`)
    ? opts.subject
    : `${opts.subject.replace(/^Re:\s*/i, 'Re: ')} [${opts.issueKey}]`;

  const fromName = process.env.EMAIL_FROM_NAME || 'CloudFuze Support';
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="background:#0052CC;padding:16px 24px">
        <span style="color:white;font-size:18px;font-weight:bold">${fromName}</span>
      </div>
      <div style="background:#10B981;padding:8px 24px">
        <span style="color:white;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Ticket Created Successfully</span>
      </div>
      <div style="padding:24px;background:#f9f9f9">
        <p style="color:#333;font-size:14px;margin:0 0 16px">${opts.autoReplyText}</p>
        <div style="margin:0 0 20px;padding:16px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;border-left:4px solid #0052CC">
          <p style="margin:0;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Your Support Ticket</p>
          <p style="margin:8px 0 0;font-size:22px;font-weight:bold;color:#0052CC">${opts.issueKey}</p>
          <p style="margin:6px 0 0;color:#555;font-size:13px">📌 ${opts.subject}</p>
          <p style="margin:12px 0 0">
            <a href="${opts.issueUrl}" style="display:inline-block;background:#0052CC;color:white;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600">View Ticket →</a>
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
    </div>
  `;

  // Build headers — this is what makes email threading work in mail clients
  const extraHeaders: Record<string, string> = {};
  if (opts.outboundMessageId) extraHeaders['Message-ID'] = opts.outboundMessageId;
  if (opts.inReplyTo)         extraHeaders['In-Reply-To'] = opts.inReplyTo;
  if (opts.references)        extraHeaders['References']  = opts.references;

  await transporter.sendMail({
    from:    `"${fromName}" <${opts.from}>`,
    to:      opts.to,
    subject,
    text:    `${opts.autoReplyText}\n\nYour support ticket: ${opts.issueKey}\nSubject: ${opts.subject}\nView ticket: ${opts.issueUrl}\n\nReply to this email to add a comment to your ticket.\nTicket reference: ${opts.issueKey}`,
    html,
    headers: extraHeaders,
  });
}

// ─── Multi-account IMAP Poller ───────────────────────────────────────────────
// Each email address gets its own poller instance, keyed by email address.
// This mirrors Jira Service Management: every board can have its own inbox.

interface PollerInstance {
  config:    EmailConfig;
  interval:  ReturnType<typeof setInterval>;
  running:   boolean;
  spaceKey:  string;
}

declare global {
  var __imapPollers:     Map<string, PollerInstance> | undefined;
  var __pollerConfigs:   Map<string, EmailConfig>    | undefined; // survives hot-reload
}
if (!globalThis.__imapPollers)       globalThis.__imapPollers       = new Map();
if (!globalThis.__pollerConfigs)     globalThis.__pollerConfigs     = new Map();
// Tracks message-IDs we've already processed so we don't create duplicate tickets
if (!(globalThis as any).__processedMsgIds)       (globalThis as any).__processedMsgIds       = new Set<string>();
if (!(globalThis as any).__processedMsgIdsLoaded) (globalThis as any).__processedMsgIdsLoaded = false;

/** Extract rich HTML body from a raw RFC 2822 message.
 *  - Handles text/plain, text/html, multipart/alternative, multipart/mixed, multipart/related
 *  - Decodes base64 and quoted-printable parts
 *  - Embeds inline images (cid: references) as data: URLs so they render in the browser
 *  - Sanitizes Outlook junk while keeping images, links, and formatting */
function extractBodyFromRawMessage(raw: string): string {
  if (!raw) return '';

  // Split headers from body at first blank line
  const headerBodySplit = raw.indexOf('\r\n\r\n');
  const bodyStart = headerBodySplit !== -1 ? headerBodySplit + 4 : raw.indexOf('\n\n') + 2;
  // Keep original-case headers — boundary value in body is case-sensitive
  const headersRaw = raw.slice(0, bodyStart);
  const headersLow = headersRaw.toLowerCase();
  const fullBody   = raw.slice(bodyStart);

  // Detect top-level content type
  const ctMatch = headersLow.match(/content-type:\s*([^\r\n;]+)/);
  const ct       = ctMatch ? ctMatch[1].trim() : '';
  const isTopB64 = headersLow.includes('content-transfer-encoding: base64') ||
                   headersLow.includes('content-transfer-encoding:base64');
  const isTopQP  = headersLow.includes('quoted-printable');

  // ── Single-part plain text ──────────────────────────────────────────────
  if (ct === 'text/plain') {
    let text = fullBody;
    if (isTopQP)  text = decodeQuotedPrintable(text);
    if (isTopB64) { try { text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8'); } catch {} }
    return autoLinkAndWrap(text.trim());
  }

  // ── Single-part HTML ────────────────────────────────────────────────────
  if (ct === 'text/html') {
    let html = fullBody;
    if (isTopQP)  html = decodeQuotedPrintable(html);
    if (isTopB64) { try { html = Buffer.from(html.replace(/\s/g, ''), 'base64').toString('utf8'); } catch {} }
    return sanitizeEmailHtml(html);
  }

  // ── Multipart — find boundary (case-sensitive match against body) ───────
  const boundaryMatch = headersRaw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) {
    // No boundary found — try to detect if fullBody is base64 HTML
    const trimmed = fullBody.trim();
    if (/^[A-Za-z0-9+/\r\n]+=*$/.test(trimmed) && trimmed.length > 20) {
      try {
        const decoded = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf8');
        if (/<[a-zA-Z]/.test(decoded)) return sanitizeEmailHtml(decoded);
        return autoLinkAndWrap(decoded);
      } catch {}
    }
    return autoLinkAndWrap(fullBody.trim());
  }

  const boundaryVal = boundaryMatch[1].trim();
  const boundaryEsc = '--' + boundaryVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts       = fullBody.split(new RegExp(boundaryEsc));

  let htmlText  = '';
  let plainText = '';
  // Map of Content-ID → data: URL for inline image embedding
  const cidMap: Record<string, string> = {};

  for (const part of parts) {
    const phEnd = part.indexOf('\r\n\r\n') !== -1
      ? part.indexOf('\r\n\r\n') + 4
      : (part.indexOf('\n\n') !== -1 ? part.indexOf('\n\n') + 2 : -1);
    if (phEnd < 2) continue;

    const ph      = part.slice(0, phEnd).toLowerCase();
    const pbRaw   = part.slice(phEnd);

    const partCtM = ph.match(/content-type:\s*([^\r\n;]+)/);
    const partCt  = partCtM ? partCtM[1].trim() : '';
    const pIsQP   = ph.includes('quoted-printable');
    const pIsB64  = ph.includes('base64');

    // ── Collect inline images — replace cid: refs later ──────────────────
    if (partCt.startsWith('image/')) {
      const cidMatch   = ph.match(/content-id:\s*<([^>]+)>/);
      const cidVal     = cidMatch ? cidMatch[1].trim() : '';
      if (cidVal && pIsB64) {
        const b64clean = pbRaw.replace(/\s/g, '');
        cidMap[cidVal] = `data:${partCt};base64,${b64clean}`;
      }
      continue;
    }

    // ── Text/plain part ───────────────────────────────────────────────────
    if (partCt === 'text/plain' && !plainText) {
      let text = pbRaw;
      if (pIsQP)  text = decodeQuotedPrintable(text);
      if (pIsB64) { try { text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8'); } catch {} }
      plainText = text.trim();
      continue;
    }

    // ── Text/html part ────────────────────────────────────────────────────
    if (partCt === 'text/html' && !htmlText) {
      let html = pbRaw;
      if (pIsQP)  html = decodeQuotedPrintable(html);
      if (pIsB64) { try { html = Buffer.from(html.replace(/\s/g, ''), 'base64').toString('utf8'); } catch {} }
      htmlText = html;
      continue;
    }

    // ── Nested multipart (alternative/related/mixed) — recurse ───────────
    if (partCt.startsWith('multipart/') && !htmlText) {
      const nested = extractBodyFromRawMessage(part.slice(0, phEnd) + '\r\n' + part.slice(phEnd));
      if (nested) htmlText = nested;
    }
  }

  // ── Embed inline images: replace cid: references with data: URLs ────────
  if (htmlText && Object.keys(cidMap).length > 0) {
    for (const [cid, dataUrl] of Object.entries(cidMap)) {
      const cidEsc = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      htmlText = htmlText.replace(new RegExp(`cid:${cidEsc}`, 'gi'), dataUrl);
    }
  }

  // ── Return best available content ────────────────────────────────────────
  if (htmlText) return sanitizeEmailHtml(htmlText);
  if (plainText) return autoLinkAndWrap(plainText);
  return '';
}

/** Auto-link URLs in plain text and wrap paragraphs in <p> tags. */
function autoLinkAndWrap(text: string): string {
  if (!text) return '';
  const linked = text.replace(
    /(https?:\/\/[^\s<>"')\]]+)/gi,
    url => {
      const clean = url.replace(/[.,;!?]+$/, '');
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
    }
  );
  return linked
    .split(/\n\n+/)
    .map(p => p.trim() ? `<p>${p.trim().replace(/\n/g, '<br/>')}</p>` : '')
    .filter(Boolean)
    .join('');
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '')                           // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Fully strip all HTML to plain text (used for thread detection only).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Take a clean plain-text email body and inject named hyperlinks extracted from
 * the HTML part. This gives us:
 *   - Clean text (no Outlook reading-pane junk — that's only in the HTML)
 *   - Clickable links (href preserved from HTML <a> tags)
 *
 * Outlook plain-text format for named links:
 *   "Software project configuration - Jira <https://example.com>"
 * We also match just the visible text against HTML <a> tags.
 */
function mergeLinksIntoPlainText(plain: string, html: string): string {
  if (!plain) return '';

  // Step 1: auto-link raw URLs already in plain text (http://..., https://...)
  let result = plain.replace(
    /(https?:\/\/[^\s<>"')\]]+)/gi,
    url => {
      const clean = url.replace(/[.,;!?]+$/, '');
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
    }
  );

  // Step 2: handle Outlook's plain-text link format: "Link text <https://url>"
  result = result.replace(
    /([^\n<]+?)\s+<(https?:\/\/[^>]+)>/g,
    (_, text, url) => {
      const cleanText = text.trim();
      const cleanUrl  = url.trim().replace(/[.,;!?]+$/, '');
      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${cleanText}</a>`;
    }
  );

  // Step 3: extract named links from HTML and inject into plain text by matching visible text
  if (html) {
    const linkPattern = /<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(html)) !== null) {
      const href = m[1].trim();
      const visibleText = m[2].replace(/<[^>]+>/g, '').trim(); // strip inner HTML tags
      if (!visibleText || visibleText.startsWith('http')) continue;
      // Inject link only if not already a link and text exists in result
      const escapedText = visibleText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const textRegex = new RegExp(`(?<!href=["'][^"']*|">)${escapedText}(?!</a>)`, 'g');
      result = result.replace(textRegex,
        `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${visibleText}</a>`
      );
    }
  }

  // Step 4: wrap paragraphs in <p> tags
  const wrapped = result
    .split(/\n\n+/)
    .map(para => para.trim() ? `<p>${para.trim().replace(/\n/g, '<br/>')}</p>` : '')
    .filter(Boolean)
    .join('');

  return wrapped || result;
}

/**
 * Sanitize HTML email body — render it like the email looks, preserving:
 *  - Images (inline data: URLs and http:// linked images)
 *  - Clickable links (<a href>)
 *  - Basic formatting (bold, italic, lists, tables)
 *  - Text content
 *
 * Strips:
 *  - <script>, <style>, <head>, Outlook conditional comments
 *  - Outlook namespace tags (<o:p>, <w:>, <v:>)
 *  - Dangerous event handlers (onclick etc.)
 *  - Quoted reply blocks (--- Original Message ---)
 *  - Outlook reading-pane junk (x_ classes, divRplyFwdMsg etc.)
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';

  // If the entire body looks like base64 (common when Graph/EWS returns encoded body)
  // decode it first
  const trimmed = html.trim();
  if (/^[A-Za-z0-9+/\r\n]+=*$/.test(trimmed) && trimmed.length > 40 && !/<[a-zA-Z]/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf8');
      if (decoded && decoded.length > 0) html = decoded;
    } catch {}
  }

  let h = html;

  // 1. Strip Outlook conditional comments
  h = h.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Strip <head>, <style>, <script> blocks entirely
  h = h.replace(/<head[\s\S]*?<\/head>/gi, '');
  h = h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // 3. Strip Outlook namespace tags: <o:p>, <w:sdt>, <v:shape>, etc.
  h = h.replace(/<\/?[ovwmbp]:[^>]*>/gi, '');

  // 4. Remove dangerous event attributes
  h = h.replace(/\s+on\w+="[^"]*"/gi, '');
  h = h.replace(/\s+on\w+='[^']*'/gi, '');

  // 5. Strip quoted-reply blocks (plain text patterns embedded in HTML)
  h = h.replace(/(<div[^>]*>)?\s*[-_]{3,}\s*(Original Message|Forwarded Message)[\s\S]*/i, '');
  h = h.replace(/On .{5,80} wrote:[\s\S]*/i, '');

  // 5b. Strip <blockquote> elements entirely (they contain the quoted thread)
  // Use a loop to handle nesting: replace inner blockquotes first, then outer
  let bqPrev = '';
  while (bqPrev !== h) {
    bqPrev = h;
    h = h.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '');
  }

  // 5c. Strip Outlook's blue-line reply header divs
  //     e.g. <div style="...border-top:solid #E1E1E1..."> or border-top:1pt solid
  h = h.replace(/<div[^>]*style="[^"]*border(?:-top)?:[^"]*solid[^"]*"[^>]*>[\s\S]*$/i, '');
  // Strip from the <hr> separator Outlook inserts before the quoted block
  h = h.replace(/<hr[^>]*\/?>\s*<div[^>]*>[\s\S]*$/i, '');

  // 6. Strip Outlook reading-pane preview divs (x_ classes, divRplyFwdMsg, etc.)
  //    Use iterative replacement to handle deeply nested structures
  let prev = '';
  while (prev !== h) {
    prev = h;
    h = h.replace(/<div[^>]*class="[^"]*(?:x_|ReadMsgBody|ExternalClass|OutlookMessageHeader)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    h = h.replace(/<div[^>]*id="[^"]*(?:divRplyFwdMsg|Signature|appendonsend)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  }

  // 7. Clean <img> tags — keep src (data: and https:), strip dangerous ones; add display style
  h = h.replace(/<img\s+([^>]*)>/gi, (_, attrs) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
    const alt = altMatch ? altMatch[1] : 'image';
    // Allow data: URLs (embedded images) and http/https URLs
    if (!src) return '';
    if (src.startsWith('data:image/') || /^https?:\/\//i.test(src)) {
      return `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:4px;margin:4px 0;" />`;
    }
    // cid: references that weren't replaced — skip them (image not available)
    return src.startsWith('cid:') ? '' : '';
  });

  // 8. Clean <a> tags — keep ANY href that looks like a real URL, add target=_blank
  h = h.replace(/<a\s+([^>]*)>/gi, (_, attrs) => {
    const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
    let href = hrefMatch ? hrefMatch[1].trim() : '';
    if (!href || href === '#') return '<a>';
    // Add https:// to bare www. links
    if (/^www\./i.test(href)) href = 'https://' + href;
    // Allow: https, http, ftp, mailto, and bare www. (already prefixed above)
    // Block only javascript: and data: (security risk)
    if (/^javascript:/i.test(href) || /^data:/i.test(href)) return '<a>';
    // For anything else that doesn't have a scheme, add https://
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) href = 'https://' + href;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">`;
  });

  // 9. Auto-link bare URLs not already in <a> tags — catches https://, http://, and www.
  // Match https?:// URLs
  h = h.replace(/(?<![='"#>])(https?:\/\/[^\s<>"')\]]{4,})/gi, (url) => {
    const clean = url.replace(/[.,;!?]+$/, '');
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
  });
  // Match www. URLs not already in a tag
  h = h.replace(/(?<![='"#>/])(www\.[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}[^\s<>"')\]]*)/gi, (url) => {
    const clean = url.replace(/[.,;!?]+$/, '');
    return `<a href="https://${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
  });

  // 10. Remove unsafe tags but keep content; keep block structure via <br>
  const SAFE_TAGS = new Set([
    'a','b','strong','em','i','u','s','strike','p','br','hr',
    'ul','ol','li','blockquote','pre','code',
    'img',
    'span','div',
    'table','thead','tbody','tr','td','th',
    'h1','h2','h3','h4','h5','h6',
  ]);
  // Block-level tags whose class/style should be stripped (Outlook/Gmail add lots of noise here)
  const STRIP_ATTRS_TAGS = new Set(['div','p','span','td','th','tr','table','thead','tbody','ul','ol','li','blockquote']);
  h = h.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*)>/g, (tag, slash, name, attrs) => {
    const n = name.toLowerCase();
    if (!SAFE_TAGS.has(n)) {
      // Unknown block tags → line break so content doesn't run together
      const blockLike = new Set(['section','article','aside','header','footer','nav','main','figure','figcaption']);
      return blockLike.has(n) ? (slash ? '' : '<br/>') : '';
    }
    // For block elements, strip class and style attributes (removes Outlook elementToProof, Gmail extra styling)
    if (!slash && STRIP_ATTRS_TAGS.has(n)) {
      // Keep only dir attribute on some elements
      return `<${n}>`;
    }
    return tag;
  });

  // 11. Decode HTML entities
  h = h
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

  // 12. Collapse excessive blank lines
  h = h.replace(/(\s*<br\s*\/?>\s*){3,}/gi, '<br/><br/>');
  h = h.replace(/(\n\s*){3,}/g, '\n\n').trim();

  return h;
}

/**
 * Strip quoted/forwarded content from a reply email body.
 * Keeps only the new text the sender wrote — removes:
 *   - Lines starting with ">" (quoted lines)
 *   - Everything after "-----Original Message-----"
 *   - Everything after "From: ... Sent: ... To: ..." reply headers (line-start OR inline)
 *   - Everything after "On <date> <name> wrote:"
 *   - CloudFuze auto-reply boilerplate
 */
export function stripQuotedContent(text: string): string {
  if (!text) return '';

  // ── 1. Cut at inline "From: X Sent: Y" patterns (Outlook reply block embedded in same line)
  // e.g. "Hi bhanu this is the problem From: Bhanu Srikakulam Sent: 20 May..."
  const inlineSplit = text.replace(
    /\s+From:\s+.{1,80}Sent:\s+\d/gi,
    '\n<<<CUT>>>'
  );
  const cutIndex = inlineSplit.indexOf('\n<<<CUT>>>');
  const cleaned = cutIndex !== -1 ? text.slice(0, cutIndex) : text;

  // ── 2. Line-by-line filter
  const lines = cleaned.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Stop at block-level quoted markers
    if (
      trimmed.startsWith('-----Original Message-----') ||
      trimmed.startsWith('________________________________') ||
      /^-{3,}\s*Original Message\s*-{3,}/i.test(trimmed) ||
      /^On .{5,} wrote:$/i.test(trimmed) ||
      /^From:\s+.+Sent:\s+/i.test(trimmed) ||
      // Outlook multiline reply header: "From: Name <email@...>"
      /^From:\s+.+[<@].+[>@]/i.test(trimmed) ||
      // Outlook reply header standalone "Sent: " line right after a From: line
      /^Sent:\s+\d{1,2}\s+\w+\s+\d{4}/i.test(trimmed) ||
      // CloudFuze auto-reply boilerplate
      trimmed.includes('CloudFuze Support') ||
      trimmed.includes('Thank you for contacting us') ||
      trimmed.includes('Your support ticket:') ||
      trimmed.includes('Reply to this email to add a comment') ||
      trimmed.includes('Your ticket reference:')
    ) {
      break;
    }

    // Skip pure quote lines ("> text")
    if (/^>/.test(trimmed)) continue;

    result.push(line);
  }

  // Trim trailing blank lines
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }

  return result.join('\n').trim();
}

// Legacy single-poller shims (kept for backward compat)
let pollerRunning = false;
let pollerInterval: ReturnType<typeof setInterval> | null = null;

interface ParsedEmail {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  attachments: Array<{ filename: string; contentType: string; size: number; content?: string }>;
}

export function startImapPoller(
  config: EmailConfig,
  onEmail: (data: ParsedEmail) => Promise<void>
) {
  const emailKey = config.imap.user.toLowerCase();

  // If a poller already exists for this address, stop it first then restart
  if (globalThis.__imapPollers!.has(emailKey)) {
    const existing = globalThis.__imapPollers!.get(emailKey)!;
    clearInterval(existing.interval);
    globalThis.__imapPollers!.delete(emailKey);
  }

  // Also update legacy flag
  pollerRunning = true;

  // Persist config so we can auto-restart after hot-reload
  globalThis.__pollerConfigs!.set(emailKey, config);

  // ── Self-bootstrap: ensure __processedMsgIds is loaded from DB ──────────
  // This runs ONCE per poller start so the poller works immediately without
  // waiting for /api/email/reconnect to be called first.
  if (!(globalThis as any).__processedMsgIdsLoaded) {
    (globalThis as any).__processedMsgIdsLoaded = true;
    (async () => {
      try {
        const { Pool } = await import('pg');
        const DB = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';
        const pool = new Pool({ connectionString: DB });
        await pool.query(`
          CREATE TABLE IF NOT EXISTS processed_emails (
            message_id TEXT PRIMARY KEY,
            processed_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        const res = await pool.query(`SELECT message_id FROM processed_emails`);
        await pool.end();
        const ids = (globalThis as any).__processedMsgIds as Set<string>;
        res.rows.forEach((r: any) => { if (r.message_id) ids.add(r.message_id); });
        console.log(`[EmailPoller] Bootstrapped ${res.rows.length} processed message IDs from DB`);
      } catch (e) {
        console.error('[EmailPoller] Failed to bootstrap processedMsgIds:', e);
      }
    })();
  }

  // ── Also ensure email_configs table has this entry ───────────────────────
  (async () => {
    try {
      const { Pool } = await import('pg');
      const DB = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';
      const pool = new Pool({ connectionString: DB });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS email_configs (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          space_key TEXT NOT NULL, address TEXT NOT NULL,
          imap_host TEXT NOT NULL DEFAULT 'outlook.office365.com', imap_port INT NOT NULL DEFAULT 993,
          smtp_host TEXT NOT NULL DEFAULT 'smtp.office365.com',   smtp_port INT NOT NULL DEFAULT 587,
          password_enc TEXT, auto_reply BOOLEAN DEFAULT true, auto_reply_text TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(space_key, address)
        )
      `);
      await pool.query(`
        INSERT INTO email_configs (space_key, address, imap_host, imap_port, smtp_host, smtp_port, auto_reply)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (space_key, address) DO UPDATE SET
          imap_host=EXCLUDED.imap_host, smtp_host=EXCLUDED.smtp_host, auto_reply=EXCLUDED.auto_reply
      `, [config.spaceKey, config.imap.user, config.imap.host, config.imap.port,
          config.smtp?.host || 'smtp.office365.com', config.smtp?.port || 587, true]);
      await pool.end();
      console.log(`[EmailPoller] Config persisted for ${config.imap.user} → space ${config.spaceKey}`);
    } catch (e) {
      console.error('[EmailPoller] Failed to persist email config:', e);
    }
  })();

  console.log(`[EmailPoller] Starting for ${config.imap.user} → space ${config.spaceKey}`);

  // ── Get a Graph-scoped token from the stored refresh token ─────────────────
  // Even if the current access token has Exchange audience, the refresh token
  // can be exchanged for a Graph-scoped token if the app has Graph permissions.
  async function getGraphScopedToken(): Promise<string | null> {
    try {
      const { getOAuthTokens } = await import('@/lib/oauth-service');
      const stored = getOAuthTokens(config.imap.user);
      if (!stored?.refreshToken) return null;

      const clientId     = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
      if (!clientId || !clientSecret) return null;

      const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     clientId,
          client_secret: clientSecret,
          refresh_token: stored.refreshToken,
          scope:         'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access email openid profile',
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn(`[EmailPoller] Could not get Graph token for ${config.imap.user} (${res.status}): ${err}`);
        return null;
      }
      const data = await res.json();
      console.log(`[EmailPoller] Got Graph-scoped token for ${config.imap.user}`);
      return data.access_token || null;
    } catch (e) {
      console.error('[EmailPoller] getGraphScopedToken error:', e);
      return null;
    }
  }

  // ── Microsoft polling: try Graph API only if we can get a Graph-scoped token ─
  // Returns true if handled (Graph API ran), false to signal caller to try IMAP.
  async function pollViaMicrosoft(exchangeToken: string): Promise<boolean> {
    const graphToken = await getGraphScopedToken();
    if (graphToken) {
      console.log(`[EmailPoller] Using Graph API for ${config.imap.user}`);
      await pollViaGraphApi(graphToken);
      return true; // handled
    }
    // No Graph token — tell caller to fall back to IMAP
    return false;
  }

  // ── EWS polling — uses Exchange/IMAP token (aud: outlook.office365.com) ─────
  async function pollViaEws(token: string) {
    try {
      const since = new Date(); since.setDate(since.getDate() - 3);
      const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');

      const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013_SP1"/>
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="25" Offset="0" BasePoint="Beginning"/>
      <m:Restriction>
        <t:IsGreaterThanOrEqualTo>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURIOrConstant><t:Constant Value="${sinceStr}"/></t:FieldURIOrConstant>
        </t:IsGreaterThanOrEqualTo>
      </m:Restriction>
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

      const res = await fetch('https://outlook.office365.com/EWS/Exchange.asmx', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'text/xml; charset=utf-8',
          'Accept':        'text/xml',
        },
        body: soapBody,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[EmailPoller] EWS ${res.status} for ${config.imap.user}: ${errText.slice(0, 300)}`);
        return;
      }

      const xml = await res.text();
      console.log(`[EmailPoller] EWS response for ${config.imap.user} (${xml.length} bytes)`);

      // Parse EWS XML response — extract Message elements
      const itemMatches = [...xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)];
      console.log(`[EmailPoller] EWS: found ${itemMatches.length} messages`);

      if (!(globalThis as any).__processedMsgIds) (globalThis as any).__processedMsgIds = new Set<string>();
      const processedIds: Set<string> = (globalThis as any).__processedMsgIds;

      for (const match of itemMatches) {
        const part = match[1];

        const getTag = (tag: string) => {
          const m = part.match(new RegExp(`<(?:t:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:t:)?${tag}>`, 'i'));
          return m ? m[1].trim() : '';
        };

        const msgId   = getTag('InternetMessageId') || `<ews_${Date.now()}>`;
        const subject = getTag('Subject') || '(no subject)';
        const fromName  = getTag('Name');
        const fromAddr  = getTag('EmailAddress');
        const from    = fromAddr || 'unknown@sender.com';
        const to      = config.address;

        // Get body via GetItem if needed (FindItem may not return body)
        let body = subject;
        const itemId = part.match(/<t:ItemId Id="([^"]+)"/)?.[1];
        if (itemId) {
          try {
            const getItemSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Body"/>
        </t:AdditionalProperties>
        <t:BodyType>Text</t:BodyType>
      </m:ItemShape>
      <m:ItemIds><t:ItemId Id="${itemId}"/></m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
            const gr = await fetch('https://outlook.office365.com/EWS/Exchange.asmx', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8' },
              body: getItemSoap,
            });
            if (gr.ok) {
              const gxml = await gr.text();
              const bm = gxml.match(/<t:Body[^>]*>([\s\S]*?)<\/t:Body>/i);
              if (bm) body = bm[1].trim() || body;
            }
          } catch {}
        }

        if (processedIds.has(msgId)) continue;

        console.log(`[EmailPoller] EWS email: "${subject}" from ${from}`);
        try {
          await onEmail({ from, to, cc: '', subject, body, messageId: msgId, inReplyTo: '', references: '', attachments: [] });
          const webhookResult = (globalThis as any).__lastWebhookResult as { ok: boolean } | undefined;
          if (!webhookResult || webhookResult.ok !== false) {
            processedIds.add(msgId);
          } else {
            console.warn(`[EmailPoller] EWS: webhook failed for "${subject}" — will retry`);
          }
        } catch (e) {
          console.error('[EmailPoller] EWS email processing error:', e);
        }
      }
    } catch (e) {
      console.error(`[EmailPoller] EWS error for ${config.imap.user}:`, e);
    }
  }

  // ── Graph API polling — fallback for accounts with Graph-scoped tokens ────
  async function pollViaGraphApi(token: string) {
    try {
      const since = new Date(); since.setDate(since.getDate() - 3);
      const sinceStr = since.toISOString();
      const url = `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages` +
        `?$top=25&$orderby=receivedDateTime desc` +
        `&$filter=receivedDateTime ge ${sinceStr}` +
        `&$select=id,subject,from,toRecipients,ccRecipients,body,internetMessageId,receivedDateTime,hasAttachments`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[EmailPoller] Graph API ${res.status} for ${config.imap.user}: ${errText}`);
        return;
      }

      const data = await res.json();
      const msgs: any[] = data.value || [];
      console.log(`[EmailPoller] Graph API: ${msgs.length} messages for ${config.imap.user}`);

      if (!(globalThis as any).__processedMsgIds) (globalThis as any).__processedMsgIds = new Set<string>();
      const processedIds: Set<string> = (globalThis as any).__processedMsgIds;

      for (const gm of msgs) {
        const msgId = gm.internetMessageId || `<graph_${gm.id}>`;
        if (processedIds.has(msgId)) continue;

        const from    = gm.from?.emailAddress?.address || 'unknown@sender.com';
        const to      = gm.toRecipients?.[0]?.emailAddress?.address || config.address;
        const cc      = (gm.ccRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');
        const subject = gm.subject || '(no subject)';
        let   body    = gm.body?.content || subject;

        // ── Fetch inline images and embed as data: URLs ─────────────────────
        // Graph body.content contains <img src="cid:..."> for inline images.
        // We must fetch the actual attachment bytes and replace each cid: ref.
        // NOTE: Graph API sometimes reports hasAttachments=false even when
        // inline images exist. Always fetch when body contains a cid: reference.
        const hasCidRef = body.includes('cid:');
        if (gm.id && (gm.hasAttachments || hasCidRef)) {
          try {
            const attRes = await fetch(
              `https://graph.microsoft.com/v1.0/me/messages/${gm.id}/attachments`,
              { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
            );
            if (attRes.ok) {
              const attData = await attRes.json();
              const attachments: any[] = attData.value || [];
              for (const att of attachments) {
                // Inline image: has contentId and isInline flag
                const cid = att.contentId || '';
                if (att.isInline && cid && att.contentBytes) {
                  const contentType = att.contentType || 'image/png';
                  const dataUrl = `data:${contentType};base64,${att.contentBytes}`;
                  // Replace cid: reference in body (with and without angle brackets)
                  const cidClean = cid.replace(/^<|>$/g, '');
                  body = body.replace(new RegExp(`cid:${cidClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), dataUrl);
                  body = body.replace(new RegExp(`cid:&lt;${cidClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&gt;`, 'gi'), dataUrl);
                }
              }
              console.log(`[EmailPoller] Graph: embedded ${attachments.filter((a: any) => a.isInline).length} inline image(s) for "${subject}"`);
            }
          } catch (attErr) {
            console.warn(`[EmailPoller] Graph: failed to fetch attachments for "${subject}":`, attErr);
          }
        }

        console.log(`[EmailPoller] Graph email: "${subject}" from ${from} to ${to}`);
        try {
          await onEmail({ from, to, cc, subject, body, messageId: msgId, inReplyTo: '', references: '', attachments: [] });
          const webhookResult = (globalThis as any).__lastWebhookResult as { ok: boolean } | undefined;
          if (!webhookResult || webhookResult.ok !== false) {
            processedIds.add(msgId);
          } else {
            console.warn(`[EmailPoller] Graph: webhook failed for "${subject}" — will retry`);
          }
        } catch (e) {
          console.error('[EmailPoller] Graph email processing error:', e);
        }
      }
    } catch (e) {
      console.error(`[EmailPoller] Graph API error for ${config.imap.user}:`, e);
    }
  }

  async function pollOnce() {
    console.log(`[EmailPoller] Poll starting for ${config.imap.user}`);
    // Refresh OAuth token if needed
    let accessToken = config.imap.oauthAccessToken;
    if (config.imap.oauthProvider && config.imap.oauthRefreshToken) {
      try {
        const { getValidAccessToken } = await import('@/lib/oauth-service');
        accessToken = await getValidAccessToken(config.imap.user) ?? accessToken;
      } catch {}
    }

    // ── Microsoft accounts: Graph API (if app has consent) → else IMAP ─────
    if ((config.imap.oauthProvider === 'microsoft' || config.imap.host?.includes('outlook')) && accessToken) {
      const handledByGraph = await pollViaMicrosoft(accessToken);
      if (handledByGraph) return; // Graph API handled it — skip IMAP
      // No Graph token available → fall through to IMAP below
      console.log(`[EmailPoller] No Graph token for ${config.imap.user}, trying IMAP...`);
    }

    const auth: Record<string, unknown> = accessToken
      ? { user: config.imap.user, accessToken }
      : { user: config.imap.user, pass: config.imap.password };

    const client = new ImapFlow({
      host:   config.imap.host,
      port:   config.imap.port,
      secure: config.imap.secure,
      auth:   auth as any,
      logger: false,
      tls: { rejectUnauthorized: false },
    });

    // Prevent ECONNRESET / socket errors from becoming uncaughtExceptions
    client.on('error', (err: any) => {
      console.error('[EmailPoller] IMAP socket error (handled):', err?.message || err);
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const messages = [];

        // Fetch all messages received in the last 3 days (read or unread)
        // We track processed messageIds ourselves to avoid duplicate processing
        const since = new Date();
        since.setDate(since.getDate() - 3);

        console.log(`[EmailPoller] Fetching messages since ${since.toISOString().split('T')[0]} for ${config.imap.user}`);

        // Always fall back to empty Set so the poller works even before reconnect initialises it
        if (!(globalThis as any).__processedMsgIds) {
          (globalThis as any).__processedMsgIds = new Set<string>();
        }
        const processedIds: Set<string> = (globalThis as any).__processedMsgIds;

        for await (const msg of client.fetch(
          { since },
          { envelope: true, source: true, bodyStructure: true, headers: true }
        )) {
          const msgId = msg.envelope?.messageId || `uid_${msg.uid}`;
          // Skip already processed messages
          if (processedIds.has(msgId)) continue;
          messages.push(msg);
        }

        console.log(`[EmailPoller] Found ${messages.length} new message(s) to process for ${config.imap.user}`);

        for (const msg of messages) {
          const env = msg.envelope || {};
          const from    = (env.from?.[0]?.address) || 'unknown@sender.com';
          const to      = (env.to?.[0]?.address)   || config.address;
          const cc      = (env.cc || []).map((a: any) => a.address).filter(Boolean).join(', ');
          const subject = env.subject || '(no subject)';

          // Extract body from raw source — handles all MIME structures
          const body = extractBodyFromRawMessage(msg.source?.toString() || '');
          const msgId   = env.messageId || `<msg_${Date.now()}@cloudfuze.com>`;

          // Extract RFC 2822 threading headers from raw headers
          let inReplyTo = '';
          let references = '';
          if (msg.headers) {
            const rawHeaders = msg.headers.toString();
            const inReplyToMatch = rawHeaders.match(/^In-Reply-To:\s*(.+)$/im);
            const referencesMatch = rawHeaders.match(/^References:\s*([\s\S]+?)(?=\r?\n\S|\r?\n\r?\n|$)/im);
            if (inReplyToMatch) inReplyTo = inReplyToMatch[1].trim();
            if (referencesMatch) references = referencesMatch[1].replace(/\r?\n\s+/g, ' ').trim();
          }

          // Extract attachments from body structure
          const attachments: ParsedEmail['attachments'] = [];
          if (msg.bodyStructure) {
            const walkParts = (part: any) => {
              if (!part) return;
              if (part.disposition === 'attachment' || (part.type !== 'text' && part.type !== 'multipart')) {
                attachments.push({
                  filename:    part.parameters?.name || part.dispositionParameters?.filename || 'attachment',
                  contentType: `${part.type}/${part.subtype}`,
                  size:        part.size || 0,
                });
              }
              if (part.childNodes) part.childNodes.forEach(walkParts);
            };
            walkParts(msg.bodyStructure);
          }

          console.log(`[EmailPoller] Email from ${from}: "${subject}"${inReplyTo ? ` (reply to ${inReplyTo})` : ' (new)'}`);

          try {
            await onEmail({ from, to, cc, subject, body, messageId: msgId, inReplyTo, references, attachments });
            // Only mark as processed if the webhook call SUCCEEDED (returned ok:true).
            // If webhook failed (space not found, DB error etc.) we do NOT add to processedIds
            // so the next poll will retry.
            // onEmail calls fetch() internally — we check the response via a shared result slot.
            const webhookResult = (globalThis as any).__lastWebhookResult as { ok: boolean } | undefined;
            const webhookOk = !webhookResult || webhookResult.ok !== false;
            if (webhookOk) {
              processedIds.add(msgId);
              await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']).catch(() => {});
            } else {
              console.warn(`[EmailPoller] Webhook returned ok:false for msgId ${msgId} — will retry next poll`);
            }
          } catch (err) {
            console.error('[EmailPoller] Failed to process email:', err);
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      console.error('[EmailPoller] IMAP error:', err);
    }
  }

  pollOnce().catch(err => console.error('[EmailPoller] pollOnce unhandled error:', err));
  const interval = setInterval(() => {
    pollOnce().catch(err => console.error('[EmailPoller] pollOnce unhandled error:', err));
  }, 30000);
  pollerInterval = interval; // legacy shim

  // Register in multi-poller map
  globalThis.__imapPollers!.set(emailKey, {
    config,
    interval,
    running: true,
    spaceKey: config.spaceKey,
  });
}

/** Stop poller for a specific email address */
export function stopImapPollerForEmail(email: string) {
  const key = email.toLowerCase();
  const instance = globalThis.__imapPollers!.get(key);
  if (instance) {
    clearInterval(instance.interval);
    globalThis.__imapPollers!.delete(key);
    console.log(`[EmailPoller] Stopped poller for ${email}`);
  }
}

/** Stop ALL pollers */
export function stopImapPoller() {
  Array.from(globalThis.__imapPollers!.entries()).forEach(([email, instance]) => {
    clearInterval(instance.interval);
    console.log(`[EmailPoller] Stopped poller for ${email}`);
  });
  globalThis.__imapPollers!.clear();
  if (pollerInterval) clearInterval(pollerInterval);
  pollerRunning = false;
  pollerInterval = null;
  console.log('[EmailPoller] All pollers stopped.');
}

/** Get all active pollers info */
export function getActivePollers(): Array<{ email: string; spaceKey: string }> {
  return Array.from(globalThis.__imapPollers!.entries()).map(([email, inst]) => ({
    email,
    spaceKey: inst.spaceKey,
  }));
}

/** Check if a specific email is already being polled */
export function isPollerActiveForEmail(email: string): boolean {
  return globalThis.__imapPollers!.has(email.toLowerCase());
}

// ─── Test connections ──────────────────────────────────────────────────────────
export async function testSmtpConnection(smtp: EmailConfig['smtp']): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.password },
      tls: { rejectUnauthorized: false },
    });
    await t.verify();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function testImapConnection(imap: EmailConfig['imap']): Promise<{ ok: boolean; error?: string; unread?: number }> {
  const client = new ImapFlow({
    host: imap.host, port: imap.port, secure: imap.secure,
    auth: { user: imap.user, pass: imap.password },
    logger: false, tls: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const status = await client.status('INBOX', { unseen: true });
    await client.logout();
    return { ok: true, unread: status.unseen ?? 0 };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── Auto-restart pollers after hot-reload ────────────────────────────────────
// On every module reload (hot-reload or cold start):
//  1. Clear ALL existing pollers — their setInterval closures capture old code
//  2. Re-read configs from __pollerConfigs and restart with the CURRENT code
// This ensures code changes (body parsing, polling strategy) take effect immediately.
(async () => {
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
  const webhookUrl = `${appUrl}/api/email/receive`;

  if (globalThis.__pollerConfigs!.size > 0) {
    // Stop all old pollers — their closures reference old code
    for (const [, instance] of Array.from(globalThis.__imapPollers!.entries())) {
      try { clearInterval(instance.interval); } catch {}
    }
    globalThis.__imapPollers!.clear();
    console.log('[EmailPoller] Cleared stale pollers on module reload — restarting with new code...');
  }

  for (const [emailKey, config] of Array.from(globalThis.__pollerConfigs!.entries())) {
    console.log(`[EmailPoller] Restarting poller for ${emailKey} with updated code`);
    startImapPoller(config, async (email) => {
      await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          from: email.from, to: email.to, cc: email.cc,
          subject: email.subject, body: email.body,
          messageId: email.messageId, inReplyTo: email.inReplyTo,
          references: email.references, attachments: email.attachments,
        }),
      }).catch(() => {});
    });
  }
})();
