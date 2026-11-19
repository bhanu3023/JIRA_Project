/**
 * Consent page for the Claude connector (reached from /api/oauth/authorize
 * once the person is signed in). Server-rendered: checks the session and the
 * client itself, then posts Allow/Deny back to /api/oauth/authorize.
 * Lives under /auth so the app shell (sidebar, header) isn't drawn around it.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { pgPool as pool } from '@/lib/pg-pool';
import { resolveSessionUserId } from '@/lib/jira-pg-api';
import { AUTHORIZE_KEYS, pickAuthorizeParams, toQuery, validateClient } from '@/lib/mcp/authorize';

export const dynamic = 'force-dynamic';

export default async function ClaudeConnectPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const p = pickAuthorizeParams((k) => searchParams[k]);
  const client = await validateClient(p);
  if ('error' in client) {
    return <Shell><h1 className="text-lg font-semibold text-gray-900">Can&apos;t connect Claude</h1><p className="mt-2 text-sm text-gray-600">{client.error}</p></Shell>;
  }
  const userId = await resolveSessionUserId(cookies().get('jira_session')?.value);
  if (!userId) redirect(`/auth/login?next=${encodeURIComponent(`/api/oauth/authorize?${toQuery(p)}`)}`);
  const u = await pool.query(`SELECT "firstName", "lastName", email FROM users WHERE id = $1`, [userId]);
  const me = u.rows[0] || {};
  const name = `${me.firstName || ''} ${me.lastName || ''}`.trim() || me.email;

  return (
    <Shell>
      <div className="flex items-center gap-3">
        <img src="/neutara-logo.png" alt="" className="h-9 w-9 rounded-md object-contain" />
        <h1 className="text-lg font-semibold text-gray-900">Connect Claude to Neutara Ticketing</h1>
      </div>
      <p className="mt-4 text-sm text-gray-700">
        <b>{client.clientName}</b> is asking to read the ticketing app as <b>{name}</b> ({me.email}).
      </p>
      <ul className="mt-4 space-y-2 text-sm text-gray-700 list-disc pl-5">
        <li>Claude can <b>read</b> the tickets, history, comments, SLAs, worklogs and KB articles you can already see in the app.</li>
        <li>Claude <b>cannot change anything</b>: no creating, editing, assigning, commenting or resolving.</li>
        <li>You can disconnect at any time in <b>Settings → API Tokens → Claude connections</b>.</li>
      </ul>
      <form method="POST" action="/api/oauth/authorize" className="mt-6 flex gap-3">
        {AUTHORIZE_KEYS.map((k) => ((p as any)[k] ? <input key={k} type="hidden" name={k} value={(p as any)[k]} /> : null))}
        <button name="decision" value="allow" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Allow read-only access</button>
        <button name="decision" value="deny" className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
    </div>
  );
}
