/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Starts IMAP pollers from DB config and retries every 5 minutes for
 * any account that failed (e.g. OAuth tokens expired or not yet in DB).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const internalPort = process.env.INTERNAL_PORT || process.env.PORT || '3000';
  const internalUrl  = `http://localhost:${internalPort}`;

  async function tryRestartPollers(label: string): Promise<number> {
    try {
      const res = await fetch(`${internalUrl}/api/email/restart-pollers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      const started = data.started ?? 0;
      console.log(`[Startup] ${label} — pollers started: ${started}`, data.results ?? []);
      return started;
    } catch (err) {
      console.error(`[Startup] ${label} — restart-pollers failed:`, err);
      return -1;
    }
  }

  // Initial boot: wait for server + DB to be ready
  await new Promise(res => setTimeout(res, 8000));
  await tryRestartPollers('Boot');

  // Retry loop: every 5 minutes, restart any pollers that are down.
  // This handles OAuth token expiry, network blips, and tokens that
  // weren't in DB yet when the server first booted.
  setInterval(async () => {
    await tryRestartPollers('Periodic');
  }, 5 * 60 * 1000);
}
