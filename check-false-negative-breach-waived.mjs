// check-sla-system-health.mjs's falseNegativeBreach check didn't account for
// waived -- a legitimately waived breach correctly shows isBreached:false
// despite real elapsed time exceeding the goal, which isn't a bug. Checks
// whether CF-30766/CF-33368/CF-29697's Migration instances are actually
// waived before treating this as something to fix. Read-only.
//
// Usage: node check-false-negative-breach-waived.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const KEYS = ['CF-30766', 'CF-33368', 'CF-29697'];

async function main() {
  const { rows } = await pool.query(`
    SELECT COALESCE(cf_key, key) AS key, sla_snapshot, sla_waivers
    FROM issues WHERE COALESCE(cf_key, key) = ANY($1::text[])
  `, [KEYS]);

  for (const row of rows) {
    console.log(`=== ${row.key} ===`);
    console.log('sla_waivers:', JSON.stringify(row.sla_waivers));
    for (const inst of row.sla_snapshot || []) {
      if (inst.deptName === 'Migration') {
        console.log(`  Migration instance: isBreached=${inst.isBreached} waived=${inst.waived} waivedByName=${inst.waivedByName} waivedReason=${inst.waivedReason} actualElapsedMs=${inst.actualElapsedMs} goalDurationMs=${inst.goalDurationMs}`);
      }
    }
    console.log('');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
