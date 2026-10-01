# QA Queue — Configuration Reference

Space: `TESTIN` (CloudFuze Board). Read directly from `custom_queues.queues[]` where `name = 'QA'` on 2026-09-16 — this is a snapshot of real data, not a spec.

## Summary

| | |
|---|---|
| Members | 11 |
| Statuses configured | 6 |
| Transitions configured | **0** |
| SLA policies | **0** |

## Statuses (`queueStatuses`, in configured order)

| Order | Name | Category | id |
|---|---|---|---|
| 0 | Open | todo | `qst_qa_open` |
| 1 | In Progress | in_progress | `qst_qa_inprogress` |
| 2 | Routed to Dev | in_progress | `qst_qa_waitingdev` |
| 3 | Routed to Infra | in_progress | `qst_qa_waitinginfra` |
| 4 | Routed to Migration | in_progress | `qst_qa_routedtomigration` |
| 5 | Resolved | done | `qst_qa_resolved` |

Note QA has no "Routed to Pre-sales" status, unlike Dev/Infra/Migration/Pre-Sales.

## Transitions — ⚠️ none configured

`queueTransitions` is empty for this queue. In practice this isn't as bad as it sounds: the status dropdown's own fallback rule ("if no transitions are defined from the current status, show every other status") means QA's dropdown ends up showing all 5 other statuses regardless — so this alone hasn't been observed to hide options the way Migration's partial config does (see `migration.md`). Still worth fixing for consistency with Dev's fully-explicit workflow, and so QA gets the same intentional guardrails (e.g. disallowing a direct Open → Resolved jump, if that's ever wanted) that Dev has.

## SLA — ⚠️ none configured

No SLA policy exists for this queue at all. Every ticket sitting in QA has `dept_sla_started_at` ticking but no `sla_definitions` row to compute a due time against — meaning **no SLA warning or breach will ever fire for a ticket currently in QA**, regardless of how long it sits there. This is a real, likely-unintentional gap.

## Known issues found (2026-09-16 session)

- **`originDepartment`/`canResolveHere` bug** (fixed, commit `218180b`): a QA-created subtask (CF-32998) had its earliest `department` history event point at "Dev" instead of QA, due to drifting there via an older bug before ever getting its first history row. The dropdown hid "Resolved" as a result. Fixed by trusting the `original_dept` column over history reconstruction — unrelated to this queue's own config, but worth knowing QA tickets were the ones that surfaced it.

## How this was generated

```sql
SELECT q.value->>'name', jsonb_array_length(q.value->'memberIds'), jsonb_array_length(q.value->'queueStatuses'),
       jsonb_array_length(q.value->'queueTransitions'), jsonb_array_length(q.value->'slaPolicies')
FROM custom_queues cq, jsonb_array_elements(cq.queues) q
WHERE cq.space_key='TESTIN' AND q.value->>'name'='QA';
```
