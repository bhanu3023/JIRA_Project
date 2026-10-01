'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';
import { api, type KbAccess, type KbArticle, type KbTeam } from '@/lib/api';
import { sanitizeForDisplay } from '@/lib/kb-sanitize';
import RichTextEditor from '@/components/ui/RichTextEditor';
import { BookOpen, Plus, Search, Globe, Users, ArrowLeft, Pencil, Trash2, ShieldCheck, X, FileText } from 'lucide-react';

type Scope = 'all' | 'mine' | 'drafts';
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All articles' },
  { id: 'mine', label: 'My articles' },
  { id: 'drafts', label: 'Drafts' },
];

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
  mode, initial, onCancel, onConfirm,
}: {
  mode: 'publish' | 'access';
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
          <h2 className="text-[15px] font-semibold text-gray-800">{mode === 'publish' ? 'Publish article' : 'Manage access'}</h2>
          <button onClick={onCancel} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"><X size={16} /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[13px] text-gray-600">Who should be able to read this article?</p>
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

function ArticleList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
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
    api.listKbArticles(scope, debounced || undefined)
      .then(setArticles)
      .catch((e) => { setArticles([]); setError(e?.message || 'Failed to load articles'); })
      .finally(() => setLoading(false));
  }, [scope, debounced]);

  return (
    <>
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-8 py-4">
        <h1 className="flex items-center gap-2 text-xl font-bold text-gray-800"><BookOpen size={20} /> KB Articles</h1>
        <button onClick={onNew} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-blue-700">
          <Plus size={15} /> New article
        </button>
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8">
        <div className="flex gap-1">
          {SCOPES.map((s) => (
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
            placeholder="Search articles"
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
              {debounced ? 'No articles match your search' : scope === 'drafts' ? 'No drafts' : 'No articles yet'}
            </p>
            {!debounced && <p className="mt-1 text-[13px] text-gray-500">Share what you know: write the first article.</p>}
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
                <p className="mt-2 text-[12px] text-gray-400">
                  {a.authorName || 'Unknown'} · {a.status === 'draft' ? `Edited ${formatDate(a.updatedAt)}` : `Published ${formatDate(a.publishedAt)}`}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Article view ─────────────────────────────────────────────────────────────

function ArticleView({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'publish' | 'access' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setArticle(null);
    setError(null);
    api.getKbArticle(id).then(setArticle).catch((e) => setError(e?.message || 'Failed to load article'));
  }, [id]);

  const html = useMemo(() => sanitizeForDisplay(article?.bodyHtml || ''), [article?.bodyHtml]);

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteKbArticle(id);
      onBack();
    } catch (e: any) {
      setError(e?.message || 'Failed to delete');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8 py-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-gray-600 hover:text-gray-900"><ArrowLeft size={15} /> All articles</button>
        {article?.canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {article.status === 'draft' ? (
              <button onClick={() => setDialog('publish')} className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700">Publish</button>
            ) : (
              <button onClick={() => setDialog('access')} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"><ShieldCheck size={14} /> Manage access</button>
            )}
            <button onClick={onEdit} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"><Pencil size={14} /> Edit</button>
            {confirmDelete ? (
              <span className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[12px] text-red-700">
                Delete this article?
                <button onClick={remove} disabled={deleting} className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete'}</button>
                <button onClick={() => setConfirmDelete(false)} className="rounded px-1.5 py-0.5 hover:bg-red-100">Cancel</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {error && <div className="mx-auto mb-4 max-w-4xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}
        {!article && !error && (
          <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
        )}
        {article && (
          <article className="mx-auto max-w-4xl rounded-xl border border-gray-200 bg-white px-8 py-7">
            <div className="mb-2"><VisibilityBadge article={article} /></div>
            <h1 className="text-2xl font-bold text-gray-900">{article.title}</h1>
            <p className="mt-1 text-[12.5px] text-gray-500">
              By {article.authorName || 'Unknown'}
              {article.publishedAt ? ` · Published ${formatDate(article.publishedAt)}` : ''}
              {article.updatedAt && article.updatedAt !== article.createdAt ? ` · Updated ${formatDate(article.updatedAt)}` : ''}
            </p>
            <div
              className="mt-6 break-words text-[14px] leading-relaxed text-[#172B4D] [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-md [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-100 [&_pre]:p-3 [&_table]:my-2 [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-300 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: html || '<p style="color:#9ca3af">This article has no content yet.</p>' }}
            />
          </article>
        )}
      </div>

      {dialog && article && (
        <AccessDialog
          mode={dialog}
          initial={dialog === 'access' ? { visibility: article.visibility, teams: article.teams.map((t) => t.key) } : undefined}
          onCancel={() => setDialog(null)}
          onConfirm={async (access) => {
            const updated = dialog === 'publish' ? await api.publishKbArticle(id, access) : await api.updateKbAccess(id, access);
            setArticle(updated);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────

function ArticleEditor({ id, onDone, onCancel }: { id: string | null; onDone: (id: string) => void; onCancel: () => void }) {
  const [articleId, setArticleId] = useState<string | null>(id);
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [title, setTitle] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [loaded, setLoaded] = useState(!id);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.getKbArticle(id)
      .then((a) => {
        if (!a.canManage) { onDone(a.id); return; }
        setTitle(a.title); setBodyHtml(a.bodyHtml || ''); setStatus(a.status); setLoaded(true);
      })
      .catch((e) => { setError(e?.message || 'Failed to load article'); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Creates the article on first save, updates it after that. Returns its id.
  const save = async (): Promise<string | null> => {
    if (!title.trim()) { setError('Add a title first'); return null; }
    setSaving(true);
    setError(null);
    try {
      const saved = articleId
        ? await api.updateKbArticle(articleId, { title, bodyHtml })
        : await api.createKbArticle({ title, bodyHtml });
      setArticleId(saved.id);
      return saved.id;
    } catch (e: any) {
      setError(e?.message || 'Failed to save');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || uploading;

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-8 py-3">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[13px] text-gray-600 hover:text-gray-900"><ArrowLeft size={15} /> {id ? 'Back to article' : 'All articles'}</button>
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
                disabled={busy}
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
          {uploading && <p className="text-[12px] text-gray-500">Uploading attachment… saving is paused until it finishes.</p>}
          {!loaded ? (
            <div className="flex h-40 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Article title"
                maxLength={300}
                className="mb-4 w-full border-0 border-b border-gray-200 pb-2 text-2xl font-bold text-gray-900 placeholder:text-gray-300 focus:border-blue-500 focus:outline-none"
              />
              <RichTextEditor
                value={bodyHtml}
                onChange={setBodyHtml}
                placeholder="Write the article: steps, screenshots, links…"
                minHeight="360px"
                onUploadingChange={setUploading}
              />
            </div>
          )}
        </div>
      </div>

      {publishOpen && articleId && (
        <AccessDialog
          mode="publish"
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

  if (!user) return null;

  let content;
  if (creating) {
    content = <ArticleEditor key="new" id={null} onDone={(newId) => router.replace(`/kb?id=${newId}`)} onCancel={() => router.push('/kb')} />;
  } else if (id && editing) {
    content = <ArticleEditor key={`edit-${id}`} id={id} onDone={(doneId) => router.replace(`/kb?id=${doneId}`)} onCancel={() => router.push(`/kb?id=${id}`)} />;
  } else if (id) {
    content = <ArticleView id={id} onBack={() => router.push('/kb')} onEdit={() => router.push(`/kb?id=${id}&edit=1`)} />;
  } else {
    content = <ArticleList onOpen={(aid) => router.push(`/kb?id=${aid}`)} onNew={() => router.push('/kb?new=1')} />;
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
