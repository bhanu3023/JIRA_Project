/**
 * revert-presales-queue-members.mjs
 *
 * Undoes fix-presales-queue-members.mjs: removes exactly the members it
 * added to the Pre-Sales queue (the full Dev/Migration staff list),
 * restoring Pre-Sales to whoever was on it before (Nivas B, Vignesh T,
 * and whichever third id "before: 3" in that script's own report
 * referred to). Never asked for -- undoing it.
 *
 * SAFE BY DEFAULT: dry run unless DRY_RUN=false is passed explicitly.
 *
 * Run: node revert-presales-queue-members.mjs
 * Apply for real: DRY_RUN=false node revert-presales-queue-members.mjs
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://jirauser:Neutara%402024@localhost:5432/jiradb',
});

const DRY_RUN = process.env.DRY_RUN !== 'false';

// Exact set added by fix-presales-queue-members.mjs's real run.
const IDS_TO_REMOVE = new Set([
  'pg_6acdmwma8k', 'pg_3qs010ohxf', 'pg_1hrjiywece', 'pg_b6pkipkamo', 'pg_oi9gf494i2',
  'guest_abhinav_surattu_cloudfuze_com', 'pg_5fadlcfqhr', 'pg_sc56fmz79j', 'pg_3lc6y8c9x7',
  'pg_1m9s5c32uu', 'usr_sairaj_kanigicharla_cloudfuze_com', 'pg_on73cwx5te', 'pg_re39aa1bez',
  'pg_k5c3au94xn', 'pg_2r4daq3sf2', 'usr_shiva_amuda_cloudfuze_com', 'usr_shivam_singh_cloudfuze_com',
  'pg_35ir2rs9h3', 'pg_s8qucswiur', 'usr_srinu_gudimitla_cloudfuze_com',
  'usr_praveen_kumar_vancharla_cloudfuze_com', '6f770436-5089-4893-acb8-747d6c68e835',
  'usr_praveen_kothagolla_cloudfuze_com', 'pg_xfzjhrm2i1', 'usr_vishal_kumar_cloudfuze_com',
  'usr_rehan_khan_cloudfuze_com', 'pg_k1p79j5sl9', 'pg_7da8vs32an', 'usr_jaswanth_adari_cloudfuze_com',
  'pg_iri3tflqn7', 'pg_mawkgv3jc', 'pg_slqls8e2hg', 'pg_6x0m06gscc', 'pg_06et0mfiyt', 'pg_2k8njrsy29',
  'pg_hl6yc66vzb', 'pg_8g68kcrard', 'pg_eew90ftna7', 'usr_pallavi_kosuvaripalli_cloudfuze_com',
  'pg_b1ttbxd9k0', 'pg_ij3dk69wzx', 'pg_kk3j6mska8', 'usr_arundhati_sen_cloudfuze_com', 'pg_qzx2fd56tf',
  'pg_8fxft5o8uj', 'pg_s68gu26al1', 'pg_3p2z3p0qoo', 'usr_sriram_ramakrishnan_cloudfuze_com',
  'pg_2udycegsep', 'pg_id236f00qb', 'pg_u9vc89wm8e', 'pg_7pxgdgvt3u', 'pg_ia7glmzoji',
  'ar_99238a2f89449b526e269a64', 'pg_sx3i96si11', 'pg_sitpis570o', 'pg_5qkf2zt9u4', 'pg_fxwatbcdm2',
  'pg_woe4qhur4z', 'pg_tki1df2838', 'pg_mdrbxrinb3',
]);

async function main() {
  const rows = await pool.query(`SELECT space_key, queues FROM custom_queues`);
  const plan = [];

  for (const row of rows.rows) {
    const queues = row.queues || [];
    const presalesQueue = queues.find((q) => (q.name || '').toLowerCase() === 'pre-sales');
    if (!presalesQueue) continue;

    const before = presalesQueue.memberIds || [];
    const after = before.filter((id) => !IDS_TO_REMOVE.has(id));
    if (after.length === before.length) continue;

    presalesQueue.memberIds = after;
    plan.push({ space: row.space_key, before: before.length, after: after.length, removedCount: before.length - after.length });

    if (!DRY_RUN) {
      await pool.query(`UPDATE custom_queues SET queues = $1::jsonb WHERE space_key = $2`, [JSON.stringify(queues), row.space_key]);
    }
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} Pre-Sales queue membership:`);
  console.log(JSON.stringify(plan, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
