// Confirm whether these 4 Migration queue memberIds actually exist as
// real rows in `users`. If not, the Assignee filter is silently falling
// back to "show everything" when given an ID it can't resolve, instead
// of correctly matching zero tickets. Read-only.
//
// Usage: node check-stale-member-ids.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const suspectIds = [
    'pg_8g68kcrard',
    'usr_pallavi_kosuvaripalli_cloudfuze_com',
    'usr_arundhati_sen_cloudfuze_com',
    'ar_99238a2f89449b526e269a64',
  ];
  const { rows } = await pool.query(`SELECT id, "firstName", "lastName", email FROM users WHERE id = ANY($1::text[])`, [suspectIds]);
  console.log(`${rows.length} of ${suspectIds.length} suspect IDs exist as real users:`);
  console.log(JSON.stringify(rows, null, 2));
  const foundIds = new Set(rows.map(r => r.id));
  const missing = suspectIds.filter(id => !foundIds.has(id));
  console.log(`\nIDs with NO matching user row (orphaned): ${JSON.stringify(missing)}`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
