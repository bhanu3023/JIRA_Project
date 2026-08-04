#!/bin/bash
# ── Neutara Ticketing — Server Deploy Script ──────────────────────────────────
# Safe deploy: never drops the database if it already has data.
# Only restores the backup on the very first deploy (empty DB).
set -e

echo "==> Pulling latest code..."
git pull origin fresh-start

echo "==> Rebuilding and restarting containers..."
docker compose down
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
  -- cf_key and partnerKey are raw columns (not in the Prisma schema, so Prisma's
  -- own migrations never index them) but are on hot paths: cf_key is scanned with
  -- MAX(...) on every single ticket creation to assign the next CF-#### number,
  -- and partnerKey is looked up on every ticket detail page load to merge in a
  -- linked partner ticket's comments. Both were sequential-scanning the full
  -- issues table without these.
  CREATE INDEX IF NOT EXISTS idx_issues_cf_key ON issues (cf_key);
  CREATE INDEX IF NOT EXISTS issues_partner_key_idx ON issues (\"partnerKey\");
" 2>&1 | grep -v NOTICE || true

DATABASE_URL="postgresql://jirauser:Neutara%402024@localhost:5434/jiradb" node /root/Jira-v2.0/seed-queues.mjs 2>/dev/null || true

echo "==> Setting the final per-department status lists (Migration, Dev, QA, Infra)..."
# Each of these 4 queues had no (or an incomplete) queueStatuses configured, so their status
# dropdown fell back to the space's full unscoped status list (every status ever used across
# every board — dozens of entries). This sets each queue's own final status list (applies to
# all roles, per queue status scoping in the app) and is safe to re-run on every deploy — it
# only touches these 4 queue entries' queueStatuses field, matched by department name.
docker exec -i jira_postgres psql -U jirauser -d jiradb <<'SQL' 2>&1 | grep -v NOTICE || true
UPDATE custom_queues
SET queues = (
  SELECT jsonb_agg(
    CASE
      WHEN lower(elem->>'name') = 'migration'
        THEN elem || jsonb_build_object('queueStatuses', '[
          {"id":"qst_migration_open","name":"Open","color":"#6366F1","category":"todo","order":0},
          {"id":"qst_migration_inprogress","name":"In Progress","color":"#3B82F6","category":"in_progress","order":1},
          {"id":"qst_migration_waitingdev","name":"Waiting for Dev","color":"#F59E0B","category":"in_progress","order":2},
          {"id":"qst_migration_waitinginfra","name":"Waiting for Infra","color":"#F59E0B","category":"in_progress","order":3},
          {"id":"qst_migration_waitingqa","name":"Waiting for QA","color":"#F59E0B","category":"in_progress","order":4},
          {"id":"qst_migration_resolved","name":"Resolved","color":"#10B981","category":"done","order":5}
        ]'::jsonb)
      WHEN lower(elem->>'name') = 'dev'
        THEN elem || jsonb_build_object('queueStatuses', '[
          {"id":"qst_dev_open","name":"Open","color":"#6366F1","category":"todo","order":0},
          {"id":"qst_dev_inprogress","name":"In Progress","color":"#3B82F6","category":"in_progress","order":1},
          {"id":"qst_dev_waitingmigration","name":"Waiting for Migration","color":"#F59E0B","category":"in_progress","order":2},
          {"id":"qst_dev_waitingqa","name":"Waiting for QA","color":"#F59E0B","category":"in_progress","order":3},
          {"id":"qst_dev_waitinginfra","name":"Waiting for Infra","color":"#F59E0B","category":"in_progress","order":4},
          {"id":"qst_dev_resolved","name":"Resolved","color":"#10B981","category":"done","order":5}
        ]'::jsonb)
      WHEN lower(elem->>'name') = 'qa'
        THEN elem || jsonb_build_object('queueStatuses', '[
          {"id":"qst_qa_open","name":"Open","color":"#6366F1","category":"todo","order":0},
          {"id":"qst_qa_inprogress","name":"In Progress","color":"#3B82F6","category":"in_progress","order":1},
          {"id":"qst_qa_waitingdev","name":"Waiting for Dev","color":"#F59E0B","category":"in_progress","order":2},
          {"id":"qst_qa_waitinginfra","name":"Waiting for Infra","color":"#F59E0B","category":"in_progress","order":3},
          {"id":"qst_qa_resolved","name":"Resolved","color":"#10B981","category":"done","order":4}
        ]'::jsonb)
      WHEN lower(elem->>'name') = 'infra'
        THEN elem || jsonb_build_object('queueStatuses', '[
          {"id":"qst_infra_open","name":"Open","color":"#6366F1","category":"todo","order":0},
          {"id":"qst_infra_inprogress","name":"In Progress","color":"#3B82F6","category":"in_progress","order":1},
          {"id":"qst_infra_waitingqa","name":"Waiting for QA","color":"#F59E0B","category":"in_progress","order":2},
          {"id":"qst_infra_waitingdev","name":"Waiting for Dev","color":"#F59E0B","category":"in_progress","order":3},
          {"id":"qst_infra_resolved","name":"Resolved","color":"#10B981","category":"done","order":4}
        ]'::jsonb)
      ELSE elem
    END
  )
  FROM jsonb_array_elements(queues) elem
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(queues) e
  WHERE lower(e->>'name') IN ('migration', 'dev', 'qa', 'infra')
);
SQL

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
