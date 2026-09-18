# Security follow-ups — pre-existing risks

Risks this repository carried **before** the AI-SDLC framework was added. None were introduced by it, and none were fixed by it — Phase 2 changed no application code by design.

The security reviewer reads this file every run, so a pre-existing risk is reported as pre-existing rather than re-discovered as new or silently accepted.

**This file names variables, files and line numbers. It contains no credential values, and must never contain one.** Anyone fixing an item below reads the value from the file cited, not from here.

---

## SF-1 — CRITICAL — `.env.server` is committed to the repository

**What.** `.env.server` is tracked in git (`git ls-files` lists it). It holds live server-side values, including a database connection string with its password, a mailbox password, and the JWT signing secret.

**Why it happened.** `.gitignore` covers `.env`, `.env.local` and `.env.*.local`. **`.env.server` matches none of those patterns.**

**Impact.** Anyone with repository read access — including anyone with a clone, a fork, or access to a CI log that echoes it — holds production database, mailbox and session-signing credentials. The JWT secret is the most serious of the three: it signs `user_sessions` tokens, so possession allows forging a session for any user id.

**Remediation, in this order.** Rotating first matters more than scrubbing history — the credentials are already exposed and history rewriting takes time and coordination.

1. **Rotate all three** — the database password, the mailbox password, and the JWT secret. Rotating the JWT secret invalidates every live session; plan for the forced re-login.
2. Add `.env.server` to `.gitignore` and `git rm --cached .env.server`.
3. Purge it from history (`git filter-repo`, or BFG) and force-push, coordinated with everyone holding a clone.
4. Re-issue the values through the deployment path already in use: `docker-compose.yml` reads `env_file: .env.local`, which is correctly gitignored.

**Not fixed in Phase 2** — the file was explicitly left untouched.

---

## SF-2 — CRITICAL — hardcoded credential fallbacks in tracked source

**What.** Roughly 25 `process.env.X || '<literal>'` expressions across tracked source. The credential-bearing ones:

| Variable | Files | Note |
|---|---|---|
| `JWT_SECRET` | [src/lib/jira-pg-api.ts:944](src/lib/jira-pg-api.ts#L944), [src/app/api/auth/oauth/microsoft/callback/route.ts:18](src/app/api/auth/oauth/microsoft/callback/route.ts#L18) | session signing key, duplicated in two places |
| `ADMIN_BULK_SECRET` | 7 route handlers under `src/app/api/admin/` | same literal in all seven |
| `DATABASE_URL` | [src/lib/db.ts](src/lib/db.ts), [src/lib/pg-pool.ts](src/lib/pg-pool.ts) | connection string with inline password |

**Impact.** A deployment that forgets to set one of these does not fail — it silently falls back to a value that is public in the repository. For `JWT_SECRET` that means an attacker who has read the repo can mint valid session tokens.

**Remediation.** Fail closed instead of falling back:

```ts
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is not configured');
```

Then rotate every affected value and document each variable **by name** in `.env.example`.

**Interaction with the secret-scan guard.** Existing occurrences are not blocked — the scanner is diff-aware, so ordinary work near them proceeds. **Editing the line that carries one does block**, with a message saying to fix it rather than carry it forward. That converts this backlog into something that gets paid down as the code is touched, instead of all at once or never.

---

## SF-3 — CRITICAL — user passwords are stored and compared in plaintext

**What.** Login compares the submitted password directly against the stored column:

```ts
if (!user || user.password !== password) { ... }
```

[src/lib/jira-pg-api.ts:3976](src/lib/jira-pg-api.ts#L3976). `prisma/schema.prisma` gives `User.password` a plaintext default of a fixed shared string.

**Impact.** Any read of the `users` table — a backup, a dump, a SQL-injection elsewhere, a support query — yields every user's actual password. Users reuse passwords, so the blast radius extends past this application.

**Remediation.** Hash with `bcrypt` or `argon2`, verify against the hash, migrate existing rows on next login, and remove the plaintext default. This is a design change: it needs the architect, and it adds a dependency that must be flagged and approved.

**Note.** `neutara_db_backup.sql` (64 MB) is tracked in the repository. If it contains rows from `users`, SF-3 and SF-1 compound.

---

## SF-4 — HIGH — legacy unsigned tokens are still accepted

**What.** `resolveUserId` accepts a `dev.`-prefixed token whose payload is plain base64url with **no signature**, logs `[Security] Legacy unsigned token used`, and returns the `sub` claim as the authenticated user id. [src/lib/jira-pg-api.ts:988-1000](src/lib/jira-pg-api.ts#L988-L1000).

**Impact.** Anyone who can reach the API can authenticate as any user by base64-encoding `{"sub":"<user id>"}` behind a `dev.` prefix. No key needed. The warning is logged but the request proceeds.

**Remediation.** Remove the branch. The transition it was written for has long since happened — the signed path is the live one. If a grace period is still wanted, gate the branch on `NODE_ENV === 'development'` as an interim step, then delete it.

---

## SF-5 — HIGH — a development branch skips session revocation

**What.** In the signed-JWT path, when `NODE_ENV === 'development'`, `resolveUserId` returns the `sub` claim without checking `user_sessions` for revocation or expiry. [src/lib/jira-pg-api.ts:1011-1013](src/lib/jira-pg-api.ts#L1011-L1013).

**Impact.** Correct as intended for local work without a database. It becomes a real vulnerability the moment anything reachable runs with `NODE_ENV` unset or set to `development` — a revoked or logged-out token still authenticates. The risk is a misconfiguration away, not an exploit away.

**Remediation.** Require an explicit opt-in variable (for example `ALLOW_SESSIONLESS_DEV_AUTH`) in addition to `NODE_ENV`, so the unsafe path cannot be reached by an environment variable being absent.

---

## SF-6 — MEDIUM — a shared admin secret across seven endpoints

**What.** All seven `src/app/api/admin/` bulk endpoints authenticate with the same `ADMIN_BULK_SECRET` value (see SF-2), a single shared static string with no rotation, no expiry and no per-caller identity.

**Impact.** One leak grants every admin bulk operation at once — board auto-linking, bulk patching, space-type rewriting, Jira comment/field/link sync, CFITS migration, photo sync. There is no audit trail of who called what.

**Remediation.** Prefer the existing `x-internal-job-secret` mechanism ([src/lib/internal-job-secret.ts](src/lib/internal-job-secret.ts)), which is per-process and randomly generated at boot, or the `api_tokens` table for caller-identifiable access.

---

## SF-7 — LOW — a 10 GB upload ceiling on an authenticated endpoint

**What.** `POST /api/uploads` sets `MAX_UPLOAD_BYTES` to 10 GB and buffers the whole file into memory via `Buffer.from(await file.arrayBuffer())` before writing it to disk. [src/lib/jira-pg-api.ts:4002-4022](src/lib/jira-pg-api.ts#L4002-L4022).

**Impact.** An authenticated user can exhaust process memory or fill the `jira_app_uploads_tmp` volume. Low because it needs a valid session and the path traversal guard is correct (`filePath.startsWith(uploadsRoot)`).

**Remediation.** Lower the ceiling to something the product actually needs, and stream to disk rather than buffering.

---

## Register

| ID | Severity | Summary | Introduced by Phase 2? | Fixed? |
|---|---|---|---|---|
| SF-1 | Critical | `.env.server` committed with live credentials | No | No — explicitly out of scope |
| SF-2 | Critical | ~25 hardcoded credential fallbacks in source | No | No — guard now blocks edits to them |
| SF-3 | Critical | plaintext password storage and comparison | No | No |
| SF-4 | High | unsigned `dev.` tokens accepted | No | No |
| SF-5 | High | dev branch skips session revocation | No | No |
| SF-6 | Medium | one shared secret across 7 admin endpoints | No | No |
| SF-7 | Low | 10 GB in-memory upload ceiling | No | No |

Phase 2 introduced no application code and therefore no new risk. It reduced the *rate* at which SF-2-class issues accumulate, and it made SF-1's category harder to repeat, but it fixed nothing on this list.
