import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient() {
  // Default pg pool max is 10 — far too low once concurrent users start
  // stacking up (each request holds a connection for the duration of its
  // queries), causing requests to queue behind the pool instead of failing
  // fast or running in parallel. 20 gives real headroom while staying well
  // under Postgres's default max_connections (100), leaving room for the
  // other pools in this app (jira-pg-api.ts's raw pool, email pollers, etc).
  // connectionTimeoutMillis bounds how long a query waits for a free connection
  // in the pool — without it (pg's default is 0 = wait forever), a saturated or
  // exhausted pool makes every request hang indefinitely instead of failing fast.
  const adapter = new PrismaPg({ connectionString: DB_URL, max: 20, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  return new PrismaClient({ adapter });
}

// Reuse client across HMR reloads in development
export const db: PrismaClient = globalThis.__prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.__prisma = db;
