/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Calls /api/email/restart-pollers which handles BOTH password-based
 * and OAuth (Microsoft/Google) accounts from email_configs DB.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Wait for server to be ready to accept requests
  await new Promise(res => setTimeout(res, 8000));

  // Use internal localhost URL — NEXT_PUBLIC_APP_URL is the public domain and
  // may not be reachable from inside the Docker container during startup.
  // PORT defaults to 3000 in Next.js; override via INTERNAL_PORT env if needed.
  const internalPort = process.env.INTERNAL_PORT || process.env.PORT || '3000';
  const internalUrl = `http://localhost:${internalPort}`;

  try {
    const res = await fetch(`${internalUrl}/api/email/restart-pollers`, {
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
