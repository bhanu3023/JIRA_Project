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

  // Jira has no push/webhook wired up for these boards, and previously the
  // ONLY way a new L2B/L3B ticket ever reached this app was someone opening
  // its exact URL by hand (which also silently 404'd -- see the PREFIX_TO_META
  // fix in jira-pg-api.ts). Real gap found: local was ~900 L2B and ~100 L3B
  // tickets behind Jira, going back about a month.
  //
  // This calls the API over HTTP rather than importing runJiraIssueSync
  // directly -- importing anything from jira-pg-api.ts here drags in
  // email-service.ts's imapflow/mailsplit dependency chain (needs Node's
  // 'stream' module), which broke the build for every route the moment it
  // was tried. The endpoint has no user session to check since this is a
  // background job, so it authenticates with a per-process secret instead
  // (see internal-job-secret.ts) rather than an empty/missing Authorization
  // header -- an unauthenticated call is exactly why checkSlaBreaches above
  // silently 401s and never actually notifies anyone.
  async function syncJiraIssues(label: string): Promise<void> {
    try {
      const { INTERNAL_JOB_SECRET } = await import('@/lib/internal-job-secret');
      // 500 is the endpoint's own hard cap (see jira-issue-sync's `limit`
      // clamp) -- asking for it explicitly just means a freshly-deployed
      // server clears a ~1000-issue backlog in 2 ticks instead of 20.
      const res = await fetch(`${internalUrl}/api/jira-issue-sync?limit=500`, {
        method: 'POST',
        headers: { 'x-internal-job-secret': INTERNAL_JOB_SECRET },
      });
      const data = await res.json().catch(() => ({}));
      const imported: string[] = data.imported ?? [];
      const errors: string[] = data.errors ?? [];
      if (imported.length > 0) console.log(`[Jira Sync] ${label} — imported ${imported.length} issue(s):`, imported);
      if (errors.length > 0) console.error(`[Jira Sync] ${label} — ${errors.length} error(s):`, errors.slice(0, 10));
    } catch (err) {
      console.error(`[Jira Sync] ${label} — failed:`, err);
    }
  }

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

  // One-time catch-up: fills Client Name (from the reporter's email domain)
  // on every EXISTING ticket that predates auto-fill at creation time. The
  // endpoint itself is idempotent (checks app_settings before touching
  // anything and only ever runs the bulk update once), so calling it on
  // every boot is safe -- it's a real no-op after the first successful run.
  async function backfillClientNames(label: string): Promise<void> {
    try {
      const { INTERNAL_JOB_SECRET } = await import('@/lib/internal-job-secret');
      const res = await fetch(`${internalUrl}/api/admin/backfill-client-names`, {
        method: 'POST',
        headers: { 'x-internal-job-secret': INTERNAL_JOB_SECRET },
      });
      const data = await res.json().catch(() => ({}));
      if (data.updated > 0) console.log(`[Client Name backfill] ${label} — filled ${data.updated} ticket(s).`);
    } catch (err) {
      console.error(`[Client Name backfill] ${label} — failed:`, err);
    }
  }

  // Fire-and-forget: schedule the boot-time run and both 5-minute intervals,
  // but do NOT await any of it here — see the note above for why.
  setTimeout(() => {
    tryRestartPollers('Boot');
    checkSlaBreaches('Boot');
    syncJiraIssues('Boot');
    backfillClientNames('Boot');

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

    // Catch up on new Jira tickets every 5 minutes. The very first run after
    // this ships processes the whole existing backlog (uncapped -- see
    // runJiraIssueSync's default maxPerRun), which takes a while the first
    // time; every run after that is just whatever's new since the last tick.
    setInterval(() => { syncJiraIssues('Periodic'); }, 5 * 60 * 1000);
  }, 8000);
}
