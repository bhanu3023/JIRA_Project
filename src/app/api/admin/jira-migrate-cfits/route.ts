/**
 * POST /api/admin/jira-migrate-cfits
 *
 * Bulk-migrates tickets from Jira CFITS project into L1BOAR space (Migration queue).
 * Syncs comments and changelog (history) for each ticket.
 *
 * Body: { jiraUrl, email, apiToken, department? }
 *   - jiraUrl:    e.g. "https://cf2020.atlassian.net"
 *   - email:      Jira account email
 *   - apiToken:   Jira API token
 *   - department: target department/queue (default: "Migration")
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

function rid() {
  return `mig_${Math.random().toString(36).slice(2, 12)}`;
}

function adfNodeToHtml(node: any): string {
  if (!node) return '';
  if (node.type === 'doc') return (node.content || []).map(adfNodeToHtml).join('');
  if (node.type === 'paragraph') { const i = (node.content||[]).map(adfNodeToHtml).join(''); return i.trim() ? `<p>${i}</p>` : ''; }
  if (node.type === 'text') {
    let t = (node.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    for (const m of (node.marks || [])) {
      if (m.type === 'strong') t = `<strong>${t}</strong>`;
      else if (m.type === 'em') t = `<em>${t}</em>`;
      else if (m.type === 'underline') t = `<u>${t}</u>`;
      else if (m.type === 'strike') t = `<s>${t}</s>`;
      else if (m.type === 'code') t = `<code>${t}</code>`;
      else if (m.type === 'link') {
        const href = (m.attrs?.href || '#').replace(/"/g, '&quot;');
        t = `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      }
    }
    return t;
  }
  if (node.type === 'hardBreak') return '<br/>';
  if (node.type === 'bulletList') return `<ul>${(node.content||[]).map(adfNodeToHtml).join('')}</ul>`;
  if (node.type === 'orderedList') return `<ol>${(node.content||[]).map(adfNodeToHtml).join('')}</ol>`;
  if (node.type === 'listItem') return `<li>${(node.content||[]).map(adfNodeToHtml).join('')}</li>`;
  if (node.type === 'heading') { const lvl = Math.min(Math.max(node.attrs?.level||2, 1), 6); return `<h${lvl}>${(node.content||[]).map(adfNodeToHtml).join('')}</h${lvl}>`; }
  if (node.type === 'codeBlock') return `<pre><code>${(node.content||[]).map((n:any) => (n.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('')}</code></pre>`;
  if (node.type === 'blockquote') return `<blockquote>${(node.content||[]).map(adfNodeToHtml).join('')}</blockquote>`;
  if (node.type === 'mention') return `<span style="color:#3b82f6;font-weight:500;">@${node.attrs?.text?.replace(/^@/,'') || ''}</span>`;
  if (node.type === 'emoji') return node.attrs?.text || '';
  if (node.type === 'table') return `<table style="border-collapse:collapse;width:100%;margin:8px 0;">${(node.content||[]).map(adfNodeToHtml).join('')}</table>`;
  if (node.type === 'tableRow') return `<tr>${(node.content||[]).map(adfNodeToHtml).join('')}</tr>`;
  if (node.type === 'tableHeader') return `<th style="border:1px solid #e5e7eb;padding:6px 10px;background:#f9fafb;font-weight:600;">${(node.content||[]).map(adfNodeToHtml).join('')}</th>`;
  if (node.type === 'tableCell') return `<td style="border:1px solid #e5e7eb;padding:6px 10px;">${(node.content||[]).map(adfNodeToHtml).join('')}</td>`;
  if (node.type === 'inlineCard' || node.type === 'blockCard') {
    const u = node.attrs?.url || '';
    return u ? `<a href="${u.replace(/"/g,'&quot;')}" target="_blank">${u}</a>` : '';
  }
  if (node.type === 'media') {
    const id = node.attrs?.id;
    if (id) return `<img src="/api/jira-image?id=${id}" style="max-width:100%;border-radius:4px;margin:4px 0;" loading="lazy"/>`;
    return '';
  }
  if (node.type === 'mediaSingle') return (node.content||[]).map(adfNodeToHtml).join('');
  return (node.content || []).map(adfNodeToHtml).join('');
}

function extractJiraValue(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) {
    const vals = raw.map((v: any) => v?.value ?? v?.name ?? v?.displayName ?? String(v)).filter(Boolean);
    return vals.length ? vals.join(', ') : null;
  }
  return (raw.value ?? raw.name ?? raw.displayName ?? raw.emailAddress ?? null);
}

const CUSTOM_FIELDS = 'customfield_10401,customfield_10883,customfield_11380,customfield_10203,customfield_10236,customfield_11404,customfield_10016';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { jiraUrl, email, apiToken, department = 'Migration' } = body;

    if (!jiraUrl || !email || !apiToken) {
      return NextResponse.json({ ok: false, error: 'Missing jiraUrl, email, or apiToken' }, { status: 400 });
    }

    const base = String(jiraUrl).replace(/\/$/, '').replace(/\/jira$/, '');
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const headers: Record<string, string> = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

    // Verify connection
    const meRes = await fetch(`${base}/rest/api/3/myself`, { headers });
    if (!meRes.ok) {
      return NextResponse.json({ ok: false, error: 'Jira authentication failed' }, { status: 401 });
    }

    // Find L1BOAR space
    const space = await db.space.findFirst({
      where: { key: 'L1BOAR' },
      include: { statuses: true },
    });
    if (!space) {
      return NextResponse.json({ ok: false, error: 'L1BOAR space not found in database' }, { status: 404 });
    }

    // Resolve user by display name
    const resolveUser = async (jiraUser: any): Promise<string | null> => {
      if (!jiraUser?.displayName) return null;
      const name = jiraUser.displayName.trim();
      const parts = name.split(/\s+/);
      const byFull = await db.user.findFirst({
        where: { firstName: { equals: parts[0], mode: 'insensitive' },
                  lastName: { equals: parts.slice(1).join(' '), mode: 'insensitive' } },
      });
      if (byFull) return byFull.id;
      if (jiraUser.emailAddress) {
        const byEmail = await db.user.findFirst({ where: { email: { equals: jiraUser.emailAddress, mode: 'insensitive' } } });
        if (byEmail) return byEmail.id;
      }
      const byFirst = await db.user.findFirst({ where: { firstName: { equals: parts[0], mode: 'insensitive' } } });
      return byFirst?.id ?? null;
    };

    const results = { total: 0, imported: 0, updated: 0, skipped: 0, commentsImported: 0, historyImported: 0, errors: [] as string[] };

    // Fetch all CFITS issues from Jira (paginated)
    let startAt = 0;
    const pageSize = 50;
    const jql = encodeURIComponent('project=CFITS ORDER BY created ASC');

    while (true) {
      const searchUrl = `${base}/rest/api/3/search/jql?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=summary,description,issuetype,priority,status,assignee,reporter,created,updated,duedate,labels,comment,parent,${CUSTOM_FIELDS}&expand=changelog`;
      const searchRes = await fetch(searchUrl, { headers });
      if (!searchRes.ok) {
        results.errors.push(`Jira search failed at offset ${startAt}: ${searchRes.status}`);
        break;
      }
      const searchData = await searchRes.json();
      const issues: any[] = searchData.issues || [];
      results.total = searchData.total || results.total;

      if (issues.length === 0) break;

      for (const ji of issues) {
        try {
          const f = ji.fields || {};
          const jiraKey = ji.key;
          const jiraStatusName = f.status?.name || 'Open';
          const localStatus = space.statuses.find(
            (s: any) => s.name.toLowerCase() === jiraStatusName.toLowerCase()
          ) ?? space.statuses[0] ?? null;

          const [assigneeId, reporterId] = await Promise.all([
            resolveUser(f.assignee),
            resolveUser(f.reporter),
          ]);

          const descHtml = f.description
            ? (typeof f.description === 'object' ? adfNodeToHtml(f.description) : f.description)
            : null;

          // Check if issue already exists by summary match (CFITS keys don't match L1BOAR keys)
          const existing = await db.issue.findFirst({
            where: { spaceId: space.id, summary: f.summary || jiraKey },
          });

          let issueId: string;

          if (existing) {
            await db.issue.update({
              where: { id: existing.id },
              data: {
                summary: f.summary || jiraKey,
                description: descHtml ?? existing.description,
                type: (f.issuetype?.name || 'task').toLowerCase(),
                priority: (f.priority?.name || 'medium').toLowerCase(),
                statusId: localStatus?.id ?? existing.statusId,
                assigneeId: assigneeId ?? existing.assigneeId,
                reporterId: reporterId ?? existing.reporterId,
                current_department: department,
                labels: Array.isArray(f.labels) ? f.labels : existing.labels,
                customerName:   extractJiraValue(f.customfield_10401) ?? existing.customerName,
                clientName:     extractJiraValue(f.customfield_10883) ?? existing.clientName,
                projectManager: extractJiraValue(f.customfield_11380) ?? existing.projectManager,
                productType:    extractJiraValue(f.customfield_10203) ?? existing.productType,
                combination:    extractJiraValue(f.customfield_10236) ?? existing.combination,
              },
            });
            issueId = existing.id;
            results.updated++;
          } else {
            const created = await db.issue.create({
              data: {
                id: rid(), key: `L1BOAR-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
                summary: f.summary || jiraKey,
                description: descHtml,
                type: (f.issuetype?.name || 'task').toLowerCase(),
                priority: (f.priority?.name || 'medium').toLowerCase(),
                spaceId: space.id,
                statusId: localStatus?.id ?? null,
                assigneeId, reporterId,
                current_department: department,
                labels: Array.isArray(f.labels) ? f.labels : [],
                customerName:   extractJiraValue(f.customfield_10401),
                clientName:     extractJiraValue(f.customfield_10883),
                projectManager: extractJiraValue(f.customfield_11380),
                productType:    extractJiraValue(f.customfield_10203),
                combination:    extractJiraValue(f.customfield_10236),
                createdAt: f.created ? new Date(f.created) : new Date(),
              },
            });
            issueId = created.id;
            results.imported++;
          }

          // Import comments
          const jiraComments: any[] = f.comment?.comments || [];
          if (jiraComments.length > 0) {
            const existingComments = await db.comment.count({ where: { issueId } });
            if (existingComments === 0) {
              for (const jc of jiraComments) {
                const commentAuthorId = await resolveUser(jc.author);
                const commentBody = typeof jc.body === 'object' ? adfNodeToHtml(jc.body) : (jc.body || '');
                if (!commentBody) continue;
                try {
                  await db.comment.create({
                    data: {
                      id: rid(), body: commentBody, issueId,
                      authorId: commentAuthorId,
                      authorName: jc.author?.displayName ?? null,
                      authorEmail: jc.author?.emailAddress ?? null,
                      createdAt: jc.created ? new Date(jc.created) : new Date(),
                      updatedAt: jc.updated ? new Date(jc.updated) : new Date(),
                    },
                  });
                  results.commentsImported++;
                } catch {}
              }
            }
          }

          // Import changelog as history
          const changelog: any[] = ji.changelog?.histories || [];
          if (changelog.length > 0) {
            const existingHistory = await db.issueHistory.count({ where: { issueId } });
            if (existingHistory === 0) {
              const histRecs: any[] = [];
              for (const entry of changelog) {
                const authorName = entry.author?.displayName ?? null;
                for (const item of entry.items || []) {
                  histRecs.push({
                    id: rid(), issueId,
                    field: item.field?.toLowerCase() || '',
                    oldValue: item.fromString ?? null,
                    newValue: item.toString ?? null,
                    authorName, authorEmail: null,
                    createdAt: new Date(entry.created),
                  });
                }
              }
              if (histRecs.length > 0) {
                await db.issueHistory.createMany({ data: histRecs });
                results.historyImported += histRecs.length;
              }
            }
          }
        } catch (err: any) {
          results.skipped++;
          results.errors.push(`${ji.key}: ${err.message}`);
        }
      }

      startAt += pageSize;
      if (startAt >= (searchData.total || 0)) break;
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (err: any) {
    console.error('[jira-migrate-cfits]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
