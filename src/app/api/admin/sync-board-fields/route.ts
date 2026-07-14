/**
 * POST /api/admin/sync-board-fields
 *
 * Syncs Jira custom field values (productType, combination, projectManager,
 * customerName, clientName) for all three boards:
 *   L1BOAR ← CFITS   (covers Migration queue tickets)
 *   L2BOARD ← L2B
 *   L3BOARD ← L3B
 *
 * Uses the same Jira credentials as the rest of the app.
 * Body: { secret } — ADMIN_BULK_SECRET or 'cf-admin-sync-2024'
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SECRET = process.env.ADMIN_BULK_SECRET || 'cf-admin-sync-2024';

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || 'sujana.manapuram@cloudfuze.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN || 'REDACTED_API_TOKEN';

const FIELD_MAP: Record<string, string> = {
  customerName:   'customfield_10401',
  clientName:     'customfield_10883',
  projectManager: 'customfield_11380',
  productType:    'customfield_10203',
  combination:    'customfield_10236',
};

const BOARDS: { spaceKey: string; jiraProject: string }[] = [
  { spaceKey: 'L1BOAR',  jiraProject: 'CFITS' },
  { spaceKey: 'L2BOARD', jiraProject: 'L2B'   },
  { spaceKey: 'L3BOARD', jiraProject: 'L3B'   },
];

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

async function syncBoard(spaceKey: string, jiraProject: string): Promise<{ updated: number; total: number; log: string[] }> {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  const jiraFieldIds = Object.values(FIELD_MAP).join(',');

  const space = await db.space.findFirst({ where: { key: spaceKey } });
  if (!space) return { updated: 0, total: 0, log: [`Space ${spaceKey} not found`] };

  const localIssues = await db.issue.findMany({
    where: { spaceId: space.id },
    select: { id: true, key: true, summary: true },
  });

  if (localIssues.length === 0) return { updated: 0, total: 0, log: ['No issues found'] };

  // Build normalized title → issue map
  const localMap = new Map<string, { id: string; key: string }>();
  for (const issue of localIssues) {
    if (!issue.summary) continue;
    const norm = normalize(issue.summary);
    localMap.set(norm, { id: issue.id, key: issue.key });
    if (norm.length > 20) localMap.set(norm.slice(0, 60), { id: issue.id, key: issue.key });
  }

  // Fetch Jira issues that have at least one custom field filled
  const conditions = Object.values(FIELD_MAP)
    .map(id => `cf[${id.replace('customfield_', '')}] is not EMPTY`)
    .join(' OR ');
  const jql = encodeURIComponent(`project=${jiraProject} AND (${conditions}) ORDER BY updated DESC`);

  const jiraMap = new Map<string, Record<string, string | null>>();
  let startAt = 0;

  while (true) {
    const url = `${JIRA_BASE}/rest/api/3/search/jql?jql=${jql}&startAt=${startAt}&maxResults=100&fields=summary,${jiraFieldIds}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await res.text();
      return { updated: 0, total: localIssues.length, log: [`Jira fetch failed for ${jiraProject}: ${err.slice(0, 200)}`] };
    }
    const data = await res.json();
    const batch: any[] = data.issues || [];

    for (const ji of batch) {
      const normTitle = normalize(ji.fields?.summary || '');
      if (!normTitle) continue;
      const fields: Record<string, string | null> = {};
      for (const [key, fieldId] of Object.entries(FIELD_MAP)) {
        fields[key] = extractValue(ji.fields?.[fieldId]);
      }
      jiraMap.set(normTitle, fields);
      if (normTitle.length > 20) jiraMap.set(normTitle.slice(0, 60), fields);
    }

    if (batch.length < 100) break;
    startAt += 100;
  }

  // Match and update
  let updated = 0;
  const log: string[] = [];
  const jiraEntries = Array.from(jiraMap.entries());

  for (const issue of localIssues) {
    if (!issue.summary) continue;
    const localNorm = normalize(issue.summary);

    let jiraFields = jiraMap.get(localNorm);
    if (!jiraFields && localNorm.length > 20) jiraFields = jiraMap.get(localNorm.slice(0, 60));
    if (!jiraFields) {
      for (const [jiraNorm, fields] of jiraEntries) {
        if (jiraNorm.length < 10) continue;
        const shorter = jiraNorm.length < localNorm.length ? jiraNorm : localNorm;
        const longer  = jiraNorm.length >= localNorm.length ? jiraNorm : localNorm;
        if (shorter.length >= 15 && longer.includes(shorter)) { jiraFields = fields; break; }
      }
    }
    if (!jiraFields) continue;

    const updateData: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(jiraFields)) {
      if (val !== null && val !== '') updateData[key] = val;
    }
    if (Object.keys(updateData).length === 0) continue;

    try {
      await db.issue.update({ where: { id: issue.id }, data: updateData });
      updated++;
      log.push(`✓ ${issue.key}: ${Object.entries(updateData).map(([k, v]) => `${k}="${v}"`).join(', ')}`);
    } catch (e: any) {
      log.push(`✗ ${issue.key}: ${e.message}`);
    }
  }

  return { updated, total: localIssues.length, log: log.slice(0, 50) };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== SECRET) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const results: Record<string, any> = {};
    for (const { spaceKey, jiraProject } of BOARDS) {
      results[spaceKey] = await syncBoard(spaceKey, jiraProject);
    }

    const totalUpdated = Object.values(results).reduce((s: number, r: any) => s + (r.updated || 0), 0);
    return NextResponse.json({ ok: true, totalUpdated, boards: results });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
