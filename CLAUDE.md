# CLAUDE.md — Neutara Ticketing (jira-client)

Instructions for any agent working in this repository. The AI-SDLC framework
lives in [`.claude/aisdlc/`](.claude/aisdlc/README.md); this file is the entry
point that decides how a request is handled.

---

## 1. Mode routing

```
Direct mode → typos, docs, formatting, single-file cosmetic, pure questions,
              one-line fixes
SDLC mode   → features, multi-file bug fixes, auth/authz, data model,
              external integrations, core product pipelines

bug / broken / error / crash / regression   → bug-fix
add / implement / new feature / support for → new-feature
"full sdlc"                                 → complete-sdlc
ambiguous                                   → ASK, never guess

Overrides: "use sdlc" | "quick fix" / "direct" | "full sdlc"
```

**Every run states which mode it used and why**, in its first line. For example:

> Mode: SDLC / bug-fix — "the Resolved option is missing on CF-29995" is a
> multi-file defect touching the department authorization gate, not a cosmetic fix.

> Mode: Direct — a one-line typo in a comment.

### What counts as "core product pipeline" here

These are SDLC-mode by default, whatever the wording, because a wrong change is
not locally contained:

- **Department routing / handoff** — `current_department`, `dept_statuses`,
  `dept_assignees`, `original_dept`, `resolve_override_depts`
- **SLA** — breach computation, `dept_sla_started_at`, pause/resume on reopen
- **Worked-on credit** and the MBR reports built on it
- **Auth and RBAC** — `resolveUserId`, `src/lib/permissions.ts`
- **Jira / email ingestion** — `runJiraIssueSync`, `src/lib/email-service.ts`
- **Anything that adds or changes a database column**

---

## 2. The three pipelines

| Pipeline | Use for | Definition |
|---|---|---|
| `bug-fix` | something that used to work, or never worked as specified | [pipelines/bug-fix.md](.claude/aisdlc/pipelines/bug-fix.md) |
| `new-feature` | new capability on an approved design | [pipelines/new-feature.md](.claude/aisdlc/pipelines/new-feature.md) |
| `complete-sdlc` | a whole initiative from requirements out | [pipelines/complete-sdlc.md](.claude/aisdlc/pipelines/complete-sdlc.md) |

Gate notation, identical in all three:

- `[H]` **hard stop** — end the message there and wait for a human. Do not
  continue to the next stage in the same response.
- `[L]` **gated loop** — on failure, route back and retry. **Maximum 2 attempts,
  then escalate to a human.** Never a third silent attempt.

Review order is **code → security → QA** in all three. It does not vary.

Failed gates route to the **developer** (bug-fix, new-feature) or the
**debug engineer** (complete-sdlc).

---

## 3. Response format

One role per response. Open with:

```
=== STAGE <n>: <name> — acting as <role> ===
```

and restate, every stage:

```
Pipeline: <bug-fix | new-feature | complete-sdlc>
Stage n of N
Consuming: <named artifact from the previous stage>
Attempt: n of 2
```

---

## 4. Global rules — binding on every role

1. **Never auto-commit or auto-push.** The commit gate is a hard stop, every
   time. Enforced by `.claude/hooks/commit-gate.mjs`.
2. **Never hardcode a secret; never log one.** Report property *names*, never
   values. Enforced by `.claude/hooks/secret-scan.mjs`.
3. **No debug prints in production source.** Enforced by
   `.claude/hooks/log-convention.mjs`.
4. **Deployment, release, CI and infrastructure are out of scope.** Every run
   says so explicitly. Do not touch `deploy.sh`, `docker-compose.yml`,
   `Dockerfile`, or `monitoring/`.
5. **Inspect the repo before claiming anything about it.** Cite `file:line`.
6. **Report real results.** "Not verified" beats a false "pass".
7. **Never weaken a test or swallow an exception to make a stage go green.**
8. **No scope creep, no drive-by refactors, no reformatting unrelated code.**
9. **Match the file you are editing, not an idealised style.**
10. **One role per response**, in the format above.

---

## 5. What this repository actually is

Verified by inspection. Do not assume beyond this without re-checking.

**Stack** — TypeScript 5.5 (`strict: true`), Next.js 14.2 App Router, React 18.3,
PostgreSQL 16, Prisma 7.8 + raw `pg`, Tailwind 3.4, Zustand. npm. Node v22.

**Layering** — there is **no service layer and no repository layer**. The real
call path is:

```
src/app/issues/[issueKey]/page.tsx     page (5,009 lines)
  → src/lib/api.ts            ApiClient — GET coalescing + a 5s static-GET cache
  → src/app/api/[[...path]]/route.ts    31-line passthrough, runtime = 'nodejs'
  → src/lib/jira-pg-api.ts    handleJiraPgApi — 14,285 lines, one path+method chain
  → pgPool (raw SQL) and db (Prisma), both, often in the same function
  → src/lib/jira-dev-mock.ts  fallback for routes not yet ported
```

25 dedicated route handlers sit outside the catch-all for what it cannot host
(OAuth callbacks, the email webhook, admin bulk jobs, the Alertmanager webhook).

**Conventions that are not optional**

- **Errors:** `return json({ error: 'message' }, status)` — the helper is at
  `src/lib/jira-pg-api.ts:454`. There are **no custom Error classes anywhere in
  `src/`** and **zero `throw new Error` in `jira-pg-api.ts`**. Do not introduce
  either. Status codes in use: 201, 400, 401, 403, 404, 409, 413, 500, 502.
- **Logging:** `console.*` only, first argument a bracketed subsystem tag —
  `[SLA]`, `[Notification]`, `[EmailPoller]`, `[Security]`, `[API]`. All 86
  `console.log` calls in `src/` follow this. Zero exceptions today; keep it that way.
- **Schema:** `prisma/schema.prisma` is **not** the source of truth.
  `deploy.sh` runs only `prisma generate`, never `prisma migrate deploy`, so
  production columns are added as idempotent `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` at module load — see `src/lib/jira-pg-api.ts:56-77`. A new column goes
  **there**, not into a migration file that will never run.
- **Timestamps:** `src/lib/pg-pool.ts` installs `types.setTypeParser(1114, ...)`
  to read naive `timestamp` columns as UTC. Never bypass `pgPool` with your own
  `new Pool(...)` — that regression cost this app a day of connection-timeout
  outages, documented in that file's header.
- **Tests:** Node's built-in `node:test` + `node:assert/strict`. No framework,
  and do not add one. Colocated `*.test.ts`. Command: `npm test`.
- **Build is not a gate:** `next.config.js` sets `typescript.ignoreBuildErrors`
  and `eslint.ignoreDuringBuilds` to `true`. A green build proves nothing about
  type safety. Verify with tests and by reading the code.

**Commits** — imperative subject, no fixed ticket prefix. Ticket ids
(`CF-29982`, `L2B-15838`, `L3B-782`) appear inline where relevant. Main branch
is `master`; branch before committing.

**Diagnostics** — reusable investigation scripts go in
`.claude/aisdlc/diagnostics/`, **not** the repository root. Throwaway
investigations go in the session scratchpad and are never committed.

---

## 6. Known risks carried by this repo

See [`.claude/aisdlc/SECURITY-FOLLOWUPS.md`](.claude/aisdlc/SECURITY-FOLLOWUPS.md).
The security reviewer reads it every run so that a pre-existing risk is reported
as pre-existing, not re-discovered as new and not silently accepted.
