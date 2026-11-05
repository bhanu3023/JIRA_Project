// Fixes the "?" (U+FFFD REPLACEMENT CHARACTER) showing up inside some
// imported test summaries/descriptions/steps. check-test-repo-encoding.mjs
// confirmed the raw bytes are the literal UTF-8 encoding of U+FFFD itself
// (ef bf bd) -- not a decoding bug in our own import pipeline, but data
// already corrupted before it reached the dump we imported from, so the
// real original character can't be recovered.
//
// Every sample found (see check-test-repo-encoding.mjs output) has the
// character sitting exactly where a plain word-separating space belongs --
// "public [FFFD]teams" -> "public teams", "private [FFFD]channel" ->
// "private channel", a trailing "numbered list[FFFD]" -> "numbered list" --
// consistent with a non-breaking space (a single stray byte outside valid
// UTF-8 on its own) having been corrupted into U+FFFD somewhere upstream.
// None of the affected rows show it paired up the way a lost quote mark
// would (opening/closing around a quoted phrase). So the fix: replace each
// U+FFFD with a plain space, collapse any resulting double space, and trim.
// This can't restore the astronaut-ellipsis-exact original byte, but it
// turns "public ?teams" back into readable "public teams" everywhere this
// pattern holds -- which is every sample checked.
//
// Covers summary, description, and every string value inside steps (JSONB:
// action/data/testSteps/result/expectedResult/comment). Dry-run by default
// -- pass --apply to write.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const FFFD = '�';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function clean(str) {
  if (typeof str !== 'string' || !str.includes(FFFD)) return str;
  return str
    .split(FFFD).join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .trim();
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return steps;
  let changed = false;
  const next = steps.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const out = { ...s };
    for (const key of ['action', 'data', 'testSteps', 'result', 'expectedResult', 'comment']) {
      if (typeof out[key] === 'string' && out[key].includes(FFFD)) {
        out[key] = clean(out[key]);
        changed = true;
      }
    }
    return out;
  });
  return changed ? next : steps;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, "jiraKey", summary, description, steps FROM test_cases
     WHERE summary LIKE '%' || $1 || '%' OR description LIKE '%' || $1 || '%' OR steps::text LIKE '%' || $1 || '%'`,
    [FFFD],
  );
  console.log(`Found ${rows.length} test case(s) with a U+FFFD character.\n`);

  let shown = 0;
  const updates = [];
  for (const r of rows) {
    const newSummary = clean(r.summary);
    const newDescription = clean(r.description);
    const newSteps = cleanSteps(r.steps);
    const summaryChanged = newSummary !== r.summary;
    const descChanged = newDescription !== r.description;
    const stepsChanged = JSON.stringify(newSteps) !== JSON.stringify(r.steps);
    if (!summaryChanged && !descChanged && !stepsChanged) continue;
    updates.push({ id: r.id, newSummary, newDescription, newSteps });
    if (shown < 15) {
      shown++;
      console.log(`${r.jiraKey || r.id}:`);
      if (summaryChanged) console.log(`  summary: "${r.summary}" -> "${newSummary}"`);
      if (descChanged) console.log(`  description: "${r.description}" -> "${newDescription}"`);
      if (stepsChanged) console.log(`  steps: ${steps_diff_count(r.steps, newSteps)} field(s) cleaned`);
    }
  }
  function steps_diff_count(oldSteps, newSteps) {
    let n = 0;
    for (let i = 0; i < (oldSteps || []).length; i++) {
      for (const key of ['action', 'data', 'testSteps', 'result', 'expectedResult', 'comment']) {
        if ((oldSteps[i] || {})[key] !== (newSteps[i] || {})[key]) n++;
      }
    }
    return n;
  }
  if (rows.length > shown) console.log(`\n...and ${rows.length - shown} more not shown.`);

  if (!APPLY) {
    console.log(`\nDry run only -- ${updates.length} row(s) would be updated. Rerun with --apply to write.`);
    await pool.end();
    return;
  }

  let count = 0;
  for (const u of updates) {
    await pool.query(
      `UPDATE test_cases SET summary = $2, description = $3, steps = $4::jsonb, "updatedAt" = NOW() WHERE id = $1`,
      [u.id, u.newSummary, u.newDescription, JSON.stringify(u.newSteps)],
    );
    count++;
  }
  console.log(`\nUpdated ${count} test case(s).`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
