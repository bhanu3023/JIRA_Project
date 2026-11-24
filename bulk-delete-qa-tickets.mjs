// Delete 25 specific tickets per explicit admin request, through the REAL
// DELETE /api/issues/:key endpoint (not raw SQL) so it goes through this
// app's actual trash mechanism: the ticket (plus comments/attachments/
// history) gets snapshotted into `deleted_issues` before the real row is
// removed, and is restorable from there later if ever needed.
//
// Requires an admin personal API token (Settings -> API Tokens), passed via
// the API_TOKEN env var -- never hardcode or paste the token into chat.
// Dry-run by default (just looks each ticket up); pass --apply to delete.
const APPLY = process.argv.includes('--apply');
const API_TOKEN = process.env.API_TOKEN;
const BASE = 'http://localhost:8080/api';

if (!API_TOKEN) {
  console.log('Set API_TOKEN=<your nta_... token> before running this script.');
  process.exit(1);
}

const KEYS = [
  'CF-9889', 'CF-10256', 'CF-10426', 'CF-14614', 'CF-14921', 'CF-14951', 'CF-14986',
  'CF-18386', 'CF-19061', 'CF-19328', 'CF-19362', 'CF-19369', 'CF-19862', 'CF-20168',
  'CF-22183', 'CF-24400', 'CF-24430', 'CF-24990', 'CF-25059', 'CF-25121', 'CF-25171',
  'CF-25172', 'CF-25292', 'CF-27197', 'CF-30003',
];

async function main() {
  for (const key of KEYS) {
    const headers = { Authorization: `Bearer ${API_TOKEN}` };
    const getRes = await fetch(`${BASE}/issues/${key}`, { headers });
    if (!getRes.ok) {
      console.log(`${key}: GET failed (${getRes.status}) -- skipping`);
      continue;
    }
    const issue = await getRes.json();
    const summary = issue?.summary ?? issue?.issue?.summary ?? '(no summary)';

    if (!APPLY) {
      console.log(`[dry-run] would DELETE ${key}: "${summary}"`);
      continue;
    }

    const delRes = await fetch(`${BASE}/issues/${key}`, { method: 'DELETE', headers });
    const body = await delRes.json().catch(() => ({}));
    console.log(delRes.ok ? `${key}: DELETED ("${summary}")` : `${key}: DELETE FAILED (${delRes.status}) ${JSON.stringify(body)}`);
  }
  console.log(APPLY ? '\nDone.' : '\nDry run only -- re-run with --apply to actually delete.');
}
main().catch((e) => { console.error(e); process.exit(1); });
