import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';

// jiraUrl is attacker-controlled input (it's typed into the Import page)
// and was being fetched with no validation at all -- that made this an
// open SSRF relay: anyone could point it at an internal service or the
// cloud metadata endpoint (169.254.169.254) and have this server fetch it
// on their behalf, with no login required. Confirmed via a security audit.
// Fixed by requiring an admin session (matches who the Import page is
// actually for) and restricting the target to a real external HTTPS host.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  // Literal IPv4 in a private/loopback/link-local (incl. cloud metadata) range.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const { jiraUrl, email, apiToken, endpoint, method = 'GET', body } = await req.json();

    if (!jiraUrl || !email || !apiToken || !endpoint) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const baseUrl = jiraUrl.replace(/\/$/, '').replace(/\/jira$/, '');
    // Rewrite deprecated /search → /search/jql automatically
    const fixedEndpoint = endpoint.replace(/^\/search(\?|$)/, '/search/jql$1');
    const url = `${baseUrl}/rest/api/3${fixedEndpoint}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid jiraUrl' }, { status: 400 });
    }
    if (parsedUrl.protocol !== 'https:' || isBlockedHost(parsedUrl.hostname)) {
      return NextResponse.json({ error: 'Target host not allowed' }, { status: 400 });
    }

    const auth64 = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth64}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Proxy error' }, { status: 500 });
  }
}
