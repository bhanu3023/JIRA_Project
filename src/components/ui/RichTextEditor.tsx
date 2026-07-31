'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  Bold, Italic, Underline, Strikethrough,
  List, ListOrdered, Code, Quote, Link2,
  Image as ImageIcon, Minus, Paperclip,
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
  const imgRef     = useRef<HTMLInputElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const pendingUploads = useRef(0);
  const beginUpload = () => {
    pendingUploads.current += 1;
    if (pendingUploads.current === 1) onUploadingChange?.(true);
  };
  const endUpload = () => {
    pendingUploads.current = Math.max(0, pendingUploads.current - 1);
    if (pendingUploads.current === 0) onUploadingChange?.(false);
  };
  const skipSync   = useRef(false);

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
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warn = (msg: string) => {
    setWarning(msg);
    if (warnTimer.current) clearTimeout(warnTimer.current);
    warnTimer.current = setTimeout(() => setWarning(null), 5000);
  };

  const uploadFile = async (file: File): Promise<{ url: string } | null> => {
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') : null;
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      return data;
    } catch (e: any) {
      warn(`Failed to upload "${file.name}": ${e?.message || 'unknown error'}`);
      return null;
    }
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
    if (skipSync.current) { skipSync.current = false; return; }
    if (el.innerHTML !== (value ?? '')) el.innerHTML = value ?? '';
  }, [value]);

  /* ── Emit changes upward ─────────────────────────────────────────── */
  const emit = useCallback(() => {
    skipSync.current = true;
    onChange(editorRef.current?.innerHTML ?? '');
  }, [onChange]);

  /* ── execCommand helper ─────────────────────────────────────────── */
  const exec = (cmd: string, val?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val);
    emit();
  };

  const formatBlock = (tag: string) => exec('formatBlock', tag);

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
      if (e.key === 'Enter') {
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
          const result = await uploadFile(new File([blob], uploadName, { type: 'image/jpeg' }));
          const el = document.getElementById(placeholderId);
          if (!result) { el?.remove(); emit(); endUpload(); return; }
          const imgEl = document.createElement('img');
          imgEl.src = result.url;
          imgEl.alt = file.name;
          imgEl.title = file.name;
          imgEl.style.cssText = 'max-width:100%;border-radius:6px;margin:6px 0;display:block;';
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

    uploadFile(file).then((result) => {
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

  /* ── Paste: intercept images; keep HTML formatting ─────────────── */
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find(i => i.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (file) insertImage(file);
      return;
    }
    // If HTML is available in clipboard, let the browser paste it natively
    // (preserves bold, links, lists, etc.) — just emit after
    const htmlContent = e.clipboardData?.getData('text/html');
    if (htmlContent) {
      // Let default browser HTML paste happen, then emit
      setTimeout(emit, 0);
      return;
    }
    // Plain text: insert as-is
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
    }
    setTimeout(emit, 0);
  };

  /* ── Drag-drop ───────────────────────────────────────────────────── */
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach(f => {
      if (f.type.startsWith('image/')) insertImage(f);
      else insertFile(f);
    });
  };

  const handleImgInput  = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(f => f.type.startsWith('image/') ? insertImage(f) : insertFile(f));
    e.target.value = '';
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
        <TBtn title="Insert image" onClick={() => imgRef.current?.click()}><ImageIcon size={13} /></TBtn>
        <TBtn title="Attach file"  onClick={() => fileRef.current?.click()}><Paperclip size={13} /></TBtn>
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
        onDragOver={e => e.preventDefault()}
        data-placeholder={placeholder}
        className={`
          px-3 py-2.5 text-sm text-gray-800 outline-none leading-relaxed
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
          [&_img]:max-w-full [&_img]:rounded-md [&_img]:my-1
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
      <input ref={imgRef}  type="file" accept="image/*" multiple hidden onChange={handleImgInput} />
      <input ref={fileRef} type="file" accept="*/*"     multiple hidden onChange={handleFileInput} />
    </div>
  );
}
