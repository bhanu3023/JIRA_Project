'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, type KbFile } from '@/lib/api';
import { Minus, Plus, ScanLine } from 'lucide-react';

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
 *
 * The viewer fills its parent (give it a definite height) and scrolls
 * internally. Word and PowerPoint pages are fixed-width, so they're scaled
 * to fit the available width, with zoom controls, and refit whenever the
 * space changes (window resize, questions pane shown/hidden/resized).
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
  return <div className="flex h-full min-h-[12rem] items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>;
}

function Failed({ message }: { message: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-red-600">{message}</div>;
}

// ── Fit-to-width zoom for fixed-width page renderers ─────────────────────────

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;

function useFitZoom(scrollRef: RefObject<HTMLDivElement>, contentRef: RefObject<HTMLDivElement>, ready: boolean) {
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [available, setAvailable] = useState(0);
  const [manual, setManual] = useState<number | null>(null); // null = fit to width

  // Measure the rendered page width once, at zoom 1.
  useEffect(() => {
    if (!ready || !contentRef.current) return;
    contentRef.current.style.zoom = '1';
    setNaturalWidth(contentRef.current.scrollWidth);
  }, [ready, contentRef]);

  // Track the space we have to fit into.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    setAvailable(el.clientWidth);
    return () => ro.disconnect();
  }, [scrollRef]);

  const fit = naturalWidth > 0 && available > 0 ? Math.min(1.5, Math.max(ZOOM_MIN, (available - 8) / naturalWidth)) : 1;
  const zoom = manual ?? fit;
  const step = useCallback((dir: 1 | -1) => {
    setManual((m) => {
      const cur = m ?? fit;
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((cur + dir * 0.1) * 10) / 10));
    });
  }, [fit]);

  return { zoom, fitted: manual === null, zoomIn: () => step(1), zoomOut: () => step(-1), fitWidth: () => setManual(null) };
}

function ZoomBar({ zoom, fitted, zoomIn, zoomOut, fitWidth }: ReturnType<typeof useFitZoom>) {
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-gray-200 bg-white/95 px-1 py-0.5 text-[12px] text-gray-700 shadow-md backdrop-blur">
      <button onClick={zoomOut} title="Zoom out" className="rounded-full p-1.5 hover:bg-gray-100"><Minus size={13} /></button>
      <span className="w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
      <button onClick={zoomIn} title="Zoom in" className="rounded-full p-1.5 hover:bg-gray-100"><Plus size={13} /></button>
      <span className="mx-0.5 h-4 w-px bg-gray-200" />
      <button onClick={fitWidth} title="Fit to width" className={`flex items-center gap-1 rounded-full px-2 py-1 ${fitted ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100'}`}>
        <ScanLine size={13} /> Fit
      </button>
    </div>
  );
}

// ── Renderers ────────────────────────────────────────────────────────────────

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
  // #view=FitH: open the PDF fitted to the pane's width.
  if (kind === 'pdf') return <iframe src={`${url}#view=FitH`} title={file.filename} className="h-full w-full border-0 bg-gray-100" />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-gray-100 p-3">
      <img src={url} alt={file.filename} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function PagedView({ blob, render, label }: {
  blob: Blob;
  render: (target: HTMLDivElement, blob: Blob) => Promise<(() => void) | void>;
  label: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const zoom = useFitZoom(scrollRef, contentRef, state === 'ready');

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | void;
    setState('loading');
    (async () => {
      try {
        if (!contentRef.current) return;
        contentRef.current.innerHTML = '';
        cleanup = await render(contentRef.current, blob);
        if (cancelled || !contentRef.current) return;
        scrubDom(contentRef.current);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; try { cleanup?.(); } catch {} };
  }, [blob, render]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-auto bg-gray-100">
        {state === 'loading' && <Spinner />}
        {state === 'error' && <Failed message={`This ${label} could not be displayed. Try downloading it instead.`} />}
        <div ref={contentRef} className="mx-auto w-fit pb-14" style={{ zoom: zoom.zoom }} />
      </div>
      {state === 'ready' && <ZoomBar {...zoom} />}
    </div>
  );
}

async function renderDocx(target: HTMLDivElement, blob: Blob) {
  const { renderAsync } = await import('docx-preview');
  await renderAsync(blob, target, undefined, {
    className: 'kb-docx',
    inWrapper: true,
    ignoreLastRenderedPageBreak: true,
    breakPages: true,
    experimental: true,
  });
  // docx-preview's wrapper adds its own gray background + padding; tighten it.
  const wrapper = target.querySelector<HTMLElement>('.kb-docx-wrapper');
  if (wrapper) { wrapper.style.background = 'transparent'; wrapper.style.padding = '16px'; }
  target.querySelectorAll<HTMLElement>('section.kb-docx').forEach((s) => {
    s.style.marginBottom = '16px';
    s.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
  });
}

async function renderPptx(target: HTMLDivElement, blob: Blob) {
  const { init } = await import('pptx-preview');
  // Render at a fixed 16:9 size; the fit-to-width zoom scales it to the pane.
  const previewer = init(target, { width: 960, height: 540, mode: 'list' });
  await previewer.preview(await blob.arrayBuffer());
  target.style.padding = '16px';
  return () => { try { (previewer as any).destroy?.(); } catch {} };
}

function DocxView({ blob }: { blob: Blob }) {
  return <PagedView blob={blob} render={renderDocx} label="Word document" />;
}

function PptxView({ blob }: { blob: Blob }) {
  return <PagedView blob={blob} render={renderPptx} label="presentation" />;
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

  if (error) return <Failed message={error} />;
  if (!sheets) return <Spinner />;
  const sheet = sheets[active];
  const width = Math.max(0, ...(sheet?.rows.map((r) => r.length) || [0]));
  return (
    <div className="flex h-full flex-col">
      {sheets.length > 1 && (
        <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 px-2 pt-1.5">
          {sheets.map((s, i) => (
            <button key={s.name + i} onClick={() => setActive(i)}
              className={`whitespace-nowrap rounded-t-md px-3 py-1 text-[12px] ${i === active ? 'border border-b-0 border-gray-200 bg-white font-semibold text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!sheet || sheet.rows.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-gray-500">This sheet is empty.</p>
        ) : (
          <table className="border-collapse text-[12.5px]">
            <tbody>
              {sheet.rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'sticky top-0 z-[1] bg-gray-100 font-semibold' : ri % 2 ? 'bg-gray-50/60' : 'bg-white'}>
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
      {sheet?.truncated && <p className="flex-shrink-0 border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">Showing the first {MAX_ROWS} rows and {MAX_COLS} columns. Download the file to see everything.</p>}
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
    <div className="flex h-full flex-col bg-white">
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[13px] leading-relaxed text-gray-800">{text}</pre>
      {blob.size > MAX_TEXT_BYTES && <p className="flex-shrink-0 border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">Showing the first 2 MB. Download the file to see everything.</p>}
    </div>
  );
}

/** Fills its parent; give the parent a definite height. */
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

  if (!kind) return <Failed message="This file type can't be shown in the browser. Use Download to open it." />;
  if (error) return <Failed message={error} />;
  if (!blob) return <Spinner />;
  if (kind === 'pdf' || kind === 'image') return <BlobFrame blob={blob} kind={kind} file={file} />;
  if (kind === 'docx') return <DocxView blob={blob} />;
  if (kind === 'sheet') return <SheetView blob={blob} file={file} />;
  if (kind === 'pptx') return <PptxView blob={blob} />;
  return <TextView blob={blob} />;
}
