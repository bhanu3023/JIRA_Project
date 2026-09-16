# Per-Queue Configuration Reference

Split out from the single combined guide (`../queues-departments-sla-guide.md`) because that document only covers system-wide *mechanisms* (how a handoff works, how SLA math works) — it says nothing about how individual queues are actually configured, and the queues have drifted far apart from each other. One file per active queue, each a snapshot of real `custom_queues` data as of 2026-09-16:

| Queue | Members | Statuses | Transitions | SLA policy | Notable gap |
|---|---|---|---|---|---|
| [Dev](./dev.md) | 37 | 7 | 51 | ✅ 1 | none — reference queue |
| [Infra](./infra.md) | 14 | 7 | 36 | ❌ 0 | no SLA coverage |
| [Migration](./migration.md) | 41 | 6 | **2** | ❌ 0 | Resolved can only reopen to Open/QA, not Dev/Infra/In Progress; no SLA coverage |
| [Pre-Sales](./pre-sales.md) | 3 | 7 | 36 | ❌ 0 | no SLA coverage |
| [QA](./qa.md) | 11 | 6 | **0** | ❌ 0 | no explicit transitions (falls back to unconstrained, so lower-impact than Migration's gap); no SLA coverage |

## Not documented individually (empty/unused queue entries)

These exist as queue rows in `custom_queues` but have 0 members, 0 statuses, 0 transitions, and 0 SLA policies — they don't appear to be actively used department queues, more likely leftover/placeholder entries:

- CloudFuze-Manage-Board (2 members, otherwise empty)
- Content-Migration-Backlog
- Email-Migration-Backlog
- Message-Migration-Backlog
- SalesOps

Worth confirming with whoever set these up whether they're intentionally dormant or should be either configured properly or removed.

## The headline finding

**Only Dev has anything close to a complete workflow.** Infra and Pre-Sales are reasonably close (36 transitions each). Migration and QA are severely under-configured relative to their actual usage — Migration in particular has the *largest* member roster (41) of any queue but only 2 transitions, both of which create a real bug (see `migration.md`). **No queue except Dev has an SLA policy at all**, meaning SLA warnings/breaches currently only ever fire for Dev tickets.

## Keeping this current

Queue config lives in `custom_queues.queues[]` (one JSON blob per space, one array entry per queue) — there's no schema/migration history for it, so these files will go stale the moment someone edits a queue's statuses/transitions/SLA in Settings. Re-run each file's "How this was generated" SQL to refresh, or regenerate all five with the summary query in this README's own table.
