'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type KbFile } from '@/lib/api';
import { viewKindOf, type ViewKind } from '@/components/kb/KbFileViewer';
import { BookOpenText, Download, FileSpreadsheet, FileText, Image as ImageIcon, Paperclip, Presentation, Trash2, Upload, X } from 'lucide-react';

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileIcon({ kind }: { kind: ViewKind | null }) {
  if (kind === 'image') return <ImageIcon size={16} className="text-purple-500" />;
  if (kind === 'pdf') return <FileText size={16} className="text-red-500" />;
  if (kind === 'sheet') return <FileSpreadsheet size={16} className="text-green-600" />;
  if (kind === 'pptx') return <Presentation size={16} className="text-orange-500" />;
  return <FileText size={16} className="text-blue-500" />;
}

export async function downloadFile(articleId: string, file: KbFile) {
  const blob = await api.fetchKbFileBlob(articleId, file.id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Read-only list of an article's documents. Which one is open is owned by
 * the page (so the Questions pane knows what the reader is looking at).
 */
export function KbDocumentList({
  articleId, files, openId, onOpenChange,
}: {
  articleId: string;
  files: KbFile[];
  openId: string | null;
  onOpenChange: (fileId: string | null) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (files.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-gray-700"><Paperclip size={14} /> Documents ({files.length})</h2>
      {error && <p className="mb-2 text-[12px] text-red-600">{error}</p>}
      <div className="space-y-2">
        {files.map((f) => {
          const kind = viewKindOf(f);
          return (
            <div
              key={f.id}
              id={`kb-file-${f.id}`}
              data-kb-file-id={f.id}
              className="overflow-hidden rounded-lg border border-gray-200"
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <FileIcon kind={kind} />
                <button
                  disabled={!kind}
                  onClick={() => onOpenChange(f.id)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-gray-800 enabled:hover:text-blue-700 disabled:cursor-default"
                  title={f.filename}
                >
                  {f.filename}
                </button>
                <span className="text-[11px] text-gray-400">{formatSize(f.size)}</span>
                {kind && (
                  <button
                    onClick={() => onOpenChange(f.id)}
                    className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-700"
                  >
                    <BookOpenText size={13} /> Read
                  </button>
                )}
                <button
                  disabled={busyId === f.id}
                  onClick={async () => {
                    setBusyId(f.id); setError(null);
                    try { await downloadFile(articleId, f); } catch (e: any) { setError(e?.message || 'Download failed'); }
                    setBusyId(null);
                  }}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  <Download size={13} /> {busyId === f.id ? 'Downloading…' : 'Download'}
                </button>
              </div>
              {!kind && (
                <p className="border-t border-gray-100 px-3 py-1.5 text-[11.5px] text-gray-500">
                  This file type can&apos;t be shown in the browser. Download it to read it.
                  {/\.(doc|ppt)$/i.test(f.filename) && ' (Older .doc/.ppt files can be re-saved as .docx/.pptx to read them here.)'}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

type PendingUpload = { key: string; name: string; pct: number; error?: string };

/**
 * Editor-side documents section. `ensureSaved` creates the draft on first
 * upload (files need an article id to hang off) and returns that id.
 */
export function KbDocumentEditor({
  articleId, files, onFilesChange, ensureSaved, onUploadingChange,
}: {
  articleId: string | null;
  files: KbFile[];
  onFilesChange: (files: KbFile[]) => void;
  ensureSaved: () => Promise<string | null>;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = pending.some((p) => !p.error);
  useEffect(() => { onUploadingChange?.(active); }, [active, onUploadingChange]);

  const uploadAll = async (list: FileList | File[]) => {
    const chosen = Array.from(list);
    if (chosen.length === 0) return;
    setError(null);
    const id = articleId || (await ensureSaved());
    if (!id) return;
    for (const file of chosen) {
      const key = `${file.name}-${Math.random().toString(36).slice(2)}`;
      if (file.size > 50 * 1024 * 1024) {
        setPending((p) => [...p, { key, name: file.name, pct: 0, error: 'Too large (max 50 MB)' }]);
        continue;
      }
      setPending((p) => [...p, { key, name: file.name, pct: 0 }]);
      try {
        const saved = await api.uploadKbFile(id, file, (pct) => setPending((p) => p.map((u) => (u.key === key ? { ...u, pct } : u))));
        onFilesChange([...filesRef.current, saved]);
        setPending((p) => p.filter((u) => u.key !== key));
      } catch (e: any) {
        setPending((p) => p.map((u) => (u.key === key ? { ...u, error: e?.message || 'Upload failed' } : u)));
      }
    }
  };

  const remove = async (f: KbFile) => {
    if (!articleId) return;
    setRemovingId(f.id); setError(null);
    try {
      await api.deleteKbFile(articleId, f.id);
      onFilesChange(filesRef.current.filter((x) => x.id !== f.id));
    } catch (e: any) {
      setError(e?.message || 'Failed to remove document');
    }
    setRemovingId(null);
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-gray-800"><Paperclip size={15} /> Documents</h2>
        <button onClick={() => inputRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50">
          <Upload size={14} /> Upload document
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) uploadAll(e.target.files); e.target.value = ''; }}
        />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadAll(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-5 text-center text-[13px] transition-colors ${dragOver ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
      >
        Drop files here or click to choose. PDF, Word, Excel, PowerPoint, images and more, up to 50 MB each.
        <br />
        <span className="text-[12px] text-gray-400">Word, Excel, PowerPoint, PDF, image and text files can be read right on the page.</span>
      </div>

      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}

      {(files.length > 0 || pending.length > 0) && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
              <FileIcon kind={viewKindOf(f)} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-gray-800" title={f.filename}>{f.filename}</span>
              <span className="text-[11px] text-gray-400">{formatSize(f.size)}</span>
              <button
                onClick={() => remove(f)}
                disabled={removingId === f.id}
                title="Remove document"
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
          {pending.map((u) => (
            <li key={u.key} className="rounded-lg border border-gray-200 px-3 py-2">
              <div className="flex items-center gap-3">
                <Upload size={14} className="text-gray-400" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">{u.name}</span>
                {u.error ? (
                  <>
                    <span className="text-[11px] text-red-600">{u.error}</span>
                    <button onClick={() => setPending((p) => p.filter((x) => x.key !== u.key))} className="rounded p-1 text-gray-400 hover:bg-gray-100"><X size={13} /></button>
                  </>
                ) : (
                  <span className="text-[11px] text-gray-500">{u.pct}%</span>
                )}
              </div>
              {!u.error && <div className="mt-1.5 h-1 overflow-hidden rounded bg-gray-100"><div className="h-full bg-blue-500 transition-all" style={{ width: `${u.pct}%` }} /></div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
