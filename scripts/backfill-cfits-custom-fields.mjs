/**
 * One-time backfill: fills missing projectManager and combination
 * for CFITS board Migration queue tickets, using values already stored
 * on the same ticket (matched by cf_key or key across spaces).
 *
 * Run: node scripts/backfill-cfits-custom-fields.mjs
 * Requires SSH tunnel: ssh -L 5433:localhost:5432 root@neutaraticketing.cftools.live -N
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db',
});

async function main() {
  console.log('Connecting to DB...');

  // 1. Find CFITS board space(s)
  // Pass space key as arg: node scripts/backfill-cfits-custom-fields.mjs CFITS
  const argKey = process.argv[2]?.toUpperCase();
  const spacesRes = await pool.query(
    argKey
      ? `SELECT id, key, name FROM spaces WHERE UPPER(key) = $1`
      : `SELECT id, key, name FROM spaces WHERE UPPER(key) LIKE '%CFIT%' OR LOWER(name) LIKE '%cfits%'`,
    argKey ? [argKey] : []
  );
  if (!spacesRes.rows.length) {
    const allSpaces = await pool.query(`SELECT id, key, name FROM spaces ORDER BY name`);
    console.log('Available spaces:');
    allSpaces.rows.forEach(s => console.log(`  ${s.key} — ${s.name}`));
    console.log('\nUsage: node scripts/backfill-cfits-custom-fields.mjs <SPACE_KEY>');
    await pool.end();
    return;
  }
  console.log('Found spaces:', spacesRes.rows.map(s => `${s.key} (${s.name})`).join(', '));
  const spaceIds = spacesRes.rows.map(s => s.id);

  // 2. Count Migration queue tickets missing projectManager or combination
  const missingRes = await pool.query(
    `SELECT id, key, cf_key, "projectManager", combination, current_department
     FROM issues
     WHERE "spaceId" = ANY($1::text[])
       AND (LOWER(current_department) = 'migration' OR LOWER(current_department) LIKE '%migrat%')
       AND (("projectManager" IS NULL OR "projectManager" = '')
            OR (combination IS NULL OR combination = ''))
     ORDER BY "createdAt" DESC`,
    [spaceIds]
  );
  console.log(`\nMigration queue tickets missing projectManager or combination: ${missingRes.rows.length}`);

  if (!missingRes.rows.length) {
    console.log('Nothing to backfill — all tickets already have values!');
    await pool.end();
    return;
  }

  // 3. For each missing ticket, look for the same cf_key or key in ANY space that has values filled
  let updated = 0;
  let skipped = 0;

  for (const ticket of missingRes.rows) {
    const lookupKey = ticket.cf_key || ticket.key;
    if (!lookupKey) { skipped++; continue; }

    // Find any ticket with the same cf_key or key that has these values filled
    const sourceRes = await pool.query(
      `SELECT "projectManager", combination
       FROM issues
       WHERE (cf_key = $1 OR key = $1)
         AND id != $2
         AND ("projectManager" IS NOT NULL AND "projectManager" != ''
              OR combination IS NOT NULL AND combination != '')
       LIMIT 1`,
      [lookupKey, ticket.id]
    );

    let newPM = ticket.projectManager;
    let newComb = ticket.combination;

    if (sourceRes.rows[0]) {
      const src = sourceRes.rows[0];
      if (!newPM && src.projectManager) newPM = src.projectManager;
      if (!newComb && src.combination)   newComb = src.combination;
    }

    // If still no values found from cross-match, check partner key
    if ((!newPM || !newComb)) {
      const partnerRes = await pool.query(
        `SELECT i."projectManager", i.combination
         FROM issues i
         JOIN issues orig ON orig."partnerKey" = i.key OR i."partnerKey" = orig.key
         WHERE orig.id = $1
           AND (i."projectManager" IS NOT NULL OR i.combination IS NOT NULL)
         LIMIT 1`,
        [ticket.id]
      ).catch(() => ({ rows: [] }));
      if (partnerRes.rows[0]) {
        if (!newPM  && partnerRes.rows[0].projectManager) newPM  = partnerRes.rows[0].projectManager;
        if (!newComb && partnerRes.rows[0].combination)   newComb = partnerRes.rows[0].combination;
      }
    }

    if (newPM !== ticket.projectManager || newComb !== ticket.combination) {
      await pool.query(
        `UPDATE issues SET "projectManager" = $1, combination = $2 WHERE id = $3`,
        [newPM || null, newComb || null, ticket.id]
      );
      console.log(`  ✓ Updated ${ticket.cf_key || ticket.key}: PM="${newPM || '—'}" | Combination="${newComb || '—'}"`);
      updated++;
    } else {
      console.log(`  ⚠ No source found for ${ticket.cf_key || ticket.key} — skipped`);
      skipped++;
    }
  }

  console.log(`\nDone. Updated: ${updated} | Skipped (no source): ${skipped}`);

  // 4. Show summary of what's still missing
  const stillMissingRes = await pool.query(
    `SELECT COUNT(*) FROM issues
     WHERE "spaceId" = ANY($1::text[])
       AND (LOWER(current_department) = 'migration' OR LOWER(current_department) LIKE '%migrat%')
       AND (("projectManager" IS NULL OR "projectManager" = '')
            OR (combination IS NULL OR combination = ''))`,
    [spaceIds]
  );
  console.log(`Still missing after backfill: ${stillMissingRes.rows[0].count}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
