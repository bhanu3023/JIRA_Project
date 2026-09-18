#!/usr/bin/env node
/**
 * GUARD: commit gate   (PreToolUse — Bash)
 *
 * Blocks `git commit` and `git push` unless an approval artifact exists for
 * the current branch, recorded in this run by approve-commit.mjs after a human
 * answered the commit-gate questions.
 *
 * Also refuses, unconditionally:
 *   --no-verify / --no-gpg-sign  (bypassing other hooks is not the gate's call)
 *   push --force / --force-with-lease without an explicit recorded allowance
 *   a commit whose message carries no ticket id, when the approval names one
 *   a commit onto master/main unless the approval says so explicitly
 *
 * Read-only git (status, log, diff, show, branch, rev-parse...) is untouched.
 */
import { readHookInput, allow, block } from './lib/hook-io.mjs';
import { readApproval, writeApproval, validate, currentBranch, TICKET_IN_TEXT_RE, MAX_USES } from './lib/approval.mjs';

const DEFAULT_BRANCHES = new Set(['master', 'main']);

const input = await readHookInput();
if ((input.tool_name || '') !== 'Bash') allow();

const command = String(input.tool_input?.command ?? '');
if (!command.trim()) allow();

// Strip quoted spans before looking for the verb, so a commit MESSAGE that
// merely mentions "git push" is not mistaken for the act of pushing.
const unquoted = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

const isCommit = /\bgit\b[^\n;|&]*\bcommit\b/.test(unquoted);
const isPush = /\bgit\b[^\n;|&]*\bpush\b/.test(unquoted);
if (!isCommit && !isPush) allow();

const verb = isCommit ? 'commit' : 'push';
const branch = currentBranch();
const approval = readApproval();
const reason = validate(approval, branch);

function refuse(headline, extra = []) {
  block([
    `BLOCKED by the AI-SDLC commit gate — git ${verb} on "${branch}"`,
    '',
    headline,
    ...extra,
    '',
    'The commit gate is a hard stop. Run it, in order, and wait for a real answer',
    'to each question before asking the next:',
    '',
    '  1. "Would you like me to commit and push these changes?"   No -> stop entirely.',
    '  2. "Which branch? — current / existing / new"',
    '  3. Only then commit, referencing the ticket ID.',
    '',
    'When, and only when, the human has answered 1 and 2, record it:',
    '',
    '     node .claude/hooks/approve-commit.mjs --ticket CF-29982 --branch <branch> --confirmed',
    '',
    '  --ticket NONE is allowed for work genuinely unrelated to a ticket.',
    `  The approval lasts 30 minutes, ${MAX_USES} uses, and only on the branch it names.`,
    '',
    'Never auto-commit. Never assume a branch. Never ask about deployment —',
    'deployment, release, CI and infrastructure are out of scope (global rule 4).',
  ]);
}

if (/--no-verify|--no-gpg-sign/.test(unquoted)) {
  refuse('This command disables other hooks or signing (--no-verify / --no-gpg-sign).', [
    'That is never the gate\'s to waive. Remove the flag and fix whatever is failing.',
  ]);
}

if (reason) refuse(`Refused: ${reason}.`);

if (isPush && /--force\b|-f\b|--force-with-lease/.test(unquoted) && approval.allowForcePush !== true) {
  refuse('This is a force push, which the recorded approval does not cover.', [
    'Re-record with --allow-force-push only if the human explicitly asked for one.',
  ]);
}

if (isCommit && DEFAULT_BRANCHES.has(branch) && approval.allowDefaultBranch !== true) {
  refuse(`HEAD is on the default branch "${branch}" and the approval does not permit it.`, [
    'Branch first, or re-record with --allow-default-branch if the human chose it knowingly.',
  ]);
}

// Ticket id must appear SOMEWHERE in the message — position is not constrained,
// matching how this repo already writes them ("...for CF-29982...").
if (isCommit && approval.ticket !== 'NONE') {
  const messages = [...command.matchAll(/-m\s+(['"])([\s\S]*?)\1/g)].map((m) => m[2]);
  const usesMessageFile = /(^|\s)(-F|--file|--template)(\s|=)/.test(unquoted);
  if (messages.length > 0) {
    const joined = messages.join(String.fromCharCode(10));
    if (!TICKET_IN_TEXT_RE.test(joined)) {
      refuse(`The approval is for ticket ${approval.ticket}, but the commit message carries no ticket id.`, [
        'Put it anywhere in the message that reads naturally — this repo writes ids inline,',
        'e.g. "Fix ticket detail page hiding real Jira-imported SLA breaches (CF-29982)".',
      ]);
    }
  } else if (!usesMessageFile) {
    refuse('This commit has no -m message, so the gate cannot confirm the ticket id is present.', [
      'Pass the message with -m so the ticket reference is verifiable.',
    ]);
  }
}

// Approved. Burn one use so the artifact cannot authorise an open-ended run of
// commits, then let the call through.
approval.uses = (approval.uses ?? 0) + 1;
approval.lastUsedAt = new Date().toISOString();
approval.history = [...(approval.history ?? []), { verb, at: approval.lastUsedAt, branch }];
writeApproval(approval);
allow();
