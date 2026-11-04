// Imports the extracted Test Repository dump (folders + test cases with
// steps, already flattened from the source tool's MongoDB export) into
// test_repo_folders / test_cases, scoped to the given space (default
// TESTIN / CloudFuze Board). Dry-run by default -- pass --apply to write.
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const SPACE_KEY = (process.argv.find((a) => a.startsWith('--space=')) || '--space=TESTIN').split('=')[1];
const DATA_PATH = process.argv[2]?.startsWith('--') ? null : process.argv[2];

function rid() { return `tc_${Math.random().toString(36).slice(2, 12)}`; }

async function main() {
  if (!DATA_PATH || !fs.existsSync(DATA_PATH)) {
    console.error('Usage: node import-test-repo-data.mjs <path-to-test-repo-import-data.json> [--space=TESTIN] [--apply]');
    process.exit(1);
  }
  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY.toUpperCase()]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) { console.error(`Space ${SPACE_KEY} not found`); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log(`Loaded ${data.folders.length} folders, ${data.tests.length} tests from dump.`);
  console.log(`Target space: ${SPACE_KEY} (${spaceId})`);

  const { rows: existingFolderCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM test_repo_folders WHERE "spaceId" = $1`, [spaceId]);
  const { rows: existingTestCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM test_cases WHERE "spaceId" = $1`, [spaceId]);
  console.log(`Currently in this space: ${existingFolderCount[0].c} folders, ${existingTestCount[0].c} tests.`);

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to actually import.');
    await pool.end();
    return;
  }

  // Folders first (parent path references), skip if already present.
  let foldersInserted = 0;
  for (const f of data.folders) {
    const id = rid();
    const result = await pool.query(
      `INSERT INTO test_repo_folders (id, "spaceId", name, path, "parentPath", source)
       VALUES ($1,$2,$3,$4,$5,'imported') ON CONFLICT ("spaceId", path) DO NOTHING`,
      [id, spaceId, f.name, f.path, f.parentPath || '/'],
    );
    if (result.rowCount) foldersInserted++;
  }
  console.log(`Inserted ${foldersInserted} new folders (${data.folders.length - foldersInserted} already existed).`);

  // Tests in batches, skip duplicates by jiraKey.
  const BATCH = 300;
  let testsInserted = 0;
  for (let i = 0; i < data.tests.length; i += BATCH) {
    const batch = data.tests.slice(i, i + BATCH);
    // Columns: id, spaceId, jiraKey, issueId, summary, description, testType, status, folderPath, steps, source
    const values2 = [];
    const params2 = [];
    let n = 1;
    for (const t of batch) {
      values2.push(`($${n},$${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7},$${n+8},$${n+9}::jsonb,'imported')`);
      params2.push(rid(), spaceId, t.jiraKey, t.issueId, t.summary.slice(0, 2000), t.description, t.testType, t.status, t.folderPath || '/', JSON.stringify(t.steps || []));
      n += 10;
    }
    const result = await pool.query(
      `INSERT INTO test_cases (id, "spaceId", "jiraKey", "issueId", summary, description, "testType", status, "folderPath", steps, source)
       VALUES ${values2.join(',')}
       ON CONFLICT ("jiraKey") WHERE "jiraKey" IS NOT NULL DO NOTHING`,
      params2,
    );
    testsInserted += result.rowCount;
    if ((i / BATCH) % 20 === 0) console.log(`  ...${i + batch.length}/${data.tests.length} processed`);
  }
  console.log(`Inserted ${testsInserted} new tests (${data.tests.length - testsInserted} already existed / duplicates).`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
