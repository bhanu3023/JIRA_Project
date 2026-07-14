-- Migration: Create Customer_Board (CUSTOM) space on production
-- Run this on the production server inside the postgres container:
--   docker exec -i jira-client-db-1 psql -U postgres -d neutara_db < scripts/migrate-custom-board.sql
-- Or via psql directly on the server.

BEGIN;

-- 1. Create the CUSTOM space (skip if already exists)
INSERT INTO spaces (id, key, name, description, type, icon, "memberCount", "issueCount", "sub_board_keys", "createdAt", "updatedAt")
VALUES (
  'pg_utuni6lcrg',
  'CUSTOM',
  'Customer_Board',
  NULL,
  'dept_queue',
  NULL,
  1,
  0,
  '{}',
  NOW(),
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- 2. Create statuses for the CUSTOM space
INSERT INTO statuses (id, name, category, color, "order", "spaceId")
VALUES
  ('109f24c1-12e1-4248-9716-679331621082', 'To Do',       'todo',        '#64748B', 0, 'pg_utuni6lcrg'),
  ('3316ffb2-540a-4069-b3f3-0b076b95718a', 'In Progress', 'in_progress', '#3B82F6', 1, 'pg_utuni6lcrg'),
  ('abe3c13b-af90-4684-8008-b0d6ff40f51f', 'Done',        'done',        '#10B981', 2, 'pg_utuni6lcrg')
ON CONFLICT (id) DO NOTHING;

-- 3. Ensure email_configs table has department column
ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT;

-- 4. Register L1board@cloudfuze.com for the CUSTOM space
INSERT INTO email_configs (id, space_key, address, imap_host, imap_port, smtp_host, smtp_port, auto_reply, auto_reply_text, department)
VALUES (
  'f00edf1e-3e09-402d-96a4-fb333ef45bca',
  'CUSTOM',
  'L1board@cloudfuze.com',
  'outlook.office365.com',
  993,
  'smtp.office365.com',
  587,
  true,
  'Thank you for contacting us. We have received your request and will get back to you shortly.',
  'Migration-Customer'
)
ON CONFLICT (id) DO UPDATE SET
  space_key        = EXCLUDED.space_key,
  imap_host        = EXCLUDED.imap_host,
  smtp_host        = EXCLUDED.smtp_host,
  auto_reply       = EXCLUDED.auto_reply,
  auto_reply_text  = EXCLUDED.auto_reply_text,
  department       = EXCLUDED.department;

-- 5. Ensure emailthreadid column exists on issues (for reply threading)
ALTER TABLE issues ADD COLUMN IF NOT EXISTS emailthreadid TEXT;

COMMIT;

SELECT 'Customer_Board (CUSTOM) migration complete' AS result;
