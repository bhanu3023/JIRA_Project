// Read-only diagnostic: find the CloudFuze Board space's custom_queues entries
// for "Pre-Sales" and "Pre-Sales-Team", how many issues currently sit in each
// (by current_department), and whether presalesteam@cloudfuze.com is already
// configured as an inbound email address and which department it routes to.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: spaceRows } = await pool.query(
    `SELECT id, key, name, custom_queues FROM spaces WHERE name ILIKE '%cloudfuze board%' OR key ILIKE '%CB%'`,
  );
  console.log(`Spaces matching "CloudFuze Board": ${spaceRows.length}`);
  for (const sp of spaceRows) {
    console.log(`\n--- Space: ${sp.name} (key=${sp.key}, id=${sp.id}) ---`);
    let cq = sp.custom_queues;
    if (typeof cq === 'string') { try { cq = JSON.parse(cq); } catch {} }
    const queues = cq?.queues || cq || [];
    for (const q of queues) {
      if (/pre.?sales/i.test(q.name || '')) {
        console.log(`Queue: "${q.name}" (id=${q.id}) members=${JSON.stringify(q.memberIds)} statuses=${(q.queueStatuses||[]).length}`);
      }
    }

    const { rows: deptCounts } = await pool.query(
      `SELECT current_department, COUNT(*)::int AS cnt FROM issues
       WHERE "spaceId" = $1 AND current_department ILIKE '%pre%sales%'
       GROUP BY current_department`,
      [sp.id],
    );
    console.log('Issue counts by current_department (pre-sales-like):', deptCounts);
  }

  const { rows: emailRows } = await pool.query(
    `SELECT id, space_key, address, department FROM email_configs WHERE address ILIKE '%presales%'`,
  );
  console.log(`\nemail_configs rows matching "presales": ${emailRows.length}`);
  for (const r of emailRows) console.log(` `, r);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
