// Imports the Test Repository data straight from the live qa-agent-mongo
// container's exports (mongoexport/mongofiles output, plain JSON -- no bson
// package needed here), instead of a file transferred from a laptop.
// Dry-run by default -- pass --apply to write.
import fs from 'fs';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const SPACE_KEY = (process.argv.find((a) => a.startsWith('--space=')) || '--space=TESTIN').split('=')[1];
const DIR = process.argv[2]?.startsWith('--') ? null : (process.argv[2] || '.');

function rid() { return `tc_${Math.random().toString(36).slice(2, 12)}`; }

async function main() {
  if (!DIR) {
    console.error('Usage: node import-test-repo-from-mongoexport.mjs <dir-with-exported-files> [--space=TESTIN] [--apply]');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(`${DIR}/snapshot.json`, 'utf8'));
  const folders = snapshot.folders.filter((f) => f.path !== '/').map((f) => ({
    name: f.name,
    path: f.path,
    parentPath: f.path.split('/').slice(0, -1).join('/') || '/',
  }));

  const localFolders = JSON.parse(fs.readFileSync(`${DIR}/test_repository_local_folders.json`, 'utf8'));
  for (const d of localFolders) folders.push({ name: d.name, path: d.path, parentPath: d.parentPath || '/' });

  const details = JSON.parse(fs.readFileSync(`${DIR}/test_expanded_details.json`, 'utf8'));
  const tests = [];
  for (const d of details) {
    const detail = d.detail || {};
    const steps = Array.isArray(detail.steps) ? detail.steps.map((s) => ({
      stepNumber: s.stepNumber,
      action: s.action || '',
      data: s.data || '',
      testSteps: s.testSteps || '',
      result: s.result || '',
      expectedResult: s.expectedResult || s.result || '',
    })) : [];
    tests.push({
      jiraKey: d.jiraKey,
      issueId: d.issueId || null,
      summary: detail.summary || d.jiraKey,
      description: detail.description || null,
      testType: detail.testType === 'Automated' ? 'Automated' : 'Manual',
      status: detail.status || 'To Do',
      folderPath: detail.folder?.path || '/',
      steps,
    });
  }

  const localTests = JSON.parse(fs.readFileSync(`${DIR}/test_repository_local_tests.json`, 'utf8'));
  for (const d of localTests) {
    tests.push({
      jiraKey: null,
      issueId: null,
      summary: d.summary,
      description: d.description || null,
      testType: d.testType === 'Automated' ? 'Automated' : 'Manual',
      status: d.status || 'To Do',
      folderPath: d.folderPath || '/',
      steps: Array.isArray(d.steps) ? d.steps.map((s) => ({
        stepNumber: s.stepNumber,
        action: s.action || '',
        data: s.data || '',
        testSteps: s.testSteps || '',
        result: s.result || '',
        expectedResult: s.result || '',
      })) : [],
    });
  }

  console.log(`Parsed ${folders.length} folders, ${tests.length} tests from the exported files.`);

  const { rows: spaceRows } = await pool.query(`SELECT id FROM spaces WHERE key = $1`, [SPACE_KEY.toUpperCase()]);
  const spaceId = spaceRows[0]?.id;
  if (!spaceId) { console.error(`Space ${SPACE_KEY} not found`); process.exit(1); }
  console.log(`Target space: ${SPACE_KEY} (${spaceId})`);

  const { rows: existingFolderCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM test_repo_folders WHERE "spaceId" = $1`, [spaceId]);
  const { rows: existingTestCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM test_cases WHERE "spaceId" = $1`, [spaceId]);
  console.log(`Currently in this space: ${existingFolderCount[0].c} folders, ${existingTestCount[0].c} tests.`);

  if (!APPLY) {
    console.log('\nDry run only -- rerun with --apply to actually import.');
    await pool.end();
    return;
  }

  let foldersInserted = 0;
  for (const f of folders) {
    const result = await pool.query(
      `INSERT INTO test_repo_folders (id, "spaceId", name, path, "parentPath", source)
       VALUES ($1,$2,$3,$4,$5,'imported') ON CONFLICT ("spaceId", path) DO NOTHING`,
      [rid(), spaceId, f.name, f.path, f.parentPath || '/'],
    );
    if (result.rowCount) foldersInserted++;
  }
  console.log(`Inserted ${foldersInserted} new folders (${folders.length - foldersInserted} already existed).`);

  const BATCH = 300;
  let testsInserted = 0;
  for (let i = 0; i < tests.length; i += BATCH) {
    const batch = tests.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let n = 1;
    for (const t of batch) {
      values.push(`($${n},$${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7},$${n+8},$${n+9}::jsonb,'imported')`);
      params.push(rid(), spaceId, t.jiraKey, t.issueId, String(t.summary).slice(0, 2000), t.description, t.testType, t.status, t.folderPath, JSON.stringify(t.steps || []));
      n += 10;
    }
    const result = await pool.query(
      `INSERT INTO test_cases (id, "spaceId", "jiraKey", "issueId", summary, description, "testType", status, "folderPath", steps, source)
       VALUES ${values.join(',')}
       ON CONFLICT ("jiraKey") WHERE "jiraKey" IS NOT NULL DO NOTHING`,
      params,
    );
    testsInserted += result.rowCount;
    if ((i / BATCH) % 20 === 0) console.log(`  ...${i + batch.length}/${tests.length} processed`);
  }
  console.log(`Inserted ${testsInserted} new tests (${tests.length - testsInserted} already existed / duplicates).`);

  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
