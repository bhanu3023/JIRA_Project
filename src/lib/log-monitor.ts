/**
 * Log monitor -- watches this process's own console output and forwards
 * application errors to the configured connectors (Microsoft Teams today).
 *
 * WHY IN-PROCESS RATHER THAN TAILING THE CONTAINER LOG:
 * the only log sink this app has is stdout, captured by Docker's default
 * json-file driver. Reading that back would need a bind mount added to
 * docker-compose.yml, and infrastructure is out of scope. Wrapping console
 * needs no infrastructure change and picks up every existing console.error
 * call site without editing one of them.
 *
 * THREE THINGS IN HERE ARE LOAD-BEARING -- do not "simplify" them away:
 *
 *  1. WRITE-THROUGH FIRST. The saved original console.error runs before any
 *     of this module's logic, so stdout logging has already happened even if
 *     the monitor itself throws.
 *  2. RE-ENTRANCY GUARD. The send path talks to an external webhook. If that
 *     fetch fails and anything in the failure path calls console.error, it
 *     re-enters capture() and sends again -- an unbounded loop against
 *     someone else's API. `inFlush` makes capture() a no-op while sending,
 *     and this module reports its own failures through the ORIGINAL console
 *     reference, never the patched one.
 *  3. REDACTION BEFORE BUFFERING. Error text here carries real credentials --
 *     a pg connection failure prints the DATABASE_URL, password and all.
 *     Posting raw stacks to a chat channel would publish them. redact() runs
 *     before anything is stored, not merely before it is sent.
 */

export type LogLevel = 'error' | 'warn';

export type CapturedError = {
  level: LogLevel;
  tag: string | null;
  message: string;
  /** How many occurrences collapsed into this entry during the batch window. */
  count: number;
  firstAt: number;
  lastAt: number;
  signature: string;
};

export type LogMonitorConfig = {
  /** Which console levels to forward. 'warn' is opt-in: [EVENT-LOOP] and the
   *  email pollers are chatty enough to drown a channel on their own. */
  levels: LogLevel[];
  /** Bracketed subsystem tags to drop entirely, e.g. ['EmailPoller']. */
  ignoreTags: string[];
  /** Per-signature quiet period after a send, so one repeating fault does not
   *  re-post all day. Mirrors incident-agent.ts's recentlyNotified cooldown. */
  cooldownMs: number;
  /** Collect for this long, then send one message, so an error storm becomes
   *  one post instead of hundreds of webhook calls. */
  batchWindowMs: number;
  /** Distinct errors per post; the remainder is reported as a count. */
  maxPerFlush: number;
  maxMessageChars: number;
  maxStackFrames: number;
};

export const DEFAULT_LOG_MONITOR_CONFIG: LogMonitorConfig = {
  levels: ['error'],
  ignoreTags: [],
  cooldownMs: 15 * 60 * 1000,
  batchWindowMs: 10_000,
  maxPerFlush: 10,
  maxMessageChars: 2000,
  maxStackFrames: 8,
};

// -- Redaction ---------------------------------------------------------------

/**
 * Ordered on purpose: the connection-string rule must run before the generic
 * key=value rule, or the latter chews up part of the URL and leaves the rest.
 * Each pattern replaces the VALUE only -- the surrounding text stays readable,
 * because an error nobody can interpret is not much better than no error.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // scheme://anything@host -- greedy up to the last '@' before the host, so a
  // password that itself contains '@' (this repo has one) is still covered.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1***@'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // JWT: three base64url segments. Catches session tokens pasted into errors.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***'],
  [/((?:api[_-]?key|apikey|x-api-key|password|passwd|pwd|secret|token|authorization)["']?\s*[=:]\s*)["']?[^\s"',;)}\]]+/gi, '$1***'],
  // This app's own personal API tokens: `nta_` + 40 alphanumerics, minted by
  // generateApiToken in jira-pg-api.ts and accepted as credentials there. The
  // long-hex rule below does NOT cover them (they are alphanumeric, not hex),
  // and [Security]-tagged auth failures are exactly where one would be logged.
  [/\bnta_[A-Za-z0-9]{20,}/g, '***'],
  // Long hex runs: raw keys, digests, unhyphenated ids. Deliberately broad --
  // a redacted digest costs nothing, a leaked key costs a lot.
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// -- Message shaping ---------------------------------------------------------

/** Reads this repo's universal `[Subsystem] message` log convention. */
export function parseTag(message: string): string | null {
  const m = /^\s*\[([^\]]{1,40})\]/.exec(message);
  return m ? m[1] : null;
}

/**
 * Collapses the variable parts of a message so that the same fault recurring
 * with a different ticket key, id or timestamp is recognised as one fault.
 * Without this the cooldown never matches and every occurrence posts.
 */
export function signature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[A-Z]{2,5}-\d+\b/g, '<key>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function formatArg(arg: unknown, maxStackFrames: number): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const stack = (arg.stack || '').split('\n').slice(0, maxStackFrames + 1).join('\n');
    return stack || `${arg.name}: ${arg.message}`;
  }
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function formatArgs(args: unknown[], maxStackFrames: number): string {
  return args.map((a) => formatArg(a, maxStackFrames)).join(' ');
}

// -- Core --------------------------------------------------------------------

export type LogMonitorSender = (batch: CapturedError[], suppressed: number) => Promise<void> | void;

export type LogMonitorDeps = {
  send: LogMonitorSender;
  config?: Partial<LogMonitorConfig>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Where this module reports its OWN failures. Must not be the patched
   *  console -- see the re-entrancy note in the file header. */
  onInternalError?: (message: string, err: unknown) => void;
};

export type LogMonitor = {
  capture: (level: LogLevel, args: unknown[]) => void;
  flush: () => Promise<void>;
  pendingCount: () => number;
};

export function createLogMonitor(deps: LogMonitorDeps): LogMonitor {
  const config: LogMonitorConfig = { ...DEFAULT_LOG_MONITOR_CONFIG, ...(deps.config || {}) };
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule || ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const onInternalError = deps.onInternalError || (() => {});

  /** signature -> entry, for the current batch window. */
  const buffer = new Map<string, CapturedError>();
  /** signature -> when it was last actually sent. */
  const lastSentAt = new Map<string, number>();
  let flushScheduled = false;
  let inFlush = false;

  function capture(level: LogLevel, args: unknown[]): void {
    // (2) in the file header: while a send is in flight, this module is deaf.
    if (inFlush) return;
    try {
      if (!config.levels.includes(level)) return;

      const raw = formatArgs(args, config.maxStackFrames);
      if (!raw.trim()) return;

      const tag = parseTag(raw);
      if (tag && config.ignoreTags.includes(tag)) return;

      // (3) in the file header: redact before it is stored anywhere.
      const message = redact(raw).slice(0, config.maxMessageChars);
      const sig = signature(message);
      const t = now();

      const existing = buffer.get(sig);
      if (existing) {
        existing.count += 1;
        existing.lastAt = t;
        return;
      }

      const sentAt = lastSentAt.get(sig);
      if (sentAt !== undefined && t - sentAt < config.cooldownMs) return;

      buffer.set(sig, { level, tag, message, count: 1, firstAt: t, lastAt: t, signature: sig });

      if (!flushScheduled) {
        flushScheduled = true;
        schedule(() => { void flush(); }, config.batchWindowMs);
      }
    } catch (err) {
      onInternalError('capture failed', err);
    }
  }

  async function flush(): Promise<void> {
    flushScheduled = false;
    if (buffer.size === 0) return;

    // Array.from, not spread: tsconfig targets below es2015, so spreading a
    // Map iterator trips TS2802 (see the existing instances in jira-pg-api.ts).
    const entries = Array.from(buffer.values()).sort((a, b) => a.firstAt - b.firstAt);
    buffer.clear();

    const batch = entries.slice(0, config.maxPerFlush);
    const suppressed = entries.length - batch.length;

    const t = now();
    for (const entry of batch) lastSentAt.set(entry.signature, t);

    inFlush = true;
    try {
      await deps.send(batch, suppressed);
    } catch (err) {
      onInternalError('send failed', err);
    } finally {
      inFlush = false;
    }
  }

  return { capture, flush, pendingCount: () => buffer.size };
}

// -- Installation ------------------------------------------------------------

/**
 * Patches console.error / console.warn for this process and wires the monitor
 * to the connector system. Idempotent -- guarded on globalThis the same way
 * the event-loop lag sampler in pg-pool.ts is, because module state is not a
 * reliable "once" in a Next.js server.
 *
 * `config` is COMPILE-TIME ONLY. instrumentation.ts calls this with no
 * argument, so DEFAULT_LOG_MONITOR_CONFIG is what actually runs, and nothing
 * reads connector_configs.config for these values. Changing levels or
 * ignoreTags means changing the defaults above and redeploying.
 *
 * Making them adjustable from Settings is a genuine follow-up, and an
 * architect's call rather than a developer's: capture is process-wide while a
 * connector row is per-channel, so "which levels to capture" does not belong
 * to a single connector. It needs its own home (app_settings, most likely).
 */
export function installLogMonitor(config?: Partial<LogMonitorConfig>): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__logMonitorInstalled) return;
  g.__logMonitorInstalled = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  const monitor = createLogMonitor({
    config,
    // Reported through the ORIGINAL console reference on purpose: using the
    // patched one here is the recursion this module exists to avoid.
    onInternalError: (message, err) => {
      originalError('[LogMonitor]', message, err instanceof Error ? err.message : String(err));
    },
    send: async (batch, suppressed) => {
      // Imported lazily so nothing in the connector/pg import chain is pulled
      // into instrumentation.ts at module load -- that file's header records
      // what a bad import there costs.
      const { fireSystemAlert, SYSTEM_ERROR_EVENT } = await import('@/lib/connector-service');
      await fireSystemAlert({
        event: SYSTEM_ERROR_EVENT,
        timestamp: new Date().toISOString(),
        host: process.env.HOSTNAME || 'app',
        suppressed,
        errors: batch.map((e) => ({
          level: e.level,
          tag: e.tag,
          message: e.message,
          count: e.count,
          firstAt: new Date(e.firstAt).toISOString(),
          lastAt: new Date(e.lastAt).toISOString(),
        })),
      });
    },
  });

  // (1) in the file header: stdout first, always, before any monitor logic.
  console.error = (...args: unknown[]) => { originalError(...args); monitor.capture('error', args); };
  console.warn  = (...args: unknown[]) => { originalWarn(...args);  monitor.capture('warn',  args); };

  // 'uncaughtExceptionMonitor', NOT 'uncaughtException'. Adding a listener to
  // the latter REPLACES Node's default crash-and-exit, so the process would
  // limp on in the corrupted state that threw instead of dying and letting
  // docker-compose's `restart: unless-stopped` bring up a clean one. The
  // monitor variant observes and leaves the default behaviour intact.
  //
  // It also fires for unhandled rejections, which Node 22 raises as uncaught
  // exceptions by default -- so no separate 'unhandledRejection' listener is
  // needed here, and adding one would reintroduce the same suppression bug.
  //
  // Best-effort only: the process exits within milliseconds, long before the
  // batchWindowMs flush would run, so a crash captured here will usually NOT
  // reach the connector. Request-scoped failures are the ones that reliably
  // do -- they pass through the outer catch in jira-pg-api.ts, which logs
  // under [API] and is captured like any other console.error.
  process.on('uncaughtExceptionMonitor', (err) => { monitor.capture('error', ['[Uncaught]', err]); });

  console.log('[LogMonitor] Installed -- forwarding console errors to connectors subscribed to system.error');
}
