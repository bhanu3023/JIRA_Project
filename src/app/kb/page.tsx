'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';
import { api, type KbAccess, type KbArticle, type KbFile, type KbKind, type KbTeam } from '@/lib/api';
import { sanitizeForDisplay } from '@/lib/kb-sanitize';
import { KB_TEMPLATES, hasTemplatePlaceholders } from '@/lib/kb-templates';
import RichTextEditor from '@/components/ui/RichTextEditor';
import { KbDocumentEditor, KbDocumentList, FileIcon, downloadFile } from '@/components/kb/KbDocuments';
import { KbFileViewer, viewKindOf } from '@/components/kb/KbFileViewer';
import { KbQuestions } from '@/components/kb/KbQuestions';
import { BookOpen, Plus, Search, Globe, Users, ArrowLeft, Pencil, Trash2, ShieldCheck, X, FileText, Paperclip, MessageCircleQuestion, Maximize2, Minimize2, Download, Megaphone } from 'lucide-react';

// True when the editor HTML has something a reader would see (text or an image).
function hasBodyContent(html: string) {
  return /<img\b/i.test(html) || html.replace(/<[^>]+>/g, '').replace(/&nbsp;|​/g, '').trim().length > 0;
}

// KB articles and release notes share every feature; only the wording and the
// list they appear in differ.
const KINDS: Record<KbKind, { title: string; one: string; many: string }> = {
  kb: { title: 'KB Articles', one: 'article', many: 'articles' },
  release: { title: 'Release Notes', one: 'release note', many: 'release notes' },
};
const KIND_ORDER: KbKind[] = ['kb', 'release'];

function kindOf(value: string | null | undefined): KbKind {
  return value === 'release' ? 'release' : 'kb';
}

function listHref(kind: KbKind) {
  return kind === 'release' ? '/kb?type=release' : '/kb';
}

function KindIcon({ kind, size }: { kind: KbKind; size: number }) {
  return kind === 'release' ? <Megaphone size={size} /> : <BookOpen size={size} />;
}

type Scope = 'all' | 'mine' | 'drafts';
function scopesFor(kind: KbKind): { id: Scope; label: string }[] {
  const { many } = KINDS[kind];
  return [
    { id: 'all', label: `All ${many}` },
    { id: 'mine', label: `My ${many}` },
    { id: 'drafts', label: 'Drafts' },
  ];
}

function formatDate(d: string | null | undefined) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function VisibilityBadge({ article }: { article: KbArticle }) {
  if (article.status === 'draft') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Draft</span>;
  }
  if (article.visibility === 'org') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700"><Globe size={11} /> Organization</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700" title={article.teams.map((t) => t.name).join(', ')}>
      <Users size={11} /> {article.teams.map((t) => t.name).join(', ') || 'No teams'}
    </span>
  );
}

// ── Publish / Manage access dialog ───────────────────────────────────────────

function AccessDialog({
  mode, kind, initial, onCancel, onConfirm,
}: {
  mode: 'publish' | 'access';
  kind: KbKind;
  initial?: KbAccess;
  onCancel: () => void;
  onConfirm: (access: KbAccess) => Promise<void>;
}) {
  const [teams, setTeams] = useState<KbTeam[] | null>(null);
  const [visibility, setVisibility] = useState<'org' | 'teams'>(initial?.visibility || 'org');
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.teams || []));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getKbTeams().then(setTeams).catch((e) => { setTeams([]); setError(e?.message || 'Failed to load teams'); });
  }, []);

  const visibleTeams = (teams || []).filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const canConfirm = !busy && (visibility === 'org' || selected.size > 0);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ visibility, teams: visibility === 'teams' ? Array.from(selected) : [] });
    } catch (e: any) {
      setError(e?.message || 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-gray-800">{mode === 'publish' ? `Publish ${KINDS[kind].one}` : 'Manage access'}</h2>
          <button onClick={onCancel} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X size={16} /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[13px] text-gray-600">Who should be able to read this {KINDS[kind].one}?</p>
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${visibility === 'org' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200'}`}>
            <input type="radio" className="mt-0.5" checked={visibility === 'org'} onChange={() => setVisibility('org')} />
            <span>
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-gray-800"><Globe size={14} /> Entire organization</span>
              <span className="text-[12px] text-gray-500">Everyone who uses the ticketing tool.</span>
            </span>
          </label>
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${visibility === 'teams' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200'}`}>
            <input type="radio" className="mt-0.5" checked={visibility === 'teams'} onChange={() => setVisibility('teams')} />
            <span>
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-gray-800"><Users size={14} /> Specific teams</span>
              <span className="text-[12px] text-gray-500">Only members of the teams you choose.</span>
            </span>
          </label>

          {visibility === 'teams' && (
            <div className="rounded-lg border border-gray-200">
              <div className="border-b border-gray-100 p-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter teams"
                  className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="max-h-56 overflow-y-auto p-1">
                {teams === null && <p className="px-2 py-3 text-[12px] text-gray-400">Loading teams…</p>}
                {teams !== null && visibleTeams.length === 0 && <p className="px-2 py-3 text-[12px] text-gray-400">No teams found.</p>}
                {visibleTeams.map((t) => (
                  <label key={t.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50">
                    <input type="checkbox" checked={selected.has(t.key)} onChange={() => toggle(t.key)} />
                    <span className="flex-1">{t.name}</span>
                    <span className="text-[11px] text-gray-400">{t.memberCount} member{t.memberCount === 1 ? '' : 's'}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {visibility === 'teams' && selected.size === 0 && <p className="text-[12px] text-gray-500">Choose at least one team.</p>}
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button onClick={onCancel} className="rounded-lg px-3 py-2 text-[13px] text-gray-600 hover:bg-gray-100">Cancel</button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving…' : mode === 'publish' ? 'Publish' : 'Save access'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Article list ─────────────────────────────────────────────────────────────

function ArticleList({ kind, onKindChange, onOpen, onNew }: {
  kind: KbKind;
  onKindChange: (kind: KbKind) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { one, many } = KINDS[kind];
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // Ignore a response that lands after the user has switched lists.
    let stale = false;
    api.listKbArticles(kind, scope, debounced || undefined)
      .then((rows) => { if (!stale) setArticles(rows); })
      .catch((e) => { if (!stale) { setArticles([]); setError(e?.message || `Failed to load ${many}`); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [kind, scope, debounced, many]);

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8 py-4">
        <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1">
          {KIND_ORDER.map((k) => (
            <button key={k} onClick={() => onKindChange(k)}
              className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[15px] font-semibold transition-colors ${k === kind ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <KindIcon kind={k} size={17} /> {KINDS[k].title}
            </button>
          ))}
        </div>
        <button onClick={onNew} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-blue-700">
          <Plus size={15} /> New {one}
        </button>
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8">
        <div className="flex gap-1">
          {scopesFor(kind).map((s) => (
            <button key={s.id} onClick={() => setScope(s.id)}
              className={`border-b-2 px-4 py-3 text-[13px] transition-colors ${scope === s.id ? 'border-blue-600 font-semibold text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative my-2 w-full max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${many}`}
            className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}
        {loading ? (
          <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center">
            <FileText size={28} className="mb-2 text-gray-300" />
            <p className="text-[14px] font-medium text-gray-700">
              {debounced ? `No ${many} match your search` : scope === 'drafts' ? 'No drafts' : `No ${many} yet`}
            </p>
            {!debounced && (
              <p className="mt-1 text-[13px] text-gray-500">
                {kind === 'release' ? 'Let everyone know what shipped: write the first release note.' : 'Share what you know: write the first article.'}
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            {articles.map((a) => (
              <button key={a.id} onClick={() => onOpen(a.id)}
                className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-left transition-shadow hover:border-blue-300 hover:shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[15px] font-semibold text-gray-800">{a.title}</h3>
                  <VisibilityBadge article={a} />
                </div>
                {a.excerpt && <p className="mt-1.5 line-clamp-2 text-[13px] text-gray-600">{a.excerpt}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-400">
                  <span>{a.authorName || 'Unknown'} · {a.status === 'draft' ? `Edited ${formatDate(a.updatedAt)}` : `Published ${formatDate(a.publishedAt)}`}</span>
                  {a.fileCount > 0 && <span className="flex items-center gap-1"><Paperclip size={12} /> {a.fileCount} document{a.fileCount === 1 ? '' : 's'}</span>}
                  {a.questionCount > 0 && <span className="flex items-center gap-1"><MessageCircleQuestion size={12} /> {a.questionCount} question{a.questionCount === 1 ? '' : 's'}</span>}
                  {a.canManage && a.openQuestionCount > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{a.openQuestionCount} awaiting answer</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Article view ─────────────────────────────────────────────────────────────
//
// A reading workspace that fills the screen: the reader on the left and the
// Questions pane on the right, each scrolling on its own (the ask box stays
// pinned), so a reader can read and ask at the same time.
//
//  - Overview: the article text plus its list of documents.
//  - Document mode (a document is open): the document fills the whole reader
//    area under one slim bar (document tabs, article text toggle, download) --
//    no page scroll around it, no nested scrollbars. Word/PowerPoint pages are
//    scaled to the available width (KbFileViewer).
//  - The divider between reader and questions can be dragged to resize.
//  - Narrow screens: the Questions pane is a slide-over from a floating button.
//  - Focus mode takes the whole workspace full screen, questions included.

function useIsWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return wide;
}

type SelectionAsk = { x: number; y: number; text: string; fileId: string | null };

const Q_WIDTH_KEY = 'kb_questions_width';
const Q_WIDTH_DEFAULT = 360;
const Q_WIDTH_MIN = 300;
const READER_MIN = 420;

function readStoredWidth() {
  try {
    const n = Number(localStorage.getItem(Q_WIDTH_KEY));
    return Number.isFinite(n) && n >= Q_WIDTH_MIN ? n : Q_WIDTH_DEFAULT;
  } catch { return Q_WIDTH_DEFAULT; }
}

const ARTICLE_BODY_CLASS = 'break-words text-[14px] leading-relaxed text-[#172B4D] [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-md [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-100 [&_pre]:p-3 [&_table]:my-2 [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-300 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5';

function ArticleView({ id, onBack, onEdit }: { id: string; onBack: (kind: KbKind) => void; onEdit: () => void }) {
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'publish' | 'access' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isWide = useIsWide();
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [showQuestions, setShowQuestions] = useState(true); // wide screens
  const [drawerOpen, setDrawerOpen] = useState(false);      // narrow screens
  const [focusMode, setFocusMode] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [counts, setCounts] = useState({ total: 0, open: 0 });
  const [selectionAsk, setSelectionAsk] = useState<SelectionAsk | null>(null);
  const [qWidth, setQWidth] = useState(Q_WIDTH_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQWidth(readStoredWidth()); }, []);

  useEffect(() => {
    setArticle(null);
    setError(null);
    setQuote(null);
    api.getKbArticle(id)
      .then((a) => {
        setArticle(a);
        // The first readable document opens straight away -- for an article
        // that is mostly its uploaded document, that document IS the article.
        setOpenFileId((a.files || []).find((f) => viewKindOf(f))?.id ?? null);
      })
      .catch((e) => setError(e?.message || 'Failed to load article'));
  }, [id]);

  // Arriving from a bell notification (/kb?id=...#questions): show the pane.
  useEffect(() => {
    if (article && window.location.hash === '#questions') {
      if (isWide) setShowQuestions(true); else setDrawerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id]);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !drawerOpen) setFocusMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, drawerOpen]);

  // Drag the divider to resize the Questions pane.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const max = Math.max(Q_WIDTH_MIN, rect.width - READER_MIN);
      setQWidth(Math.round(Math.min(max, Math.max(Q_WIDTH_MIN, rect.right - e.clientX))));
    };
    const onUp = () => setResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [resizing]);
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(Q_WIDTH_KEY, String(qWidth)); } catch {}
  }, [resizing, qWidth]);

  const html = useMemo(() => sanitizeForDisplay(article?.bodyHtml || ''), [article?.bodyHtml]);
  const files = article?.files || [];
  const readableFiles = files.filter((f) => viewKindOf(f));
  const docFile = files.find((f) => f.id === openFileId && viewKindOf(f)) || null;

  const openQuestions = () => {
    if (isWide) setShowQuestions(true); else setDrawerOpen(true);
    setFocusSignal((n) => n + 1);
  };

  const openFile = (fileId: string) => {
    setOpenFileId(fileId);
    if (!isWide) setDrawerOpen(false);
  };

  // Select text anywhere in the reader -> a floating "Ask about this" button.
  const onReaderMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().replace(/\s+/g, ' ').trim() || '';
      if (!sel || sel.rangeCount === 0 || text.length < 2 || !readerRef.current) { setSelectionAsk(null); return; }
      const range = sel.getRangeAt(0);
      if (!readerRef.current.contains(range.commonAncestorContainer)) { setSelectionAsk(null); return; }
      const rect = range.getBoundingClientRect();
      const node = range.commonAncestorContainer;
      const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
      const fileId = el?.closest('[data-kb-file-id]')?.getAttribute('data-kb-file-id') || null;
      setSelectionAsk({ x: rect.left + rect.width / 2, y: rect.top, text: text.slice(0, 1000), fileId });
    }, 0);
  };

  const askAboutSelection = () => {
    if (!selectionAsk) return;
    setQuote(selectionAsk.text);
    if (selectionAsk.fileId) setOpenFileId(selectionAsk.fileId);
    setSelectionAsk(null);
    window.getSelection()?.removeAllRanges();
    openQuestions();
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteKbArticle(id);
      onBack(kind);
    } catch (e: any) {
      setError(e?.message || 'Failed to delete');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const downloadCurrent = async () => {
    if (!article || !docFile) return;
    setDownloading(true);
    try { await downloadFile(article.id, docFile); } catch (e: any) { setError(e?.message || 'Download failed'); }
    setDownloading(false);
  };

  const questionsVisible = isWide ? showQuestions : drawerOpen;
  const published = article?.status === 'published';
  const kind = kindOf(article?.kind);
  const meta = article
    ? `By ${article.authorName || 'Unknown'}${article.publishedAt ? ` · ${formatDate(article.publishedAt)}` : ''}`
    : '';

  return (
    <div className={focusMode ? 'fixed inset-0 z-50 flex flex-col bg-gray-50' : 'flex h-full min-h-0 flex-col'}>
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 sm:px-4">
        {focusMode ? (
          <button onClick={() => setFocusMode(false)} className="flex flex-shrink-0 items-center gap-1.5 text-[13px] text-gray-600 hover:text-gray-900"><Minimize2 size={15} /> Exit focus</button>
        ) : (
          <button onClick={() => onBack(kind)} className="flex flex-shrink-0 items-center gap-1.5 text-[13px] text-gray-600 hover:text-gray-900"><ArrowLeft size={15} /> All {KINDS[kind].many}</button>
        )}
        <span className="mx-1 hidden h-4 w-px flex-shrink-0 bg-gray-200 sm:block" />
        <div className="hidden min-w-0 flex-1 items-baseline gap-2 sm:flex">
          <span className="truncate text-[13.5px] font-semibold text-gray-800">{article?.title}</span>
          <span className="hidden flex-shrink-0 text-[12px] text-gray-400 xl:inline">{meta}</span>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          {article?.canManage && !focusMode && (
            <>
              {article.status === 'draft' ? (
                <button onClick={() => setDialog('publish')} className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700">Publish</button>
              ) : (
                <button onClick={() => setDialog('access')} title="Manage access" className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"><ShieldCheck size={14} /> <span className="hidden 2xl:inline">Manage access</span></button>
              )}
              <button onClick={onEdit} title="Edit" className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"><Pencil size={14} /> <span className="hidden 2xl:inline">Edit</span></button>
              {confirmDelete ? (
                <span className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[12px] text-red-700">
                  Delete?
                  <button onClick={remove} disabled={deleting} className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete'}</button>
                  <button onClick={() => setConfirmDelete(false)} className="rounded px-1.5 py-0.5 hover:bg-red-100">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmDelete(true)} title="Delete" className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-red-600 hover:bg-red-50"><Trash2 size={14} /> <span className="hidden 2xl:inline">Delete</span></button>
              )}
              <span className="mx-0.5 h-5 w-px bg-gray-200" />
            </>
          )}
          {article && (
            <>
              <button
                onClick={() => (questionsVisible ? (isWide ? setShowQuestions(false) : setDrawerOpen(false)) : openQuestions())}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] ${questionsVisible ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
              >
                <MessageCircleQuestion size={14} /> Questions
                {counts.total > 0 && <span className="rounded-full bg-white px-1.5 text-[11px] font-semibold text-gray-700 ring-1 ring-gray-200">{counts.total}</span>}
                {article.canManage && counts.open > 0 && <span className="h-2 w-2 rounded-full bg-amber-500" title={`${counts.open} awaiting answer`} />}
              </button>
              {!focusMode && (
                <button onClick={() => setFocusMode(true)} title="Focus mode: full screen, questions included" className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50">
                  <Maximize2 size={14} /> <span className="hidden xl:inline">Focus</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Workspace */}
      <div ref={workspaceRef} className="flex min-h-0 flex-1">
        <div
          ref={readerRef}
          onMouseUp={onReaderMouseUp}
          onScrollCapture={() => { if (selectionAsk) setSelectionAsk(null); }}
          className="flex min-w-0 flex-1 flex-col"
        >
          {error && <div className="m-3 flex-shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">{error}</div>}
          {!article && !error && (
            <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
          )}

          {article && docFile && (
            <>
              {/* Document bar */}
              <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-gray-200 bg-white px-2 py-1.5">
                <button onClick={() => setOpenFileId(null)} title="Back to the article overview" className="flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-100">
                  <ArrowLeft size={13} /> Overview
                </button>
                <span className="h-4 w-px flex-shrink-0 bg-gray-200" />
                <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                  {readableFiles.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setOpenFileId(f.id)}
                      title={f.filename}
                      className={`flex max-w-[260px] flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${f.id === docFile.id ? 'bg-blue-50 font-medium text-blue-700 ring-1 ring-blue-200' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      <FileIcon kind={viewKindOf(f)} />
                      <span className="truncate">{f.filename}</span>
                    </button>
                  ))}
                </div>
                {html && (
                  <button
                    onClick={() => setNotesOpen(!notesOpen)}
                    className={`flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] ${notesOpen ? 'bg-gray-100 text-gray-800' : 'text-gray-600 hover:bg-gray-100'}`}
                  >
                    <FileText size={13} /> Article text
                  </button>
                )}
                <button onClick={downloadCurrent} disabled={downloading} title={`Download ${docFile.filename}`} className="flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                  <Download size={13} /> <span className="hidden md:inline">{downloading ? 'Downloading…' : 'Download'}</span>
                </button>
              </div>
              {notesOpen && html && (
                <div className={`max-h-[38%] flex-shrink-0 overflow-auto border-b border-gray-200 bg-white px-6 py-4 ${ARTICLE_BODY_CLASS}`} dangerouslySetInnerHTML={{ __html: html }} />
              )}
              {/* The document fills everything that's left */}
              <div className="min-h-0 flex-1" data-kb-file-id={docFile.id}>
                <KbFileViewer key={docFile.id} articleId={article.id} file={docFile} />
              </div>
            </>
          )}

          {article && !docFile && (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-8">
              <article className="mx-auto max-w-4xl rounded-xl border border-gray-200 bg-white px-5 py-6 sm:px-8 sm:py-7">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {kind === 'release' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700"><Megaphone size={11} /> Release note</span>
                  )}
                  <VisibilityBadge article={article} />
                </div>
                <h1 className="text-2xl font-bold text-gray-900">{article.title}</h1>
                <p className="mt-1 text-[12.5px] text-gray-500">
                  {meta}
                  {article.updatedAt && article.updatedAt !== article.createdAt ? ` · Updated ${formatDate(article.updatedAt)}` : ''}
                </p>
                {published && (
                  <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-blue-50/70 px-3 py-2 text-[12px] text-blue-800">
                    <MessageCircleQuestion size={14} className="flex-shrink-0" />
                    {article.canManage
                      ? 'Readers can ask questions while they read. You’ll be notified and can answer from the Questions pane.'
                      : 'Something unclear? Ask in the Questions pane while you read, or select any text and click “Ask about this”.'}
                  </p>
                )}
                {html && <div className={`mt-6 ${ARTICLE_BODY_CLASS}`} dangerouslySetInnerHTML={{ __html: html }} />}
                {!html && files.length === 0 && <p className="mt-6 text-[14px] text-gray-400">This {KINDS[kind].one} has no content yet.</p>}
                <KbDocumentList articleId={article.id} files={files} openId={openFileId} onOpenChange={setOpenFileId} />
              </article>
            </div>
          )}
        </div>

        {/* Drag handle between reader and questions (wide screens) */}
        {article && isWide && showQuestions && (
          <div
            onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
            onDoubleClick={() => setQWidth(Q_WIDTH_DEFAULT)}
            title="Drag to resize · double-click to reset"
            className={`group relative w-1.5 flex-shrink-0 cursor-col-resize border-l border-gray-200 ${resizing ? 'bg-blue-400' : 'bg-gray-100 hover:bg-blue-300'}`}
          >
            <span className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-gray-400 group-hover:bg-white" />
          </div>
        )}

        {/* Questions: a side pane on wide screens, a slide-over on narrow ones.
            Mounted once either way so its live refresh keeps the counts current. */}
        {article && (
          <aside
            style={isWide ? { width: qWidth } : undefined}
            className={`${drawerOpen ? 'fixed inset-y-0 right-0 z-[60] flex w-full shadow-2xl sm:w-[420px]' : 'hidden'} lg:static lg:z-auto lg:flex-shrink-0 lg:shadow-none ${showQuestions ? 'lg:flex' : 'lg:hidden'}`}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <KbQuestions
                articleId={article.id}
                published={published}
                canAnswer={article.canManage}
                contextFile={docFile}
                quote={quote}
                onClearQuote={() => setQuote(null)}
                onOpenFile={openFile}
                focusSignal={focusSignal}
                onClose={() => { if (isWide) setShowQuestions(false); else setDrawerOpen(false); }}
                onCountsChange={(total, open) => setCounts({ total, open })}
              />
            </div>
          </aside>
        )}
      </div>

      {/* While dragging, a full-screen layer keeps the mouse from being swallowed by a PDF iframe */}
      {resizing && <div className="fixed inset-0 z-[80] cursor-col-resize" />}

      {drawerOpen && !isWide && <div className="fixed inset-0 z-[55] bg-black/40" onClick={() => setDrawerOpen(false)} />}

      {/* Floating entry point when the pane is out of view */}
      {article && published && !questionsVisible && (
        <button
          onClick={openQuestions}
          className="fixed bottom-6 right-6 z-[45] flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2.5 text-[13px] font-medium text-white shadow-lg hover:bg-blue-700"
        >
          <MessageCircleQuestion size={16} /> Ask a question{counts.total > 0 ? ` · ${counts.total}` : ''}
        </button>
      )}

      {/* "Ask about this" for selected text */}
      {selectionAsk && published && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAboutSelection}
          style={{ left: Math.max(70, Math.min(selectionAsk.x, window.innerWidth - 70)), top: Math.max(8, selectionAsk.y - 40) }}
          className="fixed z-[70] flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg hover:bg-gray-800"
        >
          <MessageCircleQuestion size={13} /> Ask about this
        </button>
      )}

      {dialog && article && (
        <AccessDialog
          mode={dialog}
          kind={kind}
          initial={dialog === 'access' ? { visibility: article.visibility, teams: article.teams.map((t) => t.key) } : undefined}
          onCancel={() => setDialog(null)}
          onConfirm={async (access) => {
            const updated = dialog === 'publish' ? await api.publishKbArticle(id, access) : await api.updateKbAccess(id, access);
            // publish/access responses don't carry the file list -- keep the one we have.
            setArticle((prev) => ({ ...updated, files: prev?.files }));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────

function ArticleEditor({ id, newKind = 'kb', onDone, onCancel }: {
  id: string | null;
  newKind?: KbKind; // what to create when id is null
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [articleId, setArticleId] = useState<string | null>(id);
  const [kind, setKind] = useState<KbKind>(newKind);
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [title, setTitle] = useState('');
  // A new article or release note opens with its template filled in.
  const [bodyHtml, setBodyHtml] = useState(id ? '' : KB_TEMPLATES[newKind]);
  const [loaded, setLoaded] = useState(!id);
  const [uploading, setUploading] = useState(false);
  const [docsUploading, setDocsUploading] = useState(false);
  const [files, setFiles] = useState<KbFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.getKbArticle(id)
      .then((a) => {
        if (!a.canManage) { onDone(a.id); return; }
        setTitle(a.title); setBodyHtml(a.bodyHtml || ''); setFiles(a.files || []); setStatus(a.status); setKind(kindOf(a.kind)); setLoaded(true);
      })
      .catch((e) => { setError(e?.message || 'Failed to load article'); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Creates the article on first save, updates it after that. Returns its id.
  // An in-flight save is shared, so two quick document uploads on a brand-new
  // article can't each create their own draft.
  const savePromise = useRef<Promise<string | null> | null>(null);
  const save = (): Promise<string | null> => {
    if (savePromise.current) return savePromise.current;
    if (!title.trim()) { setError('Add a title first'); return Promise.resolve(null); }
    setSaving(true);
    setError(null);
    const p = (async () => {
      try {
        const saved = articleId
          ? await api.updateKbArticle(articleId, { title, bodyHtml })
          : await api.createKbArticle({ title, bodyHtml, kind });
        setArticleId(saved.id);
        return saved.id;
      } catch (e: any) {
        setError(e?.message || 'Failed to save');
        return null;
      } finally {
        setSaving(false);
        savePromise.current = null;
      }
    })();
    savePromise.current = p;
    return p;
  };

  const busy = saving || uploading || docsUploading;
  const template = KB_TEMPLATES[kind];
  const untouchedTemplate = bodyHtml === template;
  const placeholdersLeft = !untouchedTemplate && hasTemplatePlaceholders(bodyHtml);
  // Written text is optional: an article can be just its uploaded documents.
  // The template on its own doesn't count as content.
  const hasContent = (hasBodyContent(bodyHtml) && !untouchedTemplate) || files.length > 0;

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8 py-3">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[13px] text-gray-600 hover:text-gray-900"><ArrowLeft size={15} /> {id ? `Back to ${KINDS[kind].one}` : `All ${KINDS[kind].many}`}</button>
        <div className="flex items-center gap-2">
          {notice && <span className="text-[12px] text-green-600">{notice}</span>}
          {status === 'draft' ? (
            <>
              <button
                disabled={busy}
                onClick={async () => { if (await save()) { setNotice('Draft saved'); setTimeout(() => setNotice(null), 2500); } }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Save draft
              </button>
              <button
                disabled={busy || !hasContent}
                title={hasContent ? undefined : 'Write something or upload a document first'}
                onClick={async () => { if (await save()) setPublishOpen(true); }}
                className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Publish…
              </button>
            </>
          ) : (
            <button
              disabled={busy}
              onClick={async () => { const savedId = await save(); if (savedId) onDone(savedId); }}
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save changes
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="mx-auto max-w-4xl space-y-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}
          {(uploading || docsUploading) && <p className="text-[12px] text-gray-500">Uploading… saving is paused until it finishes.</p>}
          {!loaded ? (
            <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === 'release' ? 'Release note title, e.g. Version 4.2 – October 2026' : 'Article title'}
                maxLength={300}
                className="mb-4 w-full border-0 border-b border-gray-200 pb-2 text-2xl font-bold text-gray-900 placeholder:text-gray-300 focus:border-blue-500 focus:outline-none"
              />
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="text-gray-500">
                  {untouchedTemplate
                    ? `Template: replace the [bracketed] parts and delete sections that don't apply.`
                    : placeholdersLeft
                      ? <span className="text-amber-700">Some [bracketed] template text hasn&apos;t been replaced yet.</span>
                      : null}
                </span>
                {untouchedTemplate ? (
                  <button onClick={() => setBodyHtml('')} className="rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100">Start blank</button>
                ) : !hasBodyContent(bodyHtml) ? (
                  <button onClick={() => setBodyHtml(template)} className="rounded-md px-2 py-1 font-medium text-blue-600 hover:bg-blue-50">
                    Use {KINDS[kind].one} template
                  </button>
                ) : null}
              </div>
              <RichTextEditor
                value={bodyHtml}
                onChange={setBodyHtml}
                placeholder={kind === 'release'
                  ? 'What changed: new features, improvements, fixes… (optional if you upload a document below)'
                  : 'Write the article: steps, screenshots, links… (optional if you upload a document below)'}
                minHeight="300px"
                onUploadingChange={setUploading}
              />
            </div>
          )}
          {loaded && (
            <KbDocumentEditor
              articleId={articleId}
              files={files}
              onFilesChange={setFiles}
              ensureSaved={save}
              onUploadingChange={setDocsUploading}
            />
          )}
        </div>
      </div>

      {publishOpen && articleId && (
        <AccessDialog
          mode="publish"
          kind={kind}
          onCancel={() => setPublishOpen(false)}
          onConfirm={async (access) => {
            await api.publishKbArticle(articleId, access);
            onDone(articleId);
          }}
        />
      )}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function KbInner() {
  const user = useStore((s) => s.user);
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const editing = params.get('edit') === '1';
  const creating = params.get('new') === '1';
  // Which list: /kb is KB articles, /kb?type=release is release notes.
  const kind = kindOf(params.get('type'));
  const typeParam = kind === 'release' ? '&type=release' : '';

  if (!user) return null;

  let content;
  if (creating) {
    content = <ArticleEditor key={`new-${kind}`} id={null} newKind={kind} onDone={(newId) => router.replace(`/kb?id=${newId}`)} onCancel={() => router.push(listHref(kind))} />;
  } else if (id && editing) {
    content = <ArticleEditor key={`edit-${id}`} id={id} onDone={(doneId) => router.replace(`/kb?id=${doneId}`)} onCancel={() => router.push(`/kb?id=${id}`)} />;
  } else if (id) {
    content = <ArticleView id={id} onBack={(k) => router.push(listHref(k))} onEdit={() => router.push(`/kb?id=${id}&edit=1`)} />;
  } else {
    content = (
      <ArticleList
        kind={kind}
        onKindChange={(k) => router.replace(listHref(k))}
        onOpen={(aid) => router.push(`/kb?id=${aid}`)}
        onNew={() => router.push(`/kb?new=1${typeParam}`)}
      />
    );
  }

  return <div className="flex h-full min-h-0 flex-col overflow-auto bg-gray-50">{content}</div>;
}

export default function KbPage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>}>
      <KbInner />
    </Suspense>
  );
}
