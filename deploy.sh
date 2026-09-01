#!/bin/bash
# ── Neutara Ticketing — Server Deploy Script ──────────────────────────────────
# Safe deploy: never drops the database if it already has data.
# Only restores the backup on the very first deploy (empty DB).
set -e

echo "==> Pulling latest code..."
# This server's shell env sets https_proxy to a local proxy that can't reach
# GitHub ("Proxy CONNECT aborted"), which killed every deploy right here
# under `set -e` before the actual rebuild ever ran. Bypass it for this one
# git invocation instead of relying on whoever runs deploy.sh to remember to
# unset it first.
# Pulls whatever branch this checkout is actually on -- was hardcoded to
# "fresh-start", so a server checked out on a different branch (e.g. a
# feature branch under active development) would silently pull the wrong
# branch's code on every deploy instead of the commits actually pushed.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git -c http.proxy= -c https.proxy= pull origin "$CURRENT_BRANCH"

echo "==> Rebuilding and restarting only what changed..."
# Previously: `docker compose down` + `up -d --build`, which unconditionally
# stops and recreates EVERY container together, including Postgres — which
# has no code changes to pick up. That gave every deploy a window where
# Postgres itself was restarting, so the app's DB pool failed to connect:
# session lookups silently failed (users appeared logged out -> spurious
# 403s) and in-flight queries threw raw pg connection-timeout errors that
# leaked into 500 responses. `up -d --build` alone rebuilds the image and
# recreates only the container(s) whose image/config actually changed —
# Postgres stays up the whole time since its own service definition never
# changes here, and the app's own downtime window shrinks to just its own
# restart instead of the whole stack's.
docker compose up -d --build

echo "==> Waiting for Postgres to be ready..."
until docker exec jira_postgres pg_isready -U jirauser -d jiradb -q 2>/dev/null; do
  sleep 1
done

echo "==> Checking if database already has data..."
ROW_COUNT=$(docker exec jira_postgres psql -U jirauser -d jiradb -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='spaces';" 2>/dev/null || echo "0")

if [ "$ROW_COUNT" = "0" ]; then
  echo "==> First deploy detected — restoring database from backup..."
  docker cp neutara_db_backup.sql jira_postgres:/tmp/neutara_db_backup.sql
  docker exec jira_postgres psql -U jirauser -d jiradb -f /tmp/neutara_db_backup.sql 2>&1 | tail -5
  echo "==> Backup restored."
else
  echo "==> Database already has data — skipping backup restore to preserve all changes."
fi

echo "==> Running post-setup scripts..."
docker exec -i jira_postgres psql -U jirauser -d jiradb -c "
  CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT,
    user_agent TEXT,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMP(3) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON user_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS issues_space_created_idx ON issues (\"spaceId\", \"createdAt\" DESC);
  -- Queue views filter with LOWER(current_department), which the plain
  -- (spaceId, current_department) index can't serve, so Postgres fell back
  -- to a full sequential scan on every queue switch (~48ms at 29k rows,
  -- worse as the table grows). This matches the exact expression used in
  -- jira-pg-api.ts's dept-filtered queries so it can use an index scan
  -- instead (confirmed via EXPLAIN ANALYZE: ~48ms scan -> ~0.5ms).
  CREATE INDEX IF NOT EXISTS idx_issues_space_dept_lower ON issues (\"spaceId\", LOWER(current_department));
  -- The Queue Dashboard's own dept-wide queries (deptIssuesRes /
  -- originDeptIssuesRes in jira-pg-api.ts) filter by LOWER(current_department)
  -- ALONE, with no spaceId in the WHERE clause -- a composite index led by
  -- spaceId (idx_issues_space_dept_lower, above) can't serve that, so these
  -- specifically were still falling back to a full sequential scan (confirmed
  -- via EXPLAIN ANALYZE against production: ~60ms at 15k+ rows for Dev, worse
  -- as the table grows, and run on every queue-dashboard load/poll).
  CREATE INDEX IF NOT EXISTS idx_issues_current_dept_lower ON issues (LOWER(current_department));
  -- cf_key and partnerKey are raw columns (not in the Prisma schema, so Prisma's
  -- own migrations never index them) but are on hot paths: cf_key is scanned with
  -- MAX(...) on every single ticket creation to assign the next CF-#### number,
  -- and partnerKey is looked up on every ticket detail page load to merge in a
  -- linked partner ticket's comments. Both were sequential-scanning the full
  -- issues table without these.
  CREATE INDEX IF NOT EXISTS idx_issues_cf_key ON issues (cf_key);
  CREATE INDEX IF NOT EXISTS issues_partner_key_idx ON issues (\"partnerKey\");
  -- computeIssueSLAsFromDb runs 'SELECT id FROM notifications WHERE
  -- \"issueKey\" = \$1 AND type = ...' on EVERY single ticket-detail-page
  -- load (and again, batched, on the my-dashboard list) to check whether an
  -- SLA-breach notification already fired for this ticket. notifications
  -- only has (userId, isRead) and (userId, createdAt) indexes -- neither
  -- covers a lookup by issueKey, so this was a full sequential scan of the
  -- notifications table (which only grows, one row per assignment/comment/
  -- status-change/SLA-breach event ever sent) on every ticket open.
  CREATE INDEX IF NOT EXISTS idx_notifications_issuekey_type ON notifications (\"issueKey\", type);
  -- Historical SLA-breach data imported from Jira for L2B/L3B tickets --
  -- this app's own SLA clock never reports a breach once a ticket is
  -- resolved, which erases the fact that a ticket was already breached in
  -- Jira before it ever got resolved here. Raw columns, same as cf_key.
  ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_breached BOOLEAN DEFAULT FALSE;
  ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_due_at TIMESTAMPTZ;
  ALTER TABLE issues ADD COLUMN IF NOT EXISTS jira_sla_start_at TIMESTAMPTZ;
" 2>&1 | grep -v NOTICE || true

DATABASE_URL="postgresql://jirauser:Neutara%402024@localhost:5434/jiradb" node /root/Jira-v2.0/seed-queues.mjs 2>/dev/null || true

# The "Setting the final per-department status lists" bootstrap step that
# used to run here has been removed. It unconditionally overwrote Migration/
# Dev/QA/Infra's queueStatuses with a hardcoded snapshot on EVERY deploy --
# fine while those 4 queues genuinely had no (or incomplete) queueStatuses
# configured, but once real per-queue configuration exists, "safe to re-run"
# stopped being true: it silently reverted any later customization back to
# this stale baseline, using outdated "Waiting for X" naming (the app moved
# to "Routed to X" naming since this was written) and with no entry at all
# for the Pre-Sales queue added since. Confirmed for real: it silently wiped
# a newly-added "Routed to Pre-sales" status from Dev's queue on two
# consecutive deploys before this was caught. All 5 department queues
# (Migration, Dev, QA, Infra, Pre-Sales) now have real, current
# queueStatuses configured directly -- this bootstrap has outlived its job.

echo "==> Clearing stale 'Waiting for X' status markers left by tickets transferred before the department-change fix..."
# Old department-transfer code overwrote a department's own dept_statuses entry with a
# synthetic "Waiting for <newDept>" marker (id: '') instead of the ticket's real status —
# already fixed for new transfers, but tickets moved before this fix still carry the stale
# marker. Real DB statuses always have a non-empty id, so this only ever touches the
# synthetic placeholders, never a real status reference. Once cleared, the display falls
# back to the ticket's actual current status. Safe to re-run — no-op once cleaned up.
docker exec -i jira_postgres psql -U jirauser -d jiradb <<'SQL' 2>&1 | grep -v NOTICE || true
UPDATE issues
SET dept_statuses = COALESCE((
  SELECT jsonb_object_agg(key, value)
  FROM jsonb_each(dept_statuses)
  WHERE NOT (value->>'id' = '' AND lower(value->>'name') LIKE 'waiting for %')
), '{}'::jsonb)
WHERE dept_statuses IS NOT NULL AND dept_statuses != '{}'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_each(dept_statuses) e
    WHERE e.value->>'id' = '' AND lower(e.value->>'name') LIKE 'waiting for %'
  );
SQL

echo ""
echo "==> Deploy complete! App is running."
echo "==> Space members and all production data are preserved."
