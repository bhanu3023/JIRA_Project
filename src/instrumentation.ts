/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Calls /api/email/restart-pollers which handles BOTH password-based
 * and OAuth (Microsoft/Google) accounts from email_configs DB.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Wait for server to be ready to accept requests
  await new Promise(res => setTimeout(res, 5000));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8080';

  try {
    const res = await fetch(`${appUrl}/api/email/restart-pollers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[Startup] Email pollers restored: ${data.started ?? 0} started`, data.results ?? []);
  } catch (err) {
    console.error('[Startup] Failed to restore email pollers:', err);
  }
}
