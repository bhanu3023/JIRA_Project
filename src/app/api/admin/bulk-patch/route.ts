/**
 * POST /api/admin/bulk-patch
 * Body: { patches: [{key, patch}] }
 * Applies custom-field patches to multiple issues at once (internal migration use).
 *
 * Requires a real, currently logged-in admin session -- previously gated
 * only by a static shared secret also hardcoded in client-side page source.
 * See src/lib/admin-auth.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));

  const patches: Array<{ key: string; patch: Record<string, any> }> = body.patches || [];
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';
  let updated = 0;
  const errors: string[] = [];
  // Was sending a static 'x-internal-admin' header that the real PATCH
  // /api/issues/:key handler never actually checks (confirmed -- that
  // header string doesn't appear anywhere in jira-pg-api.ts), so this
  // internal call was unauthenticated and presumably failing outright.
  // Forwarding the caller's own already-verified admin Bearer token instead
  // actually authenticates it, the same way any other API call does.
  const callerAuth = req.headers.get('authorization') || '';

  for (const { key, patch } of patches) {
    try {
      const r = await fetch(`${appUrl}/api/issues/${key.toUpperCase()}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: callerAuth,
        },
        body: JSON.stringify(patch),
      });
      if (r.ok) updated++;
      else errors.push(`${key}: HTTP ${r.status}`);
    } catch (e: any) {
      errors.push(`${key}: ${e.message}`);
    }
  }

  return NextResponse.json({ ok: true, total: patches.length, updated, errors: errors.slice(0, 20) });
}
