import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: DB_URL });
  return new PrismaClient({ adapter });
}

// Reuse client across HMR reloads in development
export const db: PrismaClient = globalThis.__prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.__prisma = db;
