// GET /.well-known/oauth-authorization-server (rewritten here, see next.config.js)
import { appBaseUrl, MCP_SCOPE } from '@/lib/mcp/store';
import { jsonRes, preflight } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = appBaseUrl();
  return jsonRes({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
  });
}
export const OPTIONS = preflight;
