/**
 * POST /api/admin/fix-space-types
 * Bulk-updates all spaces that have type='service_desk' to 'scrum',
 * EXCEPT those whose key is in the SERVICE_DESK_KEYS list.
 *
 * Requires a real, currently logged-in admin session (Authorization: Bearer
 * <jwt>) -- previously gated only by a static shared secret that was also
 * hardcoded directly in client-side page source, making it readable by any
 * site visitor via devtools. See src/lib/admin-auth.ts.
 *
 * Body: { serviceDesk?: string[] }
 * serviceDesk: optional list of space keys to keep as service_desk.
 *              Defaults to known SD keys.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';

// Known service-desk space keys — all others will be set to 'scrum'
const DEFAULT_SD_KEYS = ['SOPSBOARD'];

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));

  const sdKeys: string[] = (body.serviceDesk ?? DEFAULT_SD_KEYS).map((k: string) => k.toUpperCase());

  // Update all spaces with type='service_desk' that are NOT in the SD list
  const result = await db.space.updateMany({
    where: {
      type: 'service_desk',
      key: { notIn: sdKeys },
    },
    data: { type: 'scrum' },
  });

  return NextResponse.json({ ok: true, updated: result.count, keptServiceDesk: sdKeys });
}
