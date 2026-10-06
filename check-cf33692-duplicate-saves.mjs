// Truncates long HTML field values so the output stays readable, and
// groups issue_history rows by field to spot duplicate/looping saves --
// the earlier full dump showed "root cause" written 3+ times with the
// identical value within ~2.4 seconds, and ~24 "Updated by Pragati
// Pandey" notifications firing in a ~24s burst. Pinpointing exactly
// which fields duplicated and how many times. Read-only.
//
// Usage: node check-cf33692-duplicate-saves.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function truncate(s, n = 60) {
  if (s == null) return 'null';
  const plain = String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > n ? plain.slice(0, n) + '…' : plain;
}

async function main() {
  const { rows: issueRows } = await pool.query(
    `SELECT id FROM issues WHERE key = 'CF-33692' OR cf_key = 'CF-33692' LIMIT 1`
  );
  const issue = issueRows[0];

  const { rows: hist } = await pool.query(`
    SELECT field, "oldValue", "newValue", "authorName", "createdAt"
    FROM issue_history
    WHERE "issueId" = $1 AND "createdAt" >= '2026-10-06T10:58:00Z'
    ORDER BY "createdAt" ASC
  `, [issue.id]);
  console.log(`${hist.length} issue_history rows from 10:58 onward:`);
  for (const h of hist) {
    console.log(`  [${h.createdAt?.toISOString?.()}] ${h.field}: "${truncate(h.oldValue, 30)}" -> "${truncate(h.newValue, 50)}" by ${h.authorName}`);
  }

  const { rows: notifs } = await pool.query(`
    SELECT subject, recipients, "createdAt"
    FROM notification_log
    WHERE subject ILIKE '%CF-33692%' AND "createdAt" >= '2026-10-06T10:58:00Z'
    ORDER BY "createdAt" ASC
  `);
  console.log(`\n${notifs.length} notification_log rows from 10:58 onward:`);
  for (const n of notifs) {
    console.log(`  [${n.createdAt?.toISOString?.()}] "${truncate(n.subject, 70)}" -> ${n.recipients}`);
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
