/**
 * pg-pool.ts
 *
 * ONE shared raw-SQL connection pool for the whole app. Before this, six-plus
 * different files each created their OWN `new Pool(...)` — jira-pg-api.ts,
 * rr-service.ts, connector-service.ts, notification-service.ts (x2 call
 * sites), jira-dev-mock.ts, and worst of all oauth-service.ts and
 * email-service.ts, which opened a BRAND NEW pool (and physical connection)
 * on every single call and immediately closed it afterward. With dozens of
 * mailboxes refreshing OAuth tokens continuously, that created a constant
 * churn of extra Postgres connections competing with every other pool for
 * the same finite max_connections (100 by default) — starving unrelated
 * features at random. This is exactly what produced "Connection terminated
 * due to connection timeout" in login, JWT verification, and the monitor
 * agent, all within the same few seconds, with no deploy or restart involved.
 *
 * Every raw pg.Pool user in the app should import `pgPool` from here instead
 * of constructing its own — and never call `.end()` on it, since its
 * lifecycle is shared, not owned by any one caller.
 */
import { Pool, types } from 'pg';

// node-postgres has no timezone to attach to a `timestamp without time zone`
// value (createdAt/updatedAt/dueDate on `issues` are all this type), so its
// default parser for that type (OID 1114) falls back to interpreting the
// naive "YYYY-MM-DD HH:MM:SS" string using the Node process's LOCAL
// timezone instead of the UTC the database session actually stores it in --
// silently shifting every value read back by the server's UTC offset (e.g.
// -5:30 on a server running in IST). timestamptz columns (dept_sla_started_at,
// resolvedAt) are unaffected since they carry their own offset. Confirmed
// live: NOW() written into both a TIMESTAMP and a TIMESTAMPTZ column in the
// same INSERT read back 5.5 hours apart through the default parser. Forcing
// the naive string to be read as UTC (appending 'Z') makes it agree with the
// timestamptz columns and with what is actually stored.
types.setTypeParser(1114, (str: string) => new Date(str + 'Z'));

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';

function createPool(): Pool {
  return new Pool({
    connectionString: DB_URL,
    // Sized alongside db.ts's Prisma pool (also 20) — comfortably under
    // Postgres's default max_connections (100) with room to spare, now that
    // this is the ONLY other pool in the app instead of six-plus separate ones.
    max: 20,
    // Without this, pg defaults to waiting forever for a free connection once
    // the pool is saturated — a starved pool then hangs every request instead
    // of failing fast.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

// Reuse across HMR reloads in development, same pattern as db.ts.
export const pgPool: Pool = globalThis.__pgPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalThis.__pgPool = pgPool;

declare global {
  // eslint-disable-next-line no-var
  var __eventLoopLagMonitorStarted: boolean | undefined;
}

// A ticket-open timeout was reported recurring across unrelated tickets, with
// individual queries independently confirmed fast (EXPLAIN ANALYZE, sub-20ms)
// when re-run in isolation -- so the seconds-long delays users actually saw
// weren't the queries themselves. That leaves two candidate causes that look
// identical from inside a single request: connection-pool queueing (covered
// by the pgPool stats logged alongside the slow-request warning in
// jira-pg-api.ts) and the whole Node process's event loop being blocked by
// something CPU-bound elsewhere (a large synchronous JSON.stringify, a big
// array loop, etc.), which would stall every in-flight request at once
// regardless of which pool its query used. This samples loop lag every 5s
// and logs when it's high enough to actually explain multi-second delays,
// so the next occurrence has a real answer instead of another guess.
if (!globalThis.__eventLoopLagMonitorStarted) {
  globalThis.__eventLoopLagMonitorStarted = true;
  const INTERVAL_MS = 5_000;
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - INTERVAL_MS;
    lastTick = now;
    if (lag > 300) {
      console.warn(`[EVENT-LOOP] lag=${lag}ms -- the Node process was blocked for this long instead of processing other requests, likely by CPU-bound synchronous work somewhere.`);
    }
  }, INTERVAL_MS);
}
