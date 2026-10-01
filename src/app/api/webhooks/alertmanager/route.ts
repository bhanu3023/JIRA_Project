// Receives Alertmanager's webhook POST when an alert fires or resolves.
// Auth is a shared secret passed as a query param (?secret=...) -- see
// monitoring/prometheus/alertmanager.yml for where it's configured on the
// sending side, and README/IMPLEMENTATION_NOTES for why a query param
// instead of a header (Alertmanager's stable webhook_configs has no
// built-in support for arbitrary custom headers).
import { NextRequest, NextResponse } from 'next/server';
import { processAlertmanagerWebhook } from '@/lib/incident-agent';

export const runtime = 'nodejs';

const WEBHOOK_SECRET = process.env.ALERTMANAGER_WEBHOOK_SECRET || '';

export async function POST(req: NextRequest) {
  if (!WEBHOOK_SECRET) {
    console.error('[AlertmanagerWebhook] ALERTMANAGER_WEBHOOK_SECRET is not configured -- refusing all requests');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  const providedSecret = req.nextUrl.searchParams.get('secret');
  if (providedSecret !== WEBHOOK_SECRET) {
    console.warn('[AlertmanagerWebhook] Rejected request with invalid/missing secret');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload || !Array.isArray(payload.alerts)) {
    return NextResponse.json({ error: 'Invalid payload -- expected Alertmanager webhook format with an alerts array' }, { status: 400 });
  }

  try {
    const result = await processAlertmanagerWebhook(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[AlertmanagerWebhook] Processing failed:', err?.message);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
