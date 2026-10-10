// The AI suggestion scan ran twice against a broken OpenAI key before
// Ollama was wired in -- those failed attempts stamped ai_suggested_at on
// every ticket they looked at (23 total), since the scan treats "LLM
// returned nothing" as terminal regardless of whether that's a real
// "not enough info" determination or an API failure. That poisoned the
// candidate pool for the next 7 days. This resets ai_suggested_at back to
// NULL for any ticket that was stamped but never actually got a real
// suggestion saved, so Ollama gets a genuine first attempt at them.
//
// Narrow and safe: only touches rows where a real suggestion was never
// written (both ai_suggested_root_cause and ai_suggested_fix_description
// are still NULL) -- never touches a ticket that already has a real draft.
//
// Usage: node reset-ai-suggestion-attempts.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    UPDATE issues
    SET ai_suggested_at = NULL
    WHERE ai_suggested_at IS NOT NULL
      AND ai_suggested_root_cause IS NULL
      AND ai_suggested_fix_description IS NULL
    RETURNING key
  `);
  console.log(`Reset ${rows.length} ticket(s) back to eligible: ${rows.map(r => r.key).join(', ') || '(none)'}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
