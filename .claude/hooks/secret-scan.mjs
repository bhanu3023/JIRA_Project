#!/usr/bin/env node
/**
 * GUARD: secret scan   (PreToolUse — Write | Edit | MultiEdit | NotebookEdit | Bash)
 *
 * Blocks a tool call that would introduce a hardcoded credential.
 *
 * DIFF-AWARE, and that is the whole design. Phase 1 found ~25 pre-existing
 * `process.env.X || '<literal>'` fallbacks across src/app/api/** plus a
 * committed .env.server. A guard that blocked all of those would fire on
 * every unrelated edit and be disabled inside a day, so this one compares
 * what a call ADDS against what it REMOVES (Edit) or against the file already
 * on disk (Write):
 *
 *   new value, not present before        -> BLOCK  "newly introduced"
 *   same insecure pattern, line reworked -> BLOCK  "you are editing an
 *                                                   existing insecure
 *                                                   fallback — fix it now"
 *   byte-identical, untouched            -> ALLOW  (pre-existing, not this
 *                                                   change's problem)
 *
 * Bash is matched as well as Write|Edit: this project's sessions edit files
 * with sed and heredocs, which never fire a Write|Edit matcher. A guard that
 * watched only Write|Edit would be bypassed by the repo's normal working
 * style rather than by any deliberate act.
 *
 * No finding ever reprints the credential it found — only its rule, its
 * length, and where to look.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { readHookInput, allow, block, extractText } from './lib/hook-io.mjs';
import { scan, redact } from './lib/secret-patterns.mjs';

const ALLOWLIST_PATH = resolve(process.cwd(), '.claude/hooks/secret-scan-allowlist.json');

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    // An expired exception stops suppressing — that is the pressure to fix it.
    return (raw.exceptions ?? []).filter((e) => !e.expires || e.expires >= today);
  } catch {
    return [];
  }
}

function normalise(p) {
  if (!p) return '';
  const abs = resolve(process.cwd(), p);
  return relative(process.cwd(), abs).split(sep).join('/');
}

function isAllowed(allowlist, path, ruleId) {
  const rel = normalise(path);
  if (!rel) return false;
  return allowlist.some((e) => normalise(e.path) === rel && (e.rules ?? []).includes(ruleId));
}

const input = await readHookInput();
const { kind, path, added, removed } = extractText(input);

if (kind === 'other' || !added.trim()) allow();

// Text that existed before this call: what the edit replaces, plus the file
// already on disk. A finding present here is pre-existing, not introduced.
let prior = removed || '';
if ((kind === 'write' || kind === 'edit') && path) {
  const abs = resolve(process.cwd(), path);
  if (existsSync(abs)) {
    try { prior += '\n' + readFileSync(abs, 'utf8'); } catch { /* unreadable: treat as new */ }
  }
}

/** Newline as a code point: this file is generated and edited through shells
 *  that mangle backslash escapes, so the guard avoids them entirely. */
const NL = String.fromCharCode(10);

/** The whole line of `text` that contains the character at `index`. */
function lineAt(text, index) {
  const start = text.lastIndexOf(NL, index) + 1;
  const end = text.indexOf(NL, start);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

// Compared line by line, not snippet by snippet. Renaming the constant in
// front of an existing env-fallback leaves the matched snippet byte-identical
// while still rewriting the line that carries the credential -- snippet
// comparison alone called that "untouched" and let it through. The line is the
// unit a person actually edits, so it is the unit the guard judges.
const priorLines = new Set(prior.split(NL).map((l) => l.trim()).filter(Boolean));

const allowlist = loadAllowlist();
const introduced = [];
const reworked = [];

for (const f of scan(added)) {
  if (isAllowed(allowlist, path, f.ruleId)) continue;
  if (priorLines.has(lineAt(added, f.index))) continue;  // line untouched, pre-existing
  if (prior.includes(f.value)) reworked.push(f);          // same secret, line rewritten
  else introduced.push(f);
}

if (introduced.length === 0 && reworked.length === 0) allow();

const where = path ? normalise(path) : 'the command being run';
const lines = [`BLOCKED by the AI-SDLC secret-scan guard — ${where}`, ''];

if (introduced.length) {
  lines.push(`Newly introduced credential${introduced.length > 1 ? 's' : ''} (${introduced.length}):`);
  for (const f of introduced) lines.push(`  • [${f.ruleId}] ${f.message} (${redact(f.value)})`);
  lines.push('');
}

if (reworked.length) {
  lines.push(`Existing insecure fallback${reworked.length > 1 ? 's' : ''} being modified (${reworked.length}):`);
  for (const f of reworked) lines.push(`  • [${f.ruleId}] ${f.message} (${redact(f.value)})`);
  lines.push('  This value already exists in the file, but this change rewrites the line that holds it.');
  lines.push('  Touching it means fixing it, not carrying it forward.');
  lines.push('');
}

lines.push(
  'Required fix — read the value from the environment with no literal fallback:',
  "    const SECRET = process.env.MY_SECRET;",
  "    if (!SECRET) throw new Error('MY_SECRET is not configured');",
  '',
  'Document the variable NAME in .env.example. Never the value.',
  'Global rule 2: report property names, never values.',
  '',
  'If this is genuinely not a credential, add a narrow entry to',
  '.claude/hooks/secret-scan-allowlist.json (path + rule id + reason + expiry)',
  'and say so in your response — never widen the rules to get past this.',
);

block(lines);
