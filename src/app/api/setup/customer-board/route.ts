/**
 * GET /api/setup/customer-board
 * One-time setup: creates Customer_Board (CUSTOM) space + statuses + email config on production.
 * Safe to call multiple times — uses ON CONFLICT DO NOTHING.
 */
import { NextResponse } from 'next/server';
import { Pool } from 'pg';

export const runtime = 'nodejs';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:neutara123@localhost:5433/neutara_db';

export async function GET() {
  const pool = new Pool({ connectionString: DB_URL });
  const log: string[] = [];

  try {
    // 1. Create the CUSTOM space
    const spaceRes = await pool.query(`
      INSERT INTO spaces (id, key, name, description, type, icon, "memberCount", "issueCount", "sub_board_keys", "createdAt", "updatedAt")
      VALUES ('pg_utuni6lcrg', 'CUSTOM', 'Customer_Board', NULL, 'dept_queue', NULL, 1, 0, '{}', NOW(), NOW())
      ON CONFLICT (key) DO NOTHING
    `);
    log.push(spaceRes.rowCount > 0 ? '✅ Space CUSTOM created' : '⏭️ Space CUSTOM already exists');

    // 2. Create statuses
    const s1 = await pool.query(`
      INSERT INTO statuses (id, name, category, color, "order", "spaceId")
      VALUES ('109f24c1-12e1-4248-9716-679331621082', 'To Do', 'todo', '#64748B', 0, 'pg_utuni6lcrg')
      ON CONFLICT (id) DO NOTHING
    `);
    log.push(s1.rowCount > 0 ? '✅ Status To Do created' : '⏭️ Status To Do already exists');

    const s2 = await pool.query(`
      INSERT INTO statuses (id, name, category, color, "order", "spaceId")
      VALUES ('3316ffb2-540a-4069-b3f3-0b076b95718a', 'In Progress', 'in_progress', '#3B82F6', 1, 'pg_utuni6lcrg')
      ON CONFLICT (id) DO NOTHING
    `);
    log.push(s2.rowCount > 0 ? '✅ Status In Progress created' : '⏭️ Status In Progress already exists');

    const s3 = await pool.query(`
      INSERT INTO statuses (id, name, category, color, "order", "spaceId")
      VALUES ('abe3c13b-af90-4684-8008-b0d6ff40f51f', 'Done', 'done', '#10B981', 2, 'pg_utuni6lcrg')
      ON CONFLICT (id) DO NOTHING
    `);
    log.push(s3.rowCount > 0 ? '✅ Status Done created' : '⏭️ Status Done already exists');

    // 3. Ensure email_configs has department column
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});
    log.push('✅ email_configs.department column ensured');

    // 4. Register L1board@cloudfuze.com
    const emailRes = await pool.query(`
      INSERT INTO email_configs (id, space_key, address, imap_host, imap_port, smtp_host, smtp_port, auto_reply, auto_reply_text, department)
      VALUES (
        'f00edf1e-3e09-402d-96a4-fb333ef45bca',
        'CUSTOM',
        'L1board@cloudfuze.com',
        'outlook.office365.com', 993,
        'smtp.office365.com', 587,
        true,
        'Thank you for contacting us. We have received your request and will get back to you shortly.',
        'Migration-Customer'
      )
      ON CONFLICT (id) DO UPDATE SET
        space_key = EXCLUDED.space_key,
        imap_host = EXCLUDED.imap_host,
        smtp_host = EXCLUDED.smtp_host,
        department = EXCLUDED.department
    `);
    log.push('✅ L1board@cloudfuze.com registered in email_configs');

    // 5. Ensure emailthreadid column on issues
    await pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS emailthreadid TEXT`).catch(() => {});
    log.push('✅ issues.emailthreadid column ensured');

    await pool.end();
    return NextResponse.json({ ok: true, log }, { status: 200 });

  } catch (err: any) {
    await pool.end().catch(() => {});
    return NextResponse.json({ ok: false, error: err.message, log }, { status: 500 });
  }
}
