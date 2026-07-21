/**
 * Backfill combination + projectManager for tickets missing these fields.
 * Strategy (in order):
 *  1. Same cf_key in another space → direct copy
 *  2. Same customerName → most common combination / PM for that customer
 *  3. Summary keyword match → derive combination from migration type keywords
 *
 * Usage:
 *   node scripts/backfill-run.mjs           # dry run (shows what would change)
 *   node scripts/backfill-run.mjs --apply   # apply changes
 */
import pg from 'pg';

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) console.log('DRY RUN — pass --apply to write changes\n');

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:neutara123@localhost:5433/neutara_db' });

// ── 1. Load all tickets ────────────────────────────────────────────────────
const allRes = await pool.query(`
  SELECT id, key, cf_key, summary, combination, "projectManager", "customerName", current_department
  FROM issues
  ORDER BY "createdAt" ASC
`);
const all = allRes.rows;
console.log(`Total tickets: ${all.length}`);

const missing = all.filter(t =>
  (!t.combination || t.combination === 'null') ||
  (!t.projectManager || t.projectManager === 'null')
);
console.log(`Missing combo or PM: ${missing.length}\n`);

// ── 2. Build lookup maps ───────────────────────────────────────────────────

// Map: cf_key → {combination, projectManager} from tickets that have values
const cfKeyMap = new Map();
for (const t of all) {
  const k = t.cf_key || t.key;
  if (!k) continue;
  const hasComb = t.combination && t.combination !== 'null';
  const hasPM   = t.projectManager && t.projectManager !== 'null';
  if (!hasComb && !hasPM) continue;
  if (!cfKeyMap.has(k)) cfKeyMap.set(k, {});
  const entry = cfKeyMap.get(k);
  if (hasComb && !entry.combination) entry.combination = t.combination;
  if (hasPM   && !entry.projectManager) entry.projectManager = t.projectManager;
}

// Map: customerName → most common combination / PM
const customerComboCount = new Map();  // customerName → {combo → count}
const customerPMCount    = new Map();  // customerName → {PM → count}
for (const t of all) {
  const cust = (t.customerName || '').trim();
  if (!cust || cust === 'null') continue;
  if (t.combination && t.combination !== 'null') {
    if (!customerComboCount.has(cust)) customerComboCount.set(cust, new Map());
    const m = customerComboCount.get(cust);
    m.set(t.combination, (m.get(t.combination) || 0) + 1);
  }
  if (t.projectManager && t.projectManager !== 'null') {
    if (!customerPMCount.has(cust)) customerPMCount.set(cust, new Map());
    const m = customerPMCount.get(cust);
    m.set(t.projectManager, (m.get(t.projectManager) || 0) + 1);
  }
}
const mostCommon = (map) => {
  if (!map || !map.size) return null;
  let best = null, bestCount = 0;
  for (const [val, cnt] of map) { if (cnt > bestCount) { best = val; bestCount = cnt; } }
  return best;
};

// Keyword-based combination inference from summary
const COMBO_KEYWORDS = [
  { re: /box.*onedrive|onedrive.*box/i,           val: 'Box - OneDrive' },
  { re: /box.*sharepoint|sharepoint.*box/i,        val: 'Box - SharePoint' },
  { re: /box.*mydrive|mydrive.*box|box.*gdrive/i,  val: 'Box - MyDrive' },
  { re: /dropbox.*onedrive|onedrive.*dropbox/i,    val: 'Dropbox - OneDrive' },
  { re: /dropbox.*sharepoint|sharepoint.*dropbox/i,val: 'Dropbox - SharePoint' },
  { re: /dropbox.*mydrive|mydrive.*dropbox/i,      val: 'Dropbox - MyDrive' },
  { re: /google.*onedrive|gdrive.*onedrive/i,      val: 'Google Drive to OneDrive' },
  { re: /google.*sharepoint|gdrive.*sharepoint/i,  val: 'Google Drive to SharePoint' },
  { re: /slack.*teams|teams.*slack/i,              val: 'Slack to Teams' },
  { re: /teams.*chat|chat.*teams/i,                val: 'Teams to Chat' },
  { re: /nfs.*sharepoint|sharepoint.*nfs/i,        val: 'NFS - SharePoint' },
  { re: /s2t\b|slack.+to.+teams/i,                val: 'Slack to Teams' },
  { re: /g2t\b|gmail.*teams/i,                    val: 'Gmail to Teams' },
];
function inferCombo(summary) {
  if (!summary) return null;
  for (const { re, val } of COMBO_KEYWORDS) {
    if (re.test(summary)) return val;
  }
  return null;
}

// ── 3. Determine fill values for each missing ticket ──────────────────────
let updates = [];
for (const t of missing) {
  const k = t.cf_key || t.key;
  const cust = (t.customerName || '').trim();
  let newCombo = (t.combination && t.combination !== 'null') ? t.combination : null;
  let newPM    = (t.projectManager && t.projectManager !== 'null') ? t.projectManager : null;

  // Strategy 1: cf_key cross-match
  if (k && cfKeyMap.has(k)) {
    const src = cfKeyMap.get(k);
    if (!newCombo && src.combination) newCombo = src.combination;
    if (!newPM    && src.projectManager) newPM = src.projectManager;
  }

  // Strategy 2: customerName most-common
  if (cust) {
    if (!newCombo) newCombo = mostCommon(customerComboCount.get(cust)) || null;
    if (!newPM)    newPM    = mostCommon(customerPMCount.get(cust))    || null;
  }

  // Strategy 3: summary keyword match (combination only)
  if (!newCombo) newCombo = inferCombo(t.summary);

  const comboChanged = newCombo && newCombo !== t.combination;
  const pmChanged    = newPM    && newPM    !== t.projectManager;
  if (comboChanged || pmChanged) {
    updates.push({ id: t.id, key: k, newCombo, newPM, oldCombo: t.combination, oldPM: t.projectManager });
  }
}

console.log(`Would update: ${updates.length} tickets\n`);

// Show first 30 as preview
const preview = updates.slice(0, 30);
preview.forEach(u =>
  console.log(`  ${u.key} | combo: "${u.oldCombo}" → "${u.newCombo}" | PM: "${u.oldPM}" → "${u.newPM}"`)
);
if (updates.length > 30) console.log(`  ... and ${updates.length - 30} more`);

// ── 4. Apply ───────────────────────────────────────────────────────────────
if (!DRY_RUN && updates.length > 0) {
  console.log('\nApplying updates...');
  let done = 0;
  for (const u of updates) {
    await pool.query(
      `UPDATE issues SET combination = COALESCE($1, combination), "projectManager" = COALESCE($2, "projectManager") WHERE id = $3`,
      [u.newCombo || null, u.newPM || null, u.id]
    );
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${updates.length}...`);
  }
  console.log(`Done! Updated ${done} tickets.`);
} else if (DRY_RUN) {
  console.log('\nRun with --apply to write these changes.');
}

await pool.end();
