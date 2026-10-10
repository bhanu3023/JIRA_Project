/**
 * llm-service.ts
 *
 * Thin wrapper around an LLM API, used by the automatic Root Cause / Fix
 * Description drafting agent (runAiSuggestionScan in jira-pg-api.ts,
 * scheduled in instrumentation.ts). Deliberately narrow -- one function,
 * one purpose -- rather than a general-purpose LLM client, since that's
 * the only thing this app currently needs an LLM for.
 *
 * Supports any of these, tried in this order:
 *   1. OPENAI_API_KEY      -- OpenAI's Chat Completions API (gpt-4o-mini by
 *      default -- cost-effective, appropriate for a short drafting task on
 *      a limited credit budget; override with OPENAI_MODEL).
 *   2. ANTHROPIC_API_KEY    -- Anthropic's Messages API, if that's what's
 *      configured instead (override the model with ANTHROPIC_MODEL).
 *   3. Local Ollama (no key needed) -- runs inside this app's own Docker
 *      Compose stack (see the `ollama` service in docker-compose.yml),
 *      reachable at OLLAMA_URL (defaults to http://ollama:11434, the
 *      compose service's own DNS name). Always tried last, and only if
 *      actually reachable, so it's a free no-account fallback rather than
 *      something that has to be explicitly turned on.
 * If none of the three work, every call here returns null (never throws)
 * and logs why -- the feature just stays off, the same graceful-degradation
 * shape as the email sender when no SMTP/OAuth account is configured.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

export interface TicketDraftContext {
  key: string;
  summary: string;
  description: string | null;
  department: string | null;
  priority: string | null;
  // Plain-text comment bodies, oldest first, already HTML-stripped by the
  // caller -- this module doesn't know about this app's own rich-text
  // format and shouldn't need to.
  comments: string[];
}

export interface TicketDraft {
  rootCause: string;
  fixDescription: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildPrompt(ctx: TicketDraftContext): string {
  const commentsBlock = ctx.comments.length
    ? ctx.comments.map((c, i) => `[Comment ${i + 1}] ${truncate(c, 1500)}`).join('\n\n')
    : '(no comments)';

  return `You are drafting a Root Cause and Fix Description for a resolved support ticket, to be reviewed and approved by the agent who worked it before it's saved -- not published automatically. Base your answer ONLY on the information below; never invent technical details, error codes, or steps that aren't actually present in it.

Ticket: ${ctx.key}
Department: ${ctx.department || 'unknown'}
Priority: ${ctx.priority || 'unknown'}
Summary: ${ctx.summary}
Description: ${truncate(ctx.description || '(none)', 2000)}

Comments (chronological):
${commentsBlock}

If the comments and description genuinely don't contain enough information to determine a real root cause and fix (e.g. the ticket was resolved with no technical detail at all), respond with exactly: INSUFFICIENT_INFO

Otherwise respond with ONLY a JSON object, no other text, in this exact shape:
{"rootCause": "one or two sentences describing what actually caused the issue", "fixDescription": "one or two sentences describing what was actually done to resolve it"}`;
}

function parseDraftResponse(text: string): TicketDraft | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'INSUFFICIENT_INFO') return null;
  const jsonText = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed?.rootCause || !parsed?.fixDescription) return null;
    return { rootCause: String(parsed.rootCause).trim(), fixDescription: String(parsed.fixDescription).trim() };
  } catch {
    return null;
  }
}

async function draftViaOpenAI(ctx: TicketDraftContext): Promise<TicketDraft | null> {
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`[LLM] OpenAI API ${res.status} for ${ctx.key}:`, await res.text().catch(() => ''));
    return null;
  }
  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content || '';
  return parseDraftResponse(text);
}

async function draftViaAnthropic(ctx: TicketDraftContext): Promise<TicketDraft | null> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`[LLM] Anthropic API ${res.status} for ${ctx.key}:`, await res.text().catch(() => ''));
    return null;
  }
  const data: any = await res.json();
  const text: string = data?.content?.[0]?.text || '';
  return parseDraftResponse(text);
}

async function draftViaOllama(ctx: TicketDraftContext): Promise<TicketDraft | null> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }),
    // Local inference on CPU is slower than a hosted API -- this job runs
    // in the background every 30 minutes, so there's no user waiting on
    // it, hence the generous timeout.
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error(`[LLM] Ollama ${res.status} for ${ctx.key}:`, await res.text().catch(() => ''));
    return null;
  }
  const data: any = await res.json();
  const text: string = data?.message?.content || '';
  return parseDraftResponse(text);
}

/**
 * Drafts a Root Cause and Fix Description from a resolved ticket's own
 * content -- never invents anything beyond what's in the summary,
 * description, and comments. Returns null if there's too little content to
 * draft anything meaningful from (e.g. zero comments and a one-line
 * description), if no provider is reachable, or if the call fails for any
 * reason -- a missing suggestion is always the safe failure mode here,
 * never a fabricated one.
 */
export async function draftRootCauseAndFixDescription(ctx: TicketDraftContext): Promise<TicketDraft | null> {
  try {
    if (OPENAI_API_KEY) return await draftViaOpenAI(ctx);
    if (ANTHROPIC_API_KEY) return await draftViaAnthropic(ctx);
    return await draftViaOllama(ctx);
  } catch (e: any) {
    console.error(`[LLM] Draft failed for ${ctx.key}:`, e?.message || e);
    return null;
  }
}
