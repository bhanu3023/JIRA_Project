'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  Bold, Italic, Underline, Strikethrough,
  List, ListOrdered, Code, Quote, Link2,
  Minus, Paperclip, FolderUp,
  Heading1, Heading2, Type,
} from 'lucide-react';

interface Member {
  id: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
  compact?: boolean;
  members?: Member[];   // ← space members for @ mention
  onUploadingChange?: (uploading: boolean) => void;  // ← true while any attachment upload is in flight
}

function getInitials(m: Member) {
  const f = m.firstName || m.displayName?.split(' ')[0] || '';
  const l = m.lastName  || m.displayName?.split(' ')[1] || '';
  return `${f[0] || ''}${l[0] || ''}`.toUpperCase() || '?';
}
function getFullName(m: Member) {
  if (m.firstName || m.lastName) return `${m.firstName || ''} ${m.lastName || ''}`.trim();
  return m.displayName || m.email || 'Unknown';
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = 'Add a description...',
  minHeight = '160px',
  compact = false,
  members = [],
  onUploadingChange,
}: Props) {
  const editorRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const folderRef  = useRef<HTMLInputElement>(null);
  const pendingUploads = useRef(0);
  const beginUpload = () => {
    pendingUploads.current += 1;
    if (pendingUploads.current === 1) onUploadingChange?.(true);
  };
  const endUpload = () => {
    pendingUploads.current = Math.max(0, pendingUploads.current - 1);
    if (pendingUploads.current === 0) onUploadingChange?.(false);
  };
  // Tracks the last value *this editor* emitted, so the sync effect below can
  // tell "value changed because we just typed it" apart from "value changed
  // externally (e.g. cleared after submit)". A plain skip-once boolean broke
  // here: a no-op format command (Bold with nothing selected) calls emit()
  // without actually changing innerHTML, so React bails on the state update
  // and the effect that's supposed to consume/reset the flag never runs —
  // leaving it stuck true and silently swallowing the *next* real external
  // change (e.g. the box failing to clear after Save, even though the value
  // prop did become '').
  const lastEmitted = useRef<string | null>(null);

  // Images/files are uploaded to the server and referenced by URL rather than
  // embedded as base64 inline — that used to make the description payload
  // scale with attachment size, which both tripped the reverse proxy's
  // body-size limit and made ticket creation slow (uploading tens of MB of
  // base64 text as part of the create-issue request). A plain URL keeps the
  // create-issue payload tiny no matter how big the attachment is.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
  const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  const [warning, setWarning] = useState<string | null>(null);
  // Images embed small (see insertImage/[&_img] sizing below) so a screenshot
  // doesn't dominate the description box — clicking one opens it full-size
  // in an overlay instead, rather than at its cramped inline thumbnail size.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const handleEditorClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      e.preventDefault();
      setLightboxSrc((target as HTMLImageElement).src);
    }
  };
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warn = (msg: string) => {
    setWarning(msg);
    if (warnTimer.current) clearTimeout(warnTimer.current);
    warnTimer.current = setTimeout(() => setWarning(null), 5000);
  };

  // XHR (not fetch) so we get real upload-progress events — large files can take
  // a while purely due to network transfer time, and a static "Uploading…" with
  // no feedback looks stuck even when it's working fine.
  const uploadFile = (file: File, onProgress?: (pct: number) => void): Promise<{ url: string } | null> => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') : null;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data: any = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status < 200 || xhr.status >= 300) {
          warn(`Failed to upload "${file.name}": ${data.error || 'Upload failed'}`);
          resolve(null);
          return;
        }
        resolve(data);
      };
      xhr.onerror = () => {
        warn(`Failed to upload "${file.name}": network error`);
        resolve(null);
      };
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  };

  // ── @ Mention state ──────────────────────────────────────────────────
  const [mentionOpen,   setMentionOpen]   = useState(false);
  const [mentionQuery,  setMentionQuery]  = useState('');
  const [mentionIdx,    setMentionIdx]    = useState(0);
  const [mentionPos,    setMentionPos]    = useState<{ top: number; left: number } | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);  // saved range to restore + replace
  const dropRef = useRef<HTMLDivElement>(null);

  const mentionMatches = mentionOpen
    ? members.filter(m => {
        const full = getFullName(m).toLowerCase();
        return full.includes(mentionQuery.toLowerCase());
      }).slice(0, 8)
    : [];

  /* ── Sync initial / external value changes ─────────────────────── */
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value === lastEmitted.current) return; // this value came from us — DOM already reflects it
    if (el.innerHTML !== (value ?? '')) el.innerHTML = value ?? '';
  }, [value]);

  /* ── Emit changes upward ─────────────────────────────────────────── */
  const emit = useCallback(() => {
    lastEmitted.current = editorRef.current?.innerHTML ?? '';
    onChange(lastEmitted.current);
  }, [onChange]);

  /* ── execCommand helper ─────────────────────────────────────────── */
  const exec = (cmd: string, val?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val);
    emit();
  };

  const formatBlock = (tag: string) => exec('formatBlock', tag);

  /* ── Deleting a selection that spans multiple blocks corrupts the
   * surviving one ────────────────────────────────────────────────────────
   * Selecting a whole "block" (e.g. a heading + its answer paragraph, as
   * in a numbered template like "1. Issue Reported" / answer text — but
   * this reproduces with plain paragraphs too, headings aren't special)
   * and pressing Delete/Backspace lets the browser's native command run
   * its own "smart merge" of the deletion boundary — which wraps the
   * surviving block's text in a stray inline style span (carrying over
   * formatting from whatever got deleted) and leaves the caret positioned
   * inside that block's existing text. A heading then renders wrong (the
   * span's inline style overrides the h2/h3 CSS) and the very next
   * keystroke gets typed into that unrelated block instead of a new line
   * — i.e. editing/removing one item visibly changes a completely
   * different one.
   *
   * Only a selection that spans multiple top-level blocks is affected —
   * same-block edits and single-cursor backspace-joins (the overwhelming
   * majority of editing) are untouched. For that specific case, deletion
   * is done via Range.deleteContents() (a plain DOM operation with none
   * of the command's formatting-carryover behavior) and the caret is
   * dropped into a fresh empty paragraph instead of wherever the native
   * merge would have left it.
   */
  const handleBeforeInput = (e: InputEvent) => {
    const inputType = e.inputType;
    if (!inputType || !inputType.startsWith('delete')) return;
    const editor = editorRef.current;
    if (!editor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const children = Array.from(editor.childNodes);

    // A boundary directly inside the editor (container === editor) happens for
    // any element-level selection — e.g. selecting a whole block by dragging
    // across its edges, or Range.setStartBefore/After — not just nested text
    // offsets, so it has to be resolved via its offset into editor.childNodes
    // rather than by walking parentNode (which would just climb past the editor
    // entirely and find nothing).
    const topLevelIndexOf = (node: Node, offset: number, isEnd: boolean): number => {
      if (node === editor) return isEnd ? offset - 1 : offset;
      let n: Node | null = node;
      while (n && n.parentNode !== editor) n = n.parentNode;
      return n ? children.indexOf(n as ChildNode) : -1;
    };
    const startIdx = topLevelIndexOf(range.startContainer, range.startOffset, false);
    const endIdx = topLevelIndexOf(range.endContainer, range.endOffset, true);
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return; // single-block edit — leave to native handling

    e.preventDefault();
    range.deleteContents();
    const freshP = document.createElement('p');
    freshP.innerHTML = '<br>';
    range.insertNode(freshP);
    const newRange = document.createRange();
    newRange.setStart(freshP, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    emit();
  };

  // React's synthetic onBeforeInput doesn't reliably fire for a native
  // Delete/Backspace keypress on a contentEditable element, so this is
  // wired as a real DOM listener instead.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.addEventListener('beforeinput', handleBeforeInput);
    return () => el.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  /* ── Detect @mention while typing ───────────────────────────────── */
  const checkMention = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { setMentionOpen(false); return; }

    const range  = sel.getRangeAt(0);
    const node   = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { setMentionOpen(false); return; }

    const textBefore = node.textContent?.slice(0, range.startOffset) ?? '';
    const match = textBefore.match(/@([^\s@]*)$/);

    if (match) {
      // Save a range that covers "@query" so we can replace it on insert
      const atRange = range.cloneRange();
      atRange.setStart(node, textBefore.lastIndexOf('@'));
      atRange.setEnd(node, range.startOffset);
      mentionRangeRef.current = atRange;

      // Position dropdown using fixed viewport coords so it renders outside the editor
      const rect = range.getBoundingClientRect();
      setMentionPos({
        top:  rect.bottom + 4,   // fixed = viewport-relative, no scrollY needed
        left: rect.left,
      });

      setMentionQuery(match[1]);
      setMentionOpen(true);
      setMentionIdx(0);
    } else {
      setMentionOpen(false);
    }
  }, []);

  /* ── Insert mention span ─────────────────────────────────────────── */
  const insertMention = useCallback((member: Member) => {
    const name = getFullName(member);
    const mentionHtml =
      `<span class="mention" data-userid="${member.id}" contenteditable="false"` +
      ` style="color:#0052CC;background:#DEEBFF;border-radius:3px;padding:1px 6px;font-weight:600;font-size:13px;cursor:pointer;" title="${member.email || name}">` +
      `@${name}</span>&nbsp;`;

    const savedRange = mentionRangeRef.current;
    if (savedRange) {
      savedRange.deleteContents();
      const frag = document.createRange().createContextualFragment(mentionHtml);
      savedRange.insertNode(frag);
      // Move cursor after the inserted span
      const sel2 = window.getSelection();
      if (sel2) {
        const newRange = document.createRange();
        newRange.setStartAfter(savedRange.endContainer);
        newRange.collapse(true);
        sel2.removeAllRanges();
        sel2.addRange(newRange);
      }
    } else {
      editorRef.current?.focus();
      document.execCommand('insertHTML', false, mentionHtml);
    }

    setMentionOpen(false);
    mentionRangeRef.current = null;
    emit();
  }, [emit]);

  /* ── KeyDown: arrow nav + Enter/Escape for mention ──────────────── */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mentionOpen && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx(i => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        // Space ends the @query the same way Enter does — the query regex
        // (below, in checkMention) can't include a space in the match, so
        // typing "@Bhanu" then a space always closed the dropdown right as
        // the name finished, leaving plain unlinked "@Bhanu " text behind
        // with no way to still turn it into a real tag short of deleting the
        // space and clicking a match. Committing the highlighted match here
        // instead means finishing a name the natural way (type it, hit
        // space, keep typing the rest of the comment) actually tags them.
        e.preventDefault();
        insertMention(mentionMatches[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setMentionOpen(false);
        return;
      }
    }
  };

  /* ── Close mention on outside click ─────────────────────────────── */
  useEffect(() => {
    if (!mentionOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
          !editorRef.current?.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mentionOpen]);

  /* ── Reposition dropdown on scroll so it follows the cursor ─────── */
  useEffect(() => {
    if (!mentionOpen) return;
    const updatePos = () => {
      const savedRange = mentionRangeRef.current;
      if (!savedRange) return;
      try {
        const rect = savedRange.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // range detached
        setMentionPos({
          top:  rect.bottom + 4,
          left: rect.left,
        });
      } catch { /* range may be gone */ }
    };
    window.addEventListener('scroll', updatePos, true);   // capture = catches all scroll containers
    return () => window.removeEventListener('scroll', updatePos, true);
  }, [mentionOpen]);

  /* ── Insert image: compress client-side, upload, embed the URL ───── */
  const insertImage = (file: File) => {
    const placeholderId = `up-${Math.random().toString(36).slice(2)}`;
    editorRef.current?.focus();
    document.execCommand('insertHTML', false,
      `<span id="${placeholderId}" contenteditable="false" style="display:inline-block;padding:4px 8px;background:#f1f5f9;border-radius:6px;color:#64748b;font-size:12px;">Uploading "${file.name}"…</span>&nbsp;`
    );
    emit();
    beginUpload();

    const reader = new FileReader();
    reader.onload = (ev) => {
      const originalSrc = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        const scale = img.width > MAX ? MAX / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        // JPEG at 0.75 quality — ~10x smaller than raw PNG for photos
        canvas.toBlob(async (blob) => {
          const placeholder = document.getElementById(placeholderId);
          if (!blob) {
            placeholder?.remove();
            warn(`Could not process "${file.name}".`);
            emit();
            endUpload();
            return;
          }
          if (blob.size > MAX_UPLOAD_BYTES) {
            placeholder?.remove();
            warn(`"${file.name}" is too large (${formatSize(blob.size)}, max 10GB).`);
            emit();
            endUpload();
            return;
          }
          const uploadName = file.name.replace(/\.\w+$/, '.jpg');
          const result = await uploadFile(new File([blob], uploadName, { type: 'image/jpeg' }), (pct) => {
            const p = document.getElementById(placeholderId);
            if (p) p.textContent = `Uploading "${file.name}" ${pct}%…`;
          });
          const el = document.getElementById(placeholderId);
          if (!result) { el?.remove(); emit(); endUpload(); return; }
          const imgEl = document.createElement('img');
          imgEl.src = result.url;
          imgEl.alt = file.name;
          imgEl.title = file.name;
          imgEl.style.cssText = 'max-width:220px;max-height:160px;width:auto;height:auto;border-radius:6px;margin:6px 0;display:block;cursor:pointer;object-fit:contain;';
          el?.replaceWith(imgEl);
          emit();
          endUpload();
        }, 'image/jpeg', 0.75);
      };
      img.onerror = () => {
        document.getElementById(placeholderId)?.remove();
        warn(`Could not read "${file.name}".`);
        emit();
        endUpload();
      };
      img.src = originalSrc;
    };
    reader.readAsDataURL(file);
  };

  /* ── Insert non-image file: upload, embed as a download chip ──────── */
  const insertFile = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      warn(`"${file.name}" is too large to attach (${formatSize(file.size)}, max 10GB).`);
      return;
    }
    const placeholderId = `up-${Math.random().toString(36).slice(2)}`;
    const ext = file.name.split('.').pop()?.toUpperCase() || 'FILE';
    const sizeKb = (file.size / 1024).toFixed(0);
    editorRef.current?.focus();
    document.execCommand('insertHTML', false,
      `<span id="${placeholderId}" contenteditable="false" style="display:inline-block;padding:4px 8px;background:#f1f5f9;border-radius:6px;color:#64748b;font-size:12px;">Uploading "${file.name}"…</span>&nbsp;`
    );
    emit();
    beginUpload();

    uploadFile(file, (pct) => {
      const p = document.getElementById(placeholderId);
      if (p) p.textContent = `Uploading "${file.name}" ${pct}%…`;
    }).then((result) => {
      const el = document.getElementById(placeholderId);
      if (!result) { el?.remove(); emit(); endUpload(); return; }
      const a = document.createElement('a');
      a.href = result.url;
      a.download = file.name;
      a.setAttribute('data-filename', file.name);
      a.setAttribute('data-filesize', `${sizeKb} KB`);
      a.setAttribute('contenteditable', 'false');
      a.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;margin:4px 2px;text-decoration:none;color:#1e40af;font-size:12px;font-weight:500;cursor:pointer;';
      a.innerHTML = `<span style="background:#3b82f6;color:white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:700;">${ext}</span><span style="color:#374151;">${file.name}</span><span style="color:#9ca3af;font-size:11px;">${sizeKb} KB</span><span style="color:#6b7280;font-size:11px;">⬇</span>`;
      el?.replaceWith(a);
      emit();
      endUpload();
    });
  };

  // Office (Excel/Word) clipboard HTML wraps the actual content between these
  // markers, alongside a <head> full of mso-* styles and XML namespace junk —
  // extract just the real fragment instead of dumping the whole document in.
  const extractOfficeFragment = (html: string): string => {
    const start = html.indexOf('<!--StartFragment-->');
    const end = html.indexOf('<!--EndFragment-->');
    return start !== -1 && end !== -1 && end > start
      ? html.slice(start + '<!--StartFragment-->'.length, end)
      : html;
  };

  // Strips Office-specific cruft (conditional comments, o:/v:/w: namespace
  // tags) and — critically — any standalone <img> Excel/Word sometimes embeds
  // as a fallback preview ALONGSIDE the real <table>/text markup in the same
  // HTML payload. Left in place, the browser's native paste renderer for
  // complex Office content (merged cells, conditional formatting) can prefer
  // rendering that embedded image over the actual table, even though real
  // table markup with real, editable text was right there in the same paste.
  const sanitizeOfficeHtml = (html: string): string => {
    let cleaned = extractOfficeFragment(html)
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?(?:o|v|w|m):[a-z0-9]+(?:\s[^>]*)?>/gi, '');
    const hasStructuralText = /<table[\s>]|<td[\s>]|<tr[\s>]/i.test(cleaned)
      && /[a-zA-Z0-9]/.test(cleaned.replace(/<[^>]+>/g, ''));
    if (hasStructuralText) cleaned = cleaned.replace(/<img\b[^>]*>/gi, '');

    // Word/Outlook exports comment threads, revision marks, and "important"
    // callouts as a plain colored border on a <div>/<p>/<span> wrapping that
    // text — nothing marks it as a comment once pasted elsewhere, it just
    // shows up as a random red (or other colored) box around part of the
    // ticket with no indication why. Strip border styling from everything
    // EXCEPT table cells, where a border is the actual visible grid lines a
    // pasted spreadsheet needs to stay readable.
    try {
      const container = document.createElement('div');
      container.innerHTML = cleaned;
      const borderProps = ['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'outline'];
      container.querySelectorAll<HTMLElement>('*').forEach(el => {
        if (['TABLE', 'TD', 'TH', 'TR', 'THEAD', 'TBODY'].includes(el.tagName)) return;
        for (const prop of borderProps) (el.style as any)[prop] = '';
        el.removeAttribute('bordercolor');
      });
      cleaned = container.innerHTML;
    } catch { /* if DOM parsing itself fails, fall back to the regex-cleaned string as-is */ }

    return cleaned;
  };

  /* ── Paste: intercept images; keep HTML formatting ─────────────── */
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find(i => i.type.startsWith('image/'));
    // Copying cells from Excel/Google Sheets (or a table in Word/Docs) puts a
    // bitmap preview of the selection on the clipboard ALONGSIDE the real
    // text/html — this used to check for an image item first and, if found,
    // always treated the whole paste as that image, discarding the actual
    // text entirely. A pasted list of IDs from a spreadsheet became a single
    // screenshot-like image instead of the IDs themselves. Only fall back to
    // the image when there's truly no text representation to prefer instead
    // (a real screenshot/copied-image paste has no text/html or text/plain).
    const htmlContent = e.clipboardData?.getData('text/html');
    const plainText = e.clipboardData?.getData('text/plain');
    if (imgItem && !htmlContent && !plainText) {
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (file) insertImage(file);
      return;
    }
    // Insert HTML ourselves rather than letting the browser's own native
    // paste handler take over — for complex Office markup (merged cells,
    // conditional formatting), some browsers' native paste renderer flattens
    // the whole thing into a single embedded image instead of real table
    // markup, which we'd never see coming since by that point it's the
    // browser's own paste rendering, not anything in the clipboard items we
    // already checked above.
    if (htmlContent) {
      e.preventDefault();
      editorRef.current?.focus();
      document.execCommand('insertHTML', false, sanitizeOfficeHtml(htmlContent));
      emit();
      return;
    }
    // Plain text: preserve indentation and repeated spaces exactly as pasted.
    // execCommand('insertText', ...) inserts the literal characters, but the
    // editor's default white-space:normal flow then collapses every run of
    // spaces down to one at render time — pasting an indented JSON/code blob
    // came through with every nesting level flattened against the left
    // margin, reading as a jumbled single-spaced blob instead of the
    // original structure. Wrapping the inserted text in a
    // white-space:pre-wrap span keeps indentation/alignment intact while
    // still wrapping normally at long lines (unlike plain "pre", which never
    // wraps at all).
    if (plainText) {
      e.preventDefault();
      editorRef.current?.focus();
      const escaped = plainText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      document.execCommand('insertHTML', false, `<span style="white-space:pre-wrap">${escaped}</span>`);
    }
    setTimeout(emit, 0);
  };

  /* ── Recursively read a dropped folder's contents ──────────────────
   * Plain `e.dataTransfer.files` only ever contains files dropped directly
   * — dropping a folder yields nothing from it, silently discarding every
   * file inside. The Chromium/WebKit-only FileSystemEntry API
   * (webkitGetAsEntry) is the only way to see into a dropped directory. */
  const readEntry = (entry: any): Promise<File[]> => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f: File) => resolve([f]), () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all: File[] = [];
        const readBatch = () => {
          reader.readEntries(async (entries: any[]) => {
            if (!entries.length) { resolve(all); return; }
            const nested = await Promise.all(entries.map(readEntry));
            nested.forEach(files => all.push(...files));
            readBatch(); // readEntries only returns a batch at a time — keep going until empty
          }, () => resolve(all));
        };
        readBatch();
      } else {
        resolve([]);
      }
    });
  };

  /* ── Drag-drop (files or whole folders) ─────────────────────────── */
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const items = e.dataTransfer.items;
    const hasFolderApi = items && Array.from(items).some(i => typeof (i as any).webkitGetAsEntry === 'function');
    let files: File[];
    if (hasFolderApi) {
      const entries = Array.from(items).map(i => (i as any).webkitGetAsEntry()).filter(Boolean);
      files = (await Promise.all(entries.map(readEntry))).flat();
    } else {
      files = Array.from(e.dataTransfer.files);
    }
    files.forEach(f => {
      if (f.type.startsWith('image/')) insertImage(f);
      else insertFile(f);
    });
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(f => f.type.startsWith('image/') ? insertImage(f) : insertFile(f));
    e.target.value = '';
  };

  const insertLink = () => {
    const url = prompt('Enter URL (e.g. https://example.com):');
    if (url?.trim()) exec('createLink', url.trim());
  };

  /* ── Toolbar button helper ───────────────────────────────────────── */
  const TBtn = ({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" title={title}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-colors text-[12px] font-semibold"
    >{children}</button>
  );
  const Divider = () => <div className="w-px h-5 bg-gray-300 mx-0.5" />;

  return (
    <div className="border border-gray-300 rounded-md focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 transition-shadow relative">

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 bg-gray-50 border-b border-gray-200">
        {!compact && (
          <>
            <TBtn title="Normal text" onClick={() => formatBlock('p')}><Type size={13} /></TBtn>
            <TBtn title="Heading 1"   onClick={() => formatBlock('h2')}><Heading1 size={13} /></TBtn>
            <TBtn title="Heading 2"   onClick={() => formatBlock('h3')}><Heading2 size={13} /></TBtn>
            <Divider />
          </>
        )}
        <TBtn title="Bold (Ctrl+B)"      onClick={() => exec('bold')}><Bold size={13} /></TBtn>
        <TBtn title="Italic (Ctrl+I)"    onClick={() => exec('italic')}><Italic size={13} /></TBtn>
        <TBtn title="Underline (Ctrl+U)" onClick={() => exec('underline')}><Underline size={13} /></TBtn>
        <TBtn title="Strikethrough"      onClick={() => exec('strikeThrough')}><Strikethrough size={13} /></TBtn>
        <Divider />
        <TBtn title="Bullet list"   onClick={() => exec('insertUnorderedList')}><List size={13} /></TBtn>
        <TBtn title="Numbered list" onClick={() => exec('insertOrderedList')}><ListOrdered size={13} /></TBtn>
        <Divider />
        <TBtn title="Inline code" onClick={() => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const range = sel.getRangeAt(0);
          const parentCode = range.startContainer.parentElement?.closest('code');
          if (parentCode && !parentCode.closest('pre')) {
            const text = parentCode.textContent || '';
            const textNode = document.createTextNode(text);
            parentCode.replaceWith(textNode);
            emit();
            return;
          }
          const txt = sel.toString();
          if (txt) {
            const code = document.createElement('code');
            code.textContent = txt;
            range.deleteContents();
            range.insertNode(code);
            range.setStartAfter(code);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            const code = document.createElement('code');
            code.innerHTML = '&ZeroWidthSpace;';
            range.insertNode(code);
            range.setStart(code, 0);
            range.setEnd(code, 1);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          emit();
        }}><Code size={13} /></TBtn>
        <TBtn title="Code block" onClick={() => {
          const sel = window.getSelection();
          const txt = sel?.toString() || '';
          editorRef.current?.focus();
          const pre = document.createElement('pre');
          pre.style.cssText = 'background:#1e293b;color:#e2e8f0;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:13px;overflow-x:auto;margin:8px 0;white-space:pre-wrap;word-break:break-word;';
          const code = document.createElement('code');
          code.textContent = txt || 'code here';
          pre.appendChild(code);
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(pre);
            const br = document.createElement('br');
            pre.after(br);
            range.setStartAfter(br);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          emit();
        }}><span className="text-[10px] font-bold font-mono">{'{}'}</span></TBtn>
        {!compact && (
          <TBtn title="Blockquote" onClick={() => formatBlock('blockquote')}><Quote size={13} /></TBtn>
        )}
        <TBtn title="Horizontal rule" onClick={() => exec('insertHorizontalRule')}><Minus size={13} /></TBtn>
        <Divider />
        <TBtn title="Insert link"  onClick={insertLink}><Link2 size={13} /></TBtn>
        <TBtn title="Attach file"   onClick={() => fileRef.current?.click()}><Paperclip size={13} /></TBtn>
        <TBtn title="Attach folder" onClick={() => folderRef.current?.click()}><FolderUp size={13} /></TBtn>
      </div>

      {warning && (
        <div className="px-3 py-1.5 text-xs text-amber-800 bg-amber-50 border-b border-amber-200">
          {warning}
        </div>
      )}

      {/* ── Editable area ── */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={() => { emit(); checkMention(); }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onClick={handleEditorClick}
        onDragOver={e => e.preventDefault()}
        data-placeholder={placeholder}
        className={`
          px-3 py-2.5 text-sm text-gray-800 outline-none leading-relaxed break-words
          [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-1
          [&_h3]:text-sm  [&_h3]:font-bold [&_h3]:mt-2 [&_h3]:mb-1
          [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1
          [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1
          [&_blockquote]:border-l-4 [&_blockquote]:border-gray-300
            [&_blockquote]:pl-3 [&_blockquote]:text-gray-500 [&_blockquote]:italic [&_blockquote]:my-1
          [&_hr]:border-gray-200 [&_hr]:my-2
          [&_code]:bg-slate-100 [&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs
          [&_pre]:bg-slate-800 [&_pre]:text-slate-200 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:overflow-x-auto
          [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0
          [&_a]:text-blue-600 [&_a]:underline
          [&_img]:max-w-[220px] [&_img]:max-h-[160px] [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain [&_img]:rounded-md [&_img]:my-1 [&_img]:cursor-pointer
          empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400
          empty:before:pointer-events-none
        `}
        style={{ minHeight }}
      />

      {/* ── @ Mention dropdown — exact Jira style ── */}
      {mentionOpen && mentionPos && (
        <div
          ref={dropRef}
          style={{
            position: 'fixed',
            top: mentionPos.top,
            left: Math.min(mentionPos.left, window.innerWidth - 310),
            width: 300,
            zIndex: 9999,
            background: '#fff',
            borderRadius: 4,
            boxShadow: '0 4px 8px -2px rgba(9,30,66,0.25), 0 0 1px rgba(9,30,66,0.31)',
            overflow: 'hidden',
          }}
        >
          {mentionMatches.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 14, color: '#6B778C' }}>
              No results
            </div>
          ) : (
            <ul style={{ margin: 0, padding: '4px 0', maxHeight: 320, overflowY: 'auto', listStyle: 'none' }}>
              {mentionMatches.map((m, i) => {
                const name     = getFullName(m);
                const initials = getInitials(m);
                const colors   = ['#E53935','#00897B','#1E88E5','#FB8C00','#8E24AA','#00ACC1','#43A047','#F4511E'];
                const idStr    = m.id || m.email || name;
                const colorIdx = Array.from(idStr).reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
                const avatarBg = colors[colorIdx];
                const isActive = i === mentionIdx;

                return (
                  <li
                    key={m.id}
                    onMouseDown={e => { e.preventDefault(); insertMention(m); }}
                    onMouseEnter={() => setMentionIdx(i)}
                    style={{
                      listStyle: 'none',
                      background: isActive ? '#F4F5F7' : '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px' }}>
                      {/* Avatar */}
                      {m.avatarUrl ? (
                        <img
                          src={m.avatarUrl}
                          alt={name}
                          style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                        />
                      ) : (
                        <div style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          background: avatarBg,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          color: '#fff',
                          fontWeight: 700,
                          fontSize: 14,
                        }}>
                          {initials}
                        </div>
                      )}
                      {/* Name only — exactly like Jira */}
                      <span style={{
                        fontSize: 14,
                        fontWeight: 400,
                        color: '#172B4D',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {name}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Hidden inputs */}
      <input ref={fileRef} type="file" accept="*/*"     multiple hidden onChange={handleFileInput} />
      {/* webkitdirectory isn't in React's DOM typings — spread it in untyped so
          the folder picker (not just multi-file select) actually opens. */}
      <input ref={folderRef} type="file" multiple hidden onChange={handleFileInput} {...({ webkitdirectory: '' } as any)} />

      {/* Image lightbox — opens over this same screen, not a new tab/page */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-full max-w-full rounded-md shadow-2xl object-contain"
            onClick={e => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
