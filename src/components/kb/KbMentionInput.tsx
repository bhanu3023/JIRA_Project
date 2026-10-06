'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { api, type KbPerson } from '@/lib/api';
import { cleanMentionName, splitMentions, type KbMention } from '@/lib/kb-mentions';

/** Renders stored question/answer text with @mentions as chips. */
export function KbMentionText({ text, className }: { text: string | null | undefined; className?: string }) {
  return (
    <p className={className}>
      {splitMentions(text).map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <span key={i} className="rounded bg-blue-50 px-1 font-medium text-blue-700">@{part.name}</span>
        ),
      )}
    </p>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase() || '?';
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  articleId: string;
  value: string;
  onChange: (value: string) => void;
  mentions: KbMention[];
  onMentionsChange: (mentions: KbMention[]) => void;
  /** Open the suggestions above the box (for an input pinned to the bottom). */
  dropUp?: boolean;
};

/**
 * A textarea where typing @ suggests people who can read the article. Picking
 * one inserts "@Name" and records who it is; toStored() turns that into a
 * mention token when the text is posted.
 */
export const KbMentionInput = forwardRef<HTMLTextAreaElement, Props>(function KbMentionInput(
  { articleId, value, onChange, mentions, onMentionsChange, dropUp, onKeyDown, className, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  // The "@query" being typed: where it starts and what follows the @.
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [people, setPeople] = useState<KbPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  const detect = (text: string, caret: number | null) => {
    if (caret === null) { setTrigger(null); return; }
    const m = text.slice(0, caret).match(/(^|\s)@([^\s@]{0,40})$/);
    setTrigger(m ? { start: caret - m[2].length - 1, query: m[2] } : null);
  };

  const query = trigger?.query;
  useEffect(() => {
    if (query === undefined) { setPeople([]); setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api.searchKbPeople(articleId, query, ctrl.signal)
        .then((rows) => { setPeople(rows); setActive(0); })
        .catch(() => { if (!ctrl.signal.aborted) setPeople([]); })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [articleId, query]);

  const pick = (p: KbPerson) => {
    if (!trigger) return;
    const name = cleanMentionName(p.name);
    const caret = trigger.start + 1 + trigger.query.length;
    const insert = `@${name} `;
    const next = value.slice(0, trigger.start) + insert + value.slice(caret);
    onChange(next);
    if (!mentions.some((m) => m.id === p.id)) onMentionsChange([...mentions, { id: p.id, name }]);
    setTrigger(null);
    const pos = trigger.start + insert.length;
    requestAnimationFrame(() => {
      const el = innerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const open = trigger !== null && (loading || people.length > 0 || trigger.query.length > 0);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && people.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % people.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + people.length) % people.length); return; }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') { e.preventDefault(); pick(people[active]); return; }
    }
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTrigger(null); return; }
    onKeyDown?.(e);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        {...rest}
        ref={innerRef}
        value={value}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setTrigger(null), 150)}
        onKeyDown={handleKeyDown}
        className={className}
      />
      {open && (
        <div
          className={`absolute left-0 z-[75] w-full max-w-xs overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          onMouseDown={(e) => e.preventDefault()}
        >
          <p className="border-b border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">People who can read this</p>
          {loading && people.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-gray-400">Searching…</p>
          ) : people.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-gray-400">No one found</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {people.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => pick(p)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-blue-50' : ''}`}
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">{initials(p.name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-gray-800">{p.name}</span>
                      <span className="block truncate text-[11px] text-gray-400">{p.email}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
