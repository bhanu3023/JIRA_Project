/**
 * GET /api/setup/customer-board
 * Fixes Customer_Board email config on production.
 * - Detects the actual space key (CUSTM or CUSTOM) created by the user
 * - Updates email_configs to point L1board@cloudfuze.com to that space
 * - Removes duplicate CUSTOM space if user's space is CUSTM
 * - Ensures required columns exist
 * Safe to call multiple times.
 */
import { NextResponse } from 'next/server';
import { pgPool as pool } from '@/lib/pg-pool';

export const runtime = 'nodejs';

export async function GET() {
  const log: string[] = [];

  try {
    // 1. Find the Customer_Board space — prefer CUSTM (user-created) over CUSTOM (migration)
    const spacesRes = await pool.query(
      `SELECT id, key, name FROM spaces WHERE name = 'Customer_Board' OR key IN ('CUSTM','CUSTOM') ORDER BY key`
    );
    log.push(`Found spaces: ${spacesRes.rows.map((r: any) => `${r.key}(${r.id})`).join(', ')}`);

    // Pick the real space: prefer CUSTM (manually created by user), fallback to CUSTOM
    const realSpace = spacesRes.rows.find((r: any) => r.key === 'CUSTM') ||
                      spacesRes.rows.find((r: any) => r.key === 'CUSTOM') ||
                      spacesRes.rows[0];

    if (!realSpace) {
      return NextResponse.json({ ok: false, error: 'No Customer_Board space found. Please create it first via the UI.', log });
    }
    log.push(`✅ Using space: ${realSpace.key} (id=${realSpace.id})`);

    // 2. If there's a duplicate CUSTOM space and user's real one is CUSTM, clean up duplicate
    if (realSpace.key === 'CUSTM') {
      const dupSpace = spacesRes.rows.find((r: any) => r.key === 'CUSTOM');
      if (dupSpace) {
        // Move any issues/statuses from duplicate to real space before deleting
        await pool.query(`UPDATE issues SET "spaceId" = $1 WHERE "spaceId" = $2`, [realSpace.id, dupSpace.id]).catch(() => {});
        await pool.query(`UPDATE statuses SET "spaceId" = $1 WHERE "spaceId" = $2`, [realSpace.id, dupSpace.id]).catch(() => {});
        await pool.query(`DELETE FROM spaces WHERE key = 'CUSTOM' AND id != $1`, [realSpace.id]).catch(() => {});
        log.push('✅ Removed duplicate CUSTOM space');
      }
    }

    // 3. Ensure statuses exist for the real space
    const existingStatuses = (await pool.query(`SELECT name FROM statuses WHERE "spaceId" = $1`, [realSpace.id])).rows.map((r: any) => r.name);
    if (!existingStatuses.includes('To Do')) {
      await pool.query(`INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES (gen_random_uuid()::text, 'To Do', 'todo', '#64748B', 0, $1) ON CONFLICT DO NOTHING`, [realSpace.id]);
      log.push('✅ Status To Do created');
    } else { log.push('⏭️ Status To Do already exists'); }

    if (!existingStatuses.includes('In Progress')) {
      await pool.query(`INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES (gen_random_uuid()::text, 'In Progress', 'in_progress', '#3B82F6', 1, $1) ON CONFLICT DO NOTHING`, [realSpace.id]);
      log.push('✅ Status In Progress created');
    } else { log.push('⏭️ Status In Progress already exists'); }

    if (!existingStatuses.includes('Done')) {
      await pool.query(`INSERT INTO statuses (id, name, category, color, "order", "spaceId") VALUES (gen_random_uuid()::text, 'Done', 'done', '#10B981', 2, $1) ON CONFLICT DO NOTHING`, [realSpace.id]);
      log.push('✅ Status Done created');
    } else { log.push('⏭️ Status Done already exists'); }

    // 4. Ensure email_configs columns exist
    await pool.query(`ALTER TABLE email_configs ADD COLUMN IF NOT EXISTS department TEXT`).catch(() => {});
    log.push('✅ email_configs.department column ensured');

    // 5. Register / fix L1board@cloudfuze.com → real space key
    await pool.query(`
      INSERT INTO email_configs (id, space_key, address, imap_host, imap_port, smtp_host, smtp_port, auto_reply, auto_reply_text, department)
      VALUES (
        'f00edf1e-3e09-402d-96a4-fb333ef45bca',
        $1,
        'L1board@cloudfuze.com',
        'outlook.office365.com', 993,
        'smtp.office365.com', 587,
        true,
        'Thank you for contacting us. We have received your request and will get back to you shortly.',
        'Migration-Customer'
      )
      ON CONFLICT (id) DO UPDATE SET
        space_key       = EXCLUDED.space_key,
        imap_host       = EXCLUDED.imap_host,
        smtp_host       = EXCLUDED.smtp_host,
        auto_reply      = EXCLUDED.auto_reply,
        department      = EXCLUDED.department
    `, [realSpace.key]);
    log.push(`✅ L1board@cloudfuze.com linked to space ${realSpace.key}`);

    // Also fix any other rows with wrong space key
    await pool.query(
      `UPDATE email_configs SET space_key = $1 WHERE LOWER(address) = 'l1board@cloudfuze.com' AND space_key != $1`,
      [realSpace.key]
    );

    // 6. Ensure emailthreadid column on issues
    await pool.query(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS emailthreadid TEXT`).catch(() => {});
    log.push('✅ issues.emailthreadid column ensured');

    // 7. Check if OAuth tokens exist for L1board@cloudfuze.com
    let oauthStatus = 'NOT CONNECTED';
    try {
      const { getOAuthTokens } = await import('@/lib/oauth-service');
      const tokens = getOAuthTokens('l1board@cloudfuze.com');
      oauthStatus = tokens ? '✅ OAuth tokens found — poller can start' : '❌ No OAuth tokens — must connect via Microsoft OAuth';
    } catch { oauthStatus = 'unknown'; }
    log.push(`OAuth status: ${oauthStatus}`);

    const needsOAuth = oauthStatus.includes('❌');
    return NextResponse.json({
      ok: true,
      spaceKey: realSpace.key,
      spaceId: realSpace.id,
      log,
      oauthConnected: !needsOAuth,
      next: needsOAuth
        ? `⚠️ REQUIRED: Go to https://neutaraticketing.cftools.live/spaces/${realSpace.key}/settings?tab=email and click "Connect with Microsoft" for L1board@cloudfuze.com to start the email poller.`
        : `✅ All done! Email poller should be running. Test by sending an email to L1board@cloudfuze.com.`
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message, log }, { status: 500 });
  }
}
