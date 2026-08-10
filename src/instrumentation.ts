/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Starts IMAP pollers from DB config and retries every 5 minutes for
 * any account that failed (e.g. OAuth tokens expired or not yet in DB).
 * Also runs the recurring SLA breach-warning check (see below).
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

  // POST /api/sla-breach-check finds every ticket within 30 minutes of its SLA
  // due time and notifies the assignee/reporter/leads/managers (in-app + email)
  // — but nothing was ever calling it. The route existed and worked, it just had
  // no scheduler, so those 30-minute warnings never actually fired in practice.
  async function runSlaBreachCheck(label: string): Promise<number> {
    try {
      const res = await fetch(`${internalUrl}/api/sla-breach-check`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      const notified = data.notified ?? 0;
      if (notified > 0) console.log(`[SLA breach check] ${label} — notified: ${notified}`);
      return notified;
    } catch (err) {
      console.error(`[SLA breach check] ${label} — failed:`, err);
      return -1;
    }
  }

  // Initial boot: wait for server + DB to be ready
  await new Promise(res => setTimeout(res, 8000));
  await tryRestartPollers('Boot');
  await runSlaBreachCheck('Boot');

  // Retry loop: every 5 minutes, restart any pollers that are down.
  // This handles OAuth token expiry, network blips, and tokens that
  // weren't in DB yet when the server first booted.
  setInterval(async () => {
    await tryRestartPollers('Periodic');
  }, 5 * 60 * 1000);

  // SLA breach warnings are time-sensitive (a 30-minute window), so this runs
  // on a tighter cadence than the poller retry above — every 5 minutes gives
  // several chances to catch a ticket before it enters and then leaves the
  // 30-minute window, and the route's own "already notified in the last hour"
  // check prevents repeat notifications on every tick.
  setInterval(async () => {
    await runSlaBreachCheck('Periodic');
  }, 5 * 60 * 1000);
}
