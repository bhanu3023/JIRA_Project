/**
 * POST /api/admin/jira-field-sync
 *
 * Syncs Customer Name, Client Name, Project Manager (and optionally
 * Product Type, Combination) from a Jira project into local issues by
 * matching on normalized title — using Prisma directly to avoid HTTP auth.
 *
 * Body: {
 *   secret,          // ADMIN_BULK_SECRET env var or 'cf-admin-sync-2024'
 *   jiraUrl,         // e.g. https://cf2020.atlassian.net/jira
 *   email,           // Jira account email
 *   apiToken,        // Jira API token
 *   jiraProject,     // e.g. CFITS
 *   spaceKey,        // local space to update, e.g. L1BOAR
 *   onlyMissing,     // boolean — if true, only update issues where ALL 3 fields are null
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Jira custom field IDs
const FIELD_MAP: Record<string, string> = {
  customerName:   'customfield_10401',
  clientName:     'customfield_10883',
  projectManager: 'customfield_11380',
  productType:    'customfield_10203',
  combination:    'customfield_10236',
};

function extractValue(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) {
    const vals = raw.map(extractValue).filter((v): v is string => v !== null && v !== '');
    return vals.length ? vals.join(', ') : null;
  }
  if (typeof raw === 'object') {
    const v = raw.value ?? raw.name ?? raw.displayName ?? raw.emailAddress ?? null;
    return v ? String(v).trim() || null : null;
  }
  return null;
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function POST(req: NextRequest) {
  try {
    const adminAuth = await requireAdmin(req);
    if (!adminAuth.ok) return NextResponse.json({ ok: false, error: adminAuth.error }, { status: adminAuth.status });

    const body = await req.json().catch(() => ({}));
    const { jiraUrl, email, apiToken, jiraProject, spaceKey, onlyMissing } = body;
    if (!jiraUrl || !email || !apiToken || !jiraProject || !spaceKey) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
    }

    const base = String(jiraUrl).replace(/\/$/, '').replace(/\/jira$/, '');
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const jiraHeaders = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

    const jiraFieldIds = Object.values(FIELD_MAP).join(',');

    // ── 1. Fetch local issues for this space ───────────────────────────────────
    const space = await db.space.findFirst({ where: { key: String(spaceKey).toUpperCase() } });
    if (!space) {
      return NextResponse.json({ ok: false, error: `Space ${spaceKey} not found` }, { status: 404 });
    }

    const whereClause: any = { spaceId: space.id };
    if (onlyMissing) {
      whereClause.AND = [
        { customerName: null },
        { clientName: null },
        { projectManager: null },
      ];
    }

    const localIssues = await db.issue.findMany({
      where: whereClause,
      select: { id: true, key: true, summary: true },
    });

    if (localIssues.length === 0) {
      return NextResponse.json({ ok: true, message: 'No local issues to update', updated: 0 });
    }

    // ── 2. Build a map of normalized local titles → issue IDs ─────────────────
    const localMap = new Map<string, { id: string; key: string }>();
    for (const issue of localIssues) {
      if (issue.summary) {
        localMap.set(normalize(issue.summary), { id: issue.id, key: issue.key });
        // Also index truncated (first 60 chars)
        const norm = normalize(issue.summary);
        if (norm.length > 20) localMap.set(norm.slice(0, 60), { id: issue.id, key: issue.key });
      }
    }

    // ── 3. Fetch Jira issues with at least one field filled ────────────────────
    const customFieldConditions = Object.values(FIELD_MAP)
      .map(id => `cf[${id.replace('customfield_', '')}] is not EMPTY`)
      .join(' OR ');
    const jql = encodeURIComponent(
      `project=${jiraProject} AND (${customFieldConditions}) ORDER BY updated DESC`
    );

    // Map: normalizedJiraTitle → field values
    const jiraMap = new Map<string, Record<string, string | null>>();
    let startAt = 0;
    const pageSize = 100;

    while (true) {
      const url = `${base}/rest/api/3/search/jql?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=summary,${jiraFieldIds}`;
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
        const fields: Record<string, string | null> = {};
        for (const [ourKey, jiraFieldId] of Object.entries(FIELD_MAP)) {
          fields[ourKey] = extractValue(ji.fields?.[jiraFieldId]);
        }
        jiraMap.set(normTitle, fields);
        if (normTitle.length > 20) jiraMap.set(normTitle.slice(0, 60), fields);
      }

      if (batch.length < pageSize) break;
      startAt += pageSize;
    }

    // ── 4. Match local issues to Jira issues ───────────────────────────────────
    let updated = 0;
    const log: string[] = [];
    const jiraEntries = Array.from(jiraMap.entries());

    for (const issue of localIssues) {
      if (!issue.summary) continue;
      const localNorm = normalize(issue.summary);

      // Try exact match first
      let jiraFields = jiraMap.get(localNorm);

      // Try prefix match (first 60 chars)
      if (!jiraFields && localNorm.length > 20) {
        jiraFields = jiraMap.get(localNorm.slice(0, 60));
      }

      // Try substring match
      if (!jiraFields) {
        for (let ei = 0; ei < jiraEntries.length; ei++) {
          const [jiraNorm, fields] = jiraEntries[ei];
          if (jiraNorm.length < 10) continue;
          const shorter = jiraNorm.length < localNorm.length ? jiraNorm : localNorm;
          const longer  = jiraNorm.length >= localNorm.length ? jiraNorm : localNorm;
          if (shorter.length >= 15 && longer.includes(shorter)) {
            jiraFields = fields;
            break;
          }
        }
      }

      if (!jiraFields) continue;

      // Build update data — only set fields that have a value
      const updateData: Record<string, string | null> = {};
      for (const [ourKey, val] of Object.entries(jiraFields)) {
        if (val !== null && val !== '') {
          updateData[ourKey] = val;
        }
      }

      if (Object.keys(updateData).length === 0) continue;

      try {
        await db.issue.update({
          where: { id: issue.id },
          data: updateData,
        });
        updated++;
        const summary = Object.entries(updateData)
          .map(([k, v]) => `${k}="${v}"`)
          .join(', ');
        log.push(`✓ ${issue.key}: ${summary}`);
      } catch (e: any) {
        log.push(`✗ ${issue.key}: ${e.message}`);
      }
    }

    return NextResponse.json({
      ok: true,
      localTotal: localIssues.length,
      jiraWithFields: jiraMap.size,
      updated,
      log: log.slice(0, 100),
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
