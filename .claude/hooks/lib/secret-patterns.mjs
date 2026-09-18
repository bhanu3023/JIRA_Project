/**
 * Credential detection rules for the secret-scan guard.
 *
 * Scoped to what this repo actually gets wrong. A Phase 1 sweep found live
 * credentials reaching tracked files three ways, and each rule below exists
 * for one of them:
 *   1. `process.env.X || '<real value>'` fallbacks   -> ENV_FALLBACK
 *   2. a connection string with inline user:password -> CONNECTION_STRING
 *   3. a credential-named constant assigned a literal -> CREDENTIAL_LITERAL
 * The vendor-shape and private-key rules are ordinary belt-and-braces.
 *
 * The scanner is DIFF-AWARE (see secret-scan.mjs): these rules only ever fire
 * on text a tool call is introducing. The ~25 pre-existing fallbacks in
 * src/app/api/** are therefore left alone until someone edits one of those
 * lines, which is the point — a guard that blocked every existing fallback
 * would fire on unrelated work and get switched off within a day.
 */

/** A value that is plainly not a real credential. Kept narrow on purpose. */
const PLACEHOLDER = /^(|\s*|__.*__|<.*>|\{\{.*\}\}|\$\{.*\}|x{3,}|\*{3,}|\.{3,}|(your|my|some|example|sample|placeholder|replace|changeme|change-me|todo|fixme|dummy|fake|test|mock|stub|redacted|removed)[-_a-z0-9]*)$/i;

/** localhost / loopback URLs are configuration, not secrets. */
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\/?$/i;

export function isPlaceholder(value) {
  const v = String(value ?? '').trim();
  return PLACEHOLDER.test(v) || LOCAL_URL.test(v) || v.length < 6;
}

/**
 * Each rule: { id, severity, describe(match) -> string, regex }
 * `regex` must be global so the scanner can walk every occurrence, and must
 * expose the offending literal as a capture group for the allowlist check.
 */
export const RULES = [
  {
    id: 'ENV_FALLBACK',
    severity: 'critical',
    // process.env.SOMETHING_SECRET || 'literal'
    regex: /process\.env\.([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)\s*(?:\|\||\?\?)\s*(['"`])([^'"`\n]{6,})\2/g,
    valueGroup: 3,
    describe: (m) => `hardcoded fallback for process.env.${m[1]} — a real credential committed as source`,
  },
  {
    id: 'CONNECTION_STRING',
    severity: 'critical',
    // postgres://user:password@host  (also mysql/mongodb/redis/amqp)
    regex: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s'"`:@\/]+:([^\s'"`@\/]{4,})@[^\s'"`]+)/g,
    valueGroup: 2,
    describe: () => 'connection string with an inline password',
  },
  {
    id: 'CREDENTIAL_LITERAL',
    severity: 'critical',
    // const JWT_SECRET = 'value'   |   password: "value"
    regex: /\b([A-Za-z_$][A-Za-z0-9_$]*(?:secret|password|passwd|pwd|token|apikey|api_key|accesskey|access_key|privatekey|private_key)[A-Za-z0-9_$]*)\s*[:=]\s*(['"`])([^'"`\n]{6,})\2/gi,
    valueGroup: 3,
    describe: (m) => `credential-named identifier "${m[1]}" assigned a string literal`,
  },
  {
    id: 'VENDOR_KEY',
    severity: 'critical',
    // Known provider key shapes, including this app's own API tokens (nta_…,
    // minted by generateApiToken in src/lib/jira-pg-api.ts).
    regex: /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|nta_[A-Za-z0-9]{40})\b/g,
    valueGroup: 1,
    describe: () => 'a literal that matches a known API key / token format',
  },
  {
    id: 'PRIVATE_KEY',
    severity: 'critical',
    regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)/g,
    valueGroup: 1,
    describe: () => 'an embedded private key block',
  },
  {
    id: 'JWT_LITERAL',
    severity: 'high',
    // A signed token pasted into source — three base64url segments.
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    valueGroup: 1,
    describe: () => 'a literal signed JWT',
  },
];

/** Run every rule over `text`, skipping placeholders. */
export function scan(text) {
  const findings = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(text)) !== null) {
      const value = m[rule.valueGroup];
      if (rule.id !== 'PRIVATE_KEY' && isPlaceholder(value)) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        message: rule.describe(m),
        snippet: m[0],
        index: m.index,
        // Never echoed anywhere. Used only to compare against prior text and
        // the allowlist, so the guard can report a finding without reprinting
        // the credential it found.
        value,
      });
    }
  }
  return findings;
}

/** Redact a value for display: length and shape only, never content. */
export function redact(value) {
  const v = String(value ?? '');
  return `<redacted ${v.length} chars>`;
}
