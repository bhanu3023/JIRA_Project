#!/usr/bin/env node
/**
 * GUARD: log convention   (PostToolUse — Write | Edit | MultiEdit | NotebookEdit | Bash)
 *
 * Warns when a debug print is added to production source. Advisory by design:
 * it fires after the write, so it tells the agent to clean up rather than
 * losing the edit.
 *
 * The convention it enforces is the repo's own, and the repo actually keeps
 * it: a Phase 1 sweep of src/ found 86 console.log calls and every single one
 * opens with a bracketed subsystem tag — [EmailPoller] (44), [Notification]
 * (12), [OAuthService] (10), [Reconnect] (9), [IncidentAgent], [SLA],
 * [Security], [MonitorAgent], [EVENT-LOOP], [API]. Zero untagged. So an
 * untagged console.log in src/ is not a style quibble here, it is a stray
 * debug print — the tag is what makes a line greppable in a container log,
 * which is the only way this app is observed in production.
 *
 * Tests are exempt: src/analytics/hotjar.test.ts and any *.test.ts alongside
 * it are not production source.
 */
import { readHookInput, allow, block, extractText } from './lib/hook-io.mjs';
import { resolve, relative, sep } from 'node:path';

const NL = String.fromCharCode(10);

/** Production source this guard cares about. */
function isProductionSource(rel) {
  if (!rel.startsWith('src/')) return false;
  if (/\.(test|spec)\.tsx?$/.test(rel)) return false;
  return /\.(ts|tsx|js|jsx|mjs)$/.test(rel);
}

function normalise(p) {
  if (!p) return '';
  return relative(process.cwd(), resolve(process.cwd(), p)).split(sep).join('/');
}

/** console.log/debug/dir/trace whose first argument is NOT a "[Tag]" string. */
const UNTAGGED = /console\.(log|debug|dir|trace)\s*\(\s*(?!['"`]\s*\[)/g;
const DEBUGGER = /(^|[^\w.])debugger\s*;?/g;

const input = await readHookInput();
const { kind, path, added, removed } = extractText(input);
if (kind === 'other' || !added.trim()) allow();

// For a Bash call there is no file path, so infer one — sed/heredoc edits are
// how this session writes files.
//
// The command must plausibly WRITE to a src/ file, not merely mention one.
// The first version tested for any `src/**.ts` substring anywhere in the
// command, which fired on a scratchpad script that only *imported* from src/
// while printing its own diagnostic output. A guard that cries wolf on
// unrelated commands gets ignored, so the patterns below look for an actual
// write: a redirect into src/, an in-place sed, a tee, or a copy/move whose
// destination is under src/.
const SRC_FILE = String.raw`src/[\w./-]+\.(?:ts|tsx|js|jsx|mjs)`;
const WRITES_TO_SRC = new RegExp(
  [
    String.raw`>>?\s*["']?(?:\./)?${SRC_FILE}`,        // cat > src/x.ts   /  >> src/x.ts
    String.raw`\bsed\b[^|;&]*-i[^|;&]*${SRC_FILE}`,     // sed -i ... src/x.ts
    String.raw`\btee\b[^|;&]*${SRC_FILE}`,              // | tee src/x.ts
    String.raw`\b(?:cp|mv|install)\b[^|;&]*\s${SRC_FILE}\s*$`, // cp foo src/x.ts
  ].join('|'),
  'm',
);

const rel = normalise(path);
const targetsSource = kind === 'bash'
  ? WRITES_TO_SRC.test(added) && !/\.(test|spec)\.tsx?\b/.test(added)
  : isProductionSource(rel);

if (!targetsSource) allow();

const priorLines = new Set(removed.split(NL).map((l) => l.trim()).filter(Boolean));

const findings = [];
for (const [re, label] of [[UNTAGGED, 'untagged console call'], [DEBUGGER, 'debugger statement']]) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(added)) !== null) {
    const start = added.lastIndexOf(NL, m.index) + 1;
    const endRaw = added.indexOf(NL, start);
    const line = added.slice(start, endRaw === -1 ? added.length : endRaw).trim();
    if (priorLines.has(line)) continue; // already there, not added by this call
    findings.push({ label, line: line.slice(0, 140) });
  }
}

if (findings.length === 0) allow();

block([
  `Log-convention warning — ${rel || 'this command'} (advisory, the write already happened)`,
  '',
  `${findings.length} debug print${findings.length > 1 ? 's' : ''} added to production source:`,
  ...findings.map((f) => `  • ${f.label}: ${f.line}`),
  '',
  'This repo tags every log line with a bracketed subsystem prefix, and currently',
  'has zero untagged console.log calls in src/. Match it:',
  '',
  "    console.log(`[SLA] resumed ${issueKey} after reopen`);",
  "    console.error('[Notification] send failed:', err);",
  '',
  'Use an existing tag where one fits ([EmailPoller], [Notification], [OAuthService],',
  '[Reconnect], [IncidentAgent], [SLA], [Security], [MonitorAgent], [API]).',
  'If this was scaffolding rather than a real signal, remove it — global rule 3:',
  'no debug prints in production source.',
]);
