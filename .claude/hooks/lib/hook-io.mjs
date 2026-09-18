/**
 * Shared stdin/exit plumbing for the AI-SDLC PreToolUse / PostToolUse hooks.
 *
 * Claude Code hands a hook one JSON object on stdin and reads the process's
 * exit code back:
 *   exit 0  -> allow, stderr ignored
 *   exit 2  -> BLOCK the tool call (PreToolUse) or surface the message as
 *              feedback (PostToolUse); stderr is what the model is shown
 *   other   -> non-blocking error, stderr shown to the user only
 *
 * Kept dependency-free and in .mjs to match the ~250 existing .mjs scripts in
 * this repo, and because a #!/bin/bash hook would not run on the Windows
 * machines this project is developed on.
 */

/** Read the whole hook payload from stdin. Never throws — a malformed or
 *  empty payload must not wedge the tool call, so it degrades to `{}`. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Allow the tool call. */
export function allow() {
  process.exit(0);
}

/** Block the tool call (PreToolUse) / raise it as feedback (PostToolUse). */
export function block(lines) {
  process.stderr.write((Array.isArray(lines) ? lines.join('\n') : String(lines)) + '\n');
  process.exit(2);
}

/**
 * Pull the text this tool call is about to introduce, plus the text it is
 * replacing, so callers can tell a NEW problem from a pre-existing one.
 *
 * Bash is included deliberately: this project's sessions are instructed to
 * edit files with sed/heredoc through Bash, which never fires a Write|Edit
 * matcher — a guard that only watched Write|Edit would be trivially bypassed
 * by the repo's own normal working style.
 */
export function extractText(input) {
  const name = input.tool_name || '';
  const ti = input.tool_input || {};
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [{ old_string: ti.old_string, new_string: ti.new_string }];
    return {
      kind: 'edit',
      path: ti.file_path || '',
      added: edits.map((e) => e?.new_string ?? '').join('\n'),
      removed: edits.map((e) => e?.old_string ?? '').join('\n'),
    };
  }
  if (name === 'Write') {
    return { kind: 'write', path: ti.file_path || '', added: ti.content ?? '', removed: '' };
  }
  if (name === 'NotebookEdit') {
    return { kind: 'write', path: ti.notebook_path || '', added: ti.new_source ?? '', removed: '' };
  }
  if (name === 'Bash') {
    return { kind: 'bash', path: '', added: ti.command ?? '', removed: '' };
  }
  return { kind: 'other', path: '', added: '', removed: '' };
}
