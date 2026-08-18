// Generated fresh per server process. Lets instrumentation.ts's own
// self-fetch calls (scheduled background jobs, no user session) authenticate
// to the API without a real login -- without this, every such call 401s at
// the blanket "no session -> Unauthorized" gate in jira-pg-api.ts (this is
// exactly why the existing SLA breach-warning job silently never fires:
// checkSlaBreaches() calls POST /api/sla-breach-check with no auth header at
// all). Kept in its own tiny leaf module with zero heavy imports -- anything
// pulled in from jira-pg-api.ts itself drags in email-service.ts's
// imapflow/mailsplit chain, which needs Node's 'stream' module and breaks
// instrumentation.ts's build the moment it's imported there.
//
// Uses the Web Crypto API (globalThis.crypto), not Node's `crypto` module --
// this file gets bundled for instrumentation.ts's edge-runtime variant too,
// and a static `import ... from 'crypto'` isn't resolvable there, which
// broke the build the same way the 'stream' import did above. Web Crypto is
// available in both the Node.js and Edge runtimes without any import.
//
// Cached on globalThis rather than a plain module-level const: Next.js
// compiles instrumentation.ts and the /api catch-all route as separate
// webpack bundles, so each gets its OWN instance of this module -- a plain
// `const` computed at module load would generate two different values, one
// per side, and the two would never match. globalThis is the one thing
// actually shared across every bundle in the same Node process.
declare global {
  // eslint-disable-next-line no-var
  var __internalJobSecret: string | undefined;
}
if (!globalThis.__internalJobSecret) {
  globalThis.__internalJobSecret = `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`;
}
export const INTERNAL_JOB_SECRET: string = globalThis.__internalJobSecret;
