/**
 * oauth-service.ts
 *
 * Handles OAuth 2.0 tokens for Microsoft (Outlook/Office365) and Google (Gmail).
 * Tokens are stored in-memory (globalThis) — they survive HMR but not server restarts.
 *
 * Microsoft scopes:
 *   https://outlook.office365.com/IMAP.AccessAsUser.All
 *   https://outlook.office365.com/SMTP.Send
 *   offline_access  email  openid  profile
 *
 * Google scopes:
 *   https://mail.google.com/  (full IMAP + SMTP access)
 *   email  openid  profile
 */

export type OAuthProvider = 'microsoft' | 'google';

export interface OAuthTokens {
  provider:     OAuthProvider;
  email:        string;
  name?:        string;
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number; // ms timestamp
  spaceKey?:    string; // the space this email account belongs to
}

// ── In-memory store + DB persistence (survives container rebuilds) ────────────
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = path.join(process.cwd(), '.oauth-tokens.json');

declare global { var __oauthTokenStore: Map<string, OAuthTokens> | undefined; }

// ── DB helpers ────────────────────────────────────────────────────────────────
// All three used to open a BRAND NEW Pool (a real Postgres connection) and
// close it again on every single call. saveTokensToDB in particular runs on
// every OAuth token refresh — with dozens of mailboxes refreshing
// continuously, that was a constant churn of extra connections competing
// with every other pool in the app for the same finite max_connections,
// causing unrelated features (login, JWT verification, the monitor agent) to
// intermittently fail to get a connection. Now uses the one shared pool.
async function ensureOAuthTable() {
  const { pgPool: pool } = await import('@/lib/pg-pool');
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        email       TEXT PRIMARY KEY,
        tokens_json TEXT NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch {}
}

async function saveTokensToDB(email: string, tokens: OAuthTokens) {
  const { pgPool: pool } = await import('@/lib/pg-pool');
  try {
    await pool.query(`
      INSERT INTO oauth_tokens (email, tokens_json, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (email) DO UPDATE SET tokens_json = EXCLUDED.tokens_json, updated_at = NOW()
    `, [email.toLowerCase(), JSON.stringify(tokens)]);
  } catch (e) {
    console.error('[OAuthService] Failed to persist tokens to DB:', e);
  }
}

async function loadTokensFromDB(): Promise<Map<string, OAuthTokens>> {
  const { pgPool: pool } = await import('@/lib/pg-pool');
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        email TEXT PRIMARY KEY, tokens_json TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    const rows = await pool.query(`SELECT email, tokens_json FROM oauth_tokens`);
    const map = new Map<string, OAuthTokens>();
    for (const row of rows.rows) {
      try { map.set(row.email, JSON.parse(row.tokens_json)); } catch {}
    }
    console.log(`[OAuthService] Loaded ${map.size} OAuth token(s) from DB`);
    return map;
  } catch (e) {
    console.error('[OAuthService] Failed to load tokens from DB:', e);
    return new Map();
  }
}

// ── File helpers (kept for local dev fallback) ────────────────────────────────
function loadTokensFromDisk(): Map<string, OAuthTokens> {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
      const obj = JSON.parse(raw) as Record<string, OAuthTokens>;
      return new Map(Object.entries(obj));
    }
  } catch {}
  return new Map();
}

function saveTokensToDisk(store: Map<string, OAuthTokens>) {
  try {
    const obj: Record<string, OAuthTokens> = {};
    for (const [k, v] of store.entries()) obj[k] = v;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}

// ── Initialise: load from file first (sync, fast), then overlay DB (async) ────
if (!globalThis.__oauthTokenStore) {
  globalThis.__oauthTokenStore = loadTokensFromDisk();
  // Async: overlay with DB tokens (DB wins — it has the latest after a rebuild).
  // Also migrate any file-only tokens to DB so they survive future container rebuilds.
  loadTokensFromDB().then(dbTokens => {
    for (const [k, v] of dbTokens.entries()) {
      globalThis.__oauthTokenStore!.set(k, v);
    }
    // Migration: save tokens that are in the file but not yet in DB
    for (const [k, v] of globalThis.__oauthTokenStore!.entries()) {
      if (!dbTokens.has(k)) {
        console.log(`[OAuthService] Migrating file token to DB for ${k}`);
        saveTokensToDB(k, v);
      }
    }
  }).catch(() => {});
}

export function reloadTokensFromDisk() {
  const fresh = loadTokensFromDisk();
  for (const [k, v] of fresh.entries()) globalThis.__oauthTokenStore!.set(k, v);
  // Also reload from DB
  loadTokensFromDB().then(dbTokens => {
    for (const [k, v] of dbTokens.entries()) globalThis.__oauthTokenStore!.set(k, v);
  }).catch(() => {});
}

export function storeOAuthTokens(email: string, tokens: OAuthTokens) {
  globalThis.__oauthTokenStore!.set(email.toLowerCase(), tokens);
  saveTokensToDisk(globalThis.__oauthTokenStore!);   // local file (fast)
  saveTokensToDB(email, tokens);                      // DB (survives rebuilds)
  ensureOAuthTable();                                 // no-op after first call
}

export function getOAuthTokens(email: string): OAuthTokens | undefined {
  return globalThis.__oauthTokenStore!.get(email.toLowerCase());
}

export function getAllOAuthEmails(): string[] {
  return Array.from(globalThis.__oauthTokenStore!.keys());
}

// ── Token refresh ────────────────────────────────────────────────────────────
const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export async function getValidAccessToken(email: string): Promise<string | null> {
  const tokens = getOAuthTokens(email);
  if (!tokens) {
    console.warn(`[OAuthService] No tokens stored for ${email}`);
    return null;
  }
  const timeLeft = tokens.expiresAt - Date.now();
  if (timeLeft > BUFFER_MS) {
    console.log(`[OAuthService] Token for ${email} valid (expires in ${Math.round(timeLeft/1000)}s)`);
    return tokens.accessToken;
  }
  console.log(`[OAuthService] Token for ${email} expired/expiring (${Math.round(timeLeft/1000)}s), refreshing...`);
  return tokens.provider === 'microsoft'
    ? refreshMicrosoftToken(tokens)
    : refreshGoogleToken(tokens);
}

async function refreshMicrosoftToken(tokens: OAuthTokens): Promise<string | null> {
  const clientId     = process.env.MICROSOFT_CLIENT_ID!;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET!;
  if (!clientId || !clientSecret) return null;

  // Detect which scopes to use based on the token's audience.
  // Exchange/IMAP tokens (aud: https://outlook.office365.com) must be refreshed
  // with Exchange scopes — requesting Graph scopes will fail if consent not granted.
  let scope = 'https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send offline_access email openid profile';
  try {
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));
    if (String(payload.aud || '').includes('graph.microsoft.com')) {
      scope = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access email openid profile';
    }
  } catch {}

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      scope,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[OAuthService] Microsoft token refresh FAILED for ${tokens.email} (${res.status}):`, err);
    return null;
  }
  const data = await res.json();
  console.log(`[OAuthService] Microsoft token refreshed for ${tokens.email}, expires in ${data.expires_in}s`);
  const updated: OAuthTokens = {
    ...tokens,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt:    Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  storeOAuthTokens(tokens.email, updated);
  return updated.accessToken;
}

async function refreshGoogleToken(tokens: OAuthTokens): Promise<string | null> {
  const clientId     = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const updated: OAuthTokens = {
    ...tokens,
    accessToken: data.access_token,
    expiresAt:   Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  storeOAuthTokens(tokens.email, updated);
  return updated.accessToken;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function getMicrosoftAuthUrl(redirectUri: string, state: string, loginHint = '', mode: 'login' | 'email' = 'email'): string {
  // Login only needs identity scopes. Email mode also needs Mail scopes for IMAP/Graph.
  const scope = mode === 'login'
    ? 'openid profile email offline_access'
    : 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access email openid profile';
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID!,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri:  redirectUri,
    scope,
    prompt:        'select_account',
    state,
  });
  // Pre-fill the email account so the user doesn't have to type it
  if (loginHint) params.set('login_hint', loginHint);
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

export function getGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    response_type: 'code',
    redirect_uri:  redirectUri,
    scope:         'https://mail.google.com/ email openid profile',
    access_type:   'offline',
    prompt:        'select_account consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Decode a JWT payload without verifying the signature (safe for display/lookup only). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function exchangeMicrosoftCode(code: string, redirectUri: string, mode: 'login' | 'email' = 'email'): Promise<{ tokens: OAuthTokens; email: string; name: string } | null> {
  const scope = mode === 'login'
    ? 'openid profile email offline_access'
    : 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access email openid profile';
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      code,
      redirect_uri:  redirectUri,
      scope,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[OAuthService] exchangeMicrosoftCode FAILED (${res.status}):`, errText);
    return null;
  }
  const data = await res.json() as Record<string, unknown>;

  // ── 1. Try id_token claims first (no extra network call) ───────────────────
  let email = '';
  let name  = '';
  if (data.id_token && typeof data.id_token === 'string') {
    const claims = decodeJwtPayload(data.id_token);
    email = String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase();
    name  = String(claims.name || '');
  }

  // ── 2. Fallback: call MS Graph /me ─────────────────────────────────────────
  if (!email) {
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName,otherMails', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json() as Record<string, unknown>;
        // otherMails often has the real SMTP address when mail is null
        const otherMails = Array.isArray(me.otherMails) ? (me.otherMails as string[]) : [];
        email = String(me.mail || otherMails[0] || me.userPrincipalName || '').toLowerCase();
        if (!name) name = String(me.displayName || '');
      }
    } catch (e) {
    }
  }

  // ── 3. If UPN looks like external (has #EXT#), strip it ────────────────────
  if (email.includes('#ext#')) {
    // e.g. bhanu.srikakulam_cloudfuze.com#EXT#@tenant.onmicrosoft.com
    // → bhanu.srikakulam@cloudfuze.com
    const localPart = email.split('#ext#')[0];
    email = localPart.replace(/_([^_]+\.[^_]+)$/, '@$1');
  }


  if (!name) name = email;

  // ── 4. Fetch profile photo from MS Graph ───────────────────────────────────
  let avatarUrl: string | undefined;
  try {
    const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (photoRes.ok) {
      const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
      const buf = await photoRes.arrayBuffer();
      avatarUrl = `data:${contentType};base64,${Buffer.from(buf).toString('base64')}`;
    }
  } catch { /* no photo is fine */ }

  const tokens: OAuthTokens = {
    provider:     'microsoft',
    email,
    name,
    accessToken:  data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt:    Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
  };
  if (email) storeOAuthTokens(email, tokens);
  return { tokens, email, name, avatarUrl };
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ tokens: OAuthTokens; email: string; name: string } | null> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      redirect_uri:  redirectUri,
    }),
  });
  if (!res.ok) { return null; }
  const data = await res.json();

  // Get email from userinfo
  const meRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const me = meRes.ok ? await meRes.json() : {};
  const email = (me.email || '').toLowerCase();
  const name  = me.name || email;

  const tokens: OAuthTokens = {
    provider:     'google',
    email,
    name,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  storeOAuthTokens(email, tokens);
  return { tokens, email, name };
}
