#!/usr/bin/env node
/**
 * Records a commit-gate approval. The ONLY sanctioned way to unblock a commit.
 *
 *   node .claude/hooks/approve-commit.mjs --ticket CF-29982 --branch aisdlc-a --confirmed
 *
 * Flags:
 *   --ticket <ID|NONE>      board-prefixed id (CF-29982, L2B-15838, L3B-782),
 *                           or NONE for work genuinely unrelated to a ticket
 *   --branch <name>         the branch the human chose at question 2; must be
 *                           the branch actually checked out
 *   --confirmed             the human answered YES to question 1
 *   --allow-default-branch  the human knowingly chose master/main
 *   --allow-force-push      the human explicitly asked for a force push
 *   --revoke                delete any recorded approval
 *
 * HONEST LIMIT, stated plainly: this command is run by the agent, so it does
 * not prove a human spoke. What it does is make committing impossible by
 * default, force approval to be a separate, explicit, logged act naming a
 * branch and a ticket, and cap its blast radius to 30 minutes and 4 uses on
 * one branch. That converts "the model forgot the rule" — the common failure —
 * into a hard stop. It does not defend against a model that decides to lie.
 * For that, use a real git pre-commit hook or a server-side branch protection.
 */
import { existsSync, rmSync } from 'node:fs';
import { STATE_PATH, TICKET_RE, TTL_MINUTES, currentBranch, writeApproval } from './lib/approval.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

function die(msg) {
  console.error('approve-commit: ' + msg);
  process.exit(1);
}

if (has('--revoke')) {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
  console.log('approve-commit: approval revoked.');
  process.exit(0);
}

const ticket = String(val('--ticket') ?? '').toUpperCase();
const branch = String(val('--branch') ?? '');

if (!TICKET_RE.test(ticket)) {
  die('--ticket must be a board-prefixed id (e.g. CF-29982, L2B-15838, L3B-782) or NONE');
}
if (!branch) die('--branch is required — never assume a branch (question 2)');
if (!has('--confirmed')) {
  die('--confirmed is required — it records the human\'s YES to question 1');
}

const head = currentBranch();
if (head && head !== branch) {
  die(`--branch "${branch}" is not the checked-out branch ("${head}"). Check out the chosen branch first.`);
}

const now = new Date();
writeApproval({
  confirmed: true,
  ticket,
  branch,
  allowDefaultBranch: has('--allow-default-branch'),
  allowForcePush: has('--allow-force-push'),
  approvedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + TTL_MINUTES * 60_000).toISOString(),
  uses: 0,
  history: [],
});

console.log(`approve-commit: recorded for ticket ${ticket} on branch ${branch}, valid ${TTL_MINUTES} minutes.`);
