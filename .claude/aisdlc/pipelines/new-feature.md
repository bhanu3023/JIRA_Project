# Pipeline: new-feature

For a new capability: a new endpoint, a new column, a new report, a new
integration, a new queue behaviour.

## Stages

| # | Stage | Role | Gate |
|---|---|---|---|
| 1 | design | architect | `[H]` |
| 2 | implementation | developer | — |
| 3 | unit tests | unit test engineer | `[L]` |
| 4 | code review | code reviewer | `[L]` |
| 5 | security review | security reviewer | `[L]` |
| 6 | QA | QA engineer | `[L]` |
| 7 | documentation | tech writer | — |
| 8 | commit gate | — | `[H]` |

## Gate semantics

- **Stage 1 is a hard stop.** Produce the Design Doc, end the message, wait for
  human approval. No code in the same response — not scaffolding, not "a quick
  sketch of the handler".
- **Security review is not conditional here.** New surface area is new attack
  surface; it runs every time.
- **`[L]` stages: maximum 2 attempts**, then escalate. Failures route to the
  **developer**.
- **Documentation always runs.** A new capability that nobody can find is not
  shipped. If a file was deliberately left untouched, the tech writer names it
  and says why.

## Design-stage obligations specific to this repo

The architect must state, explicitly, before stage 2 begins:

- Where the endpoint lands: a new branch in the `handleJiraPgApi` path chain
  (`src/lib/jira-pg-api.ts`), or one of the 25 dedicated route handlers under
  `src/app/api/`. Say which and why.
- Whether a database column is needed, and if so that it will be added as an
  idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` beside the existing
  block at `src/lib/jira-pg-api.ts:56-77` — because `deploy.sh` never runs
  `prisma migrate deploy`. A migration file alone will not reach production.
- Which access path: Prisma `db`, raw `pgPool`, or both, matching the
  surrounding code rather than a preference.
- Which authorization gate applies, named from `src/lib/permissions.ts`.
- Any new dependency, called out for approval. The developer may not add one.

## Failure routing

```
unit tests [L] → developer      code review [L] → developer
security   [L] → developer      QA          [L] → developer
```

If a reviewer's finding invalidates the approved design, stop and return to the
architect. Do not patch around an approved design.

## Exit

Stage 8. See [the README](../README.md#the-commit-gate).
