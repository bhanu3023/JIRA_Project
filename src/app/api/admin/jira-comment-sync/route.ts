/**
 * POST /api/admin/jira-comment-sync
 *
 * Syncs comments from Jira into local issues.
 * Only fetches comments for issues that currently have ZERO comments locally.
 * Uses /rest/api/3/issue/{key}/comment — batched in parallel groups of 10.
 *
 * matchBy="key"   → Jira key == local key  (L2B-123 → L2B-123)
 * matchBy="title" → CFITS: title-matched issues, look up Jira key via stored jiraKey
 *                   (falls back to fetching CFITS issues with comments by title)
 *
 * Body: { secret, jiraUrl, email, apiToken,
 *   boards: [{ jiraProject, spaceKey, matchBy }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function rid() {
  return `cmt_${Math.random().toString(36).slice(2, 12)}`;
}

function extractAdfText(nodes: any[]): string {
  if (!nodes) return '';
  return nodes.map(node => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'paragraph') return extractAdfText(node.content || []) + '\n';
    if (node.content) return extractAdfText(node.content);
    return '';
  }).join('').trim();
}

function extractText(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  if (body.type === 'doc' && Array.isArray(body.content)) return extractAdfText(body.content);
  return JSON.stringify(body);
}

async function fetchComments(base: string, jiraKey: string, headers: Record<string, string>) {
  try {
    const res = await fetch(`${base}/rest/api/3/issue/${jiraKey}/comment?maxResults=100`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return data.comments || [];
  } catch {
    return [];
  }
}

interface BoardConfig { jiraProject: string; spaceKey: string; matchBy: 'key' | 'title'; }

export async function POST(req: NextRequest) {
  try {
    const adminAuth = await requireAdmin(req);
    if (!adminAuth.ok) return NextResponse.json({ ok: false, error: adminAuth.error }, { status: adminAuth.status });

    const body = await req.json().catch(() => ({}));
    const { jiraUrl, email, apiToken, boards } = body;
    if (!jiraUrl || !email || !apiToken || !Array.isArray(boards) || boards.length === 0) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
    }

    const base = String(jiraUrl).replace(/\/$/, '').replace(/\/jira$/, '');
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const jiraHeaders: Record<string, string> = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

    const results: Record<string, { inserted: number; skipped: number; noMatch: number; error?: string }> = {};

    for (const cfg of boards as BoardConfig[]) {
      const { jiraProject, spaceKey, matchBy } = cfg;
      const result = { inserted: 0, skipped: 0, noMatch: 0 };
      results[spaceKey] = result;

      try {
        const space = await db.space.findFirst({ where: { key: spaceKey.toUpperCase() } });
        if (!space) { results[spaceKey].error = 'Space not found'; continue; }

        // Only get issues that have ZERO comments — skip already-synced ones
        const issuesNeedingComments = await db.issue.findMany({
          where: { spaceId: space.id, comments: { none: {} } },
          select: { id: true, key: true, summary: true },
        });

        if (issuesNeedingComments.length === 0) continue;

        // ── matchBy="key": Jira key == local key ──────────────────────────────
        if (matchBy === 'key') {
          // Process in batches of 10 parallel requests
          const BATCH = 10;
          for (let i = 0; i < issuesNeedingComments.length; i += BATCH) {
            const batch = issuesNeedingComments.slice(i, i + BATCH);
            await Promise.all(batch.map(async (localIssue: any) => {
              const jiraComments = await fetchComments(base, localIssue.key, jiraHeaders);
              if (!jiraComments.length) { result.noMatch++; return; }

              for (const jc of jiraComments) {
                const commentText = extractText(jc.body);
                if (!commentText) continue;
                try {
                  await db.comment.create({
                    data: {
                      id: rid(),
                      body: commentText,
                      issueId: localIssue.id,
                      authorName: jc.author?.displayName ?? jc.author?.emailAddress ?? 'Jira User',
                      authorEmail: jc.author?.emailAddress ?? '',
                      createdAt: jc.created ? new Date(jc.created) : new Date(),
                      updatedAt: jc.updated ? new Date(jc.updated) : new Date(),
                    },
                  });
                  result.inserted++;
                } catch { result.skipped++; }
              }
            }));
          }

        // ── matchBy="title": CFITS → L1BOAR via title matching ────────────────
        } else {
          // Build title map for local issues
          const byTitle = new Map<string, typeof issuesNeedingComments[0]>();
          for (const issue of issuesNeedingComments) {
            if (!issue.summary) continue;
            const norm = normalize(issue.summary);
            byTitle.set(norm, issue);
            if (norm.length > 20) byTitle.set(norm.slice(0, 60), issue);
          }

          // Page through CFITS issues
          let startAt = 0;
          const pageSize = 100;
          const jql = encodeURIComponent(`project=${jiraProject} ORDER BY updated DESC`);

          while (true) {
            const url = `${base}/rest/api/3/search/jql?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=summary,comment`;
            const res = await fetch(url, { headers: jiraHeaders });
            if (!res.ok) break;
            const data = await res.json();
            const batch: any[] = data.issues || [];

            for (const ji of batch) {
              const jiraComments: any[] = ji.fields?.comment?.comments || [];
              if (!jiraComments.length) continue;

              const norm = normalize(ji.fields?.summary || '');
              let localIssue = byTitle.get(norm) ?? byTitle.get(norm.slice(0, 60));

              if (!localIssue && norm.length >= 15) {
                for (const [tNorm, issue] of Array.from(byTitle.entries())) {
                  const shorter = tNorm.length < norm.length ? tNorm : norm;
                  const longer  = tNorm.length >= norm.length ? tNorm : norm;
                  if (shorter.length >= 15 && longer.includes(shorter)) { localIssue = issue; break; }
                }
              }

              if (!localIssue) { result.noMatch++; continue; }

              for (const jc of jiraComments) {
                const commentText = extractText(jc.body);
                if (!commentText) continue;
                try {
                  await db.comment.create({
                    data: {
                      id: rid(),
                      body: commentText,
                      issueId: localIssue.id,
                      authorName: jc.author?.displayName ?? jc.author?.emailAddress ?? 'Jira User',
                      authorEmail: jc.author?.emailAddress ?? '',
                      createdAt: jc.created ? new Date(jc.created) : new Date(),
                      updatedAt: jc.updated ? new Date(jc.updated) : new Date(),
                    },
                  });
                  result.inserted++;
                } catch { result.skipped++; }
              }
              // Remove from map so we don't double-process
              byTitle.delete(norm);
            }

            if (batch.length < pageSize) break;
            startAt += pageSize;
          }
        }
      } catch (e: any) {
        results[spaceKey].error = e.message;
      }
    }

    const totalInserted = Object.values(results).reduce((s, r) => s + r.inserted, 0);
    const totalSkipped  = Object.values(results).reduce((s, r) => s + r.skipped, 0);
    return NextResponse.json({ ok: true, totalInserted, totalSkipped, boards: results });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
