# Jira Clone — Implementation Notes
> Last updated: 2026-09-19

---

## 1. @ Mention in Comments (RichTextEditor)

**File:** `src/components/ui/RichTextEditor.tsx`

- Uses `contentEditable` div, NOT `<textarea>`
- `checkMention()` — detects `@query` at cursor using `window.getSelection().getRangeAt(0)`
- Saves the `@query` Range in `mentionRangeRef` to replace on insert
- Dropdown uses `position: fixed` (viewport coords) so it is never clipped by parent overflow
- Position recalculates on scroll via `window.addEventListener('scroll', updatePos, true)` (capture mode)
- Dropdown style: exact Jira match — white bg, `#F4F5F7` hover, 36px avatar, name only, box-shadow `0 4px 8px -2px rgba(9,30,66,0.25)`
- Inserted mention chip: `color:#0052CC; background:#DEEBFF`
- `members` prop passed from issue page as `allMembers` (from `spaceMembers`)

**Issue page:** `src/app/issues/[issueKey]/page.tsx`
- `allMembers = spaceMembers.map((m: any) => m.user || m)`
- Both RichTextEditor instances (new comment + edit comment) receive `members={allMembers}`

---

## 2. Email-to-Ticket (All Boards)

### Architecture
- **IMAP polling** via `imapflow` — one poller per board inbox
- **Per-board config** stored in PostgreSQL `email_configs` table (survives restarts)
- **Auto-reconnect** on every app load via `RootLayoutClient` → `POST /api/email/reconnect`

### Key files
| File | Purpose |
|------|---------|
| `src/lib/email-service.ts` | IMAP poller, SMTP sender, email body parsing |
| `src/app/api/email/connect/route.ts` | Connect inbox → starts poller + saves to DB |
| `src/app/api/email/reconnect/route.ts` | On startup: restarts all pollers from DB |
| `src/app/api/email/receive/route.ts` | Webhook: converts email → ticket |

### DB table: `email_configs`
```sql
CREATE TABLE IF NOT EXISTS email_configs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  space_key       TEXT NOT NULL,
  address         TEXT NOT NULL,
  imap_host       TEXT NOT NULL DEFAULT 'outlook.office365.com',
  imap_port       INT  NOT NULL DEFAULT 993,
  smtp_host       TEXT NOT NULL DEFAULT 'smtp.office365.com',
  smtp_port       INT  NOT NULL DEFAULT 587,
  password_enc    TEXT,
  auto_reply      BOOLEAN DEFAULT true,
  auto_reply_text TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(space_key, address)
);
```

### Setup for a new board
1. Go to **Board → Settings → Email**
2. Click **Connect Microsoft / Outlook** (OAuth)
3. Authenticate once — config saved to DB permanently
4. Emails to that inbox create tickets in that board automatically

### How board is determined from incoming email
1. `getEmailAddressSpaceKey(toAddress)` — in-memory mock store
2. `email_configs` DB lookup by `LOWER(address) = toAddress`
3. Derive from email prefix: `sales@domain.com` → `SALES` board

---

## 3. Email Body Parsing (Description Quality)

**File:** `src/lib/email-service.ts`

- Prefers **plain text** as base (avoids Outlook reading pane junk in HTML)
- `mergeLinksIntoPlainText(plain, html)` — extracts named `<a href>` links from HTML, injects into plain text
- Auto-links raw URLs with regex `/(https?:\/\/[^\s<>"')\]]+)/gi`
- Handles Outlook plain-text link format: `"Link text <https://url>"`
- `sanitizeEmailHtml()` — strips Outlook conditional comments, namespace tags, reading pane divs, `on*` events

**File:** `src/app/api/email/receive/route.ts`
- `cleanMimeBody()` — strips raw MIME headers/base64, extracts inline images as `data:` URLs
- Ticket number uses `spaceId` query (not key prefix) to get correct next number

---

## 4. Partner Comment Isolation

**File:** `src/lib/jira-pg-api.ts`

- Comments are shared only between tickets linked by explicit `partnerKey` column (NOT by number suffix)
- `partnerKey` is set during "department pass" — both tickets get each other's key
- DB: `ALTER TABLE issues ADD COLUMN IF NOT EXISTS "partnerKey" TEXT;`

---

## 5. Description Link Clickability

**File:** `src/app/issues/[issueKey]/page.tsx`

```tsx
onClick={(e) => {
  if ((e.target as HTMLElement).closest('a')) return; // don't intercept link clicks
  setEditing('description');
}}
```

---

## 6. Email Poller — Critical Self-Bootstrap Pattern

**Root cause that was fixed (2026-05-28):**
- `(globalThis as any).__processedMsgIds` was `undefined` when `startImapPoller` ran before `/api/email/reconnect` was called
- `processedIds.has(msgId)` → **TypeError crash** → poller silently skipped ALL emails → no tickets created for newly connected boards

**Fix in `src/lib/email-service.ts`:**
- At module init: `if (!(globalThis).__processedMsgIds) globalThis.__processedMsgIds = new Set()`
- Inside `startImapPoller`: self-bootstrap — loads processed IDs from DB on first call, no dependency on reconnect
- Also self-persists `email_configs` row to DB on every `startImapPoller` call

**Fix in `src/app/api/auth/oauth/microsoft/callback/route.ts`:**
- After OAuth: calls `POST /api/email/connect` (starts poller + saves to DB)
- Also calls `POST /api/email/reconnect` to restart ALL other boards' pollers

**Fix in `src/app/api/email/receive/route.ts`:**
- `extractEmail(addr)` strips display name from `"Name <email>"` format before DB lookup
- DB `CREATE TABLE IF NOT EXISTS email_configs` runs on every receive (safety net)

**Rule:** `startImapPoller` must always work standalone — never assume reconnect was called first.

## 7. Token Key
Always use `localStorage.getItem('jira_token')` — NOT `'token'`

---

## 7. DB
- DB name: `neutara_db`
- Connection: `postgresql://postgres:neutara123@localhost:5432/neutara_db`
- ORM: Prisma (for most queries) + raw `pg` Pool (for complex queries)

---

## 8. Department-Keyed Map Lookups (`dept_statuses` / `dept_assignees`)

**File:** `src/lib/dept-map.ts` — used by `src/lib/jira-pg-api.ts` and `src/lib/utils.ts`

- `dept_statuses`, `dept_assignees` and the per-department SLA log are JSONB maps keyed by department **name**, not id.
- Key casing is whatever wrote the entry. The Change Department dropdown writes the canonical name; a `Waiting for X` / `Routed to X` queue status is free text an admin typed, and the target department is regex-parsed back out of that label. So the same department can arrive as `Pre-Sales` or `Pre-sales`.
- **Always use `deptMapGet` / `deptMapSet` / `deptMapDelete`.** Never `map[deptName]`.
  - `deptMapGet(map, dept)` — case-insensitive read; returns `undefined` for a null/blank dept or map
  - `deptMapSet(map, dept, value)` — reuses the casing already present, so one ticket never accumulates both `Dev` and `dev`
  - `deptMapDelete(map, dept)` — removes under any casing
- **Asymmetry, deliberate:** the looked-up name is trimmed, the stored key is not. This reproduces the original private implementation exactly. A key stored with surrounding whitespace is still missed — a known latent bug, left for its own change rather than folded into a casing fix.
- These helpers were private to `jira-pg-api.ts` until the display layer was found using a plain case-sensitive `map[dept]`. The two rules disagreed: CF-29995 rendered a leftover QA status while sitting in Pre-Sales, and its status dropdown's `fromStatusId` filter then matched no transition at all. Shared now so they cannot drift apart again.
- Tests: `src/lib/dept-map.test.ts` (17) and `src/lib/utils.test.ts` (8). Run with `npm test`.
