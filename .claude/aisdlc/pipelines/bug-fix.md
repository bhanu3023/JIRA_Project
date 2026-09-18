# Pipeline: bug-fix

For a defect: something that used to work, or never worked as specified.
Multi-file bug fixes, department/SLA/credit defects, authorization gaps.

A one-line cosmetic fix is **Direct mode**, not this pipeline.

## Stages

| # | Stage | Role | Gate | Conditional |
|---|---|---|---|---|
| 1 | diagnosis | debug engineer | — | always. **Root cause only — writes NO code** |
| 2 | design | architect | `[H]` | only if the root cause is architectural |
| 3 | implementation | developer | — | always |
| 4 | unit tests | unit test engineer | `[L]` | always |
| 5 | code review | code reviewer | `[L]` | always |
| 6 | security review | security reviewer | `[L]` | only if auth / input / secrets / uploads touched |
| 7 | QA | QA engineer | `[L]` | always |
| 8 | documentation | tech writer | — | only if a contract or behaviour changed |
| 9 | commit gate | — | `[H]` | always. `auto_commit: NEVER` |

## Gate semantics

- **Stage 1 writes no code.** Not a stub, not a "while I was there". The
  diagnosis is a Root-Cause Report. If stage 1 produces a diff, the pipeline has
  already failed.
- **Stage 2 is conditional and is a hard stop when it runs.** It runs when the
  cause is a design problem rather than a coding slip — the fix needs a new
  column, a changed authorization gate, a new sync path, or it contradicts an
  existing design decision. When it runs, end the message and wait.
- **`[L]` stages: maximum 2 attempts.** Attempt 1 fails → route back to the
  **developer** with the specific finding → attempt 2. If attempt 2 fails,
  **stop and escalate to a human.** Do not start attempt 3. Do not narrow the
  test to make attempt 2 pass.
- **Stage 6 trigger** — run it if the change touches any of: `resolveUserId` /
  token handling, `src/lib/permissions.ts` or any `isPrivileged` / `isManager` /
  `can()` gate, the department resolve gate (`original_dept`,
  `resolve_override_depts`, `canResolveHere`), request-body parsing, file
  upload/serve paths, or anything reading `process.env`.
- **Stage 8 trigger** — an API response shape changed, a config property was
  added, a status/transition was added, or user-visible behaviour changed.
  If it does not run, the tech writer still records *why* at the commit gate.

## Failure routing

```
unit tests  [L] fail → developer
code review [L] fail → developer
security    [L] fail → developer
QA          [L] fail → developer
```

Two attempts each. If the reviewer's finding is that the **design** is wrong
rather than the code, do not loop — escalate to the architect (stage 2) and say
so plainly.

## Entry requirement

A reproducible symptom. If there is no reproduction, stage 1's first job is to
produce one; if it cannot, it says so and stops rather than guessing.

## Exit

Stage 9. The commit gate is identical in all three pipelines — see
[the README](../README.md#the-commit-gate).
