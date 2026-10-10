/**
 * llm-service.ts
 *
 * Thin wrapper around the Anthropic Messages API, used by the automatic
 * Root Cause / Fix Description drafting agent (runAiSuggestionScan in
 * jira-pg-api.ts, scheduled in instrumentation.ts). Deliberately narrow --
 * one function, one purpose -- rather than a general-purpose LLM client,
 * since that's the only thing this app currently needs an LLM for.
 *
 * Requires ANTHROPIC_API_KEY in the environment. If it's missing, every
 * call here returns null (never throws) and the caller logs that this ran
 * with no key configured -- the feature just stays off until someone adds
 * one, the same graceful-degradation shape as the email sender when no
 * SMTP/OAuth account is configured.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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

/**
 * Drafts a Root Cause and Fix Description from a resolved ticket's own
 * content -- never invents anything beyond what's in the summary,
 * description, and comments. Returns null if there's too little content to
 * draft anything meaningful from (e.g. zero comments and a one-line
 * description), or if the API call fails for any reason -- a missing
 * suggestion is always the safe failure mode here, never a fabricated one.
 */
export async function draftRootCauseAndFixDescription(ctx: TicketDraftContext): Promise<TicketDraft | null> {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[LLM] ANTHROPIC_API_KEY not configured -- skipping AI suggestion for', ctx.key);
    return null;
  }

  const commentsBlock = ctx.comments.length
    ? ctx.comments.map((c, i) => `[Comment ${i + 1}] ${truncate(c, 1500)}`).join('\n\n')
    : '(no comments)';

  const prompt = `You are drafting a Root Cause and Fix Description for a resolved support ticket, to be reviewed and approved by the agent who worked it before it's saved -- not published automatically. Base your answer ONLY on the information below; never invent technical details, error codes, or steps that aren't actually present in it.

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

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`[LLM] Anthropic API ${res.status} for ${ctx.key}:`, await res.text().catch(() => ''));
      return null;
    }
    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text?.trim() || '';
    if (!text || text === 'INSUFFICIENT_INFO') return null;

    // The model is instructed to return bare JSON, but strip a code fence
    // defensively in case it wraps the answer in one anyway.
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonText);
    if (!parsed?.rootCause || !parsed?.fixDescription) return null;
    return { rootCause: String(parsed.rootCause).trim(), fixDescription: String(parsed.fixDescription).trim() };
  } catch (e: any) {
    console.error(`[LLM] Draft failed for ${ctx.key}:`, e?.message || e);
    return null;
  }
}
