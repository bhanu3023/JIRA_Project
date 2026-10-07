// Checks whether issues.projectPool reliably holds a clean ENT/SMB value for
// Migration department tickets -- if so, MBR's Migration ENT/SMB split could
// be driven by each ticket's own projectPool field (self-maintaining, no
// roster list to drift) instead of a hand-maintained per-person email list
// that's already confirmed drifted from the live Migration queue. Also
// checks it per the 8 people missing from that list, and per the 3 stale
// ones, to see whether their own tickets' projectPool values would cleanly
// place them on the right sub-team. Read-only.
//
// Usage: node check-migration-projectpool.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('=== Distinct projectPool values on Migration-department tickets ===');
  const { rows: distinctVals } = await pool.query(`
    SELECT COALESCE("projectPool", '(null/empty)') AS pool, COUNT(*) AS cnt
    FROM issues
    WHERE LOWER(current_department) = 'migration'
    GROUP BY "projectPool"
    ORDER BY cnt DESC
  `);
  for (const r of distinctVals) console.log(`  ${r.pool}: ${r.cnt}`);

  console.log('\n=== Per missing/stale person: their own tickets\' projectPool breakdown ===');
  const people = [
    'ambika.patil@cloudfuze.com', 'bharath.tummaganti@cloudfuze.com', 'jyoshitha.dhannapaneni@cloudfuze.com',
    'kiran.ummenthala@cloudfuze.com', 'meghana.chowdada@cloudfuze.com', 'nithish.bunne@cloudfuze.com',
    'sanjana.nerella@cloudfuze.com', 'vainateya.rasala@cloudfuze.com',
    'lakshmi.prasanna@cloudfuze.com', 'abhishikth.yenugula@cloudfuze.com', 'raghu.yellani@cloudfuze.com',
  ];
  for (const email of people) {
    const { rows } = await pool.query(`
      SELECT COALESCE(i."projectPool", '(null/empty)') AS pool, COUNT(*) AS cnt
      FROM issues i JOIN users u ON u.id = i."assigneeId"
      WHERE LOWER(u.email) = LOWER($1) AND LOWER(i.current_department) = 'migration'
      GROUP BY i."projectPool"
      ORDER BY cnt DESC
    `, [email]);
    const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
    console.log(`${email} (${total} Migration tickets assigned):`, rows.map(r => `${r.pool}=${r.cnt}`).join(', ') || '(none)');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
