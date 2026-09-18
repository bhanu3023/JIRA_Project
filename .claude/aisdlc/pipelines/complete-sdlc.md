# Pipeline: complete-sdlc

For a whole initiative, from a stated problem to committed code. Invoked by
"full sdlc", or when a request is large and under-specified enough that jumping
to design would be guessing.

## Stages

| # | Stage | Role | Gate | Conditional |
|---|---|---|---|---|
| 1 | requirements | requirement engineer | `[H]` | always |
| 2 | feasibility | feasibility engineer | `[H]` | always |
| 3 | user stories | user story engineer | `[H]` | always |
| 4 | design | architect | `[H]` | always |
| 5 | development | developer | — | always |
| 6 | unit tests | unit test engineer | `[L]` | always |
| 7 | debugging | debug engineer | — | only if stage 6 surfaced a defect |
| 8 | code review | code reviewer | `[L]` | always |
| 9 | security | security reviewer | `[L]` | always |
| 10 | QA | QA engineer | `[L]` | always |
| 11 | test cases | test case engineer | — | always |
| 12 | documentation | tech writer | — | always |
| 13 | commit gate | — | `[H]` | always |
| 14 | monitoring | monitoring engineer | — | advisory — reports gaps, **never blocks** |

## The four hard stops at the front

Stages 1–4 are each `[H]`. Produce the artifact, end the message, wait. Four
separate human decisions, not one batched approval at the end. This is the
point of the pipeline: an initiative that is wrong at the requirements stage
costs nothing to correct there and a great deal to correct at stage 10.

## Stage 2 can end the pipeline

A verdict of **"Not Feasible as Scoped"** with **no approved alternative**
**stops the pipeline at stage 2.** Do not proceed to stage 3. Do not
soften the verdict to keep going.

If the report offers an alternative and a human approves it, the alternative
becomes the scope and the pipeline continues from stage 3 with the revised
scope restated.

The feasibility engineer must apply the architect's design-first rule when
reaching that verdict: a missing implementation is a missing capability, not
proof of infeasibility. "Not Feasible as Scoped" means the external world says
no — the Jira API has no such endpoint, the data was never captured — not that
this codebase does not do it yet.

## Stage 7 is conditional

It runs only when stage 6 surfaced a defect. When it runs, it runs in
**diagnose-and-fix mode** and produces a Fix Report with re-run evidence.

## Failure routing — different from the other two pipelines

```
unit tests [L] fail → debug engineer
code review [L] fail → debug engineer
security    [L] fail → debug engineer
QA          [L] fail → debug engineer
```

Failures route to the **debug engineer**, not the developer. At this scale the
question "why did this fail" is worth answering before anyone edits again.
Maximum 2 attempts per `[L]` stage, then escalate to a human.

If the debug engineer concludes the cause is the design, it escalates to the
architect (stage 4) rather than patching around it — and the pipeline re-enters
at stage 4's hard stop.

## Stage 14 is advisory

The monitoring engineer reports observability gaps. It **never blocks** and
never fails the pipeline. It runs after the commit gate because its subject is
what happens to the change in production, and its output is a follow-up list,
not a verdict.

Its scope is signals — what this app already logs and what it does not. It is
**not** deployment, release, CI or infrastructure work, which are out of scope
under global rule 4. It does not touch `monitoring/prometheus/*.yml`,
`docker-compose.yml`, or `deploy.sh`; it recommends, a human decides.

## Exit

Stage 13, then the advisory stage 14. See
[the README](../README.md#the-commit-gate).
