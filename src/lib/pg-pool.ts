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
import { Pool } from 'pg';

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
