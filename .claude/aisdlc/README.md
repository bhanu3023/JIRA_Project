# AI-SDLC framework — Neutara Ticketing

A staged workflow for changing this codebase, with human decision points that an agent cannot skip and guardrails it cannot talk past.

Read this file and you can use the framework. The role files are reference, not prerequisites.

---

## Layout

```
CLAUDE.md                        mode routing, global rules, repo conventions
.claude/
  settings.json                  hook registration
  hooks/
    commit-gate.mjs              PreToolUse  · Bash            — blocks git commit/push
    secret-scan.mjs              PreToolUse  · Write|Edit|Bash — blocks new credentials
    log-convention.mjs           PostToolUse · Write|Edit|Bash — warns on debug prints
    approve-commit.mjs           records a commit-gate approval (the only way to unblock)
    secret-scan-allowlist.json   narrow, dated, documented exceptions
    lib/                         hook-io.mjs · secret-patterns.mjs · approval.mjs
  aisdlc/
    README.md                    this file
    SECURITY-FOLLOWUPS.md        known risks carried by the repo
    pipelines/                   bug-fix.md · new-feature.md · complete-sdlc.md
    roles/                       13 role definitions
    diagnostics/                 reusable investigation scripts (never the repo root)
    scratchpad/                  throwaway probes, never committed
    state/                       commit-approval artifacts (gitignored)
```

---

## Choosing a pipeline

First decide **Direct** or **SDLC**:

```
Direct mode → typos, docs, formatting, single-file cosmetic, pure questions,
              one-line fixes
SDLC mode   → features, multi-file bug fixes, auth/authz, data model,
              external integrations, core product pipelines
```

Then, in SDLC mode:

| The request says | Pipeline |
|---|---|
| bug · broken · error · crash · regression | **bug-fix** |
| add · implement · new feature · support for | **new-feature** |
| "full sdlc" | **complete-sdlc** |
| ambiguous | **ASK** — never guess |

Overrides a human can give at any time: `use sdlc` · `quick fix` / `direct` · `full sdlc`.

**Every run states which mode it used and why**, in its first line.

In this repo, treat as SDLC regardless of wording: department routing, SLA, worked-on credit and MBR, auth and RBAC, Jira/email ingestion, and **anything that adds or changes a database column**.

---

## The pipelines at a glance

**bug-fix** — diagnosis → *design* `[H]` → implementation → unit tests `[L]` → code review `[L]` → *security* `[L]` → QA `[L]` → *documentation* → commit gate `[H]`

*Italic stages are conditional.* Stage 1 writes **no code**.

**new-feature** — design `[H]` → implementation → unit tests `[L]` → code review `[L]` → security `[L]` → QA `[L]` → documentation → commit gate `[H]`

**complete-sdlc** — requirements `[H]` → feasibility `[H]` → user stories `[H]` → design `[H]` → development → unit tests `[L]` → *debugging* → code review `[L]` → security `[L]` → QA `[L]` → test cases → documentation → commit gate `[H]` → monitoring (advisory)

A **"Not Feasible as Scoped"** verdict at stage 2 with no approved alternative **stops the pipeline there.**

Review order is **code → security → QA** in all three. It never varies.

---

## Gate semantics

| | Meaning |
|---|---|
| `[H]` | **Hard stop.** Produce the artifact, end the message, wait for a human. Do not continue to the next stage in the same response. |
| `[L]` | **Gated loop.** On failure, route back with the specific finding and retry. **Maximum 2 attempts, then escalate to a human.** |
| *(none)* | Proceed when the artifact is complete. |

**The two-attempt cap is absolute.** Attempt 1 fails → route back → attempt 2. If attempt 2 fails, stop and tell a human what is stuck. There is no attempt 3, and "I'll just try one more thing" is the behaviour the cap exists to prevent.

**Where failures route:**

| Pipeline | Failed `[L]` goes to |
|---|---|
| bug-fix | developer |
| new-feature | developer |
| complete-sdlc | debug engineer |

If a reviewer's finding is that the **design** is wrong rather than the code, do not loop — escalate to the architect and say so.

---

## The roles

| Role | Produces |
|---|---|
| [requirement engineer](roles/requirement-engineer.md) | **Requirement Spec** — problem, stakeholders, in/out of scope, functional + non-functional requirements, trigger model, success/failure states, assumptions, open questions |
| [feasibility engineer](roles/feasibility-engineer.md) | **Feasibility Report** — verdict (Feasible / with Caveats / Not Feasible as Scoped), risks, API constraints, complexity S/M/L by layers touched, new-dependency flags, alternative |
| [user story engineer](roles/user-story-engineer.md) | **User Story Set** — As a / I want / so that, plus Given/When/Then criteria, priority, traceability |
| [architect](roles/architect.md) | **Design Doc** — Requirements Analysis · Capability Gap Analysis · Existing System Impact · Architecture · Backend Changes · Data Model Changes · API Spec · Integration Points · Component List · Security Considerations · Testing Strategy · Implementation Sequence |
| [developer](roles/developer.md) | the code + **Implementation Summary** — files changed, config property names, new error conditions and status mapping, deviations with justification |
| [unit test engineer](roles/unit-test-engineer.md) | **Unit Test Report** — tests added, coverage per method, uncovered branches with justification, real test-command output |
| [debug engineer](roles/debug-engineer.md) | **Root-Cause Report** (diagnosis mode, no code) or **Fix Report** (diagnose-and-fix, with re-run evidence) |
| [code reviewer](roles/code-reviewer.md) | **Verdict** — Approve / Approve with Comments / Request Changes, every comment with a file reference |
| [security reviewer](roles/security-reviewer.md) | **Findings** graded Critical / High / Medium / Low, plus verdict Clear or Blocked |
| [QA engineer](roles/qa-engineer.md) | **QA Report** — defects, severity, repro steps, pass/fail table from real assertions |
| [test case engineer](roles/test-case-engineer.md) | **Test Case Suite** — ID, category, preconditions, steps, data, expected result, traceability |
| [tech writer](roles/tech-writer.md) | **Documentation Summary** — files updated, and files deliberately untouched with the reason |
| [monitoring engineer](roles/monitoring-engineer.md) | **Observability Checklist** — existing signals, success vs. failure, gaps, follow-ups (advisory only) |

### The four rules that matter most

- **Architect, design-first.** The repo is the foundation, not the ceiling. Ask "how can this be extended?" before "does this already exist?" A missing implementation is a missing capability, not proof of infeasibility. Distinguish "not supported yet" (design the extension) from "the API has no such endpoint" (may genuinely be infeasible). **Never conclude infeasible from class names.**
- **Unit test + QA.** Assertions are mandatory. A case with no real assertion is marked **"not verified"**, never "pass". Report actual command output, never a narrative claim. Never modify production code to make a test pass.
- **Debug engineer.** Reproduce before changing. Fix the cause, not the symptom. Never swallow an exception or weaken an assertion. If the cause needs a design change, escalate to the architect instead of patching around the design.
- **Developer.** Implement the approved design exactly. Mirror the nearest existing sibling file. No redesign, no scope creep, no new dependency without flagging it for approval.

---

## Response format

One role per response, opening with:

```
=== STAGE <n>: <name> — acting as <role> ===
```

and each stage restating:

```
Pipeline: <name>
Stage n of N
Consuming: <artifact>
Attempt: n of 2
```

---

## The commit gate

Identical in all three pipelines, and a hard stop every time.

```
1. "Would you like me to commit and push these changes?"   No → stop entirely.
2. "Which branch? — current / existing / new"
3. Only then commit, referencing the ticket ID.
```

**Never auto-commit. Never assume a branch. Never ask about deployment.**

Ask question 1, wait for a real answer. Ask question 2, wait. Only then record the approval:

```bash
node .claude/hooks/approve-commit.mjs --ticket CF-29982 --branch aisdlc-a --confirmed
```

- Ticket must be board-prefixed (`CF-29982`, `L2B-15838`, `L3B-782`) — **or `NONE`** for work genuinely unrelated to a ticket.
- The ticket id must appear **somewhere** in the commit message. Position is not constrained; this repo writes them inline.
- The approval lasts **30 minutes**, **4 uses**, and only on **the branch it names**.
- `--allow-default-branch` and `--allow-force-push` exist, and are only for a human's explicit request.
- `--revoke` clears it.

Without a valid approval, `git commit` and `git push` are blocked by the hook, not by a rule someone might forget.

---

## The guardrails

| Guard | Fires on | Action |
|---|---|---|
| **commit gate** | before `git commit` / `git push` | blocks unless approved in this run |
| **secret scan** | before any write, edit, or Bash command | blocks a newly introduced key, token, password, or connection string |
| **log convention** | after any write, edit, or Bash command | warns on a debug print added to production source |

**The secret scan is diff-aware, deliberately.** This repo already carries ~25 `process.env.X || '<literal>'` fallbacks. A guard that blocked all of them would fire on unrelated work and be switched off within a day. So it compares what a call *adds* against what it *removes* (Edit) or against the file on disk (Write):

- new value, not present before → **blocked**, "newly introduced"
- same insecure pattern, but the line is being rewritten → **blocked**, "you are editing an existing insecure fallback — fix it now"
- byte-identical and untouched → **allowed** (pre-existing, not this change's problem)

Verified against every tracked source file in the repo: **zero false positives.**

**All three guards also match `Bash`,** because sessions here are instructed to edit with `sed` and heredocs, which never fire a `Write|Edit` matcher.

**Exceptions** go in `.claude/hooks/secret-scan-allowlist.json`, keyed by path + rule id, each with a reason and an expiry date. They contain no credential values. An expired entry stops suppressing and the guard blocks again — an exception is a dated promise, not a permanent hole.

### What the hooks do and do not guarantee

Stated plainly, because the value of a guardrail depends on knowing its edge.

**They do** stop the ordinary failure — the model that forgot the rule, drifted over a long session, or was steered past it. Committing is impossible by default; approval is a separate, explicit, logged act naming a branch and a ticket, capped at 30 minutes and 4 uses.

**They do not** stop a model that decides to fabricate an approval, since `approve-commit.mjs` is run by the agent and cannot prove a human spoke. For a guarantee at that level you need a real git `pre-commit` hook, or server-side branch protection. Both are compatible with this framework; neither is installed here, and `.git/hooks` currently holds only `*.sample` files.

---

## Diagnostics

Reusable investigation scripts go in [diagnostics/](diagnostics/) — **never the repository root**, which already carries ~250 one-off `check-*.mjs` / `fix-*.mjs` / `audit-*.mjs` files. Throwaway probes stay in the session scratchpad and are never committed. A diagnostic reads by default; any write needs an explicit human decision, an explicit key allowlist, and a stated undo.

---

## Out of scope, always

Deployment, release, CI and infrastructure. Every run says so explicitly (global rule 4). `deploy.sh`, `docker-compose.yml`, `Dockerfile` and `monitoring/` are not this framework's to change.
