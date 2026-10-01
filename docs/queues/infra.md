# Infra Queue — Configuration Reference

Space: `TESTIN` (CloudFuze Board). Read directly from `custom_queues.queues[]` where `name = 'Infra'` on 2026-09-16 — this is a snapshot of real data, not a spec.

## Summary

| | |
|---|---|
| Members | 14 |
| Statuses configured | 7 |
| Transitions configured | 36 |
| SLA policies | **0** |

## Statuses (`queueStatuses`, in configured order)

| Order | Name | Category |
|---|---|---|
| 0 | Open | todo |
| 1 | In Progress | in_progress |
| 2 | Routed to QA | in_progress |
| 3 | Routed to Dev | in_progress |
| 4 | Routed to Migration | in_progress |
| 5 | Routed to Pre-sales | in_progress |
| 6 | Resolved | done |

## Transitions

36 transitions — a solid, well-connected graph (roughly matching Pre-Sales' own 36), though not as exhaustive as Dev's 51. Not individually enumerated in this pass; re-run the query below if a specific transition gap needs checking (e.g. if a particular status pair turns out to be missing, the way Migration's Resolved status was).

## SLA — ⚠️ none configured

No `slaPolicies` entry exists for Infra. Same gap as Migration and QA: tickets sitting in Infra never get an SLA warning or breach notification, regardless of how long they sit there.

## Known issues found (2026-09-16 session)

None specific to Infra's own transition/status config — worth a deeper transition-gap check (see `migration.md` for the kind of issue to look for) since it hasn't been individually verified the way Migration's Resolved-only gap was found.

## How this was generated

```sql
SELECT q.value->>'name', jsonb_array_length(q.value->'memberIds'), jsonb_array_length(q.value->'queueStatuses'),
       jsonb_array_length(q.value->'queueTransitions'), jsonb_array_length(q.value->'slaPolicies')
FROM custom_queues cq, jsonb_array_elements(cq.queues) q
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Infra';

-- To check for a Migration-style partial-transition gap:
SELECT t->>'from' AS from_status, jsonb_agg(t->>'to') AS can_go_to
FROM custom_queues cq, jsonb_array_elements(cq.queues) q, jsonb_array_elements(q.value->'queueTransitions') t
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Infra' GROUP BY t->>'from';
```
