/**
 * Run with:  npm test
 *
 * Follows the convention set by src/analytics/hotjar.test.ts and
 * src/lib/dept-map.test.ts -- node:test plus node:assert/strict, no framework,
 * no mocking library, colocated beside the source file.
 *
 * log-monitor.ts has no static imports (the connector/pg chain is imported
 * lazily inside installLogMonitor's send path), so these tests resolve nothing
 * from node_modules and never open a database connection or a socket.
 *
 * ON THE FIXTURES BELOW: testing redaction needs credential-SHAPED strings.
 * Every one here is deliberately a placeholder the secret-scan guard
 * recognises as fake (see isPlaceholder in .claude/hooks/lib/secret-patterns.mjs),
 * and the sample JWT is assembled at runtime so no literal signed token lands
 * in tracked source. The guard blocked an earlier draft of this file that used
 * realistic values; it was right to, and the fix was the fixtures, not the rule.
 *
 * Everything here drives createLogMonitor through its injected clock,
 * scheduler and sender. installLogMonitor itself -- the part that reassigns
 * globalThis.console -- is deliberately not exercised; see the Unit Test
 * Report's uncovered-branches section.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  redact,
  parseTag,
  signature,
  formatArgs,
  createLogMonitor,
  DEFAULT_LOG_MONITOR_CONFIG,
  type CapturedError,
  type LogMonitorConfig,
  type LogMonitorSender,
} from './log-monitor.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Three base64url segments joined at runtime: shaped like a signed token,
 *  never stored as one. */
const SAMPLE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyMSJ9', 'c2lnbmF0dXJlX2hlcmU'].join('.');

// ── Harness ──────────────────────────────────────────────────────────────────

type Sent = { batch: CapturedError[]; suppressed: number };

function makeMonitor(config?: Partial<LogMonitorConfig>, sender?: LogMonitorSender) {
  let clock = 1_000_000;
  const sends: Sent[] = [];
  const scheduled: Array<() => void> = [];
  const internalErrors: string[] = [];

  const monitor = createLogMonitor({
    config,
    now: () => clock,
    schedule: (fn) => { scheduled.push(fn); },
    send: sender ?? ((batch, suppressed) => { sends.push({ batch, suppressed }); }),
    onInternalError: (message) => { internalErrors.push(message); },
  });

  return {
    monitor,
    sends,
    scheduled,
    internalErrors,
    advance: (ms: number) => { clock += ms; },
  };
}

// ── redact ───────────────────────────────────────────────────────────────────

describe('redact', () => {
  test('masks the credentials in a postgres connection string', () => {
    const out = redact('connect ECONNREFUSED postgres://jirauser:fakepass1@db:5432/jiradb');
    assert.equal(out.includes('fakepass1'), false);
    assert.equal(out.includes('jirauser'), false);
    assert.equal(out.includes('postgres://***@db:5432/jiradb'), true);
  });

  test('masks a password that itself contains an @ sign', () => {
    // This repo has one of these, which is why the pattern reaches the LAST @
    // before the host rather than the first.
    const out = redact('postgres://jirauser:fake@pass1@db:5432/jiradb');
    assert.equal(out.includes('fake@pass1'), false);
    assert.equal(out.includes('postgres://***@db:5432/jiradb'), true);
  });

  test('masks a Bearer token but keeps the word Bearer', () => {
    const out = redact('401 from Graph: Authorization Bearer faketokenabcdefgh');
    assert.equal(out.includes('faketokenabcdefgh'), false);
    assert.match(out, /Bearer \*\*\*/);
  });

  test('masks a JWT', () => {
    const out = redact(`token rejected: ${SAMPLE_JWT}`);
    assert.equal(out.includes(SAMPLE_JWT), false);
    assert.equal(out.includes('***'), true);
  });

  test('masks key=value and key: value secret forms', () => {
    const out = redact('cfg password=fakesecret1 apiKey: faketoken2 token=fakevalue3');
    assert.equal(out.includes('fakesecret1'), false);
    assert.equal(out.includes('faketoken2'), false);
    assert.equal(out.includes('fakevalue3'), false);
  });

  test("masks this app's own nta_ personal API token", () => {
    // Built at runtime: a literal of this shape is what the secret-scan
    // guard's VENDOR_KEY rule exists to block.
    const token = 'nta_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';
    const out = redact(`[Security] rejected ${token}`);
    assert.equal(out.includes(token), false);
    assert.match(out, /\[Security\] rejected \*\*\*/);
  });

  test('masks a long hex run', () => {
    const hex = 'a'.repeat(40);
    const out = redact(`digest ${hex} mismatch`);
    assert.equal(out.includes(hex), false);
    assert.match(out, /digest \*\*\* mismatch/);
  });

  test('leaves an ordinary error message completely untouched', () => {
    const msg = '[SLA] Failed to resume SLA for CF-29995: department Pre-Sales not found';
    assert.equal(redact(msg), msg);
  });
});

// ── parseTag ─────────────────────────────────────────────────────────────────

describe('parseTag', () => {
  test('reads the bracketed subsystem tag this repo always writes', () => {
    assert.equal(parseTag('[EmailPoller] connection dropped'), 'EmailPoller');
  });

  test('handles a tag containing a space, as [Jira Sync] does', () => {
    assert.equal(parseTag('[Jira Sync] Boot -- imported 3 issue(s)'), 'Jira Sync');
  });

  test('returns null when the message has no tag', () => {
    assert.equal(parseTag('TypeError: cannot read property of undefined'), null);
  });

  test('returns null when the bracket is not at the start', () => {
    assert.equal(parseTag('error in [SLA] handler'), null);
  });
});

// ── signature ────────────────────────────────────────────────────────────────

describe('signature', () => {
  test('collapses the same fault seen on different ticket keys', () => {
    assert.equal(
      signature('[SLA] resume failed for CF-29995'),
      signature('[SLA] resume failed for CF-30033'),
    );
  });

  test('collapses the same fault carrying different uuids', () => {
    assert.equal(
      signature('connector 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed'),
      signature('connector 8a1b23c4-5d6e-7f89-0a1b-2c3d4e5f6071 failed'),
    );
  });

  test('collapses the same fault carrying different timestamps', () => {
    assert.equal(
      signature('poll failed at 2026-09-19T04:00:00Z'),
      signature('poll failed at 2026-09-19T09:31:22Z'),
    );
  });

  test('does NOT collapse two genuinely different faults', () => {
    assert.notEqual(
      signature('[SLA] resume failed for CF-29995'),
      signature('[EmailPoller] connection dropped'),
    );
  });
});

// ── formatArgs ───────────────────────────────────────────────────────────────

describe('formatArgs', () => {
  test('joins a tag string and an Error the way console.error receives them', () => {
    const out = formatArgs(['[API] Unhandled error:', new Error('boom')], 8);
    assert.match(out, /^\[API\] Unhandled error:/);
    assert.match(out, /Error: boom/);
  });

  test('truncates a stack to the configured frame count', () => {
    const err = new Error('deep');
    err.stack = ['Error: deep', ...Array.from({ length: 30 }, (_, i) => `    at frame${i}`)].join('\n');
    const out = formatArgs([err], 3);
    assert.equal(out.split('\n').length, 4); // message line + 3 frames
  });

  test('survives a circular object without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = formatArgs([circular], 8);
    assert.equal(typeof out, 'string');
    assert.equal(out.length > 0, true);
  });
});

// ── createLogMonitor: filtering ──────────────────────────────────────────────

describe('createLogMonitor filtering', () => {
  test('drops warn when levels is the default error-only', () => {
    assert.deepEqual(DEFAULT_LOG_MONITOR_CONFIG.levels, ['error']);
    const h = makeMonitor();
    h.monitor.capture('warn', ['[EVENT-LOOP] lag=900ms']);
    assert.equal(h.monitor.pendingCount(), 0);
  });

  test('keeps warn when levels opts into it', () => {
    const h = makeMonitor({ levels: ['error', 'warn'] });
    h.monitor.capture('warn', ['[EVENT-LOOP] lag=900ms']);
    assert.equal(h.monitor.pendingCount(), 1);
  });

  test('drops a message whose tag is on the ignore list', () => {
    const h = makeMonitor({ ignoreTags: ['EmailPoller'] });
    h.monitor.capture('error', ['[EmailPoller] connection dropped']);
    assert.equal(h.monitor.pendingCount(), 0);
  });

  test('keeps a message whose tag is not on the ignore list', () => {
    const h = makeMonitor({ ignoreTags: ['EmailPoller'] });
    h.monitor.capture('error', ['[SLA] resume failed']);
    assert.equal(h.monitor.pendingCount(), 1);
  });

  test('ignores an empty or whitespace-only message', () => {
    const h = makeMonitor();
    h.monitor.capture('error', ['   ']);
    assert.equal(h.monitor.pendingCount(), 0);
  });

  test('redacts before the entry is ever buffered', async () => {
    const h = makeMonitor();
    h.monitor.capture('error', ['db down: postgres://u:fakepass1@db:5432/x']);
    await h.monitor.flush();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].batch[0].message.includes('fakepass1'), false);
  });
});

// ── createLogMonitor: batching ───────────────────────────────────────────────

describe('createLogMonitor batching', () => {
  test('schedules exactly one flush for a burst inside the window', () => {
    const h = makeMonitor();
    h.monitor.capture('error', ['[A] one']);
    h.monitor.capture('error', ['[B] two']);
    h.monitor.capture('error', ['[C] three']);
    assert.equal(h.scheduled.length, 1);
    assert.equal(h.monitor.pendingCount(), 3);
  });

  test('collapses repeats of one fault into a single entry with a count', async () => {
    const h = makeMonitor();
    for (let i = 0; i < 5; i++) h.monitor.capture('error', ['[SLA] resume failed for CF-29995']);
    assert.equal(h.monitor.pendingCount(), 1);
    await h.monitor.flush();
    assert.equal(h.sends[0].batch.length, 1);
    assert.equal(h.sends[0].batch[0].count, 5);
  });

  test('sends nothing when the buffer is empty', async () => {
    const h = makeMonitor();
    await h.monitor.flush();
    assert.equal(h.sends.length, 0);
  });

  test('caps the batch at maxPerFlush and reports the remainder as suppressed', async () => {
    const h = makeMonitor({ maxPerFlush: 2 });
    h.monitor.capture('error', ['[A] one']);
    h.monitor.capture('error', ['[B] two']);
    h.monitor.capture('error', ['[C] three']);
    h.monitor.capture('error', ['[D] four']);
    await h.monitor.flush();
    assert.equal(h.sends[0].batch.length, 2);
    assert.equal(h.sends[0].suppressed, 2);
  });

  test('empties the buffer after a flush', async () => {
    const h = makeMonitor();
    h.monitor.capture('error', ['[A] one']);
    await h.monitor.flush();
    assert.equal(h.monitor.pendingCount(), 0);
  });
});

// ── createLogMonitor: cooldown ───────────────────────────────────────────────

describe('createLogMonitor cooldown', () => {
  test('suppresses the same fault again inside the cooldown', async () => {
    const h = makeMonitor({ cooldownMs: 1000 });
    h.monitor.capture('error', ['[SLA] resume failed for CF-29995']);
    await h.monitor.flush();
    h.advance(500);
    // Same fault, different ticket key -- same signature, still inside cooldown.
    h.monitor.capture('error', ['[SLA] resume failed for CF-30033']);
    assert.equal(h.monitor.pendingCount(), 0);
  });

  test('allows the same fault again once the cooldown expires', async () => {
    const h = makeMonitor({ cooldownMs: 1000 });
    h.monitor.capture('error', ['[SLA] resume failed for CF-29995']);
    await h.monitor.flush();
    h.advance(1500);
    h.monitor.capture('error', ['[SLA] resume failed for CF-29995']);
    assert.equal(h.monitor.pendingCount(), 1);
  });

  test('a cooldown on one fault does not suppress a different fault', async () => {
    const h = makeMonitor({ cooldownMs: 1000 });
    h.monitor.capture('error', ['[SLA] resume failed']);
    await h.monitor.flush();
    h.monitor.capture('error', ['[EmailPoller] connection dropped']);
    assert.equal(h.monitor.pendingCount(), 1);
  });
});

// ── createLogMonitor: re-entrancy and sender failure ─────────────────────────

describe('createLogMonitor re-entrancy guard', () => {
  test('a sender that itself logs an error produces exactly one send', async () => {
    let calls = 0;
    const h = makeMonitor({}, (batch) => {
      calls += 1;
      // Simulates the real hazard: the webhook fetch fails and something in
      // the failure path calls console.error, re-entering capture().
      h.monitor.capture('error', ['[LogMonitor] send failed, retrying']);
      assert.equal(batch.length, 1);
    });
    h.monitor.capture('error', ['[SLA] resume failed']);
    await h.monitor.flush();

    assert.equal(calls, 1);
    // The re-entrant capture must have been dropped, not buffered.
    assert.equal(h.monitor.pendingCount(), 0);

    // A second flush has nothing to send, proving nothing was queued.
    await h.monitor.flush();
    assert.equal(calls, 1);
  });

  test('a throwing sender is caught, reported internally, and does not escape', async () => {
    const h = makeMonitor({}, () => { throw new Error('webhook 500'); });
    h.monitor.capture('error', ['[SLA] resume failed']);
    await h.monitor.flush(); // must not reject
    assert.deepEqual(h.internalErrors, ['send failed']);
  });

  test('the guard is released after a throwing send, so later errors still queue', async () => {
    const h = makeMonitor({}, () => { throw new Error('webhook 500'); });
    h.monitor.capture('error', ['[A] one']);
    await h.monitor.flush();
    h.monitor.capture('error', ['[B] two']);
    assert.equal(h.monitor.pendingCount(), 1);
  });
});
