# Diagnostics

Reusable investigation scripts. **Not the repository root.**

## Why this directory exists

The repository root currently holds roughly 250 one-off scripts — `check-*.mjs`, `fix-*.mjs`, `audit-*.mjs`, `verify-*.mjs`, `backfill-*.mjs` — and recent commits kept adding more. They were genuinely useful investigations, but the root is now unnavigable and it is impossible to tell which scripts are still meaningful.

New reusable diagnostics go here instead. Existing root scripts are left alone: moving them is a separate change, and not one the AI-SDLC framework should make on its own.

## What belongs here

A script that:

- answers a question that will be asked again (an SLA computation cross-check, a department-drift audit, a worked-credit reconciliation), and
- is worth keeping after this session ends.

## What does not

- **A throwaway probe for one investigation** → the session scratchpad. Never committed.
- **A test** → a colocated `*.test.ts`, run by `npm test`.
- **A production fix** → the application code, through a pipeline.

## Conventions

Match the existing root scripts, which are well-built even though there are too many of them:

- **`.mjs`**, run with plain `node`, top-level `await`.
- Import the shared pool: `import { pgPool } from '../../../src/lib/pg-pool.js'` — or construct a `pg.Pool` directly if the script must run standalone outside the app. **Never add a new pool to application code.**
- `DATABASE_URL` from the environment. **Never a hardcoded connection string** — the secret-scan guard blocks it, and it would be a credential in tracked source.
- Print findings; do not summarise them away. The point is ground truth.
- Name it for the question: `check-<subject>.mjs`, `audit-<subject>.mjs`.

## Read by default

**A diagnostic reads. It does not write.**

A script that writes to the live database needs, every time:

1. an explicit human decision recorded in the session,
2. an explicit allowlist of the keys it may touch — the root script `Restrict backfill writes to an explicit --keys allowlist` exists because an earlier version wrote too widely,
3. a stated undo, and
4. a dry-run mode that is the default.

This is not ceremony. Several commits in this repo's history are corrections to earlier corrections — `revert-cf29589-false-positive.mjs`, `fix-cf29399-hand-verified.mjs` ("script got this one wrong twice"). A write-capable diagnostic that is wrong creates work rather than removing it.

## Naming

```
check-<subject>.mjs     read-only ground truth
audit-<subject>.mjs     read-only sweep across many rows
verify-<subject>.mjs    read-only confirmation that a fix held
```

Write-capable scripts are named `fix-*` or `backfill-*` and must carry the four requirements above in a header comment.
