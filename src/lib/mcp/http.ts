// Small helpers shared by the OAuth routes for the Claude connector.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
};

export function jsonRes(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

export function oauthError(error: string, description: string, status = 400) {
  return jsonRes({ error, error_description: description }, status);
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/** Reads a form-encoded or JSON body into a plain object. */
export async function readBody(req: Request): Promise<Record<string, any>> {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return (await req.json().catch(() => ({}))) || {};
  const text = await req.text().catch(() => '');
  return Object.fromEntries(new URLSearchParams(text));
}
