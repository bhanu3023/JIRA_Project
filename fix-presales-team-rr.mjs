// Fixes the round-robin assignment gap: CloudFuze Board's rr_config has no
// "Pre-Sales-Team" department at all, so getNextAgent() always returns null
// for it and every Pre-Sales-Team email ticket lands unassigned (confirmed:
// 259/260 recent ones). Adds a Pre-Sales-Team department using that queue's
// own already-configured active members (Harsh, Nivas, Vignesh T, Vimalesh T)
// as the rotation. Dry run by default; --apply to write.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const NEW_DEPT = {
  name: 'Pre-Sales-Team',
  order: 99,
  isDefault: false,
  agents: [
    { userId: 'pg_53hgizbzhw',            name: 'Harsh',      isActive: true, maxTickets: 10 },
    { userId: 'pg_vm3oypqs04',            name: 'Nivas',      isActive: true, maxTickets: 10 },
    { userId: 'pg_aazp2va4mb',            name: 'Vignesh T',  isActive: true, maxTickets: 10 },
    { userId: 'usr_vimalesh_t_cloudfuze_com', name: 'Vimalesh T', isActive: true, maxTickets: 10 },
  ],
  currentIndex: 0,
};

async function main() {
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = 'CF' OR name ILIKE '%cloudfuze board%'`);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) { console.log('CloudFuze Board space not found.'); await pool.end(); return; }

  const { rows } = await pool.query(`SELECT departments FROM rr_config WHERE space_id = $1`, [spaceId]);
  const current = rows[0]?.departments || [];
  if (current.some((d) => (d.name || '').trim().toLowerCase() === 'pre-sales-team')) {
    console.log('A "Pre-Sales-Team" department already exists in rr_config -- nothing to add. Current departments:');
    console.log(JSON.stringify(current, null, 2));
    await pool.end();
    return;
  }

  const next = [...current, NEW_DEPT];
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: would add department:`);
  console.log(JSON.stringify(NEW_DEPT, null, 2));
  console.log(`\nResulting departments count: ${current.length} -> ${next.length}`);

  if (APPLY) {
    await pool.query(
      `INSERT INTO rr_config (space_id, departments, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (space_id) DO UPDATE SET departments = $2, updated_at = NOW()`,
      [spaceId, JSON.stringify(next)],
    );
    console.log('\nApplied.');
  } else {
    console.log('\nDry run only -- re-run with --apply to write.');
  }

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
