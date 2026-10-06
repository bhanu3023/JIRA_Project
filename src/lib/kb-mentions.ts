/**
 * kb-mentions.ts
 * @mentions in KB questions and answers. Questions are plain text, so a
 * mention is stored as a token -- @[Display Name](userId) -- and the editor
 * shows it as "@Display Name". Shared by the API (who to notify) and the page
 * (editing and rendering).
 */

export type KbMention = { id: string; name: string };

const TOKEN_RE = /@\[([^\]\n]{1,120})\]\(([A-Za-z0-9_-]{1,64})\)/g;

// Characters that would break a token are dropped from the stored name.
export function cleanMentionName(name: string) {
  return name.replace(/[[\]()\n]/g, '').trim();
}

export function mentionToken(m: KbMention) {
  return `@[${cleanMentionName(m.name)}](${m.id})`;
}

/** User ids mentioned in stored text. */
export function mentionedIds(text: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  String(text || '').replace(TOKEN_RE, (_, _name: string, id: string) => { ids.add(id); return ''; });
  return ids;
}

/** Stored text -> what the editor shows, plus the mentions it contained. */
export function toEditable(text: string | null | undefined): { text: string; mentions: KbMention[] } {
  const mentions: KbMention[] = [];
  const out = String(text || '').replace(TOKEN_RE, (_, name: string, id: string) => {
    if (!mentions.some((m) => m.id === id)) mentions.push({ id, name });
    return `@${name}`;
  });
  return { text: out, mentions };
}

/**
 * Editor text -> stored text. Only "@Name" for people picked from the
 * suggestions becomes a mention; anything else typed after @ stays plain text.
 */
export function toStored(text: string, mentions: KbMention[]): string {
  let out = text;
  // Longest names first so "@Ravi Kumar" wins over "@Ravi".
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const name = cleanMentionName(m.name);
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w\\]])@${escaped}(?![\\w])`, 'g'), (_, pre: string) => `${pre}${mentionToken({ id: m.id, name })}`);
  }
  return out;
}

/** Stored text -> pieces to render, mentions separated out. */
export function splitMentions(text: string | null | undefined): Array<string | KbMention> {
  const parts: Array<string | KbMention> = [];
  const src = String(text || '');
  let last = 0;
  src.replace(TOKEN_RE, (whole: string, name: string, id: string, at: number) => {
    if (at > last) parts.push(src.slice(last, at));
    parts.push({ name, id });
    last = at + whole.length;
    return whole;
  });
  if (last < src.length) parts.push(src.slice(last));
  return parts;
}

/** Stored text with mentions as "@Name" -- for notification previews. */
export function plainMentions(text: string | null | undefined): string {
  return String(text || '').replace(TOKEN_RE, (_, name: string) => `@${name}`);
}
