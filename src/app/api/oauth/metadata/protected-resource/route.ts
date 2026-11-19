// GET /.well-known/oauth-protected-resource (rewritten here, see next.config.js)
import { appBaseUrl, MCP_SCOPE } from '@/lib/mcp/store';
import { jsonRes, preflight } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = appBaseUrl();
  return jsonRes({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Neutara Ticketing (read-only)',
  });
}
export const OPTIONS = preflight;
