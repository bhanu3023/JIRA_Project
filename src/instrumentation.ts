/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Starts IMAP pollers from DB config and retries every 5 minutes for
 * any account that failed (e.g. OAuth tokens expired or not yet in DB).
 * Also runs the recurring SLA breach-warning check (see below).
 *
 * IMPORTANT: register() itself must return (resolve) quickly and must never
 * await anything that depends on this same server being ready to serve
 * requests. Next.js gates ALL request handling on register() finishing — so
 * if register() awaits a fetch() back into this same server, that's a
 * deadlock: the request can't be served until register() finishes, and
 * register() can't finish until that same request is served. This
 * previously took the whole site down, not just these two jobs, since every
 * unrelated request queued up behind the same block until the self-fetch's
 * own timeout eventually fired and unstuck it. Scheduling the actual work
 * via setTimeout/setInterval WITHOUT awaiting it here means register()
 * returns immediately, the server is marked ready right away, and the
 * scheduled jobs run afterward against an already-serving app — safe to
 * fetch() into it or await slow queries either way.
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
  async function checkSlaBreaches(label: string): Promise<number> {
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

  // Fire-and-forget: schedule the boot-time run and both 5-minute intervals,
  // but do NOT await any of it here — see the note above for why.
  setTimeout(() => {
    tryRestartPollers('Boot');
    checkSlaBreaches('Boot');

    // Retry loop: every 5 minutes, restart any pollers that are down.
    // This handles OAuth token expiry, network blips, and tokens that
    // weren't in DB yet when the server first booted.
    setInterval(() => { tryRestartPollers('Periodic'); }, 5 * 60 * 1000);

    // SLA breach warnings are time-sensitive (a 30-minute window), so this runs
    // on a tighter cadence than the poller retry above — every 5 minutes gives
    // several chances to catch a ticket before it enters and then leaves the
    // 30-minute window, and the route's own "already notified in the last hour"
    // check prevents repeat notifications on every tick.
    setInterval(() => { checkSlaBreaches('Periodic'); }, 5 * 60 * 1000);
  }, 8000);
}
