'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type KbFile, type KbQuestion } from '@/lib/api';
import { CheckCircle2, FileText, MessageCircleQuestion, Quote, Send, Trash2, X } from 'lucide-react';

const MAX_CHARS = 4000;
const POLL_MS = 20_000;

function initials(name: string | null) {
  const parts = (name || '?').trim().split(/\s+/);
  return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase() || '?';
}

function timeAgo(d: string | null) {
  if (!d) return '';
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function QuestionItem({
  articleId, q, canAnswer, onChange, onDelete, onOpenFile,
}: {
  articleId: string;
  q: KbQuestion;
  canAnswer: boolean;
  onChange: (q: KbQuestion) => void;
  onDelete: (id: string) => void;
  onOpenFile: (fileId: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState(q.answer || '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitAnswer = async () => {
    if (!draft.trim()) return;
    setBusy(true); setError(null);
    try {
      onChange(await api.answerKbQuestion(articleId, q.id, draft.trim()));
      setAnswering(false);
    } catch (e: any) {
      setError(e?.message || 'Failed to save answer');
    }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await api.deleteKbQuestion(articleId, q.id);
      onDelete(q.id);
    } catch (e: any) {
      setError(e?.message || 'Failed to delete');
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-gray-100 px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-semibold text-blue-700">{initials(q.askerName)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
            <span className="font-semibold text-gray-800">{q.askerName || 'Unknown'}</span>
            <span className="text-gray-400">{timeAgo(q.createdAt)}</span>
            {!q.answer && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700">Awaiting answer</span>}
          </div>

          {q.fileId && (
            <button onClick={() => onOpenFile(q.fileId!)} className="mt-1 flex max-w-full items-center gap-1 text-[11.5px] text-blue-600 hover:underline" title="Open this document">
              <FileText size={11} className="flex-shrink-0" /> <span className="truncate">{q.fileName}</span>
            </button>
          )}
          {q.quote && (
            <blockquote className="mt-1 border-l-2 border-blue-300 bg-blue-50/50 py-0.5 pl-2 text-[12px] italic text-gray-600">“{q.quote}”</blockquote>
          )}
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-gray-800">{q.question}</p>

          {q.answer && !answering && (
            <div className="mt-2 rounded-lg border border-green-100 bg-green-50/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
                <CheckCircle2 size={13} className="text-green-600" />
                <span className="font-semibold text-gray-800">{q.answeredByName || 'Author'}</span>
                <span className="text-gray-400">answered {timeAgo(q.answeredAt)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-gray-800">{q.answer}</p>
            </div>
          )}

          {answering && (
            <div className="mt-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAnswer(); } }}
                maxLength={MAX_CHARS}
                rows={3}
                autoFocus
                placeholder="Write your answer (Ctrl+Enter to post)"
                className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="mt-1.5 flex justify-end gap-2">
                <button onClick={() => { setAnswering(false); setDraft(q.answer || ''); }} className="rounded-lg px-2.5 py-1 text-[12px] text-gray-600 hover:bg-gray-100">Cancel</button>
                <button onClick={submitAnswer} disabled={busy || !draft.trim()} className="rounded-lg bg-blue-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {busy ? 'Saving…' : q.answer ? 'Save answer' : 'Post answer'}
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-1 text-[12px] text-red-600">{error}</p>}

          {!answering && (canAnswer || q.canDelete) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px]">
              {canAnswer && (
                <button onClick={() => { setDraft(q.answer || ''); setAnswering(true); }} className="font-medium text-blue-600 hover:text-blue-800">
                  {q.answer ? 'Edit answer' : 'Answer'}
                </button>
              )}
              {q.canDelete && (confirmDelete ? (
                <span className="flex items-center gap-2 text-red-700">
                  Delete this question?
                  <button onClick={remove} disabled={busy} className="font-semibold hover:underline disabled:opacity-50">Delete</button>
                  <button onClick={() => setConfirmDelete(false)} className="text-gray-500 hover:underline">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 text-gray-400 hover:text-red-600"><Trash2 size={12} /> Delete</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

type Filter = 'all' | 'open' | 'doc';

/**
 * Full-height Q&A pane that sits beside the reader. The thread scrolls on
 * its own and the ask box is pinned to the bottom, so a reader can keep the
 * document open and ask as they go. Refreshes every 20s while visible, so
 * new questions and answers show up without reloading.
 */
export function KbQuestions({
  articleId, published, canAnswer, contextFile, quote, onClearQuote, onOpenFile, focusSignal, onClose, onCountsChange,
}: {
  articleId: string;
  published: boolean;
  canAnswer: boolean;
  /** The document the reader currently has open, if any. */
  contextFile: KbFile | null;
  /** Text the reader selected and chose to ask about. */
  quote: string | null;
  onClearQuote: () => void;
  onOpenFile: (fileId: string) => void;
  /** Bumped by the page to focus the ask box (e.g. after "Ask about this"). */
  focusSignal: number;
  onClose?: () => void;
  onCountsChange?: (total: number, open: number) => void;
}) {
  const [questions, setQuestions] = useState<KbQuestion[] | null>(null);
  const [text, setText] = useState('');
  const [attachDoc, setAttachDoc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (initial: boolean) =>
      api.listKbQuestions(articleId)
        .then((qs) => { if (!cancelled) setQuestions(qs); })
        .catch((e) => { if (!cancelled && initial) { setQuestions([]); setError(e?.message || 'Failed to load questions'); } });
    setQuestions(null);
    load(true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(false); }, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [articleId]);

  useEffect(() => {
    if (questions) onCountsChange?.(questions.length, questions.filter((q) => !q.answer).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions]);

  // A newly opened document becomes the question's context again by default.
  useEffect(() => { setAttachDoc(true); }, [contextFile?.id]);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const ask = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const q = await api.askKbQuestion(articleId, text.trim(), {
        fileId: attachDoc ? contextFile?.id : null,
        quote,
      });
      setQuestions((prev) => [...(prev || []), q]);
      setText('');
      onClearQuote();
      setFilter('all');
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }));
    } catch (e: any) {
      setError(e?.message || 'Failed to post question');
    }
    setBusy(false);
  };

  const all = questions || [];
  const openCount = all.filter((q) => !q.answer).length;
  const docCount = contextFile ? all.filter((q) => q.fileId === contextFile.id).length : 0;
  const shown = all.filter((q) =>
    filter === 'open' ? !q.answer : filter === 'doc' ? !!contextFile && q.fileId === contextFile.id : true,
  );

  const chip = (id: Filter, label: string) => (
    <button
      onClick={() => setFilter(id)}
      className={`rounded-full px-2.5 py-0.5 text-[11.5px] ${filter === id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
    >
      {label}
    </button>
  );

  return (
    <section id="questions" className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex-shrink-0 border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-gray-800">
            <MessageCircleQuestion size={16} /> Questions
            {all.length > 0 && <span className="rounded-full bg-gray-100 px-1.5 text-[11px] font-medium text-gray-600">{all.length}</span>}
          </h2>
          {onClose && (
            <button onClick={onClose} title="Hide questions" className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X size={16} /></button>
          )}
        </div>
        {all.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chip('all', `All (${all.length})`)}
            {chip('open', `Awaiting answer (${openCount})`)}
            {contextFile && chip('doc', `This document (${docCount})`)}
          </div>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {questions === null ? (
          <div className="flex h-24 items-center justify-center"><div className="h-5 w-5 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <MessageCircleQuestion size={26} className="mx-auto mb-2 text-gray-300" />
            <p className="text-[13px] text-gray-600">
              {all.length === 0 ? 'No questions yet.' : filter === 'open' ? 'Every question has an answer.' : 'No questions about this document yet.'}
            </p>
            {published && all.length === 0 && (
              <p className="mt-1 text-[12px] text-gray-400">
                {canAnswer ? 'Readers’ questions will appear here, and you’ll get a notification for each one.' : 'Ask while you read: tip, select any text in the article to ask about it.'}
              </p>
            )}
          </div>
        ) : (
          <ul>
            {shown.map((q) => (
              <QuestionItem
                key={q.id}
                articleId={articleId}
                q={q}
                canAnswer={canAnswer}
                onOpenFile={onOpenFile}
                onChange={(updated) => setQuestions((prev) => (prev || []).map((x) => (x.id === updated.id ? updated : x)))}
                onDelete={(qid) => setQuestions((prev) => (prev || []).filter((x) => x.id !== qid))}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Ask box, pinned to the bottom of the pane */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-gray-50/80 px-4 py-3">
        {published ? (
          <>
            {(quote || (contextFile && attachDoc)) && (
              <div className="mb-2 space-y-1.5">
                {contextFile && attachDoc && (
                  <div className="flex items-center gap-1.5 rounded-md border border-blue-100 bg-white px-2 py-1 text-[11.5px] text-gray-600">
                    <FileText size={12} className="flex-shrink-0 text-blue-500" />
                    <span className="flex-shrink-0">About</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-800" title={contextFile.filename}>{contextFile.filename}</span>
                    <button onClick={() => setAttachDoc(false)} title="Ask about the article in general" className="rounded p-0.5 text-gray-400 hover:bg-gray-100"><X size={12} /></button>
                  </div>
                )}
                {quote && (
                  <div className="flex items-start gap-1.5 rounded-md border border-blue-100 bg-white px-2 py-1 text-[11.5px] text-gray-600">
                    <Quote size={12} className="mt-0.5 flex-shrink-0 text-blue-500" />
                    <span className="line-clamp-3 min-w-0 flex-1 italic">{quote}</span>
                    <button onClick={onClearQuote} title="Remove quote" className="rounded p-0.5 text-gray-400 hover:bg-gray-100"><X size={12} /></button>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } }}
                maxLength={MAX_CHARS}
                rows={2}
                placeholder={canAnswer ? 'Add a note or question for readers…' : 'Ask the author a question…'}
                className="max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={ask}
                disabled={busy || !text.trim()}
                title="Ask (Ctrl+Enter)"
                className="flex h-[44px] flex-shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-[12.5px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Send size={14} /> {busy ? 'Asking…' : 'Ask'}
              </button>
            </div>
            {error && <p className="mt-1 text-[12px] text-red-600">{error}</p>}
            <p className="mt-1 text-[11px] text-gray-400">
              {canAnswer ? 'Everyone who can read this article sees the questions and answers.' : 'The author is notified. Everyone who can read this article sees the answer.'}
            </p>
          </>
        ) : (
          <p className="text-[12px] text-gray-500">Readers can ask questions once this article is published.</p>
        )}
      </div>
    </section>
  );
}
