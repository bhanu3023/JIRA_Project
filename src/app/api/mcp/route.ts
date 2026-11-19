/**
 * POST /api/mcp -- the Claude Desktop connector endpoint (MCP, Streamable
 * HTTP, stateless). Requires a read-only `ntm_` access token from the OAuth
 * flow in /api/oauth/*. Without one it answers 401 with a pointer to the
 * OAuth metadata, which is how Claude knows to start the sign-in.
 */
import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '@/lib/mcp/server';
import { appBaseUrl, mcpEnabled, resolveMcpAccessToken } from '@/lib/mcp/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized(message = 'Sign in required') {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource", scope="tickets:read"`,
    },
  });
}

async function handle(req: NextRequest) {
  if (!mcpEnabled()) return new Response('The Claude connector is turned off.', { status: 503 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token.startsWith('ntm_')) return unauthorized();
  const userId = await resolveMcpAccessToken(token);
  if (!userId) return unauthorized('Token expired or revoked');

  // Stateless: a fresh server + transport per request, no session ids.
  const server = buildMcpServer({ token, userId });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON-response mode has finished writing by the time handleRequest resolves.
    server.close().catch(() => {});
  }
}

export async function POST(req: NextRequest) { return handle(req); }
// Stateless servers don't offer a GET event stream or session DELETE.
export async function GET() { return new Response(null, { status: 405, headers: { Allow: 'POST' } }); }
export async function DELETE() { return new Response(null, { status: 405, headers: { Allow: 'POST' } }); }
