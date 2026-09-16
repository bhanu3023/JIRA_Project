# Migration Queue — Configuration Reference

Space: `TESTIN` (CloudFuze Board). Read directly from `custom_queues.queues[]` where `name = 'Migration'` on 2026-09-16 — this is a snapshot of real data, not a spec.

## Summary

| | |
|---|---|
| Members | 41 (largest roster of any queue) |
| Statuses configured | 6 |
| Transitions configured | **2** |
| SLA policies | **0** |

## Statuses (`queueStatuses`, in configured order)

| Order | Name | Category | id |
|---|---|---|---|
| 0 | Open | todo | `qst_migration_open` |
| 1 | In Progress | in_progress | (not captured this pass — see below) |
| 2 | Routed to Dev | in_progress | |
| 3 | Routed to Infra | in_progress | |
| 4 | Routed to QA | in_progress | |
| 5 | Resolved | done | `qst_migration_resolved` |

Note Migration has no "Routed to Pre-sales" status, unlike Infra/Pre-Sales.

## Transitions — ⚠️ only 2, and both are a real bug

The entire `queueTransitions` array is:

```json
[
  { "from": "qst_migration_resolved", "to": "qst_migration_open" },
  { "from": "qst_migration_resolved", "to": "qst_migration_waitingqa" }
]
```

**This is a real, live bug**, not just a gap. Every other status in Migration (Open, In Progress, Routed to Dev/Infra/QA) has zero transitions defined for it, so the dropdown's fallback rule kicks in and shows all other statuses — fine. But **Resolved is the one status that has SOME transitions defined**, which means its dropdown is constrained to exactly those two targets and does NOT get the "show everything" fallback. Reopening a resolved Migration ticket can currently only go to **Open** or **Routed to QA** — there is no direct path back to Routed to Dev, Routed to Infra, or In Progress from Resolved in this queue's own workflow.

Fix options (not yet applied, pending a decision on intended behavior):
- Add the missing `qst_migration_resolved → qst_dev/infra/inprogress` transitions to match Dev's fully-connected graph, **or**
- Remove these 2 partial transitions entirely so Resolved falls back to the same unconstrained "show all" behavior every other Migration status already has.

## SLA — ⚠️ none configured

Same gap as QA: no `slaPolicies` entry exists for Migration. No SLA warning or breach will ever fire for a ticket currently in Migration, despite Migration having the largest member roster (41) of any queue and being the most heavily-trafficked department by ticket volume this session.

## Known issues found (2026-09-16 session)

- The Resolved-transition gap above is newly discovered while building this doc — not yet fixed in code.
- Migration was the department most frequently involved in this session's subtask department-drift and cascade-reversal work (see `docs/queues-departments-sla-guide.md` §2 for the general handoff mechanism, and recent commit history for `cascadeDeptToChildren`).

## How this was generated

```sql
SELECT q.value->>'name', jsonb_array_length(q.value->'memberIds'), jsonb_array_length(q.value->'queueStatuses'),
       jsonb_array_length(q.value->'queueTransitions'), jsonb_array_length(q.value->'slaPolicies')
FROM custom_queues cq, jsonb_array_elements(cq.queues) q
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Migration';

SELECT jsonb_pretty(q.value -> 'queueTransitions') FROM custom_queues cq,
  jsonb_array_elements(cq.queues) q WHERE cq.space_key='TESTIN' AND q.value->>'name'='Migration';
```

*Statuses 1–4's `id` values weren't individually captured in this pass (only names/categories were queried) — re-run the `queueStatuses` query from `dev.md`, swapping the queue name, to fill those in.*
