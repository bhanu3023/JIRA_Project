/**
 * The commit-gate approval artifact.
 *
 * Shared by commit-gate.mjs (which reads it) and approve-commit.mjs (which
 * writes it, and is the ONLY sanctioned way to create one).
 *
 * Deliberately short-lived, branch-bound and use-counted, so an approval
 * granted for one commit cannot silently authorise a different commit on a
 * different branch an hour later.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const STATE_PATH = resolve(process.cwd(), '.claude/aisdlc/state/commit-approval.json');

/** Board-prefixed ticket, e.g. CF-29982 / L2B-15838 / L3B-782. `NONE` is the
 *  explicit opt-out for work genuinely unrelated to a ticket. */
export const TICKET_RE = /^([A-Z][A-Z0-9]{1,9}-\d+|NONE)$/;

/** Same shape, unanchored, for finding a ticket id inside a commit message.
 *  Position is deliberately unconstrained — this repo writes ids inline
 *  ("Fix ... for CF-29982 ..."), never as a fixed prefix. */
export const TICKET_IN_TEXT_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;

export const TTL_MINUTES = 30;
export const MAX_USES = 4; // commit, push, and room for one retry of each

export function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function readApproval() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function writeApproval(approval) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(approval, null, 2) + String.fromCharCode(10), 'utf8');
}

/** Why this approval does not authorise the call, or null if it does. */
export function validate(approval, branch) {
  if (!approval) return 'no approval has been recorded in this run';
  if (approval.confirmed !== true) return 'the recorded approval was never confirmed by a human';
  if (!approval.branch) return 'the recorded approval names no branch';
  if (approval.branch !== branch) {
    return `the approval is for branch "${approval.branch}" but HEAD is on "${branch}"`;
  }
  if (!TICKET_RE.test(String(approval.ticket ?? ''))) {
    return `the approval carries no valid ticket id (got "${approval.ticket ?? ''}")`;
  }
  const expires = Date.parse(approval.expiresAt ?? '');
  if (!Number.isFinite(expires)) return 'the approval has no valid expiry';
  if (Date.now() > expires) return `the approval expired at ${approval.expiresAt}`;
  if ((approval.uses ?? 0) >= MAX_USES) {
    return `the approval has already been used ${approval.uses} times (max ${MAX_USES})`;
  }
  return null;
}
