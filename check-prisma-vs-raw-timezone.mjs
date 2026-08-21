/**
 * check-prisma-vs-raw-timezone.mjs
 * READ-ONLY. Settles whether Prisma's own date parsing suffers the same
 * -5:30 shift confirmed for raw node-postgres reads (see
 * check-timezone-bug.mjs) by reading the SAME ticket's createdAt through
 * BOTH Prisma and a raw pg.Pool query and comparing.
 *
 * Run: DATABASE_URL=... node check-prisma-vs-raw-timezone.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb';
const { Pool } = require('./node_modules/pg/lib/index.js');
const { PrismaPg } = require('./node_modules/@prisma/adapter-pg/dist/index.js');
const { PrismaClient } = require('./node_modules/@prisma/client/index.js');

const pool = new Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const db = new PrismaClient({ adapter });

async function main() {
  const raw = await pool.query(`SELECT id, key, "createdAt", "createdAt"::text AS created_at_text FROM issues WHERE key = 'L1BOAR-15243'`);
  const row = raw.rows[0];
  console.log('RAW pg.Pool read:');
  console.log('  createdAt (parsed to JS Date):', row.createdAt.toISOString());
  console.log('  createdAt (raw text cast, no parsing):', row.created_at_text);

  const viaPrisma = await db.issue.findUnique({ where: { id: row.id }, select: { key: true, createdAt: true } });
  console.log('\nPRISMA read of the SAME row:');
  console.log('  createdAt (Prisma-parsed):', viaPrisma.createdAt.toISOString());

  const diffMs = row.createdAt.getTime() - viaPrisma.createdAt.getTime();
  console.log(`\nDifference between raw-pg read and Prisma read: ${diffMs}ms (${diffMs / 3_600_000}h)`);
  if (diffMs === 0) {
    console.log('SAME instant -- Prisma and raw pg.Pool agree, meaning Prisma also has the shift (or neither does). Compare createdAt above against the raw text cast to see which one matches the true stored value.');
  } else {
    console.log(`DIFFERENT -- one of them is wrong. The raw text cast above ("${row.created_at_text}") is the ground truth of what is actually stored (no parsing involved), so whichever of the two Date values does NOT match those digits (interpreted as UTC) is the one with the bug.`);
  }

  await db.$disconnect();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
