/**
 * Storage + token rules for the read-only Claude (MCP) connector.
 *
 * Claude Desktop custom connectors sign people in with OAuth 2.1. This file
 * owns the tables behind that flow and the one rule that keeps the
 * connector read-only everywhere:
 *
 *   MCP access tokens start with `ntm_`. The main API handler
 *   (jira-pg-api.ts) only ever lets an `ntm_` token make GET requests to the
 *   paths in MCP_READ_PATHS below -- nothing else, ever. So even a leaked
 *   token can't change a ticket, settings, users, or anything else.
 *
 * Tables are created lazily (CREATE TABLE IF NOT EXISTS) the first time any
 * of this runs, same idempotent style as the rest of the app's raw columns.
 */
import crypto from 'crypto';
import { pgPool as pool } from '@/lib/pg-pool';

export const MCP_ACCESS_TTL_SEC = 60 * 60;            // 1 hour
export const MCP_REFRESH_TTL_SEC = 60 * 60 * 24 * 30;  // 30 days
export const MCP_CODE_TTL_SEC = 10 * 60;              // 10 minutes
export const MCP_SCOPE = 'tickets:read';

export const mcpEnabled = () => String(process.env.MCP_ENABLED ?? 'true').toLowerCase() !== 'false';

export const appBaseUrl = () =>
  (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://neutaraticketing.cftools.live').replace(/\/$/, '');

/**
 * The only API paths an `ntm_` token may call (GET only). Kept to exactly
 * what the MCP tools need -- anything not listed is refused with 403.
 */
export const MCP_READ_PATHS: RegExp[] = [
  /^auth\/me$/,
  /^issues$/,
  /^issues\/[^/]+$/,
  /^issues\/[^/]+\/(comments|worklogs)$/,
  /^worklogs$/,
  /^activity-worklogs$/,
  /^spaces$/,
  /^spaces\/[^/]+\/dept-queue\/summary$/,
  /^reports\/resolution-sla$/,
  /^reports\/assignments$/,
  /^kb\/articles$/,
  /^kb\/articles\/[^/]+$/,
  /^users$/,
];

export function isMcpAllowedRequest(path: string, method: string): boolean {
  return method === 'GET' && MCP_READ_PATHS.some((re) => re.test(path));
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix: string, bytes = 32) => `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;

let _ready: Promise<void> | null = null;
export function ensureMcpTables(): Promise<void> {
  if (!_ready) {
    _ready = pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS mcp_access_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE
      );
      -- One row per "Claude connection" a user approved. Revoking it kills
      -- every access/refresh token issued under it.
      CREATE TABLE IF NOT EXISTS mcp_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args JSONB,
        ok BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS mcp_grants_user_idx ON mcp_grants (user_id);
      CREATE INDEX IF NOT EXISTS mcp_audit_user_idx ON mcp_audit (user_id, created_at);
    `).then(() => undefined).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

/** Resolves an `ntm_` access token to its user id, or null if invalid/expired/revoked. */
export async function resolveMcpAccessToken(token: string): Promise<string | null> {
  if (!mcpEnabled() || !token.startsWith('ntm_')) return null;
  try {
    await ensureMcpTables();
    const r = await pool.query(
      `SELECT t.user_id, t.grant_id FROM mcp_access_tokens t
         JOIN mcp_grants g ON g.id = t.grant_id
        WHERE t.token_hash = $1 AND t.expires_at > NOW() AND g.revoked = FALSE
        LIMIT 1`,
      [sha256(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    pool.query(`UPDATE mcp_grants SET last_used_at = NOW() WHERE id = $1`, [row.grant_id]).catch(() => {});
    // A deactivated user loses connector access immediately, same as the app.
    const u = await pool.query(`SELECT "isActive" FROM users WHERE id = $1`, [row.user_id]);
    if (!u.rows[0]?.isActive) return null;
    return row.user_id;
  } catch {
    return null;
  }
}

/** Issues a fresh access + refresh token pair under a grant. */
export async function issueTokenPair(userId: string, clientId: string, grantId: string) {
  const accessToken = randomToken('ntm_');
  const refreshToken = randomToken('ntr_');
  await pool.query(
    `INSERT INTO mcp_access_tokens (token_hash, user_id, client_id, grant_id, expires_at)
     VALUES ($1,$2,$3,$4, NOW() + ($5 || ' seconds')::interval)`,
    [sha256(accessToken), userId, clientId, grantId, String(MCP_ACCESS_TTL_SEC)],
  );
  await pool.query(
    `INSERT INTO mcp_refresh_tokens (token_hash, user_id, client_id, grant_id, expires_at)
     VALUES ($1,$2,$3,$4, NOW() + ($5 || ' seconds')::interval)`,
    [sha256(refreshToken), userId, clientId, grantId, String(MCP_REFRESH_TTL_SEC)],
  );
  // Housekeeping: drop long-expired rows now and then.
  if (Math.random() < 0.05) {
    pool.query(`DELETE FROM mcp_access_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    pool.query(`DELETE FROM mcp_refresh_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    pool.query(`DELETE FROM mcp_oauth_codes WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    pool.query(`DELETE FROM mcp_audit WHERE created_at < NOW() - INTERVAL '180 days'`).catch(() => {});
  }
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: MCP_SCOPE,
  };
}

/**
 * Redirect URIs Claude uses for custom connectors. Anything else is refused
 * at client registration, so a stranger can't register a client that sends
 * someone's authorization code to their own site. Extra URIs can be allowed
 * with MCP_EXTRA_REDIRECT_URIS (comma-separated), e.g. for MCP Inspector
 * during testing: http://localhost:6274/oauth/callback
 */
export function isAllowedRedirectUri(uri: string): boolean {
  const allowed = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    ...String(process.env.MCP_EXTRA_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ];
  return allowed.includes(uri);
}

export function logMcpCall(userId: string, tool: string, args: unknown, ok: boolean) {
  ensureMcpTables()
    .then(() => pool.query(`INSERT INTO mcp_audit (user_id, tool, args, ok) VALUES ($1,$2,$3,$4)`, [userId, tool, JSON.stringify(args ?? {}), ok]))
    .catch(() => {});
}
