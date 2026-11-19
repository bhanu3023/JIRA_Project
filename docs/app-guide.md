# Neutara Ticketing — how the app works

This guide is for anyone in the company: support, migration, dev, QA, infra, pre-sales and managers. It explains the app in plain terms. The Claude connector serves it as the "overview" topic; the other topics (`queues-and-sla-internals`, `queue-dev`, …) go into more detail.

> The per-queue files (`queue-*`) are snapshots taken on a past date. A queue's members, statuses and SLA goals can change in Settings since then. For live numbers, look at a real ticket (`get_ticket`) or the SLA policies in the space settings.

## 1. The basics

| Term | Meaning |
|---|---|
| **Ticket** | One request or issue. Its key looks like `CF-35038`; older tickets may also have a space key such as `L2B-12718`. |
| **Space** | A board or project, for example the CloudFuze Board (`TESTIN`). People only see tickets in spaces they're a member of, plus tickets they reported or are assigned to. |
| **Department / queue** | The team that currently owns the ticket: Dev, Migration, QA, Infra, Pre-Sales and so on. A ticket sits in exactly one department at a time (`current department`). |
| **Status** | Each department has its own statuses, e.g. Dev: Open → In Progress → Routed to Migration/QA/Infra/Pre-sales → Resolved. |
| **Assignee** | The person working on the ticket in its current department. |
| **Priority** | Highest, High, Medium, Low or Lowest. It sets the SLA goal. |
| **Work type / ticket type** | The kind of work, e.g. Bug, Task, or one of the Pre-Sales work types. |

## 2. Moving a ticket between departments (handoffs)

- To hand a ticket on, change its department, or pick a "Routed to …" status. For example, Dev picks "Routed to Migration".
- On a handoff:
  1. The old department's SLA clock **pauses** and the new department's clock **starts or resumes**.
  2. The new department gets an assignee. If someone in that department handled this ticket before, they get it back. Otherwise the department's **round robin** picks the next person on shift; product-type rules can send certain tickets straight to a specialist.
  3. The new department starts at "Open" on a first visit, or at "In Progress" when the ticket comes back.
  4. History records the department change, the assignee change and the SLA events.
- Only the department that currently owns a ticket (or an admin) can move it. Other departments can still view it and comment on it.
- The **Sent / Watching** and **Worked on** lists show tickets a person or department handled earlier. Times on those lists are frozen at the moment the ticket left.

## 3. SLA — how the clock works

- SLA policies are set per space, and usually per department (in practice mainly Dev). A policy gives a goal for each priority, for example Dev "Time to Resolution": Highest 6h, High 8h, Medium 24h, Low 48h.
- **Each department has its own clock.** Time is counted only while the ticket sits in that department, and repeat visits add up.
- **Paused**: if the ticket's status is one of the policy's pause statuses (for example "Waiting for customer"), the clock stops and the ticket cannot breach while paused. It also stops when the ticket leaves the department.
- **Breached**: the department's time spent went past its goal while the department owned the ticket. The monitor checks every 30 seconds, warns about 30 minutes before a breach, and writes "SLA breached — <Dept>" in History when it happens.
- **Resolved**: when a ticket is resolved, its SLA is frozen. The SLA panel then shows, for each department, time spent against goal and on time or breached, plus who resolved it.
- **Reopened**: reopening hands the ticket back to a department, and that department's clock resumes from where it stopped. A ticket that's resolved more than once shows one result per resolution in History, and a red badge only on the resolutions that actually breached.
- Why a ticket can show **no SLA at all**: its department or priority has no SLA policy (for example, a queue without a policy, or a priority whose goal is set to 0h), or its clock was never started because there was no handoff.

## 4. Worklogs

- **Time on tickets**: people log time against a ticket (Log work). The Worklog page totals it per person and date range, and it can be downloaded to Excel. The cross-team report is limited to admins and people granted worklog access.
- **Ticket Worklog tab (daily activities)**: everyone logs non-ticket work here, such as meetings, automation, KB writing, client calls, hand-offs or project work like "Worked on Mantec project". There's one activity list for Migration and a separate one for Dev. Entries are filed under the queue picked when logging, and this tab can also be downloaded to Excel.

## 5. Knowledge base (KB)

- Articles are visible either to the whole organization or only to specific teams (queues). Release notes are a separate kind of article.
- Lifecycle: draft → submitted for approval (pending) → published. The author's manager, or an admin, approves.
- The KB list can be filtered by author and by date range.

## 6. Filters, dashboards and reports

- **Filters**: search tickets by text, space, status, department, assignee, reporter, priority, created/updated/resolved dates, SLA breached, overdue, customer and product type. Filters can be saved.
- **Dashboards**: "Assigned to me", "Worked on", and the department queue boards with their own counts.
- **Reports** (managers/admins): resolution SLA, team analytics, MBR (if granted), and dept-queue summaries.

## 7. Using Claude with the app (read-only connector)

- In Claude Desktop, connect the **Neutara Ticketing** connector and sign in with Microsoft. Claude can then answer questions using exactly what **you** can see in the app.
- Claude can only **read**. It cannot create, edit, assign, comment on or resolve tickets; do those in the app.
- Example questions:
  - "What's the status of CF-35038 and why did it breach SLA?"
  - "Which tickets were assigned to each person in Dev after 2 pm today?"
  - "Show high-priority Dev tickets created this week that are still open."
  - "How many hours did I log last week, by activity?"
  - "Is there a KB article about OneDrive permission errors?"
  - "How does SLA pause work?"
- To disconnect, go to Settings → API tokens → Claude connections. Your connection also stops working if your account is deactivated.
