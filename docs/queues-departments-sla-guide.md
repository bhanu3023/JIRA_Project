# Neutara Ticketing — Queues, Department Handoffs & SLA Guide

This document explains, based on the actual production code (`src/lib/jira-pg-api.ts`, `src/lib/rr-service.ts`, and related pages), how three of the most important — and most complained-about — parts of the system actually work: **custom queues**, **department transfers**, and **SLA tracking**. It also calls out a few gaps worth knowing about for best practices.

Nothing in this document changes any code — it's a description of current behavior only.

This document covers how the *mechanisms* work system-wide (handoffs, round robin, SLA math). For how each individual queue (Dev, Infra, Migration, Pre-Sales, QA) is actually *configured* — its own statuses, workflow transitions, SLA policy, and known per-queue gaps — see [`docs/queues/`](./queues/README.md). The two are split because the queues have drifted far apart from each other in practice (e.g. only Dev has an SLA policy at all, and Migration has only 2 of the ~36-51 transitions the other fully-configured queues have).

---

## 1. Spaces, Boards, and Queues — the vocabulary

| Term | What it means in this app |
|---|---|
| **Space** | A "board" — one project (`spaces` table). Has a `type`: `scrum`, `kanban`, or `service_desk`. |
| **Dept Queue board** | A space whose *type is stored/treated as* `dept_queue` — the only kind of space that can have **Custom Queues**. Plain `scrum`/`kanban`/`service_desk` boards never have custom queues. |
| **Custom Queue** | A named sub-group *inside* a dept_queue space (e.g. "Migration", "Dev", "Billing"), stored in the `custom_queues` table as one JSON blob per space (`custom_queues.queues`, a JSON array). Each queue entry has: `id`, `name`, `memberIds` (who can see/work it), `queueStatuses` (its own status list), and optional round-robin/product-type config. |
| **Department (dept)** | The *current owner* of a ticket, tracked per-issue in `issues.current_department`. A department is really just "which Custom Queue currently has this ticket." |

**Access control:** `GET /custom-queues/:spaceKey` filters the queue list server-side — a regular member only ever receives the queues whose `memberIds` include them; admins/managers get everything. This was tightened specifically so a restricted user's browser can't even see (or call the API for) queues they don't belong to.

---

## 2. How a ticket moves between departments (the handoff flow)

This is triggered by `PATCH /issues/:key/department`, which the ticket page's Department field calls whenever someone changes the department dropdown. For a normal (single-board) handoff, here's the exact sequence:

1. **Authorization check** — only the department that *currently* owns the ticket (via `current_department`) may move it, unless you're an admin. Someone just *watching* it via Sent/Watching cannot transfer it.
2. **Figure out the old department** (`oldDept`) — usually just the ticket's current `current_department`.
3. **Save the outgoing assignee** into `dept_assignees[oldDept]` — a per-department JSONB map on the issue (`issues.dept_assignees`) that remembers *who* was handling the ticket the last time it sat in each department.
4. **Decide the new assignee** for the target department, in this priority order:
   - **If `dept_assignees[newDept]` already has someone** (this dept has handled this exact ticket before) → **restore that same person.** This is what makes a Queue1 → Queue2 → Queue1 → Queue2 bounce land back on the same Queue2 person instead of a fresh round-robin pick.
   - **Otherwise → round robin** via `getNextAgent()` (see §3 below), and remember the pick in `dept_assignees[newDept]` for next time.
5. **Decide the new status:**
   - First time this ticket has ever been in `newDept` → an "Open"/To-do status from that queue's own `queueStatuses`.
   - Ticket has been in `newDept` before (returning) → an "In Progress" status instead — it's treated as resumed work, not a fresh arrival.
   - The *old* department's status is snapshotted into `dept_statuses[oldDept]` exactly as it was right before the move, so Sent/Watching can later show "what it was at when it left," not a generic "Waiting for X" placeholder.
6. **SLA**: `pauseDeptSLA(oldDept)` then `startDeptSLA(newDept)` — see §4.
7. **Bookkeeping** (fire-and-forget, doesn't block the response):
   - `issue_dept_transitions` gets a row (`from_dept` → `to_dept`) — this is the audit trail used elsewhere to reconstruct a ticket's department history.
   - `user_worked_on_tickets` gets an upsert for whoever *just handed it off* (`reason='passed'`), and for whoever it's *returning to* if that dept has a remembered assignee (`reason='returned'`). This is the data behind the "Worked On" tab.
   - Notifications fire: `DEPT_CHANGE` (to reporter), `ASSIGNED` (to the new assignee), `DEPT_ASSIGNED` (to the rest of the new department's members/leads), `SLA_PAUSED` (to the outgoing assignee), `SLA_RESUMED` (to the new assignee).
   - An `issueHistory` entry ("Transferred to X") and an outbound email to the reporter + new assignee.

**Multi-board mode**: if `targetBoard` names a *different* space than the ticket's current one, the code takes a separate branch (creates/links the ticket in the other board). That branch does **not** currently persist the same `dept_assignees` per-department memory — it's a genuinely different code path, worth knowing if you rely on "same person comes back" behavior across boards, not just within one.

### Best practice
- Don't rely on department names being unique across boards — `dept_assignees`/`dept_statuses` are keyed by the literal department name string, so "Migration" on Board A and "Migration" on Board B are two independent histories.
- The assignee-memory only works within the *same board*. If your workflow regularly passes tickets to another board and back, know that it currently resets to round robin there.

---

## 3. Round robin assignment (`src/lib/rr-service.ts`)

Each space has one `rr_config` row containing a list of departments, each with its own agent roster and rotation pointer. `getNextAgent(spaceId, departmentName, productType)` resolves like this, **in order**:

1. **Product-type rule** (deterministic override, doesn't touch rotation at all) — e.g. "any ticket whose productType mentions 'Email' always goes to Ankit," checked by substring match, case-insensitive, on either side.
2. **Active agents only** — an agent with `isActive: false` is skipped entirely.
3. **Shift filtering** — each agent can have a `shiftStart`/`shiftEnd` ("HH:MM", 24h, supports overnight windows like 22:00–06:00). Only agents currently inside their shift window are eligible.
   - **If nobody is currently on shift**, the filter is dropped entirely and it falls back to *all* active agents — tickets always get assigned to someone, they never queue up unassigned just because it's outside everyone's shift.
4. **Round-robin pointer** (`currentIndex`) — advances by 1 each time, wrapping within whichever pool (on-shift or fallback-to-all) was actually used that call.

### Best practice
- If a department queue has agents with staggered shifts, expect the "next agent" to depend on *when* the handoff happens, not just the rotation order — two identical tickets transferred five minutes apart, straddling a shift change, can land on different people even with the same `currentIndex`.
- Product-type rules bypass fairness entirely by design — if a specialist is getting overloaded, check `productTypeRules` before assuming the rotation is broken.

---

## 4. SLA tracking — how the clock actually works

There are **two different SLA calculations** in this app depending on whether you're looking at the ticket *right now* vs. looking at it from a department that no longer owns it (Sent/Watching). Mixing these up is the most common source of "the SLA looks wrong" confusion.

### 4a. Per-department elapsed time (`dept_sla_log`)

Every issue has `dept_sla_started_at` (when the clock most recently started) and `dept_sla_log` (a JSONB map, one entry per department, `{ started_at, elapsed_ms, paused_at, status: 'running'|'paused' }`).

- **`startDeptSLA(dept)`** — called when a ticket *arrives* in a department. Sets `status: 'running'`, `started_at: now`, keeps whatever `elapsed_ms` was already banked for that department from a previous visit.
- **`pauseDeptSLA(dept)`** — called when a ticket *leaves* a department. Adds `(now − started_at)` onto `elapsed_ms`, sets `status: 'paused'`.

So `elapsed_ms` for a department is a **running total across every visit**, not just the most recent one — if Queue2 has handled a ticket twice, its `elapsed_ms` is the sum of both stretches.

### 4b. Live SLA for the *current* owner (`computeIssueSLAsFromDb` / `computeSLAInstancesPure`)

Shown on the ticket detail page and in `/my-dashboard`'s SLA-status counts. For each active `sla_definitions` policy that applies to the space (and matches the ticket's current department, if the policy is dept-specific):

1. **Goal duration** comes from the policy's `goals`. A goal can be either a flat duration, or a **priority-grouped** duration (different hours for highest/high/medium/low/lowest priority) — first match wins.
2. **Due time** = `dept_sla_started_at + goalDuration`.
3. **Paused** if the ticket's *current status name* is in the policy's `pauseStatuses` list (e.g. "Waiting for Customer") — while paused, it can never be flagged breached, no matter how old the due time is.
4. **Breached** = not resolved, not paused, and due time is in the past.
5. **Resolved** tickets (status category `done`) are always `isCompleted`, never breached.

This is a **live** calculation — every time it's read, `dueTime` is compared against "now." It does **not** use the accumulated `elapsed_ms` from §4a at all; it only looks at the *current* `dept_sla_started_at`.

### 4c. Frozen/paused SLA for departments that no longer own it (`computePausedDeptSLA`, Sent/Watching)

When you're watching a ticket that has moved *out* of your department, the SLA shown is a **snapshot**, not a live countdown:

- Uses `dept_sla_log[dept].elapsed_ms` (the banked total from §4a) instead of comparing against "now."
- **Always `isBreached: false`** — by design. The reasoning in the code: the clock for that department is stopped (it no longer owns the ticket), so flagging it "BREACHED" would be judging a stopped clock as if it were still ticking — a false alarm for a department that isn't responsible anymore.
- `remainingMs = goalDuration − elapsed_ms` is still shown, so you can see how much of the SLA window that department actually used while it had the ticket.

### 4d. SLA breach *warnings* (30-minute heads-up)

**Updated 2026-09-16 — the paragraph below is now out of date; corrected here.** SLA warnings/breaches are handled by `runMonitorAgentScan()` in `src/lib/jira-pg-api.ts`, an in-process singleton `setInterval` registered at module load (guarded by `globalThis.__monitorAgentInterval` so it runs once per server process, not once per open browser tab). It runs immediately on server start, then **every 30 seconds** (shortened from an original 5 minutes, 2026-09-16). For each active issue within 30 minutes of breaching (or that just crossed its due time), it notifies the assignee, reporter, space leads, and admins — both an in-app `SLA_BREACH` notification (`notifyUsers`) and an email (`notifySLABreach` in `notification-service.ts`), deduped so the same ticket doesn't re-notify within an hour. It also logs an `issueHistory` "SLA breached" entry the moment a ticket crosses its due time.

~~`POST /sla-breach-check` scans every non-done issue with an SLA clock running... nothing in the current codebase actually calls `/sla-breach-check` on a schedule...~~ — this was accurate when written (Aug 2026) but the scheduling gap it describes has since been closed by `runMonitorAgentScan`, a different, newer mechanism that supersedes the old unscheduled endpoint. If `/sla-breach-check` still exists in the codebase, treat it as a legacy/manual-trigger path, not the real scheduling mechanism.

**Per-queue caveat (see `docs/queues/README.md`):** this scan only ever finds something to notify about if the ticket's space has an `sla_definitions` row that applies to it. As of 2026-09-16, only the **Dev** queue has an active SLA policy configured — Infra, Migration, Pre-Sales, and QA have none, so tickets sitting in those queues will never trigger an SLA warning or breach no matter how long they sit, regardless of this scan running correctly.

### Best practice
- If a ticket's SLA looks "stuck," check whether its current status is in that policy's `pauseStatuses` before assuming it's a bug — a paused SLA intentionally never breaches.
- Sent/Watching SLA badges are historical, not live — don't expect them to count down; they reflect time already spent, frozen at the moment the ticket left.
- SLA policies are per-space and optionally per-department (`dept_name`) — a dept-specific policy always wins over a space-wide one for tickets in that department.

---

## 5. Notifications tied to all of the above

`notifyUsers()` checks each recipient's `NotificationPreference` row before sending, via a type → preference-field map:

| Notification type | Preference field it respects | Fires when |
|---|---|---|
| `DEPT_CHANGE` | `onUpdated`* (unmapped → defaults to always-on) | Ticket transferred, sent to the reporter |
| `ASSIGNED` | `onAssigned` | New assignee picked (round robin or restored) |
| `DEPT_ASSIGNED` | `onAssigned`* (unmapped → always-on) | Ticket arrives in a department, sent to its other members/leads |
| `SLA_PAUSED` | `onAssigned` | Outgoing assignee's clock stops |
| `SLA_RESUMED` | `onAssigned` | New assignee's clock starts |
| `SLA_BREACH` | `onAssigned` | Within 30 min of breach (see §4d's scheduling caveat) |
| `DUPLICATE_ALERT` | `onCreated` | New ticket looks similar to a previously-resolved one |
| `COMMENTED` / `STATUS_CHANGED` / `MENTIONED` / `WATCHED` / `CREATED` / `UPDATED` | matching field | Standard ticket activity |

\* Any type not in the map defaults to **always notify** — there's no way for a user to silence it from their preferences today.

---

## 6. "Worked On" — how it's actually tracked

`user_worked_on_tickets (user_id, issue_id, dept, reason, worked_at)`, unique per `(user_id, issue_id, dept)`, so a repeat handoff just updates `worked_at` and `reason` rather than creating duplicate rows.

- `reason='passed'` — recorded for whoever was assignee in a department right as it hands off to the next one.
- `reason='returned'` — recorded for whoever the ticket comes back to, if that department has a remembered assignee.
- `reason='closed'` — recorded when the ticket is actually closed (separate code path from the handoff endpoint).
- The **Recall** feature (forcing a ticket back to Migration) deliberately **deletes** `reason='passed'` rows for that user/issue — it's treated as undoing the handoff, not as new work-history.
- `GET /worked-on` supports a `dept` query filter (`?dept=Migration`), so "Worked On" can be filtered to just what a user did in one specific queue.

### Best practice
- A ticket only shows up in someone's Worked On list if they were the *assignee* at the moment of handoff/return/close — someone who commented or watched but was never assigned won't appear there.

---

## 7. Quick reference — where things live in the code

| Concept | File | Key symbols |
|---|---|---|
| Custom queues CRUD | `src/lib/jira-pg-api.ts` | `custom-queues/:spaceKey` route, `custom_queues` table |
| Department handoff | `src/lib/jira-pg-api.ts` | `PATCH /issues/:key/department`, `dept_assignees`, `dept_statuses` |
| Round robin | `src/lib/rr-service.ts` | `getNextAgent`, `isWithinShift`, `rr_config` |
| SLA definitions (admin config) | `src/app/spaces/[spaceKey]/settings/page.tsx` | `goals`, `priorityRows`, `pauseStatuses` |
| SLA live computation | `src/lib/jira-pg-api.ts` | `computeIssueSLAsFromDb`, `computeSLAInstancesPure` |
| SLA paused/frozen computation | `src/lib/jira-pg-api.ts` | `computePausedDeptSLA` |
| SLA elapsed-time bookkeeping | `src/lib/jira-pg-api.ts` | `pauseDeptSLA`, `startDeptSLA`, `dept_sla_log` |
| SLA breach warnings | `src/lib/jira-pg-api.ts` | `POST /sla-breach-check` (not currently scheduled — see §4d) |
| Worked On | `src/lib/jira-pg-api.ts` | `GET /worked-on`, `user_worked_on_tickets` |
| Notification preferences | `src/lib/jira-pg-api.ts` | `userWantsNotif`, `notifyUsers` |

---

*Generated from a direct read of the production codebase — no source code was modified to produce this document.*
