# Dev Queue — Configuration Reference

Space: `TESTIN` (CloudFuze Board). Read directly from `custom_queues.queues[]` where `name = 'Dev'` on 2026-09-16 — this is a snapshot of real data, not a spec; re-run the queries in the "How this was generated" section below if it's been a while and something looks off.

## Summary

| | |
|---|---|
| Members | 37 |
| Statuses configured | 7 |
| Transitions configured | 51 |
| SLA policies | 1 ("Time to Resolution") |

This is the **most completely configured queue** in the system — every other queue's transition count should be compared against Dev's 51 as the reference for what "fully wired" looks like.

## Statuses (`queueStatuses`, in configured order)

| Order | Name | Category | id |
|---|---|---|---|
| 0 | Open | todo | `qst_dev_open` |
| 1 | In Progress | in_progress | `qst_dev_inprogress` |
| 2 | Routed to Migration | in_progress | `qst_dev_waitingmigration` |
| 3 | Routed to QA | in_progress | `qst_dev_waitingqa` |
| 4 | Routed to Infra | in_progress | `qst_dev_waitinginfra` |
| 5 | Routed to Pre-sales | in_progress | `qst_dev_waitingpresales` |
| 6 | Resolved | done | `qst_dev_resolved` |

## Transitions

51 transitions defined — effectively a near-complete graph between all 7 statuses (every status can reach almost every other status directly, including a `Resolved → In Progress` reopen path). This is why Dev's status dropdown never falls back to the "show all other statuses" unconstrained default — it's always working from real, explicit workflow rules.

## SLA

One active policy, "Time to Resolution":

| Priority | Goal |
|---|---|
| Highest | 6h |
| High | 8h |
| Medium | 24h |
| Low | 48h |
| Lowest | 48h |

- `stopCondition`: `Status = Resolved OR Status = Closed`
- `pauseCondition`: `Status = Waiting for customer`

## Known issues found (2026-09-16 session)

None specific to Dev's own configuration — Dev is the reference queue every other queue's gaps were measured against.

## How this was generated

```sql
SELECT q.value->>'name', jsonb_array_length(q.value->'memberIds'), jsonb_array_length(q.value->'queueStatuses'),
       jsonb_array_length(q.value->'queueTransitions'), jsonb_array_length(q.value->'slaPolicies')
FROM custom_queues cq, jsonb_array_elements(cq.queues) q
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Dev';

SELECT s->>'name', s->>'category', s->>'id' FROM custom_queues cq,
  jsonb_array_elements(cq.queues) q, jsonb_array_elements(q.value->'queueStatuses') s
WHERE cq.space_key='TESTIN' AND q.value->>'name'='Dev' ORDER BY (s->>'order')::int;
```
