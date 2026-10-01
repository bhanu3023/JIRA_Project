'use client';

import { useEffect, useState } from 'react';
import { api, type KbQuestion } from '@/lib/api';
import { CheckCircle2, MessageCircleQuestion, Trash2 } from 'lucide-react';

const MAX_CHARS = 4000;

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
  articleId, q, canAnswer, onChange, onDelete,
}: {
  articleId: string;
  q: KbQuestion;
  canAnswer: boolean;
  onChange: (q: KbQuestion) => void;
  onDelete: (id: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState(q.answer || '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitAnswer = async () => {
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
    <li className="border-b border-gray-100 py-3 last:border-b-0">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-semibold text-blue-700">{initials(q.askerName)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
            <span className="font-semibold text-gray-800">{q.askerName || 'Unknown'}</span>
            <span className="text-gray-400">{timeAgo(q.createdAt)}</span>
            {!q.answer && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700">Awaiting answer</span>}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-gray-800">{q.question}</p>

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
                maxLength={MAX_CHARS}
                rows={3}
                autoFocus
                placeholder="Write your answer"
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

/** Reader Q&A thread for one article. The author (or an admin) answers. */
export function KbQuestions({
  articleId, published, canAnswer, onCountsChange,
}: {
  articleId: string;
  published: boolean;
  canAnswer: boolean;
  onCountsChange?: (total: number, open: number) => void;
}) {
  const [questions, setQuestions] = useState<KbQuestion[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuestions(null);
    api.listKbQuestions(articleId)
      .then(setQuestions)
      .catch((e) => { setQuestions([]); setError(e?.message || 'Failed to load questions'); });
  }, [articleId]);

  useEffect(() => {
    if (questions) onCountsChange?.(questions.length, questions.filter((q) => !q.answer).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions]);

  // Arriving from a bell notification (/kb?id=...#questions): bring the panel into view.
  useEffect(() => {
    if (questions && typeof window !== 'undefined' && window.location.hash === '#questions') {
      document.getElementById('questions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [questions]);

  const ask = async () => {
    setBusy(true); setError(null);
    try {
      const q = await api.askKbQuestion(articleId, text.trim());
      setQuestions((prev) => [...(prev || []), q]);
      setText('');
    } catch (e: any) {
      setError(e?.message || 'Failed to post question');
    }
    setBusy(false);
  };

  const open = (questions || []).filter((q) => !q.answer).length;

  return (
    <section id="questions" className="scroll-mt-4 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-gray-800">
          <MessageCircleQuestion size={16} /> Questions
          {questions && questions.length > 0 && <span className="rounded-full bg-gray-100 px-1.5 text-[11px] font-medium text-gray-600">{questions.length}</span>}
        </h2>
        {open > 0 && <span className="text-[11px] font-medium text-amber-700">{open} awaiting answer</span>}
      </div>

      <div className="px-4 py-3">
        {published ? (
          <div className="mb-1">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_CHARS}
              rows={3}
              placeholder={canAnswer ? 'Add a question or note for readers' : 'Something unclear? Ask the author a question'}
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-gray-400">{canAnswer ? 'Readers see every question and answer.' : 'The author is notified, and everyone who can read this article sees the answer.'}</span>
              <button onClick={ask} disabled={busy || !text.trim()} className="flex-shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? 'Posting…' : 'Ask question'}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-gray-500">Readers can ask questions once this article is published.</p>
        )}
        {error && <p className="mt-1 text-[12px] text-red-600">{error}</p>}

        {questions === null ? (
          <div className="flex h-20 items-center justify-center"><div className="h-5 w-5 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
        ) : questions.length === 0 ? (
          published && <p className="py-3 text-center text-[12px] text-gray-400">No questions yet.</p>
        ) : (
          <ul className="mt-2">
            {questions.map((q) => (
              <QuestionItem
                key={q.id}
                articleId={articleId}
                q={q}
                canAnswer={canAnswer}
                onChange={(updated) => setQuestions((prev) => (prev || []).map((x) => (x.id === updated.id ? updated : x)))}
                onDelete={(qid) => setQuestions((prev) => (prev || []).filter((x) => x.id !== qid))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
