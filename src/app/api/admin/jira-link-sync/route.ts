/**
 * POST /api/admin/jira-link-sync
 *
 * Syncs "Linked work items" from a Jira project into local issues.
 * - Fetches Jira CFITS issues that have issue links
 * - Matches them to local L1BOAR issues by normalized title
 * - For each Jira link (e.g. L2B-2099 → L2B-2099 in our DB), creates an IssueLink
 *
 * Body: { secret, jiraUrl, email, apiToken, jiraProject, spaceKey }
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
  return `lnk_${Math.random().toString(36).slice(2, 12)}`;
}

export async function POST(req: NextRequest) {
  try {
    const adminAuth = await requireAdmin(req);
    if (!adminAuth.ok) return NextResponse.json({ ok: false, error: adminAuth.error }, { status: adminAuth.status });

    const body = await req.json().catch(() => ({}));

    const { jiraUrl, email, apiToken, jiraProject, spaceKey } = body;
    if (!jiraUrl || !email || !apiToken || !jiraProject || !spaceKey) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
    }

    const base = String(jiraUrl).replace(/\/$/, '').replace(/\/jira$/, '');
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const jiraHeaders = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

    // ── 1. Fetch local issues for this space ───────────────────────────────────
    const space = await db.space.findFirst({ where: { key: String(spaceKey).toUpperCase() } });
    if (!space) {
      return NextResponse.json({ ok: false, error: `Space ${spaceKey} not found` }, { status: 404 });
    }

    const localIssues = await db.issue.findMany({
      where: { spaceId: space.id },
      select: { id: true, key: true, summary: true },
    });

    // Map normalizedTitle → local issue key
    const localByTitle = new Map<string, string>();
    for (const issue of localIssues) {
      if (!issue.summary) continue;
      const norm = normalize(issue.summary);
      localByTitle.set(norm, issue.key);
      if (norm.length > 20) localByTitle.set(norm.slice(0, 60), issue.key);
    }

    // ── 2. Fetch Jira issues that have issuelinks ──────────────────────────────
    // JQL: get all issues from the project, fetch issuelinks field
    const jql = encodeURIComponent(`project=${jiraProject} AND issue in linkedIssues() ORDER BY updated DESC`);

    // Map: normalizedJiraTitle → array of linked Jira keys
    const jiraLinkMap = new Map<string, Array<{ linkedKey: string; linkType: string }>>();
    let startAt = 0;
    const pageSize = 100;

    while (true) {
      const url = `${base}/rest/api/3/search/jql?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=summary,issuelinks`;
      const res = await fetch(url, { headers: jiraHeaders });
      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ ok: false, error: `Jira search failed: ${err}` }, { status: 400 });
      }
      const data = await res.json();
      const batch: any[] = data.issues || [];

      for (const ji of batch) {
        const normTitle = normalize(ji.fields?.summary || '');
        if (!normTitle) continue;

        const links: Array<{ linkedKey: string; linkType: string }> = [];
        const issuelinks: any[] = ji.fields?.issuelinks || [];
        for (const lnk of issuelinks) {
          const linkedIssue = lnk.outwardIssue || lnk.inwardIssue;
          if (!linkedIssue?.key) continue;
          const linkType = lnk.type?.name ?? 'relates';
          links.push({ linkedKey: linkedIssue.key, linkType });
        }

        if (links.length > 0) {
          jiraLinkMap.set(normTitle, links);
          if (normTitle.length > 20) jiraLinkMap.set(normTitle.slice(0, 60), links);
        }
      }

      if (batch.length < pageSize) break;
      startAt += pageSize;
    }

    // ── 3. Match and create links ──────────────────────────────────────────────
    let linked = 0;
    let skipped = 0;
    const log: string[] = [];
    const jiraEntries = Array.from(jiraLinkMap.entries());

    // Pre-fetch all local issue keys that might be link targets
    const allLocalKeys = new Set((await db.issue.findMany({ select: { key: true } })).map(i => i.key));

    for (const issue of localIssues) {
      if (!issue.summary) continue;
      const localNorm = normalize(issue.summary);

      // Match this local issue to a Jira issue
      let jiraLinks = jiraLinkMap.get(localNorm);
      if (!jiraLinks && localNorm.length > 20) jiraLinks = jiraLinkMap.get(localNorm.slice(0, 60));

      // Substring match fallback
      if (!jiraLinks) {
        for (let ei = 0; ei < jiraEntries.length; ei++) {
          const [jiraNorm, links] = jiraEntries[ei];
          if (jiraNorm.length < 10) continue;
          const shorter = jiraNorm.length < localNorm.length ? jiraNorm : localNorm;
          const longer  = jiraNorm.length >= localNorm.length ? jiraNorm : localNorm;
          if (shorter.length >= 15 && longer.includes(shorter)) {
            jiraLinks = links;
            break;
          }
        }
      }

      if (!jiraLinks) continue;

      for (const { linkedKey, linkType } of jiraLinks) {
        // Check if the linked key exists in our local DB
        if (!allLocalKeys.has(linkedKey)) {
          skipped++;
          continue;
        }

        // Don't link to self
        if (linkedKey === issue.key) continue;

        try {
          await db.issueLink.upsert({
            where: {
              sourceKey_targetKey_linkType: {
                sourceKey: issue.key,
                targetKey: linkedKey,
                linkType,
              },
            },
            create: { id: rid(), sourceKey: issue.key, targetKey: linkedKey, linkType },
            update: {},
          });
          linked++;
          log.push(`✓ ${issue.key} → ${linkedKey} (${linkType})`);
        } catch (e: any) {
          log.push(`✗ ${issue.key} → ${linkedKey}: ${e.message}`);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      localTotal: localIssues.length,
      jiraWithLinks: jiraLinkMap.size,
      linked,
      skipped,
      log: log.slice(0, 100),
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
