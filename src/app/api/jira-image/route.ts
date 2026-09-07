import { NextRequest, NextResponse } from 'next/server';

// A live Jira API token used to sit hardcoded directly in this file (and
// therefore in git history) -- removed entirely rather than rotated-and-
// kept, since a secret baked into source is a real exposure regardless of
// whether the token itself later gets revoked. The real, current credential
// now lives only in the app_settings DB table (jira_url/jira_email/
// jira_token), set via a direct SQL insert -- same source getJiraCredentials
// in jira-pg-api.ts already reads, kept as a separate lookup here rather
// than importing that (large, unrelated) module into this small route.
async function getJiraAuth(): Promise<{ base: string; auth: string } | null> {
  try {
    const { pgPool } = await import('@/lib/pg-pool');
    const rows = await pgPool.query(`SELECT key, value FROM app_settings WHERE key IN ('jira_url','jira_email','jira_token')`);
    const s: Record<string, string> = {};
    for (const r of rows.rows) s[r.key] = r.value;
    const email = s.jira_email || process.env.JIRA_EMAIL || '';
    const token = s.jira_token || process.env.JIRA_TOKEN || '';
    if (!token) return null;
    return {
      base: s.jira_url || process.env.JIRA_BASE_URL || 'https://cf2020.atlassian.net',
      auth: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id  = searchParams.get('id');
  const url = searchParams.get('url'); // direct URL fallback

  try {
    const creds = await getJiraAuth();
    if (!creds) return NextResponse.json({ error: 'Jira credentials not configured' }, { status: 500 });
    const target = url || (id ? `${creds.base}/rest/api/3/attachment/content/${id}` : null);
    if (!target) return NextResponse.json({ error: 'Missing id or url' }, { status: 400 });

    const res = await fetch(target, {
      headers: { Authorization: creds.auth },
      redirect: 'follow',
    });

    if (!res.ok) return new NextResponse(null, { status: res.status });

    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = await res.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}

