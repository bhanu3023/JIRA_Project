/**
 * POST /api/admin/sync-ms-photos
 *
 * Strategy (tries each approach in order):
 *  1. Client-credentials app token (needs User.Read.All app permission in Azure AD)
 *  2. Any stored delegated OAuth token from users who logged in via Microsoft
 *     (needs User.ReadBasic.All delegated permission)
 *  3. Per-user delegated token if the user themselves has logged in (User.Read)
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAllOAuthEmails, getOAuthTokens } from '@/lib/oauth-service';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

// ── Tenant discovery ──────────────────────────────────────────────────────────
const tenantCache = new Map<string, string | null>();
async function getTenantId(domain: string): Promise<string | null> {
  if (tenantCache.has(domain)) return tenantCache.get(domain)!;
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${domain}/v2.0/.well-known/openid-configuration`,
    );
    if (!res.ok) { tenantCache.set(domain, null); return null; }
    const data = await res.json() as { issuer?: string };
    const match = (data.issuer || '').match(/login\.microsoftonline\.com\/([^/]+)\//);
    const tid = match?.[1] ?? null;
    tenantCache.set(domain, tid);
    return tid;
  } catch {
    tenantCache.set(domain, null);
    return null;
  }
}

// ── App token via client_credentials ─────────────────────────────────────────
async function getAppToken(tenantId: string): Promise<string | null> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

// ── Fetch photo bytes from Graph ──────────────────────────────────────────────
async function fetchPhoto(token: string, userEmail: string): Promise<string | null> {
  // Try by email (works with app token or delegated User.ReadBasic.All)
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/photo/$value`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const ct = res.headers.get('content-type') || 'image/jpeg';
      const buf = await res.arrayBuffer();
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    }
  } catch {}
  return null;
}

// ── Fetch own photo (works with User.Read delegated only) ─────────────────────
async function fetchOwnPhoto(token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/photo/$value`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const ct = res.headers.get('content-type') || 'image/jpeg';
      const buf = await res.arrayBuffer();
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    }
  } catch {}
  return null;
}

export async function POST(req: NextRequest) {
  // No auth check existed here at all -- this endpoint uses OTHER users'
  // stored Microsoft OAuth tokens (from whoever has logged in via
  // Microsoft) to call Graph on their behalf without their consent.
  // Confirmed via a security audit.
  const adminAuth = await requireAdmin(req);
  if (!adminAuth.ok) return NextResponse.json({ error: adminAuth.error }, { status: adminAuth.status });

  const body = await req.json().catch(() => ({})) as { forceAll?: boolean };

  const allUsers = await db.user.findMany({
    select: { id: true, email: true, avatarUrl: true },
  });

  const targets = body.forceAll ? allUsers : allUsers.filter(u => !u.avatarUrl);

  if (targets.length === 0) {
    return NextResponse.json({ synced: 0, total: 0, message: 'All users already have photos.' });
  }

  // ── Build token map ───────────────────────────────────────────────────────
  // domain → best available token
  const domainTokenMap = new Map<string, string | null>();
  // email → own delegated token (for fallback)
  const personalTokenMap = new Map<string, string>();

  // Collect stored OAuth tokens (from users who logged in via Microsoft)
  for (const email of getAllOAuthEmails()) {
    const tokens = getOAuthTokens(email);
    if (!tokens || tokens.provider !== 'microsoft') continue;
    personalTokenMap.set(email.toLowerCase(), tokens.accessToken);
    // Use this as a domain-level token too (for reading other users if permitted)
    const domain = email.split('@')[1];
    if (domain && !domainTokenMap.has(domain)) {
      domainTokenMap.set(domain, tokens.accessToken);
    }
  }

  const results: { email: string; status: string }[] = [];
  let synced = 0;

  for (const user of targets) {
    const domain = user.email.split('@')[1];

    // ── Step 1: Try app token (client_credentials) ──────────────────────────
    if (!domainTokenMap.has(`app:${domain}`)) {
      const tenantId = await getTenantId(domain || '');
      if (tenantId) {
        const appToken = await getAppToken(tenantId);
        domainTokenMap.set(`app:${domain}`, appToken);
      } else {
        domainTokenMap.set(`app:${domain}`, null);
      }
    }
    const appToken = domainTokenMap.get(`app:${domain}`);
    if (appToken) {
      const photo = await fetchPhoto(appToken, user.email);
      if (photo) {
        await db.user.update({ where: { id: user.id }, data: { avatarUrl: photo } });
        results.push({ email: user.email, status: 'synced via app token' });
        synced++;
        continue;
      }
    }

    // ── Step 2: Try delegated token from same domain (User.ReadBasic.All) ───
    const delegatedToken = domainTokenMap.get(domain);
    if (delegatedToken) {
      const photo = await fetchPhoto(delegatedToken, user.email);
      if (photo) {
        await db.user.update({ where: { id: user.id }, data: { avatarUrl: photo } });
        results.push({ email: user.email, status: 'synced via delegated token' });
        synced++;
        continue;
      }
    }

    // ── Step 3: Use person's own stored token ─────────────────────────────
    const ownToken = personalTokenMap.get(user.email.toLowerCase());
    if (ownToken) {
      const photo = await fetchOwnPhoto(ownToken);
      if (photo) {
        await db.user.update({ where: { id: user.id }, data: { avatarUrl: photo } });
        results.push({ email: user.email, status: 'synced via own token' });
        synced++;
        continue;
      }
    }

    results.push({ email: user.email, status: 'no photo found' });
  }

  return NextResponse.json({ synced, total: targets.length, results });
}
