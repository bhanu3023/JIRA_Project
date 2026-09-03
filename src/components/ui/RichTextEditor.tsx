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

// Matches a bare URL immediately preceding the cursor -- used while actively
// typing (see checkAutolink/linkifyTrailingUrl below), so it's anchored to
// the end of whatever text is being checked.
const URL_PATTERN = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)$/i;
// Same shape but unanchored and global, for scanning a whole block of HTML
// text for every bare URL it contains -- see linkifyPlainUrls below.
const URL_PATTERN_GLOBAL = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi;

// A submit-time safety net, not just the live typing/blur handlers below:
// this session's testing found the live handlers can be timing-sensitive
// (a trailing space normalizes to U+00A0 rather than U+0020 in some cases,
// and this environment couldn't fully confirm blur firing reliably), so a
// ticket's real description could still be saved with an unlinked URL if
// either handler missed it. Runs as a pure string transform on saved HTML:
// parses it, walks every text node NOT already inside an <a> (so an
// already-linked URL, or the same domain appearing as plain label text
// inside a link, is left alone), and wraps any bare URL substring found.
export function linkifyPlainUrls(html: string): string {
  if (!html || !html.includes('http') && !html.includes('www.')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    if (text.parentElement?.closest('a')) continue; // already a link
    URL_PATTERN_GLOBAL.lastIndex = 0;
    if (URL_PATTERN_GLOBAL.test(text.textContent ?? '')) targets.push(text);
  }
  for (const text of targets) {
    const frag = doc.createDocumentFragment();
    let lastIndex = 0;
    URL_PATTERN_GLOBAL.lastIndex = 0;
    const original = text.textContent ?? '';
    let m: RegExpExecArray | null;
    while ((m = URL_PATTERN_GLOBAL.exec(original))) {
      if (m.index > lastIndex) frag.appendChild(doc.createTextNode(original.slice(lastIndex, m.index)));
      const url = m[0];
      const a = doc.createElement('a');
      a.href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      frag.appendChild(a);
      lastIndex = m.index + url.length;
    }
    if (lastIndex < original.length) frag.appendChild(doc.createTextNode(original.slice(lastIndex)));
    text.parentNode?.replaceChild(frag, text);
  }
  return doc.body.innerHTML;
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

  // ── Locked-content protection ─────────────────────────────────────────
  // Any element carrying data-locked-heading (e.g. the Migration board's
  // required description headings, see src/lib/migration-description-template.ts)
  // must never be removable or editable, by anyone, at any time -- not via
  // Backspace/Delete, cut, select-all-and-type-over, drag-out, or a
  // toolbar command run over a selection that spans one. contenteditable="false"
  // already stops the browser from placing a cursor *inside* one, but does
  // nothing to stop the whole node being deleted/replaced from outside.
  // Every mutation path in this component (typing, exec(), paste, drop,
  // mention/image/file insert) converges on emit() before the new value is
  // reported upward, so checking there is the one choke point that covers
  // all of them: if the set of locked headings present right before the
  // edit doesn't match what's present right after, the whole edit is
  // reverted rather than trying to guess which part of it was legitimate.
  const lastGoodHtmlRef = useRef<string>('');
  const lockedSignatureRef = useRef<string | null>(null);
  const computeLockedSignature = (): string | null => {
    const el = editorRef.current;
    if (!el) return null;
    const nodes = Array.from(el.querySelectorAll('[data-locked-heading]'));
    if (nodes.length === 0) return null; // nothing to protect for this editor instance
    return nodes.map(n => n.textContent).join('');
  };

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
    // The "x" that appears over an image on hover, to remove it without
    // having to place a cursor and backspace through it -- checked first,
    // since the button itself sits visually on top of the image.
    const removeBtn = target.closest('[data-rte-img-remove]');
    if (removeBtn) {
      e.preventDefault();
      removeBtn.closest('[data-rte-img-wrap]')?.remove();
      emit();
      return;
    }
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
    // New content just landed from outside (e.g. switching which ticket is
    // loaded) -- re-baseline what "intact" means before any edit can be
    // compared against it.
    lastGoodHtmlRef.current = el.innerHTML;
    lockedSignatureRef.current = computeLockedSignature();
  }, [value]);

  /* ── Emit changes upward ─────────────────────────────────────────── */
  const emit = useCallback(() => {
    const el = editorRef.current;
    if (el && lockedSignatureRef.current !== null) {
      const sig = computeLockedSignature();
      if (sig !== lockedSignatureRef.current) {
        // A locked heading was removed or altered -- undo this edit
        // entirely rather than trying to patch around it.
        el.innerHTML = lastGoodHtmlRef.current;
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch { /* best-effort cursor placement only */ }
      } else {
        lastGoodHtmlRef.current = el.innerHTML;
      }
    }
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

  /* ── Auto-link a plain-typed URL ───────────────────────────────────
   * There was no automatic URL detection at all -- the only way to get a
   * real link was the toolbar's "Insert link" button and its prompt()
   * dialog. Typing (or pasting, see handlePaste) a bare URL just left it
   * as inert plain text, unlike Jira's own description editor and most
   * other rich text editors, which auto-linkify on the fly.
   *
   * Fires in two places: after typing a trailing space/tab (the URL is
   * followed by more text) via checkAutolink() below on every input event,
   * and on blur (the URL is the last/only thing typed in the field, so no
   * trailing space ever arrives) via linkifyTrailingUrl(). Also backstopped
   * by linkifyPlainUrls (module scope, above) at whatever consumer's submit
   * time, in case either handler misses it.
   */

  // `url` is passed explicitly rather than re-sliced from (startIdx, endIdx)
  // -- checkAutolink's endIdx spans through trailing whitespace too (so
  // deleteContents also removes it), but that same span sliced as "the URL
  // text" then baked that whitespace into the <a>'s href and label. Confirmed
  // directly: deriving the url via slice(startIdx, endIdx) produced a
  // trailing "&nbsp;" inside both the href and the visible link text.
  const wrapUrlInRange = (node: Text, startIdx: number, endIdx: number, url: string): HTMLAnchorElement => {
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const range = document.createRange();
    range.setStart(node, startIdx);
    range.setEnd(node, endIdx);
    range.deleteContents();
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    range.insertNode(a);
    return a;
  };

  const checkAutolink = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const cursorOffset = range.startOffset;
    // Only fires right after typing a trailing space -- that's what
    // completes the preceding "word" as a finished token worth linkifying.
    // Confirmed directly (not assumed): a single space keystroke at the end
    // of a text node doesn't insert one U+0020 -- it inserts U+00A0
    // (non-breaking space) followed by a real U+0020, TWO characters, to
    // keep the space from being visually collapsed away. Stripping only the
    // single last character left the nbsp attached to the "word" being
    // checked, so the captured URL (and its href) ended up with a literal
    // trailing nbsp baked in. Strip the WHOLE trailing run of space/nbsp,
    // however many characters that is, rather than assuming exactly one.
    const upToCursor = text.slice(0, cursorOffset);
    const trailingWs = upToCursor.match(/[ \t\u00A0]+$/);
    if (!trailingWs) return;
    const beforeSpace = upToCursor.slice(0, upToCursor.length - trailingWs[0].length);
    const match = beforeSpace.match(URL_PATTERN);
    if (!match) return;
    const startIdx = beforeSpace.length - match[0].length;
    // Consume the whole trailing whitespace run in the deletion too --
    // otherwise the node's existing separator space (the one before the
    // URL) and the freshly re-inserted one below end up adjacent, showing
    // as doubled-up whitespace.
    const a = wrapUrlInRange(node as Text, startIdx, cursorOffset, match[0]);
    // Range.insertNode splits the original text node around the insertion
    // point -- since that point was at the very end of its remaining
    // content, the "after" half is an empty Text node with nothing in it.
    // Harmless on its own, but left in place it's an empty sibling right
    // after the fresh space node below, which is exactly the shape that
    // confused where the browser puts the next character typed.
    if (a.nextSibling?.nodeType === Node.TEXT_NODE && a.nextSibling.textContent === '') {
      a.nextSibling.remove();
    }
    const sp = document.createTextNode(' ');
    a.parentNode?.insertBefore(sp, a.nextSibling);
    const newRange = document.createRange();
    newRange.setStart(sp, 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    emit();
  }, [emit]);

  // A URL with nothing typed after it (no trailing space ever arrives, e.g.
  // it's the only/last content in the field) never reaches checkAutolink's
  // space-triggered path -- catch it on blur instead, scanning the very
  // last text node in the editor for a trailing URL with no space to consume.
  const linkifyTrailingUrl = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) lastText = n as Text;
    if (!lastText) return;
    const text = lastText.textContent ?? '';
    const match = text.match(URL_PATTERN);
    if (!match) return;
    wrapUrlInRange(lastText, text.length - match[0].length, text.length, match[0]);
    emit();
  }, [emit]);

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
          // Reserve the actual display box via real width/height ATTRIBUTES
          // (not just the CSS max-width/max-height below) so the browser
          // knows this image's aspect ratio and lays out its final space
          // immediately, before the image itself has downloaded -- without
          // this, every image starts at ~0 height and then snaps to its real
          // size the moment it loads, shoving everything below it down. That
          // shift landing mid-scroll (multiple images finishing one after
          // another as a ticket with several screenshots renders) is what
          // reads as the page "jumping" while scrolling. w/h here are the
          // already-resized (MAX=1600) dimensions from the canvas step above.
          const dispScale = Math.min(220 / w, 160 / h, 1);
          imgEl.width = Math.round(w * dispScale);
          imgEl.height = Math.round(h * dispScale);
          imgEl.style.cssText = 'max-width:220px;max-height:160px;width:auto;height:auto;border-radius:6px;margin:6px 0;display:block;cursor:pointer;object-fit:contain;';
          // Wrapped so a small "x" can float over the top of the image on
          // hover, to remove it directly rather than having to place a
          // cursor next to it and backspace through it. contenteditable
          // false keeps the whole wrapper (image + button) as one atomic
          // unit for editing purposes, same as the "Uploading…" placeholder
          // above it -- the button itself still receives real clicks
          // (handled in handleEditorClick), contenteditable="false" only
          // affects text-editing operations, not pointer events.
          const wrap = document.createElement('span');
          wrap.setAttribute('data-rte-img-wrap', '');
          wrap.setAttribute('contenteditable', 'false');
          wrap.className = 'group relative inline-block align-top';
          wrap.appendChild(imgEl);
          const removeBtn = document.createElement('span');
          removeBtn.setAttribute('data-rte-img-remove', '');
          removeBtn.title = 'Remove image';
          removeBtn.className = 'hidden group-hover:flex';
          removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:20px;height:20px;align-items:center;justify-content:center;background:rgba(15,23,42,0.75);color:#fff;border-radius:9999px;font-size:13px;line-height:1;cursor:pointer;';
          removeBtn.textContent = '×';
          wrap.appendChild(removeBtn);
          el?.replaceWith(wrap);
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

  // Pasted rich HTML (Word/Confluence/ChatGPT/any webpage) can carry <img>
  // tags whose src is a data: URI (the full image inlined as base64) or a
  // blob: URI (a reference into the SOURCE page's own memory, meaningless
  // outside that exact document). Inserted as-is, a data: image bloats the
  // ticket description by megabytes of inline text -- the same "legacy
  // ticket with a base64-embedded image" bloat problem this file's own
  // upload pipeline exists to avoid -- and a blob: image is dead the instant
  // it lands here, permanently, since the tab/document it was created in is
  // gone. Swap both out for an "Uploading..." placeholder before insertion,
  // then resolve them below through the same upload-and-host pipeline real
  // file uploads use. Ordinary http(s) image URLs are left untouched: they
  // already work today and re-fetching them client-side risks breaking on
  // cross-origin CORS restrictions the current image doesn't hit.
  const extractEmbeddedImages = (html: string): { html: string; images: { placeholderId: string; src: string }[] } => {
    const container = document.createElement('div');
    container.innerHTML = html;
    const images: { placeholderId: string; src: string }[] = [];
    container.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!/^(data|blob):/i.test(src)) return;
      const placeholderId = `up-${Math.random().toString(36).slice(2)}`;
      const placeholder = document.createElement('span');
      placeholder.id = placeholderId;
      placeholder.setAttribute('contenteditable', 'false');
      placeholder.style.cssText = 'display:inline-block;padding:4px 8px;background:#f1f5f9;border-radius:6px;color:#64748b;font-size:12px;';
      placeholder.textContent = 'Uploading pasted image…';
      img.replaceWith(placeholder);
      images.push({ placeholderId, src });
    });
    return { html: container.innerHTML, images };
  };

  // data: URIs are decoded locally (atob) rather than via fetch(): the app's
  // own CSP sets connect-src to 'self' https: (no data:/blob:), so
  // fetch('data:...') is blocked outright even though the same URI displays
  // fine in an <img> src (img-src separately allows data:). blob: URLs have
  // no local-decode equivalent -- they're opaque handles into a browser's
  // blob store, not self-contained data -- and one pasted from another
  // page's document is already invalid here regardless of CSP, so those
  // fall through to the catch below and get removed with an explanation.
  const dataUriToBlob = (dataUri: string): Blob => {
    const comma = dataUri.indexOf(',');
    const header = dataUri.slice(5, comma); // after "data:"
    const isBase64 = header.endsWith(';base64');
    const mime = (isBase64 ? header.slice(0, -';base64'.length) : header) || 'application/octet-stream';
    const data = dataUri.slice(comma + 1);
    const binary = isBase64 ? atob(data) : decodeURIComponent(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };

  const uploadEmbeddedImage = async (placeholderId: string, src: string) => {
    beginUpload();
    try {
      const blob = src.startsWith('data:') ? dataUriToBlob(src) : await (async () => {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error('fetch failed');
        return resp.blob();
      })();
      if (blob.size > MAX_UPLOAD_BYTES) throw new Error('too large');
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : 'jpg';
      const file = new File([blob], `pasted-image.${ext}`, { type: blob.type || 'image/png' });
      // Same box-reservation fix as the file-upload path above -- without a
      // width/height attribute the browser can't reserve this image's space
      // before it downloads, so it snaps in at its real size and shoves
      // everything below it down (the "page jumps while scrolling" report,
      // most visible on a ticket with several pasted screenshots loading in
      // one after another). Measured from the blob itself since this path
      // (paste of rich HTML from Word/Confluence/etc.) has no img.onload
      // dimensions already in scope like the drag-and-drop path does.
      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
        probe.onerror = () => resolve(null);
        probe.src = URL.createObjectURL(blob);
      });
      const result = await uploadFile(file);
      const el = document.getElementById(placeholderId);
      if (!result) { el?.remove(); emit(); return; }
      const imgEl = document.createElement('img');
      imgEl.src = result.url;
      imgEl.alt = 'Pasted image';
      if (dims && dims.w > 0 && dims.h > 0) {
        const dispScale = Math.min(220 / dims.w, 160 / dims.h, 1);
        imgEl.width = Math.round(dims.w * dispScale);
        imgEl.height = Math.round(dims.h * dispScale);
      }
      imgEl.style.cssText = 'max-width:220px;max-height:160px;width:auto;height:auto;border-radius:6px;margin:6px 0;display:block;cursor:pointer;object-fit:contain;';
      const wrap = document.createElement('span');
      wrap.setAttribute('data-rte-img-wrap', '');
      wrap.setAttribute('contenteditable', 'false');
      wrap.className = 'group relative inline-block align-top';
      wrap.appendChild(imgEl);
      const removeBtn = document.createElement('span');
      removeBtn.setAttribute('data-rte-img-remove', '');
      removeBtn.title = 'Remove image';
      removeBtn.className = 'hidden group-hover:flex';
      removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:20px;height:20px;align-items:center;justify-content:center;background:rgba(15,23,42,0.75);color:#fff;border-radius:9999px;font-size:13px;line-height:1;cursor:pointer;';
      removeBtn.textContent = '×';
      wrap.appendChild(removeBtn);
      el?.replaceWith(wrap);
      emit();
    } catch {
      document.getElementById(placeholderId)?.remove();
      warn('Could not load a pasted image — it referenced another page and could not be copied here.');
      emit();
    } finally {
      endUpload();
    }
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
        // A page/tool a screenshot or table was copied from often floats or
        // absolutely-positions its own images (a right-rail figure, a sticky
        // header cell, etc). Kept as-is, that positioning survives the paste
        // and applies here too, where nothing on the page is laid out to
        // expect it -- the image floats past the (usually much shorter)
        // pasted text, leaving a tall empty gap below before the next real
        // element in the flow (reported from a screenshot: a comment's image
        // floating right of its text, with a large blank gap beneath both
        // before the Reply/Edit/Delete row). Comments/descriptions render as
        // plain flow content; nothing here is meant to float or self-position.
        el.style.float = '';
        if (el.style.position === 'absolute' || el.style.position === 'fixed') el.style.position = '';
      });

      // Excel's copied HTML defines its actual grid lines/shading through
      // classes (e.g. class="xl65") pointing at a <style> block that sits in
      // the clipboard payload's <head> -- outside the StartFragment/
      // EndFragment markers Excel itself wraps tightly around just the
      // <table>. extractOfficeFragment (necessarily) only keeps what's
      // between those markers, so the class names paste in but the CSS
      // rules they pointed to never do: real rows/columns of data land in a
      // structurally-correct <table>, just with no visible borders at all,
      // reading as "the table didn't paste" even though every cell's text is
      // right there. Force a plain visible grid on any table that didn't
      // already get real borders some other way (an inline mso-border style
      // that DID survive, or a table not from Office at all).
      container.querySelectorAll<HTMLElement>('table').forEach(table => {
        table.style.borderCollapse = 'collapse';
        table.querySelectorAll<HTMLElement>('td, th').forEach(cell => {
          if (!cell.style.border && !cell.getAttribute('style')?.includes('border')) {
            cell.style.border = '1px solid #d1d5db';
          }
          if (!cell.style.padding) cell.style.padding = '4px 8px';
        });
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
    // A real spreadsheet copy (Excel, Google Sheets, or any grid that
    // preserves cell structure in its clipboard text) always separates
    // columns with a literal tab character in its plain-text representation
    // -- a far more reliable signal than the HTML that comes alongside it.
    // Office's accompanying text/html frequently carries its actual visible
    // borders/shading through classes pointing at a <style> block that sits
    // OUTSIDE the StartFragment/EndFragment markers wrapped tightly around
    // just the <table> -- extractOfficeFragment (necessarily) keeps the
    // structure but drops that styling, and depending on the exact source
    // (a filtered view, an in-tenant web grid the IDs were copied from
    // rather than raw Excel, etc.) the HTML can vary in ways forcing a grid
    // onto every <table> we find doesn't reliably catch. Building our own
    // table straight from the tab/newline structure sidesteps all of that:
    // whatever HTML did or didn't survive, the plain text's tabs and line
    // breaks are the one thing that reliably says "this was columns and
    // rows" -- checked before the HTML branch so it takes priority over
    // whatever (possibly broken) markup came with it.
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const buildBorderedTable = (rows: string[][]) => `<table style="border-collapse:collapse">${rows.map(cells =>
      `<tr>${cells.map(cell =>
        `<td style="border:1px solid #d1d5db;padding:4px 8px">${escapeHtml(cell)}</td>`
      ).join('')}</tr>`
    ).join('')}</table>`;
    if (plainText && plainText.includes('\t')) {
      e.preventDefault();
      editorRef.current?.focus();
      const rows = plainText.replace(/\r/g, '').split('\n').filter(row => row.length > 0);
      document.execCommand('insertHTML', false, buildBorderedTable(rows.map(row => row.split('\t'))));
      emit();
      return;
    }
    // No tabs, but still a list of single-token lines (IDs, keys, codes --
    // exactly what a single-COLUMN spreadsheet selection copies as: one
    // value per line, no tab between columns since there's only one). Real
    // prose essentially never has every line be one whitespace-free token,
    // so this is a narrow, safe signal rather than trying to auto-tableify
    // any multi-line paste (which would wrongly box up an ordinary pasted
    // paragraph split across lines).
    if (plainText) {
      const lines = plainText.replace(/\r/g, '').split('\n').filter(l => l.trim().length > 0);
      if (lines.length >= 2 && lines.every(l => !/\s/.test(l.trim()))) {
        e.preventDefault();
        editorRef.current?.focus();
        document.execCommand('insertHTML', false, buildBorderedTable(lines.map(l => [l.trim()])));
        emit();
        return;
      }
      // A list of IDs pasted as one run of space-separated tokens on the
      // same line(s) -- e.g. copying a "Workspace IDs" column out of a tool
      // that renders it as inline text rather than real cells, or a
      // multi-select value list. Neither branch above catches this: no
      // tabs, and it isn't one-per-line either (confirmed for real -- a
      // pasted "_id 6a5a1b8f... 6a3d2906a9... 6a21bcb4c7..." list of Mongo-
      // style object ids landed as one long wrapped run of plain text with
      // no structure at all). Deliberately narrow: only fires when EVERY
      // token is a long hex-looking id, so an ordinary sentence (words,
      // not hex strings) never gets wrongly boxed into a table.
      const tokens = plainText.trim().split(/\s+/);
      if (tokens.length >= 3 && tokens.every(t => /^[0-9a-f]{16,}$/i.test(t))) {
        e.preventDefault();
        editorRef.current?.focus();
        document.execCommand('insertHTML', false, buildBorderedTable(tokens.map(t => [t])));
        emit();
        return;
      }
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
      const { html: withoutEmbeddedImages, images } = extractEmbeddedImages(sanitizeOfficeHtml(htmlContent));
      document.execCommand('insertHTML', false, withoutEmbeddedImages);
      emit();
      images.forEach(({ placeholderId, src }) => uploadEmbeddedImage(placeholderId, src));
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
        onInput={() => { emit(); checkMention(); checkAutolink(); }}
        onBlur={linkifyTrailingUrl}
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
          [&_table]:border-collapse [&_table]:my-2 [&_table]:max-w-full
          [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top
          [&_th]:border [&_th]:border-gray-300 [&_th]:px-2 [&_th]:py-1 [&_th]:align-top [&_th]:bg-gray-50 [&_th]:font-semibold
          [&_[data-locked-heading]]:font-bold [&_[data-locked-heading]]:bg-slate-50 [&_[data-locked-heading]]:border-l-2
          [&_[data-locked-heading]]:border-slate-300 [&_[data-locked-heading]]:pl-2 [&_[data-locked-heading]]:py-1
          [&_[data-locked-heading]]:my-1 [&_[data-locked-heading]]:rounded-sm [&_[data-locked-heading]]:cursor-default
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
