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
" 2>&1 | grep -v NOTICE || true

DATABASE_URL="postgresql://jirauser:Neutara%402024@localhost:5434/jiradb" node /root/Jira-v2.0/seed-queues.mjs 2>/dev/null || true

echo ""
echo "==> Deploy complete! App is running."
echo "==> Space members and all production data are preserved."
