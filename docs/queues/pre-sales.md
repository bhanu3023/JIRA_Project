# Pre-Sales Queue — Configuration Reference

Space: `TESTIN` (CloudFuze Board). Read directly from `custom_queues.queues[]` where `name = 'Pre-Sales'` on 2026-09-16 — this is a snapshot of real data, not a spec.

## Summary

| | |
|---|---|
| Members | 3 (smallest active roster) |
| Statuses configured | 7 |
| Transitions configured | 36 |
| SLA policies | **0** |

## Statuses (`queueStatuses`, in configured order)

| Order | Name | Category |
|---|---|---|
| 0 | Open | todo |
| 1 | In Progress | in_progress |
| 2 | Routed to Dev | in_progress |
| 3 | Routed to Migration | in_progress |
| 4 | Routed to QA | in_progress |
| 5 | Routed to Infra | in_progress |
| 6 | Resolved | done |

## Transitions

36 transitions, same count as Infra — not individually enumerated in this pass.

## SLA — ⚠️ none configured

Same gap as Infra/Migration/QA: no SLA policy for this queue. With only 3 members, this may be lower-priority to fix than Migration's gap (41 members, high volume), but worth flagging in the same pass if SLA coverage gets added queue-by-queue.

## Known issues found (2026-09-16 session)

None specific to this queue's own configuration.

## How this was generated

```sql
SELECT q.value->>'name', jsonb_array_length(q.value->'memberIds'), jsonb_array_length(q.value->'queueStatuses'),
       jsonb_array_length(q.value->'queueTransitions'), jsonb_array_length(q.value->'slaPolicies')
FROM custom_queues cq, jsonb_array_elements(cq.queues) q
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Pre-Sales';
```
