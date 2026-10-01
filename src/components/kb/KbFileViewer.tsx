'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type KbFile } from '@/lib/api';

/**
 * In-page reader for KB documents. Everything is rendered in the browser
 * from the bytes fetched with the user's token (the files are
 * access-controlled, so no third-party viewer like Office Online can be
 * used -- it would need a public URL).
 *
 *  - pdf / images  -> the browser's own viewer via a blob: URL
 *  - docx          -> docx-preview
 *  - xlsx/xls/csv  -> SheetJS (already a dependency) rendered as a table
 *  - pptx          -> pptx-preview
 *  - text formats  -> <pre>
 * The heavy libraries are loaded only when such a file is opened.
 */

export type ViewKind = 'pdf' | 'image' | 'docx' | 'sheet' | 'pptx' | 'text';

const EXT_KIND: Record<string, ViewKind> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  docx: 'docx', docm: 'docx',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', csv: 'sheet', ods: 'sheet',
  pptx: 'pptx',
  txt: 'text', md: 'text', log: 'text', json: 'text', xml: 'text', yaml: 'text', yml: 'text',
  ini: 'text', conf: 'text', sql: 'text', sh: 'text', ps1: 'text', js: 'text', ts: 'text', py: 'text',
};

const KIND_MIME: Partial<Record<ViewKind, (ext: string) => string>> = {
  pdf: () => 'application/pdf',
  image: (ext) => (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`),
};

function extOf(name: string) {
  return (name.split('.').pop() || '').toLowerCase();
}

/** How (if at all) a file can be read in the page. */
export function viewKindOf(file: KbFile): ViewKind | null {
  const byExt = EXT_KIND[extOf(file.filename)];
  if (byExt) return byExt;
  const mime = (file.mime || '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (/^image\/(png|jpe?g|gif|webp|bmp)$/.test(mime)) return 'image';
  if (mime.startsWith('text/')) return 'text';
  return null;
}

// docx/pptx renderers build DOM from the document's XML. Hyperlinks in a
// document are attacker-controlled, so strip anything script-like from the
// result before the user can click it.
function scrubDom(root: HTMLElement) {
  root.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|vbscript|data:text)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function Spinner() {
  return <div className="flex h-48 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>;
}

function BlobFrame({ blob, kind, file }: { blob: Blob; kind: 'pdf' | 'image'; file: KbFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // The server sends non-PDF/image types as octet-stream; re-type the blob
    // so the browser's PDF viewer / <img> knows what it's holding.
    const type = KIND_MIME[kind]?.(extOf(file.filename)) || blob.type;
    const u = URL.createObjectURL(new Blob([blob], { type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob, kind, file.filename]);
  if (!url) return <Spinner />;
  if (kind === 'pdf') return <iframe src={url} title={file.filename} className="h-full min-h-[70vh] w-full border-0 bg-gray-100" />;
  return <div className="flex justify-center bg-gray-50 p-3"><img src={url} alt={file.filename} className="max-h-[75vh] max-w-full object-contain" /></div>;
}

function DocxView({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = '';
        await renderAsync(blob, ref.current, undefined, {
          className: 'kb-docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          breakPages: true,
          experimental: true,
        });
        if (!cancelled && ref.current) { scrubDom(ref.current); setDone(true); }
      } catch (e: any) {
        if (!cancelled) setError('This Word document could not be displayed. Try downloading it instead.');
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);
  return (
    <div className="max-h-[80vh] overflow-auto bg-gray-100 [&_.kb-docx-wrapper]:!bg-gray-100 [&_.kb-docx-wrapper]:!p-4 [&_section.kb-docx]:!mx-auto [&_section.kb-docx]:!mb-4 [&_section.kb-docx]:shadow">
      {error && <p className="px-4 py-6 text-[13px] text-red-600">{error}</p>}
      {!done && !error && <Spinner />}
      <div ref={ref} />
    </div>
  );
}

const MAX_ROWS = 2000;
const MAX_COLS = 60;

function SheetView({ blob, file }: { blob: Blob; file: KbFile }) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][]; truncated: boolean }[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import('xlsx');
        const buf = await blob.arrayBuffer();
        const wb = extOf(file.filename) === 'csv'
          ? XLSX.read(new TextDecoder().decode(buf), { type: 'string' })
          : XLSX.read(buf, { type: 'array' });
        const parsed = wb.SheetNames.map((name) => {
          const all = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
          const truncated = all.length > MAX_ROWS || all.some((r) => r.length > MAX_COLS);
          return { name, rows: all.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => String(c ?? ''))), truncated };
        });
        if (!cancelled) setSheets(parsed);
      } catch {
        if (!cancelled) setError('This spreadsheet could not be displayed. Try downloading it instead.');
      }
    })();
    return () => { cancelled = true; };
  }, [blob, file.filename]);

  if (error) return <p className="px-4 py-6 text-[13px] text-red-600">{error}</p>;
  if (!sheets) return <Spinner />;
  const sheet = sheets[active];
  const width = Math.max(0, ...(sheet?.rows.map((r) => r.length) || [0]));
  return (
    <div>
      {sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 px-2 pt-1.5">
          {sheets.map((s, i) => (
            <button key={s.name + i} onClick={() => setActive(i)}
              className={`whitespace-nowrap rounded-t-md px-3 py-1 text-[12px] ${i === active ? 'border border-b-0 border-gray-200 bg-white font-semibold text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[75vh] overflow-auto">
        {!sheet || sheet.rows.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-gray-500">This sheet is empty.</p>
        ) : (
          <table className="border-collapse text-[12px]">
            <tbody>
              {sheet.rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'sticky top-0 bg-gray-100 font-semibold' : ri % 2 ? 'bg-gray-50/60' : ''}>
                  <td className="border border-gray-200 bg-gray-100 px-2 py-1 text-right text-[11px] text-gray-400">{ri + 1}</td>
                  {Array.from({ length: width }, (_, ci) => (
                    <td key={ci} className="max-w-[320px] whitespace-pre-wrap break-words border border-gray-200 px-2 py-1 align-top text-gray-800">{r[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheet?.truncated && <p className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">Showing the first {MAX_ROWS} rows and {MAX_COLS} columns. Download the file to see everything.</p>}
    </div>
  );
}

function PptxView({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let previewer: { destroy?: () => void } | null = null;
    (async () => {
      try {
        const { init } = await import('pptx-preview');
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = '';
        const width = Math.min(Math.max(ref.current.clientWidth - 24, 320), 1100);
        const p = init(ref.current, { width, height: Math.round((width * 9) / 16), mode: 'list' });
        previewer = p as any;
        await p.preview(await blob.arrayBuffer());
        if (!cancelled && ref.current) { scrubDom(ref.current); setDone(true); }
      } catch {
        if (!cancelled) setError('This presentation could not be displayed. Try downloading it instead.');
      }
    })();
    return () => { cancelled = true; try { previewer?.destroy?.(); } catch {} };
  }, [blob]);
  return (
    <div className="max-h-[80vh] overflow-auto bg-gray-100 p-3">
      {error && <p className="px-1 py-4 text-[13px] text-red-600">{error}</p>}
      {!done && !error && <Spinner />}
      <div ref={ref} className="mx-auto w-full" />
    </div>
  );
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function TextView({ blob }: { blob: Blob }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    blob.slice(0, MAX_TEXT_BYTES).text().then((t) => { if (!cancelled) setText(t); });
    return () => { cancelled = true; };
  }, [blob]);
  if (text === null) return <Spinner />;
  return (
    <div className="max-h-[75vh] overflow-auto bg-gray-50">
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-gray-800">{text}</pre>
      {blob.size > MAX_TEXT_BYTES && <p className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">Showing the first 2 MB. Download the file to see everything.</p>}
    </div>
  );
}

export function KbFileViewer({ articleId, file }: { articleId: string; file: KbFile }) {
  const kind = viewKindOf(file);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlob(null); setError(null);
    api.fetchKbFileBlob(articleId, file.id)
      .then((b) => { if (!cancelled) setBlob(b); })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Failed to load document'); });
    return () => { cancelled = true; };
  }, [articleId, file.id]);

  if (!kind) return <p className="px-4 py-6 text-[13px] text-gray-500">This file type can&apos;t be shown in the browser. Use Download to open it.</p>;
  if (error) return <p className="px-4 py-6 text-[13px] text-red-600">{error}</p>;
  if (!blob) return <Spinner />;
  if (kind === 'pdf' || kind === 'image') return <BlobFrame blob={blob} kind={kind} file={file} />;
  if (kind === 'docx') return <DocxView blob={blob} />;
  if (kind === 'sheet') return <SheetView blob={blob} file={file} />;
  if (kind === 'pptx') return <PptxView blob={blob} />;
  return <TextView blob={blob} />;
}
