import pg from 'pg';
const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

const all = (await pool.query(`
  SELECT id, key, cf_key, summary, "productType", combination, "projectManager", "customerName", current_department
  FROM issues
`)).rows;

const migMissing = all.filter(t =>
  t.current_department === 'Migration' && (
    (!t.combination || t.combination === 'null' || t.combination === '') ||
    (!t.projectManager || t.projectManager === 'null' || t.projectManager === '')
  )
);
console.log(`Migration tickets missing PM or combo: ${migMissing.length}`);

// ── Extract combination from summary ──────────────────────────────────────
// L1BOAR summaries often: "CustomerName | Combo | Action"
// Normalize short codes to full combo names
const COMBO_NORMALIZE = {
  'sd-od': 'Shared Drive - OneDrive', 'od-od': 'OneDrive - OneDrive',
  'md-md': 'MyDrive - MyDrive', 'sd-sd': 'Shared Drive - Shared Drive',
  'sd-md': 'Shared Drive - MyDrive', 'md-od': 'MyDrive - OneDrive',
  'md-sd': 'MyDrive - Shared Drive', 'od-md': 'OneDrive - MyDrive',
  'od-sd': 'OneDrive - Shared Drive', 'sd-spo': 'Shared Drive - SharePoint',
  'od-spo': 'OneDrive - SharePoint', 'md-spo': 'MyDrive - SharePoint',
  'od-td': 'OneDrive - Team Drive', 'sd-td': 'Shared Drive - Team Drive',
  'gmail - gmail': 'Gmail - Gmail', 'outlook - outlook': 'Outlook - Outlook',
  'gmail-gmail': 'Gmail - Gmail', 'outlook-outlook': 'Outlook - Outlook',
};

function extractComboFromSummary(s) {
  if (!s) return null;
  // Pattern: "CustomerName | COMBO | description"
  const parts = s.split(/\s*\|\s*/);
  if (parts.length >= 2) {
    const candidate = parts[1].trim();
    // Check if it looks like a migration combination (contains - or &)
    if (/\w.*[-&].*\w/.test(candidate) && candidate.length < 80) {
      const lower = candidate.toLowerCase();
      return COMBO_NORMALIZE[lower] || candidate;
    }
    // Also try "Gmail - Gmail" style in second segment
    if (/gmail|outlook|exchange|box|dropbox|onedrive|sharepoint|gdrive|drive|slack|teams|meta/i.test(candidate)) {
      const lower = candidate.toLowerCase();
      return COMBO_NORMALIZE[lower] || candidate;
    }
  }
  // Also check inline like "SD-SD & MD-MD"
  const m = s.match(/\b(SD|OD|MD|TD|SPO)[-–](SD|OD|MD|TD|SPO)(?:\s*&\s*(SD|OD|MD|TD|SPO)[-–](SD|OD|MD|TD|SPO))?\b/i);
  if (m) {
    const key = m[0].toLowerCase().replace(/\s/g,'');
    return COMBO_NORMALIZE[key] || m[0];
  }
  return null;
}

// ── Customer → PM cross-match ─────────────────────────────────────────────
function extractCusts(s) {
  if (!s) return [];
  const results = [];
  const m1 = s.match(/^([^|\-]{2,40?})\s*[\-|]/);
  if (m1) results.push(m1[1].trim().toLowerCase());
  const parts = s.split(/\s*\|\s*/);
  if (parts.length > 1) results.push(parts[0].trim().toLowerCase());
  return results.filter(c => c.length > 2);
}

const custPM = new Map();
const custCombo = new Map();
for (const t of all) {
  // PM map
  if (t.projectManager && t.projectManager !== 'null' && t.projectManager !== '') {
    for (const cust of [(t.customerName||'').trim().toLowerCase(), ...extractCusts(t.summary)]) {
      if (!cust || cust.length < 2) continue;
      if (!custPM.has(cust)) custPM.set(cust, new Map());
      custPM.get(cust).set(t.projectManager, (custPM.get(cust).get(t.projectManager)||0)+1);
    }
  }
  // Combo map
  if (t.combination && t.combination !== 'null' && t.combination !== '') {
    for (const cust of [(t.customerName||'').trim().toLowerCase(), ...extractCusts(t.summary)]) {
      if (!cust || cust.length < 2) continue;
      if (!custCombo.has(cust)) custCombo.set(cust, new Map());
      custCombo.get(cust).set(t.combination, (custCombo.get(cust).get(t.combination)||0)+1);
    }
  }
}
const mostCommon = m => { let b=null,bc=0; for (const [v,c] of m) if (c>bc){b=v;bc=c;} return b; };

// ── Fill missing fields ────────────────────────────────────────────────────
let updates = [];
for (const t of migMissing) {
  const needCombo = !t.combination || t.combination === 'null' || t.combination === '';
  const needPM = !t.projectManager || t.projectManager === 'null' || t.projectManager === '';

  let newCombo = null, newPM = null;

  if (needCombo) {
    // 1. Extract from summary
    newCombo = extractComboFromSummary(t.summary);
    // 2. Customer cross-match
    if (!newCombo) {
      for (const cust of extractCusts(t.summary)) {
        if (custCombo.has(cust)) { newCombo = mostCommon(custCombo.get(cust)); break; }
      }
    }
  }

  if (needPM) {
    // 1. Customer cross-match
    for (const cust of extractCusts(t.summary)) {
      if (custPM.has(cust)) { newPM = mostCommon(custPM.get(cust)); break; }
    }
    const cn = (t.customerName||'').trim().toLowerCase();
    if (!newPM && cn && cn !== 'null' && custPM.has(cn)) newPM = mostCommon(custPM.get(cn));
  }

  if (newCombo || newPM) {
    updates.push({ id: t.id, key: t.key, newCombo, newPM,
      oldCombo: t.combination, oldPM: t.projectManager,
      summary: (t.summary||'').slice(0, 70) });
  }
}

const withCombo = updates.filter(u => u.newCombo).length;
const withPM = updates.filter(u => u.newPM).length;
console.log(`\nWould update: ${updates.length} tickets`);
console.log(`  Combo fills: ${withCombo}`);
console.log(`  PM fills:    ${withPM}`);

console.log('\nSample:');
updates.slice(0, 20).forEach(u =>
  console.log(`  ${u.key}: combo="${u.newCombo||'(no change)'}" | pm="${u.newPM||'(no change)'}" | ${u.summary}`)
);

if (!DRY_RUN && updates.length > 0) {
  console.log('\nApplying...');
  let done = 0;
  for (const u of updates) {
    const sets = [], vals = [];
    if (u.newCombo) { sets.push(`combination = $${sets.length+1}`); vals.push(u.newCombo); }
    if (u.newPM)    { sets.push(`"projectManager" = $${sets.length+1}`); vals.push(u.newPM); }
    vals.push(u.id);
    await pool.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${updates.length}...`);
  }
  console.log(`Done! Updated ${done} tickets.`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write changes.');
}

await pool.end();
