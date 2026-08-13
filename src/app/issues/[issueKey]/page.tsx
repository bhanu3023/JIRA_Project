'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { typeIcons, formatDate, formatDateTime, formatJiraDateTime, timeAgo, getInitials, getIssueStatus, resolveStatusColor, getDeptColor } from '@/lib/utils';
import { trackRecentItem } from '@/lib/recent-items';
import { PriorityIcon, getPriorityMeta, PRIORITIES } from '@/components/ui/PriorityIcon';
import RichTextEditor from '@/components/ui/RichTextEditor';
import PriorityDropdown from '@/components/ui/PriorityDropdown';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import {
  MessageSquare, Paperclip, Link2, Clock, AlertTriangle,
  Trash2, ChevronDown, ChevronRight, User, Check, X, Plus, Search,
  MoreHorizontal, Share2, Eye, Bookmark, Zap, GitBranch,
  ExternalLink, Copy, Upload, Tag, Calendar, Target, Layers, Settings, RefreshCw, Pin, PinOff, FolderUp
} from 'lucide-react';

// Fallback status list for a department whose queue is configured (it shows up
// in custom_queues) but has no queueStatuses of its own set up yet — shows this
// minimal set instead of dumping the space's entire unscoped status list, which
// is what the dropdown showed before and is rarely what any specific queue
// actually wants. Uses the same qst_ id scheme as real custom queue statuses so
// picking one goes through the existing per-queue status storage path.
const DEFAULT_QUEUE_STATUSES = [
  { id: 'qst_default_open', name: 'Open', category: 'todo', color: '#6366F1' },
  { id: 'qst_default_inprogress', name: 'In Progress', category: 'in_progress', color: '#3B82F6' },
  { id: 'qst_default_resolved', name: 'Resolved', category: 'done', color: '#10B981' },
];

// History's comment preview shows the raw stored comment body — which is
// HTML (mentions are `<span class="mention">@Name</span>`, plus whatever
// formatting the rich text editor added) — as plain text, so it needs
// stripping down to just the readable text first or it prints the markup
// literally (e.g. `<span class="mention" data-userid="...">`).
function stripHtmlToText(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]*>/g, '');
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

// A bare URL typed as plain text (e.g. "Server - https://qarelease...") only
// ever got auto-linked when the whole description/comment had literally no
// HTML tags at all — but content saved from the rich text editor always has
// at least a <p> wrapper, so that plain-text-only check almost never actually
// matched for real tickets, leaving typed URLs unclickable. Walk the HTML's
// text nodes (skipping ones already inside a link or a code block, so an
// existing <a> never gets double-wrapped and a URL shown as code stays as
// code) and wrap any bare URL found in one with a real <a> tag.
const URL_TEST_RE = /https?:\/\/[^\s<>"')\]]+/;
const URL_REPLACE_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
function linkifyHtml(html: string): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (text.parentElement?.closest('a, code, pre')) continue;
    if (URL_TEST_RE.test(text.textContent || '')) targets.push(text);
  }
  for (const textNode of targets) {
    const text = textNode.textContent || '';
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(URL_REPLACE_RE)) {
      const url = match[0];
      const offset = match.index ?? 0;
      frag.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
      const clean = url.replace(/[.,;!?]+$/, '');
      const a = document.createElement('a');
      a.href = clean;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = '#2563eb';
      a.style.textDecoration = 'underline';
      a.textContent = clean;
      frag.appendChild(a);
      lastIndex = offset + url.length;
    }
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.replaceWith(frag);
  }
  return container.innerHTML;
}

export default function IssueDetailPage() {
  const params = useParams();
  // Normalize key: strip Jira sub-issue colon suffix (e.g. L2B-12718:1 → L2B-12718)
  const rawKey = (params.issueKey as string).toUpperCase();
  const issueKey = rawKey.includes(':') ? rawKey.split(':')[0] : rawKey;
  const { currentIssue, loadIssue, clearCurrentIssue, user, spaces } = useStore(
    useShallow((s) => ({
      currentIssue: s.currentIssue,
      loadIssue: s.loadIssue,
      clearCurrentIssue: s.clearCurrentIssue,
      user: s.user,
      spaces: s.spaces,
    })),
  );
  const [commentText, setCommentText] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  // Attachment uploads insert a placeholder chip that only gets swapped for the
  // real image/link once the upload resolves — saving while one is still pending
  // bakes that inert placeholder into the stored content permanently (clicking it
  // does nothing since it was never a real link). Gate each Save button on this.
  const [isUploadingComment, setIsUploadingComment] = useState(false);
  const [isUploadingDescription, setIsUploadingDescription] = useState(false);
  const [isUploadingEditComment, setIsUploadingEditComment] = useState(false);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const [showReporterDropdown, setShowReporterDropdown] = useState(false);
  const [reporterSearch, setReporterSearch] = useState('');
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [spaceStatuses, setSpaceStatuses] = useState<any[]>([]);
  const [workflowTransitions, setWorkflowTransitions] = useState<any[]>([]);
  const [spaceMembers, setSpaceMembers] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'comments' | 'history'>('comments');
  const [detailsExpanded, setDetailsExpanded] = useState(true);
  const [slaExpanded, setSlaExpanded] = useState(true);
  const [slaNow, setSlaNow] = useState(() => Date.now());
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [watching, setWatching] = useState(false);
  const [watchCount, setWatchCount] = useState(0);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const knownCommentIds = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [showSubtaskModal, setShowSubtaskModal] = useState(false);
  const [subtaskSummary, setSubtaskSummary] = useState('');
  const [subtaskType, setSubtaskType] = useState('subtask');
  const [subtaskPriority, setSubtaskPriority] = useState('medium');
  const [subtaskAssigneeId, setSubtaskAssigneeId] = useState<string | null>(null);
  const [subtaskSaving, setSubtaskSaving] = useState(false);
  const [subtaskPriorityOpen, setSubtaskPriorityOpen] = useState(false);

  const handleCreateSubtask = async () => {
    if (!subtaskSummary.trim() || !currentIssue) return;
    setSubtaskSaving(true);
    try {
      await api.createIssue({
        summary: subtaskSummary.trim(),
        type: subtaskType,
        priority: subtaskPriority,
        parentKey: currentIssue.key,          // link to parent
        // Use spaceKey from issue, fallback to extracting prefix from issue key (e.g. "SOPS" from "SOPS-82")
        spaceKey: currentIssue.spaceKey || currentIssue.key.split('-').slice(0, -1).join('-'),
        assigneeId: subtaskAssigneeId || undefined,
        // inherit from parent
        description: currentIssue.description || undefined,
        labels: currentIssue.labels || [],
        productType: (currentIssue as any).productType || undefined,
        combination: (currentIssue as any).combination || undefined,
        customerName: (currentIssue as any).customerName || undefined,
        clientName: (currentIssue as any).clientName || undefined,
        projectManager: (currentIssue as any).projectManager || undefined,
        // Without this, the subtask never got a current_department at all, so it
        // fell back to the space's generic "To Do" status instead of the parent's
        // queue's own Open status (and wouldn't show up in that queue's lists).
        department: (currentIssue as any).current_department || undefined,
      });
      setShowSubtaskModal(false);
      setSubtaskSummary('');
      setSubtaskType('subtask');
      setSubtaskPriority('medium');
      setSubtaskAssigneeId(null);
      await loadIssue(issueKey);
    } catch (err: any) {
      console.error('Create subtask failed:', err);
      alert('Failed to create subtask: ' + (err?.message || 'Unknown error'));
    }
    finally { setSubtaskSaving(false); }
  };

  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkType, setLinkType]         = useState('blocks');
  const [linkTarget, setLinkTarget]     = useState('');
  const [linkSaving, setLinkSaving]     = useState(false);
  const [linkSearchResults, setLinkSearchResults] = useState<any[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [showLinkDropdown, setShowLinkDropdown] = useState(false);
  const linkSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedLink, setCopiedLink]     = useState(false);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [mandatoryModal, setMandatoryModal] = useState<{ missingFields: string[]; pendingStatusId?: string; context: 'resolve' | 'department' } | null>(null);
  const [deptBlockModal, setDeptBlockModal] = useState(false);
  const [pendingDeptChange, setPendingDeptChange] = useState<{ dept: { name: string; boardKey: string }; execute: () => void } | null>(null);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const [editingCustomField, setEditingCustomField] = useState<string | null>(null);
  const [customFieldEditValue, setCustomFieldEditValue] = useState('');
  // Search box for multiselect custom fields (Combination has 70+ options,
  // Client Name has 90+) — reset whenever a different field opens for editing.
  const [customFieldSearch, setCustomFieldSearch] = useState('');
  useEffect(() => { setCustomFieldSearch(''); }, [editingCustomField]);
  const [pinnedFields, setPinnedFields] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('jira_pinned_fields') || '[]'); }
    catch { return []; }
  });
  const togglePin = (key: string) => {
    setPinnedFields(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem('jira_pinned_fields', JSON.stringify(next));
      return next;
    });
  };

  // @mention state
  const [mentionOpen,  setMentionOpen]  = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIdx,   setMentionIdx]   = useState(0);
  const [mentionStart, setMentionStart] = useState(0); // cursor position of '@'
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  // Returns all members as flat user objects
  const allMembers = spaceMembers.map((m: any) => m.user || m);

  // Filter members by what's typed after @
  const mentionMatches = mentionOpen
    ? allMembers.filter(m => {
        const full = `${m.firstName} ${m.lastName}`.toLowerCase();
        return full.includes(mentionQuery.toLowerCase());
      })
    : [];

  const handleCommentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val  = e.target.value;
    const pos  = e.target.selectionStart ?? 0;
    setCommentText(val);

    // Find the '@' token before the cursor (no spaces allowed inside)
    const textBefore = val.slice(0, pos);
    const match = textBefore.match(/@([^\s@]*)$/);
    if (match) {
      setMentionOpen(true);
      setMentionQuery(match[1]);
      setMentionStart(pos - match[0].length); // position of '@'
      setMentionIdx(0);
    } else {
      setMentionOpen(false);
    }
  };

  const insertMention = (member: any) => {
    const name   = `${member.firstName} ${member.lastName}`;
    const before = commentText.slice(0, mentionStart);
    const after  = commentText.slice(textareaRef.current?.selectionStart ?? mentionStart + mentionQuery.length + 1);
    const next   = `${before}@${name} ${after}`;
    setCommentText(next);
    setMentionOpen(false);
    // restore focus & move cursor after inserted mention
    setTimeout(() => {
      if (textareaRef.current) {
        const newPos = before.length + name.length + 2; // +2 for '@ '
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen || mentionMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIdx(i => (i + 1) % mentionMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertMention(mentionMatches[mentionIdx]);
    } else if (e.key === 'Escape') {
      setMentionOpen(false);
    }
  };

  // Auto-link plain-text URLs → clickable <a> tags
  const autoLinkText = (text: string) =>
    text.replace(/(https?:\/\/[^\s<>"')\]]+)/gi, url =>
      `<a href="${url.replace(/[.,;!?]+$/, '')}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${url.replace(/[.,;!?]+$/, '')}</a>`
    );

  // Render comment body — HTML if it contains tags, else plain text with @mentions + auto-links
  const renderCommentBody = (body: string) => {
    if (/<[a-z][\s\S]*>/i.test(body)) {
      // HTML content — render directly, intercept all link clicks to force new tab
      return <div
        className="text-[13px] text-gray-700 leading-relaxed break-words [&_img]:max-w-full [&_img]:rounded-md [&_img]:my-1 [&_a]:text-blue-600 [&_a]:underline [&_a]:cursor-pointer [&_a]:hover:text-blue-800 [&_code]:bg-slate-100 [&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
        dangerouslySetInnerHTML={{ __html: linkifyHtml(body) }}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.tagName === 'IMG') {
            const src = (target as HTMLImageElement).src;
            if (src) setLightboxSrc(src);
            return;
          }
          const anchor = target.closest('a') as HTMLAnchorElement | null;
          if (anchor) {
            e.preventDefault();
            const href = anchor.getAttribute('href');
            if (href && href !== '#') window.open(href, '_blank', 'noopener,noreferrer');
          }
        }}
      />;
    }
    // Plain text — auto-link URLs and highlight @mentions
    const linked = autoLinkText(body);
    const parts = linked.split(/(@\w[\w ]*)/g);
    return <p className="text-[13px] text-gray-700 whitespace-pre-wrap break-words leading-relaxed">{parts.map((part, i) =>
      part.startsWith('@') ? (
        <span key={i} className="text-indigo-600 font-semibold bg-indigo-50 rounded px-0.5">{part}</span>
      ) : <span key={i} dangerouslySetInnerHTML={{ __html: part }} />
    )}</p>;
  };
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAttachCount, setUploadingAttachCount] = useState(0);

  const [issueLoadDone, setIssueLoadDone] = useState(false);

  useEffect(() => {
    setIssueLoadDone(false);
    loadIssue(issueKey).finally(() => setIssueLoadDone(true));
    // Load watch status
    api.getWatch(issueKey).then(r => { setWatching(r.watching); setWatchCount(r.count); }).catch(() => {});
    return () => { clearCurrentIssue(); setIssueLoadDone(false); };
  }, [issueKey, loadIssue, clearCurrentIssue]);

  // Live SLA countdown — tick every second when SLA panel is visible
  useEffect(() => {
    const t = setInterval(() => setSlaNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Redirect to CF key URL if issue loaded with original Jira key
  useEffect(() => {
    if (currentIssue?.cfKey && issueKey !== currentIssue.cfKey) {
      router.replace(`/issues/${currentIssue.cfKey}`);
    }
  }, [currentIssue?.cfKey, issueKey]);

  // Track recently viewed issue — per user so different users don't share history
  useEffect(() => {
    if (currentIssue?.key && currentIssue?.summary) {
      trackRecentItem({
        id: currentIssue.key,
        type: 'issue',
        title: currentIssue.summary,
        href: `/issues/${currentIssue.cfKey ?? currentIssue.key}`,
        spaceKey: currentIssue.spaceKey,
        issueType: currentIssue.type,
      }, user?.id);
    }
  }, [currentIssue?.key, user?.id]);

  useEffect(() => {
    if (currentIssue?.spaceKey) {
      const dept = (currentIssue as any).current_department as string | undefined;

      // When a ticket is routed to a department, find the dept_queue space that owns
      // the custom queue with that name, and load statuses/workflow from THAT space.
      const loadStatusesForSpace = (spaceKey: string, statusIds?: string[]) => {
        api.getSpace(spaceKey).then(space => {
          const allStatuses = space.statuses || [];
          // If queue has specific statusIds configured, filter to only those
          const filtered = statusIds?.length
            ? allStatuses.filter((s: any) => statusIds.includes(s.id))
            : allStatuses;
          setSpaceStatuses(filtered);
          setSpaceMembers(space.members || []);
          api.request<any>(`workflows/wf_${spaceKey}/statuses`).then(wf => {
            setWorkflowTransitions(wf.transitions || space.transitions || []);
          }).catch(() => {
            setWorkflowTransitions(space.transitions || []);
          });
        }).catch(() => {});
      };

      if (dept) {
        // Resolve which space's custom queue matches this department in ONE
        // targeted request (department-queue) instead of fetching
        // all-space-keys and then firing one custom-queues/:spaceKey request
        // PER SPACE IN THE SYSTEM to find the same thing — that used to run
        // on every single ticket open, turning "open one ticket" into
        // 10-20+ parallel requests.
        (async () => {
          // Cheap first pass: localStorage cache from spaces this browser has visited —
          // shows something instantly, but must NOT be trusted as final: it goes stale
          // the moment a queue's status list changes on the server (e.g. an admin
          // configures Infra's statuses after this browser already cached Infra with
          // none). This used to `return` immediately on any match, permanently freezing
          // the dropdown on whatever was cached the first time this browser saw the
          // queue — always re-verifying against the live API below fixes that.
          let resolvedFromCache = false;
          const cachedSpaceKeys = [
            currentIssue.spaceKey,
            ...(spaces as any[]).map((s: any) => s.key).filter((k: string) => k !== currentIssue.spaceKey),
          ];
          for (const spKey of cachedSpaceKeys) {
            try {
              const stored = localStorage.getItem(`custom_queues_${spKey}`);
              if (!stored) continue;
              const queues: any[] = JSON.parse(stored);
              const matchedQueue = queues.find(q => (q.name || '').toLowerCase() === dept.toLowerCase());
              if (matchedQueue) {
                const qSt = matchedQueue.queueStatuses;
                const qTr = matchedQueue.queueTransitions;
                if (qSt?.length) {
                  setSpaceStatuses(qSt);
                  setWorkflowTransitions((qTr || []).map((t: any) => ({
                    fromStatusId: t.fromStatusId ?? t.from,
                    toStatusId: t.toStatusId ?? t.to,
                  })));
                } else if (matchedQueue.statusIds?.length) {
                  const effectiveKey = matchedQueue.workflowSpaceKey || spKey;
                  loadStatusesForSpace(effectiveKey, matchedQueue.statusIds);
                } else {
                  setSpaceStatuses(DEFAULT_QUEUE_STATUSES);
                  setWorkflowTransitions([]);
                }
                resolvedFromCache = true;
                break;
              }
            } catch {}
          }

          // Always verify against the live API and correct the display if the cached
          // snapshot was stale — also refreshes the cache for next time.
          try {
            const result = await api.request<{ spaceKey: string | null; queue: any }>(
              `department-queue?dept=${encodeURIComponent(dept)}`
            );
            const matchedQueue = result?.queue;
            const spKey = result?.spaceKey;
            if (matchedQueue && spKey) {
              try {
                const existing: any[] = JSON.parse(localStorage.getItem(`custom_queues_${spKey}`) || '[]');
                const others = existing.filter((q: any) => q.id !== matchedQueue.id);
                localStorage.setItem(`custom_queues_${spKey}`, JSON.stringify([...others, matchedQueue]));
              } catch {}
              const qSt = matchedQueue.queueStatuses;
              const qTr = matchedQueue.queueTransitions;
              if (qSt?.length) {
                setSpaceStatuses(qSt);
                setWorkflowTransitions((qTr || []).map((t: any) => ({
                  fromStatusId: t.fromStatusId ?? t.from,
                  toStatusId: t.toStatusId ?? t.to,
                })));
                return;
              }
              if (matchedQueue.statusIds?.length) {
                const effectiveKey = matchedQueue.workflowSpaceKey || spKey;
                loadStatusesForSpace(effectiveKey, matchedQueue.statusIds);
                return;
              }
              setSpaceStatuses(DEFAULT_QUEUE_STATUSES);
              setWorkflowTransitions([]);
              return;
            }
          } catch {}
          if (!resolvedFromCache) loadStatusesForSpace(currentIssue.spaceKey);
        })();
      } else {
        loadStatusesForSpace(currentIssue.spaceKey);
      }
    }
    // Always load members from the issue's own space (not the workflow space which may differ)
    if (currentIssue?.spaceKey) {
      api.getSpace(currentIssue.spaceKey).then((sp: any) => {
        if (sp?.members?.length) setSpaceMembers(sp.members);
      }).catch(() => {});
    }

    if (currentIssue?.spaceId && currentIssue?.id) {
      // Load custom fields for this space — also include any that were auto-copied by automation
      Promise.all([
        api.getCustomFields(),
        api.getCustomFieldValues(currentIssue.id).catch(() => [] as any[]),
      ]).then(([fields, vals]: [any[], any[]]) => {
        // Build set of field ids that have a stored value on this issue
        const fieldIdsWithValues = new Set(
          (vals || []).map((v: any) => v.fieldId || v.id).filter(Boolean)
        );
        // Read migratedFieldConfig from localStorage to check board assignments
        // for fields like Product Type, Combination that may only be in localStorage
        let migratedCfg: Record<string, { spaceIds: string[] }> = {};
        try { migratedCfg = JSON.parse(localStorage.getItem('migrated_field_config') || '{}'); } catch {}

        const NATIVE_COLS: Record<string, string> = {
          'Customer Name': 'customerName', 'Client Name': 'clientName',
          'Work Type': 'workType', 'Product Type': 'productType',
          'Combination': 'combination', 'Project Manager': 'projectManager',
        };
        const HIDDEN_FIELDS = new Set(['Sprint', 'Story Points', 'Labels']);
        const applicable = fields.filter((f: any) => {
          if (f.isDeleted) return false;
          if (HIDDEN_FIELDS.has(f.name)) return false;
          // Never show built-in system fields here — they have their own dedicated rows
          if (f.source === 'system') return false;
          const ids: string[] = Array.isArray(f.spaceIds) ? f.spaceIds : [];
          // Check migratedFieldConfig localStorage assignment for this field by name
          const migratedIds: string[] = migratedCfg[f.name]?.spaceIds || [];
          // Also show if the issue already has a native column value for this field
          const nativeCol = NATIVE_COLS[f.name];
          const hasNativeValue = nativeCol ? !!((currentIssue as any)[nativeCol]) : false;
          // Show if: assigned to this space (DB or localStorage config) OR has a stored value OR has a native value
          return ids.includes(currentIssue.spaceId) || migratedIds.includes(currentIssue.spaceId) || fieldIdsWithValues.has(f.id) || fieldIdsWithValues.has(`cf_${f.id}`) || hasNativeValue;
        });
        setCustomFields(applicable);
      }).catch(() => {});
      // Load current values, then sync SLA breach status into custom fields
      (async () => {
        try {
          const [vals, freshIssue, allFields] = await Promise.all([
            api.getCustomFieldValues(currentIssue.id).catch(() => [] as any[]),
            api.getIssue(currentIssue.key).catch(() => currentIssue as any),
            api.getCustomFields().catch(() => [] as any[])
          ]);
          const map: Record<string, string> = {};
          (vals || []).forEach((v: any) => { map[v.fieldId] = v.value; });

          const sla: any[] = freshIssue.sla || currentIssue.sla || [];
          const now = new Date();
          // Build set of field ids that have a stored value on this issue (incl. automation-copied)
          const valFieldIds = new Set((vals || []).map((v: any) => v.fieldId).filter(Boolean));
          const slaFields = allFields.filter((f: any) => {
            if (f.isDeleted || f.source === 'system') return false;
            const ids: string[] = Array.isArray(f.spaceIds) ? f.spaceIds : [];
            const inSpace = ids.includes(currentIssue.spaceId) || valFieldIds.has(f.id) || valFieldIds.has(`cf_${f.id}`);
            if (!inSpace) return false;
            return (f.name || '').toLowerCase().includes('time to first response') ||
                   (f.name || '').toLowerCase().includes('time to resolution');
          });
          for (const cf of slaFields) {
            const cfName = (cf.name || '').toLowerCase();
            const matchedSLA = sla.find((s: any) => {
              const sName = (s.policyName || '').toLowerCase();
              return cfName.includes('time to first response') ? sName.includes('time to first response') : sName.includes('time to resolution');
            });
            if (matchedSLA) {
              const due = new Date(matchedSLA.dueTime);
              const isBreached = matchedSLA.isBreached || due < now;
              const desired = isBreached ? 'Yes' : 'No';
              if ((map[cf.id] || '') !== desired) {
                await api.setCustomFieldValue(currentIssue.id, cf.id, desired).catch(() => {});
                map[cf.id] = desired;
              }
            }
          }
          setCustomFieldValues(map);
        } catch { /* ignore */ }
      })();
    }
  }, [currentIssue?.spaceKey, currentIssue?.id, currentIssue?.spaceId, spaces, user?.id]);

  // Periodically re-check SLA breach status every 30s and sync custom fields
  useEffect(() => {
    if (!currentIssue?.id || !currentIssue?.spaceId) return;
    const syncSLA = async () => {
      try {
        const [freshIssue, allFields] = await Promise.all([
          api.getIssue(currentIssue.key),
          api.getCustomFields()
        ]);
        const sla = freshIssue.sla || [];
        const now = new Date();
        const slaFields = allFields.filter((f: any) => {
          if (f.isDeleted || f.source === 'system') return false;
          const ids: string[] = Array.isArray(f.spaceIds) ? f.spaceIds : [];
          const inSpace = ids.includes(currentIssue.spaceId);
          const isSLA = (f.name || '').toLowerCase().includes('time to first response') ||
                        (f.name || '').toLowerCase().includes('time to resolution');
          return inSpace && isSLA;
        });
        for (const cf of slaFields) {
          const cfName = (cf.name || '').toLowerCase();
          const matchedSLA = sla.filter((s: any) => !s.isCompleted).find((s: any) => {
            const sName = (s.policyName || '').toLowerCase();
            return cfName.includes('time to first response') ? sName.includes('time to first response') : sName.includes('time to resolution');
          });
          if (matchedSLA) {
            const due = new Date(matchedSLA.dueTime);
            const isBreached = matchedSLA.isBreached || due < now;
            const desired = isBreached ? 'Yes' : 'No';
            setCustomFieldValues(prev => {
              if ((prev[cf.id] || '') === desired) return prev;
              api.setCustomFieldValue(currentIssue.id, cf.id, desired).catch(() => {});
              return { ...prev, [cf.id]: desired };
            });
          }
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(syncSLA, 30000);
    return () => clearInterval(interval);
  }, [currentIssue?.id, currentIssue?.spaceId, currentIssue?.key]);

  // ── Notification sound + polling for new comments on CUSTM (Customer_Board) ──
  const playNotificationSound = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      // Two-tone chime: higher note then lower note
      const notes = [880, 660];
      notes.forEach((freq, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.18);
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
        gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + i * 0.18 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.35);
        osc.start(ctx.currentTime + i * 0.18);
        osc.stop(ctx.currentTime + i * 0.18 + 0.36);
      });
    } catch { /* AudioContext not available */ }
  };

  useEffect(() => {
    // Only poll for CUSTM (Customer_Board) tickets
    if (!currentIssue?.spaceKey || currentIssue.spaceKey !== 'CUSTM') return;

    // Seed known IDs from current comments on mount (no sound for existing)
    const seed = (currentIssue.comments || []).map((c: any) => c.id);
    knownCommentIds.current = new Set(seed);

    const poll = setInterval(async () => {
      try {
        const fresh = await api.getIssue(issueKey);
        const freshComments = (fresh?.comments || []).filter(
          (c: any) => c.authorName !== 'System' && c.author?.email !== 'system'
        );
        let hasNew = false;
        for (const c of freshComments) {
          if (!knownCommentIds.current.has(c.id)) {
            knownCommentIds.current.add(c.id);
            // Only sound for comments by someone other than the current user
            const commenterEmail = (c.author?.email || '').toLowerCase();
            const myEmail = (user?.email || '').toLowerCase();
            if (commenterEmail !== myEmail) hasNew = true;
          }
        }
        if (hasNew) {
          playNotificationSound();
          // Also refresh the issue so the new comment appears
          loadIssue(issueKey);
        }
      } catch { /* ignore polling errors */ }
    }, 15000);

    return () => clearInterval(poll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIssue?.spaceKey, currentIssue?.id, issueKey]);

  const handleAddComment = async () => {
    if (!commentText.trim() || submittingComment) return;
    setSubmittingComment(true);
    const textToSubmit = commentText;
    const tempId = `opt-${Date.now()}`;
    setCommentText(''); // clear immediately to prevent double-submit
    // Append the comment right away — the previous version built this same
    // "optimistic" object but only appended it after awaiting the server response,
    // so it never actually showed until the round-trip finished.
    const optimisticComment = {
      id: tempId,
      body: textToSubmit,
      isInternal,
      authorName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || 'You',
      author: user,
      createdAt: new Date().toISOString(),
    };
    useStore.setState((s) => ({
      currentIssue: s.currentIssue
        ? { ...s.currentIssue, comments: [...(s.currentIssue.comments || []), optimisticComment] }
        : s.currentIssue,
    }));
    try {
      const saved = await api.addComment(issueKey, { body: textToSubmit, isInternal });
      setIsInternal(false);
      // Mark this comment as known so the poll doesn't fire a sound for our own comment
      if (saved?.id) knownCommentIds.current.add(saved.id);
      // Swap the placeholder for the real saved comment (real id/timestamps)
      useStore.setState((s) => ({
        currentIssue: s.currentIssue
          ? { ...s.currentIssue, comments: (s.currentIssue.comments || []).map((c: any) => c.id === tempId ? (saved || c) : c) }
          : s.currentIssue,
      }));
      // Background refresh to sync server state (don't await — no spinner)
      loadIssue(issueKey);
    } catch (err: any) {
      // 409 duplicate means the comment was already saved — don't restore text
      if (!err?.message?.includes('Duplicate comment')) {
        console.error(err);
        setCommentText(textToSubmit); // restore text on non-duplicate failures
        useStore.setState((s) => ({
          currentIssue: s.currentIssue
            ? { ...s.currentIssue, comments: (s.currentIssue.comments || []).filter((c: any) => c.id !== tempId) }
            : s.currentIssue,
        }));
      }
    }
    finally { setSubmittingComment(false); }
  };

  // displayPatch covers relational fields (assignee, status) whose visible name/avatar
  // lives on a different key than the raw id being saved (issue.assignee vs assigneeId).
  const handleUpdate = async (field: string, value: any, displayPatch?: Record<string, any>) => {
    const prevValue = (issue as any)?.[field];
    const patchKeys = displayPatch ? Object.keys(displayPatch) : [];
    const prevDisplay: Record<string, any> = {};
    for (const k of patchKeys) prevDisplay[k] = (issue as any)?.[k];
    // Reflect the change immediately instead of waiting on a PATCH + full reissue
    // fetch before anything on screen moves — sync with the server in the
    // background and revert only if the request actually fails.
    useStore.setState(s => ({
      currentIssue: s.currentIssue ? { ...s.currentIssue, [field]: value, ...(displayPatch || {}) } as any : s.currentIssue,
    }));
    setEditing(null);
    try {
      await api.updateIssue(issueKey, { [field]: value });
      loadIssue(issueKey);
    } catch (err) {
      console.error(err);
      useStore.setState(s => ({
        currentIssue: s.currentIssue ? { ...s.currentIssue, [field]: prevValue, ...prevDisplay } as any : s.currentIssue,
      }));
    }
  };

  // The board-specific custom fields below (Combination, Product Type, Project
  // Manager, etc.) used to await BOTH the PATCH and a full loadIssue() re-fetch
  // before closing the edit UI — but PATCH /issues/:key already returns the
  // fully updated issue, so that second full re-fetch (comments, attachments,
  // activity, SLA, everything) was a wasted extra round-trip making every save
  // feel slow just to get back data the PATCH response already had. Same
  // optimistic-update pattern as handleUpdate above: reflect the change and
  // close the editor immediately, sync with the server in the background.
  const saveCustomField = (key: string, newVal: any) => {
    const prevValue = (issue as any)?.[key];
    useStore.setState(s => ({
      currentIssue: s.currentIssue ? { ...s.currentIssue, [key]: newVal } as any : s.currentIssue,
    }));
    setEditingCustomField(null);
    api.updateIssue(issueKey, { [key]: newVal }).catch((e: any) => {
      console.error(`Save ${key} failed`, e);
      useStore.setState(s => ({
        currentIssue: s.currentIssue ? { ...s.currentIssue, [key]: prevValue } as any : s.currentIssue,
      }));
      alert('Failed to save. Please try again.');
    });
  };

  // Shared renderer for the board-specific custom fields below — this exact
  // view/edit/save structure was duplicated ~8 times (once per board), differing
  // only in which fields/options each board uses. Also adds a search box to
  // multiselect fields with more than a handful of options (Combination has
  // 70+, Client Name has 90+), instead of just a plain scrollable checkbox list.
  const renderCustomField = (
    key: string,
    label: string,
    type: 'select' | 'multiselect' | 'tags' | 'text' | 'textarea',
    options: string[] | undefined,
    editPrefix: string,
  ) => {
    const rawVal = (issue as any)[key];
    const currentVal = Array.isArray(rawVal) ? rawVal : (rawVal || '');
    const displayVal = Array.isArray(currentVal) ? currentVal.join(', ') : currentVal;
    const editKey = `${editPrefix}_${key}`;
    const allOptions = options || [];
    const filteredOptions = customFieldSearch.trim()
      ? allOptions.filter(o => o.toLowerCase().includes(customFieldSearch.trim().toLowerCase()))
      : allOptions;
    return (
      <PropRow key={key} label={label}>
        {editingCustomField === editKey ? (
          <div className="flex flex-col gap-1 px-1.5 py-1" onClick={e => e.stopPropagation()}>
            {type === 'textarea' ? (
              <textarea value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus rows={3}
                className="border border-blue-400 rounded px-2 py-1 text-[12px] focus:outline-none w-full resize-none" />
            ) : type === 'text' ? (
              <input value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                className="border border-blue-400 rounded px-2 py-0.5 text-[12px] focus:outline-none w-full" />
            ) : type === 'select' ? (
              <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                className="border border-blue-400 rounded px-2 py-0.5 text-[12px] focus:outline-none bg-white">
                <option value="">None</option>
                {allOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : type === 'tags' ? (
              <input value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                placeholder="Comma-separated values"
                className="border border-blue-400 rounded px-2 py-0.5 text-[12px] focus:outline-none w-full" />
            ) : (
              /* multiselect — searchable checkbox list */
              <div className="border border-blue-400 rounded bg-white overflow-hidden">
                {allOptions.length > 8 && (
                  <input value={customFieldSearch} onChange={e => setCustomFieldSearch(e.target.value)} autoFocus
                    placeholder={`Search ${allOptions.length} options…`}
                    className="w-full px-2 py-1 text-[12px] border-b border-gray-200 focus:outline-none" />
                )}
                <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto p-1.5">
                  {filteredOptions.length === 0 && (
                    <p className="text-[11px] text-gray-400 px-1 py-1">No matches</p>
                  )}
                  {filteredOptions.map(o => {
                    const selected = customFieldEditValue.split(',').map(s => s.trim()).filter(Boolean);
                    const checked = selected.includes(o);
                    return (
                      <label key={o} className="flex items-center gap-1.5 text-[12px] cursor-pointer hover:bg-gray-50 px-1 rounded">
                        <input type="checkbox" checked={checked} onChange={() => {
                          const updated = checked ? selected.filter(s => s !== o) : [...selected, o];
                          setCustomFieldEditValue(updated.join(', '));
                        }} />
                        {o}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex gap-1 mt-0.5">
              <button onClick={() => {
                const newVal = (type === 'multiselect' || type === 'tags')
                  ? customFieldEditValue.split(',').map(s => s.trim()).filter(Boolean)
                  : customFieldEditValue;
                saveCustomField(key, newVal);
              }} className="text-[11px] bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700">Save</button>
              <button onClick={() => setEditingCustomField(null)} className="text-[11px] text-gray-500 px-2 py-0.5 rounded hover:bg-gray-100">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => { setEditingCustomField(editKey); setCustomFieldEditValue(Array.isArray(currentVal) ? currentVal.join(', ') : currentVal); }}
            className="text-[13px] hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left">
            {displayVal
              ? <span className="text-gray-700 whitespace-pre-wrap break-words">{displayVal}</span>
              : <span className="text-gray-400">None</span>}
          </button>
        )}
      </PropRow>
    );
  };

  // Combination / Product Type / Project Manager must be filled before resolving a ticket
  // OR moving it to another department — shared by handleStatusChange and department change.
  const getMissingCoreFields = (): string[] => {
    const missing: string[] = [];
    const alwaysRequired: { name: string; key: string }[] = [
      { name: 'Project Manager', key: 'projectManager' },
      { name: 'Product Type',    key: 'productType'    },
      { name: 'Combination',     key: 'combination'    },
    ];
    for (const f of alwaysRequired) {
      const cfEntry = customFields.find(cf => cf.name?.toLowerCase() === f.name.toLowerCase());
      const val = (cfEntry ? customFieldValues[cfEntry.id] : null) || (issue as any)?.[f.key];
      if (!val || val.toString().trim() === '') missing.push(f.name);
    }
    return missing;
  };

  const handleStatusChange = async (statusId: string) => {
    setShowStatusDropdown(false);
    // Check if moving to a "done" category status — validate required fields
    const targetStatus = spaceStatuses.find(s => s.id === statusId);
    if (targetStatus?.category === 'done') {
      const missing: string[] = getMissingCoreFields();

      // Any other custom fields explicitly marked required
      const nativeKey: Record<string, string> = {
        'Customer Name': 'customerName', 'Client Name': 'clientName',
        'Work Type': 'workType', 'Product Type': 'productType',
        'Combination': 'combination', 'Project Manager': 'projectManager',
      };
      for (const cf of customFields.filter(c => c.required)) {
        if (missing.includes(cf.name) || ['Project Manager', 'Product Type', 'Combination'].includes(cf.name)) continue; // already checked
        const val = customFieldValues[cf.id] || (nativeKey[cf.name] ? (issue as any)?.[nativeKey[cf.name]] : null);
        if (!val || val.toString().trim() === '') missing.push(cf.name);
      }

      // Assignee must be set
      if (!issue?.assignee) missing.push('Assignee');

      if (missing.length > 0) {
        setMandatoryModal({ missingFields: missing, pendingStatusId: statusId, context: 'resolve' });
        return;
      }
    }
    // Custom queue status (qst_...) — can't set as issue.statusId (not a DB record).
    // Store in dept_statuses[current_department] instead.
    if (statusId.startsWith('qst_') && targetStatus) {
      const dept = (issue as any).current_department;
      if (dept) {
        const prevDeptStatuses = (issue as any).dept_statuses;
        const queueSt = {
          id: statusId, name: (targetStatus as any).name,
          color: (targetStatus as any).color || '#64748B', category: (targetStatus as any).category || 'todo',
        };
        useStore.setState(s => ({
          currentIssue: s.currentIssue ? { ...s.currentIssue, dept_statuses: { ...(s.currentIssue as any).dept_statuses, [dept]: queueSt } } as any : s.currentIssue,
        }));
        setShowStatusDropdown(false);
        try {
          await api.updateIssue(issueKey, {
            queueStatusId: statusId,
            queueStatusName: queueSt.name,
            queueStatusColor: queueSt.color,
            queueStatusCategory: queueSt.category,
          } as any);
          loadIssue(issueKey);
        } catch (err) {
          console.error(err);
          useStore.setState(s => ({
            currentIssue: s.currentIssue ? { ...s.currentIssue, dept_statuses: prevDeptStatuses } as any : s.currentIssue,
          }));
        }
        return;
      }
    }
    await handleUpdate('statusId', statusId, targetStatus
      ? { status: { id: targetStatus.id, name: targetStatus.name, category: (targetStatus as any).category, color: (targetStatus as any).color } }
      : undefined);
  };

  const handleAssigneeChange = async (assigneeId: string | null) => {
    setShowAssigneeDropdown(false);
    const member = assigneeId ? spaceMembers.find(m => m.id === assigneeId) : null;
    await handleUpdate('assigneeId', assigneeId, {
      assignee: member ? { id: member.id, firstName: member.firstName, lastName: member.lastName, email: (member as any).email, avatarUrl: (member as any).avatarUrl ?? null } : null,
    });
  };

  // Tickets migrated from Jira, or created without a reporter being picked,
  // can end up with no reporter at all — previously there was no way to set
  // one afterward since this field had no edit UI, unlike every other
  // property. Mirrors handleAssigneeChange.
  const handleReporterChange = async (reporterId: string | null) => {
    setShowReporterDropdown(false);
    const member = reporterId ? spaceMembers.find(m => m.id === reporterId) : null;
    await handleUpdate('reporterId', reporterId, {
      reporter: member ? { id: member.id, firstName: member.firstName, lastName: member.lastName, email: (member as any).email, avatarUrl: (member as any).avatarUrl ?? null } : null,
    });
  };

  const handlePriorityChange = async (priority: string) => {
    await handleUpdate('priority', priority);
    // Reset SLA custom fields to 'No' when priority changes (new SLA cycle starts)
    const slaCustomFields = customFields.filter(cf => {
      const name = (cf.name || '').toLowerCase();
      return name.includes('time to first response') || name.includes('time to resolution');
    });
    for (const cf of slaCustomFields) {
      if ((customFieldValues[cf.id] || '').toLowerCase() === 'yes') {
        try {
          await api.setCustomFieldValue(issue.id, cf.id, 'No');
          setCustomFieldValues(prev => ({ ...prev, [cf.id]: 'No' }));
        } catch { /* ignore */ }
      }
    }
  };

  const handleTypeChange = async (type: string) => {
    setShowTypeDropdown(false);
    await handleUpdate('type', type);
  };

  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024; // 10GB, matches the server-side cap
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Selecting multiple files (or a whole folder, via the folder-picker input)
    // used to only upload files[0] — everything else picked was silently
    // dropped with no error. Upload every selected file, immediately and in
    // parallel, so "attach" behaves the same whether it's one file or a
    // hundred picked from a folder.
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setUploadingAttachCount(files.length);
    await Promise.all(files.map(async (file) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        console.error(`"${file.name}" is too large (max 10GB).`);
        return;
      }
      // Directory-picked files only carry their bare name (file.name); the
      // browser fills in webkitRelativePath with the folder-qualified path
      // (e.g. "reports/summary.pdf") — pass that through so two files with
      // the same name in different subfolders don't look identical here.
      const displayName = (file as any).webkitRelativePath || file.name;
      try {
        await api.uploadAttachment(issueKey, file, displayName);
      } catch (err) { console.error(err); }
    }));
    setUploadingAttachCount(0);
    loadIssue(issueKey);
  };

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewAttach, setPreviewAttach] = useState<{url: string; name: string; mime: string} | null>(null);

  // Is current user an admin of this space?
  const isSpaceAdmin = React.useMemo(() => {
    if (!user) return false;
    // Check global role first
    if ((user as any).role === 'admin' || (user as any).role === 'ADMIN') return true;
    // Check space membership role
    const myMembership = spaceMembers.find((m: any) => {
      const memberId = m.user?.id || m.userId || m.id;
      return memberId === user.id;
    });
    if (!myMembership) return false;
    const role = (myMembership.role || '').toLowerCase();
    return role === 'admin' || role === 'administrator' || role === 'owner';
  }, [user, spaceMembers]);

  // Previously gated to admins / the current queue's own members once a ticket
  // moved to another department — anyone can edit a ticket regardless of which
  // queue currently owns it now, matching the backend PATCH endpoint.
  const canEdit = true;

  // Resolve the correct per-queue workflow URL for a ticket with current_department.
  // Checks the issue's own space first, then all loaded spaces — no type filter needed.
  const resolveQueueWorkflowHref = React.useCallback((issueSpaceKey: string, dept: string | undefined): string => {
    if (dept) {
      const keysToSearch = [issueSpaceKey, ...(spaces as any[]).map((s: any) => s.key).filter((k: string) => k !== issueSpaceKey)];
      for (const key of keysToSearch) {
        try {
          const stored = localStorage.getItem(`custom_queues_${key}`);
          if (stored) {
            const qs: any[] = JSON.parse(stored);
            const q = qs.find((q: any) => (q.name || '').toLowerCase() === dept.toLowerCase());
            if (q) return `/spaces/${key}/queue/${q.id}/workflow`;
          }
        } catch {}
      }
    }
    return `/spaces/${issueSpaceKey}/workflow`;
  }, [spaces]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteIssue(issueKey);
      setShowDeleteModal(false);
      const spaceKey = currentIssue?.spaceKey || issueKey.split('-').slice(0, -1).join('-');
      if (spaceKey) {
        router.push(`/spaces/${spaceKey}`);
      } else {
        router.push('/');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  };

  // router.back() assumes there's always an in-app page behind this one in
  // browser history — but opening an issue directly (email link, notification,
  // shared URL, refresh) leaves no such history, so "Back" would land
  // somewhere unrelated or force a full reload instead of returning to the
  // ticket's queue. Navigate to a known destination instead: the queue this
  // ticket's department belongs to, list caching there means it renders from
  // cache instantly rather than re-fetching.
  const handleBack = () => {
    const spaceKey = currentIssue?.spaceKey || issueKey.split('-').slice(0, -1).join('-');
    const dept = (currentIssue as any)?.current_department;
    if (spaceKey && dept) {
      router.push(`/spaces/${spaceKey}?queue=dept_all&dept=${encodeURIComponent(dept)}`);
    } else if (spaceKey) {
      router.push(`/spaces/${spaceKey}`);
    } else {
      router.push('/dashboard');
    }
  };

  if (issueLoadDone && !currentIssue) return (
    <div className="flex items-center justify-center h-64">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-2xl">?</div>
        <p className="text-base font-semibold text-gray-700">Issue not found</p>
        <p className="text-sm text-gray-400">The issue <span className="font-mono font-medium text-gray-600">{issueKey}</span> does not exist or was deleted.</p>
        <button onClick={handleBack} className="mt-2 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">Go back</button>
      </div>
    </div>
  );

  if (!currentIssue) return (
    <div className="flex items-center justify-center h-64">
      <div className="flex flex-col items-center gap-3">
        <div className="animate-spin w-8 h-8 border-[3px] border-indigo-600 border-t-transparent rounded-full" />
        <span className="text-sm text-gray-400">Loading issue...</span>
      </div>
    </div>
  );

  const issue = currentIssue;
  // Use per-queue custom status from dept_statuses when the issue is in a queue
  // and the stored status is a custom queue status (qst_... ID).
  const rawDeptStatuses = (issue as any).dept_statuses || {};
  const currentIssueDept = (issue as any).current_department;
  const deptQueueSt = currentIssueDept ? rawDeptStatuses[currentIssueDept] : null;
  // Show dept_statuses[currentDept] if it's a qst_ status OR a virtual status (id='') with a name.
  // Virtual statuses appear when a ticket first arrives in a dept (e.g. "Waiting for Migration").
  const issueStat = (deptQueueSt && typeof deptQueueSt.id === 'string' && (deptQueueSt.id.startsWith('qst_') || (deptQueueSt.id === '' && deptQueueSt.name)))
    ? (deptQueueSt as any)
    : getIssueStatus(issue);
  const t = typeIcons[issue.type] || typeIcons.task;

  /** Real-time SLA breach value for "Time to First Response" / "Time to Resolution" custom fields */
  const getSLAFieldDisplayValue = (cf: any): { value: string; isBreached: boolean } | null => {
    const cfName = (cf.name || '').toLowerCase();
    const isSLARelated = cfName.includes('time to first response') || cfName.includes('time to resolution');
    if (!isSLARelated || !issue?.sla?.length) return null;
    const matchedSLA = (issue.sla as any[]).find((s: any) => {
      const sName = (s.policyName || '').toLowerCase();
      return cfName.includes('time to first response')
        ? sName.includes('time to first response')
        : sName.includes('time to resolution');
    });
    if (!matchedSLA) return null;
    const isBreached = matchedSLA.isBreached || new Date(matchedSLA.dueTime) < new Date();
    return { value: isBreached ? 'Yes' : 'No', isBreached };
  };
  const priorityMeta = getPriorityMeta(issue.priority ?? 'medium');

  const issueTypes = issue.spaceKey === 'TESTBOARD'
    ? [
        { value: 'test',           label: 'Test' },
        { value: 'task',           label: 'Task' },
        { value: 'subtask',        label: 'Sub-task' },
        { value: 'story',          label: 'Story' },
        { value: 'bug',            label: 'Bug' },
        { value: 'epic',           label: 'Epic' },
        { value: 'test_set',       label: 'Test Set' },
        { value: 'test_plan',      label: 'Test Plan' },
        { value: 'test_execution', label: 'Test Execution' },
        { value: 'precondition',   label: 'Precondition' },
      ]
    : [
        { value: 'epic',            label: 'Epic' },
        { value: 'story',           label: 'Story' },
        { value: 'task',            label: 'Task' },
        { value: 'bug',             label: 'Bug' },
        { value: 'subtask',         label: 'Sub-task' },
        { value: 'service_request', label: 'Service Request' },
      ];

  const getStatusStyle = (category: string) => {
    if (category === 'done') return 'bg-emerald-600 text-white';
    if (category === 'in_progress') return 'bg-indigo-600 text-white';
    return 'bg-gray-700 text-white';
  };

  const currentStatusCategory = spaceStatuses.find(s => s.id === issueStat.id)?.category || 'todo';

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] overflow-hidden bg-white">

      {/* ── Top bar: breadcrumb LEFT, action icons RIGHT ── */}
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-gray-200 bg-white flex-shrink-0">
        {/* Left: Back + type icon + issue key */}
        <div className="flex items-center gap-2 text-sm">
          <button onClick={handleBack} className="flex items-center gap-1.5 text-gray-500 hover:text-indigo-600 font-medium transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            Back
          </button>
          <span className="text-gray-300 mx-1">|</span>
          {/* Type icon inline */}
          <div className="relative">
            <button onClick={() => setShowTypeDropdown(!showTypeDropdown)}
              className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-gray-100 transition-colors">
              <IssueTypeIcon type={issue.type} size={16} />
              <span className="text-gray-700 font-semibold text-sm">{issue.cfKey ?? issue.key}</span>
              <ChevronDown size={11} className="text-gray-400" />
            </button>
            {showTypeDropdown && (
              <Dropdown onClose={() => setShowTypeDropdown(false)} width="w-44" align="left-0">
                {issueTypes.map(it => (
                  <button key={it.value} onClick={() => handleTypeChange(it.value)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-gray-50 transition-colors ${issue.type === it.value ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}>
                    <IssueTypeIcon type={it.value} size={16} />
                    {it.label}
                    {issue.type === it.value && <Check size={14} className="ml-auto text-indigo-600" />}
                  </button>
                ))}
              </Dropdown>
            )}
          </div>

          {/* ── Copy link button ── */}
          <div className="relative group">
            <button
              onClick={handleCopyLink}
              className={`p-1.5 rounded-md transition-all ${copiedLink ? 'text-green-600 bg-green-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
              title="Copy link"
            >
              {copiedLink ? <Check size={14} strokeWidth={2.5} /> : <Link2 size={14} />}
            </button>
            {/* Tooltip */}
            <div className={`absolute left-1/2 -translate-x-1/2 top-full mt-1.5 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap pointer-events-none transition-all z-50
              ${copiedLink ? 'bg-green-700 text-white opacity-100' : 'bg-gray-800 text-white opacity-0 group-hover:opacity-100'}`}>
              {copiedLink ? 'Link copied!' : 'Copy link'}
            </div>
          </div>
        </div>

        {/* Right: icon actions only */}
        <div className="flex items-center gap-0.5">
          {user?.role === 'admin' && <div className="relative">
            <button onClick={() => setShowMoreMenu(!showMoreMenu)}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-all">
              <MoreHorizontal size={15} />
            </button>
            {showMoreMenu && (
              <Dropdown onClose={() => setShowMoreMenu(false)} width="w-52" align="right-0">
                <button onClick={() => { setShowMoreMenu(false); setShowDeleteModal(true); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                  <Trash2 size={14} /> Delete issue
                </button>
              </Dropdown>
            )}
          </div>}
        </div>
      </div>

      {/* ── Main two-column area (both scroll independently) ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ===== LEFT: Main Content — scrollable ===== */}
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 bg-white">
          {/* Title */}
          {editing === 'summary' ? (
            <div className="flex items-start gap-2 mb-5">
              <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
                className="flex-1 text-[22px] font-bold border-2 border-indigo-400 rounded-lg px-4 py-2 focus:outline-none focus:ring-4 focus:ring-indigo-100 text-gray-900" autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleUpdate('summary', editValue); if (e.key === 'Escape') setEditing(null); }} />
              <button onClick={() => handleUpdate('summary', editValue)} className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg mt-1 transition-colors"><Check size={20} /></button>
              <button onClick={() => setEditing(null)} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg mt-1 transition-colors"><X size={20} /></button>
            </div>
          ) : (
            <h1 className="text-[22px] font-bold text-gray-900 cursor-pointer hover:bg-indigo-50/50 px-2 py-1.5 -mx-2 rounded-lg transition-all mb-5 leading-snug"
              onClick={() => { setEditing('summary'); setEditValue(issue.summary); }}>
              {issue.summary}
            </h1>
          )}

          {/* Jira-style action bar */}
          <div className="flex items-center gap-1.5 mb-6 flex-wrap">
            {/* Create subtask */}
            <button
              onClick={() => { setShowSubtaskModal(true); setSubtaskSummary(''); setTimeout(() => document.querySelector<HTMLInputElement>('input[placeholder="Name this sub-task"]')?.focus(), 50); }}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 hover:border-gray-400 transition-all">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Create subtask
            </button>

            {/* Attach */}
            <button onClick={() => fileInputRef.current?.click()} disabled={uploadingAttachCount > 0}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 hover:border-gray-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <Paperclip size={13} className="text-gray-500" />
              Attach
            </button>
            <button onClick={() => folderInputRef.current?.click()} disabled={uploadingAttachCount > 0}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 hover:border-gray-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <FolderUp size={13} className="text-gray-500" />
              Attach folder
            </button>
            {uploadingAttachCount > 0 && (
              <span className="text-[12px] text-gray-500 italic">Uploading {uploadingAttachCount} file{uploadingAttachCount > 1 ? 's' : ''}…</span>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
            {/* webkitdirectory isn't in React's DOM typings — spread it in untyped
                so the OS folder picker (not just multi-file select) actually opens. */}
            <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleUpload} {...({ webkitdirectory: '' } as any)} />
          </div>

          {/* Reporter Line */}
          {issue.reporter && (
            <div className="flex items-center gap-3 mb-6">
              <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                {getInitials(issue.reporter.firstName, issue.reporter.lastName)}
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900">{issue.reporter.firstName} {issue.reporter.lastName}</span>
                <span className="text-sm text-gray-400 ml-1.5">created this issue {formatJiraDateTime(issue.createdAt)}</span>
              </div>
            </div>
          )}

          {/* Description Section */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider">Description</h3>
            </div>
            {editing === 'description' ? (
              <div>
                <RichTextEditor
                  value={editValue}
                  onChange={setEditValue}
                  placeholder="Add a description... (paste or drag images, use toolbar to format)"
                  minHeight="180px"
                  members={allMembers}
                  onUploadingChange={setIsUploadingDescription}
                />
                <div className="flex gap-2 mt-2">
                  <button onClick={() => handleUpdate('description', editValue)} disabled={isUploadingDescription}
                    className="bg-blue-600 text-white text-[13px] font-medium px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    {isUploadingDescription ? 'Uploading…' : 'Save'}
                  </button>
                  <button onClick={() => setEditing(null)}
                    className="text-[13px] text-gray-600 px-4 py-1.5 rounded border border-gray-200 hover:bg-gray-50 transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              /* VIEW MODE — rendered HTML, text-cursor so user can select/copy text.
                 Links ALWAYS open in a new tab; double-click enters edit mode. */
              issue.description ? (() => {
                const isHtml = /<[a-z][\s\S]*>/i.test(issue.description);
                // Convert plain text to formatted HTML if it has === sections or is long plain text
                const renderHtml = isHtml ? linkifyHtml(issue.description) : (() => {
                  let t = issue.description;
                  // === Section Name === → bold header
                  t = t.replace(/={3,}\s*([^=]+?)\s*={3,}/g, '<h4 style="font-weight:700;margin:12px 0 4px;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:2px;">$1</h4>');
                  // Auto-link URLs
                  t = t.replace(/(https?:\/\/[^\s<>"')\]]+)/g, url => {
                    const clean = url.replace(/[.,;!?]+$/, '');
                    return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">${clean}</a>`;
                  });
                  // Line breaks to <br>
                  t = t.replace(/\n/g, '<br/>');
                  return t;
                })();
                return (
                /<[a-z][\s\S]*>/i.test(renderHtml) ? (
                <div
                  className="text-[13px] text-gray-700 px-3 py-2.5 rounded border border-transparent hover:border-gray-200 min-h-[40px] leading-relaxed cursor-pointer break-words
                    [&_h2]:font-bold [&_h2]:text-base [&_h2]:mt-2 [&_h2]:mb-1
                    [&_h3]:font-bold [&_h3]:text-sm  [&_h3]:mt-2 [&_h3]:mb-1
                    [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1
                    [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1
                    [&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-500 [&_blockquote]:italic
                    [&_pre]:bg-gray-100 [&_pre]:rounded [&_pre]:px-2 [&_pre]:py-1 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:overflow-x-auto
                    [&_code]:bg-slate-100 [&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs
                    [&_img]:max-w-full [&_img]:rounded [&_img]:my-1
                    [&_a]:text-blue-600 [&_a]:underline [&_a]:cursor-pointer [&_a]:hover:text-blue-800
                    [&_p]:mb-2 [&_p:last-child]:mb-0
                    [&_table]:border-collapse [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1
                    [&_hr]:border-gray-200 [&_hr]:my-2"
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    const anchor = target.closest('a') as HTMLAnchorElement | null;
                    if (anchor) {
                      e.preventDefault();
                      const href = anchor.getAttribute('href');
                      if (href && href !== '#') {
                        window.open(href, '_blank', 'noopener,noreferrer');
                      }
                      return;
                    }
                    if (target.tagName === 'IMG') {
                      const src = (target as HTMLImageElement).src;
                      if (src) setLightboxSrc(src);
                      return;
                    }
                    setEditing('description'); setEditValue(issue.description || '');
                  }}
                  dangerouslySetInnerHTML={{ __html: renderHtml }}
                />
                ) : (
                <div
                  className="text-[13px] text-gray-700 px-3 py-2.5 rounded border border-transparent hover:border-gray-200 min-h-[40px] leading-relaxed cursor-pointer break-words"
                  dangerouslySetInnerHTML={{ __html: renderHtml }}
                  onClick={() => { setEditing('description'); setEditValue(issue.description || ''); }}
                />
                )
                );
              })() : (
                <div
                  className="text-[13px] text-gray-400 cursor-pointer px-3 py-2.5 rounded border border-dashed border-gray-200 hover:border-blue-300 hover:bg-blue-50/30 min-h-[56px] flex items-center transition-colors"
                  onClick={() => { setEditing('description'); setEditValue(''); }}
                >
                  Click to add a description...
                </div>
              )
            )}
          </div>


          {/* ── Subtasks (Child Issues) ── */}
          <div className="mb-7">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-indigo-500" />
                <h3 className="text-[13px] font-bold text-gray-900 uppercase tracking-wide">Subtasks</h3>
                {issue.children && issue.children.length > 0 && (
                  <span className="text-xs text-gray-400 font-medium bg-gray-100 px-2 py-0.5 rounded-full">{issue.children.length}</span>
                )}
              </div>
              <button
                onClick={() => { setShowSubtaskModal(true); setSubtaskSummary(''); }}
                className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                title="Create subtask"
              >
                <Plus size={15} />
              </button>
            </div>

            {/* Subtask rows */}
            {issue.children && issue.children.length > 0 && (
              <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm mb-2">
                {issue.children.map((child, idx) => (
                  <Link key={child.id} href={`/issues/${child.cfKey ?? child.key}`}
                    className={`flex items-center gap-3 px-4 py-2.5 hover:bg-indigo-50/40 transition-colors ${idx > 0 ? 'border-t border-gray-100' : ''}`}>
                    <IssueTypeIcon type={child.type || 'subtask'} size={15} />
                    <PriorityIcon priority={child.priority || 'medium'} size={13} />
                    <span className="text-sm text-indigo-600 font-semibold shrink-0">{child.cfKey ?? child.key}</span>
                    <span className="text-sm text-gray-700 flex-1 truncate">{child.summary}</span>
                    {child.assignee && (
                      <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                        {getInitials(child.assignee.firstName, child.assignee.lastName)}
                      </div>
                    )}
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded shrink-0" style={{ backgroundColor: resolveStatusColor(child.status) + '25', color: resolveStatusColor(child.status) }}>{child.status.name}</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Inline create input */}
            {showSubtaskModal && (
              <div className="border border-blue-400 rounded-xl overflow-hidden shadow-sm ring-2 ring-blue-100">
                <div className="flex items-center gap-2 px-3 py-2.5 bg-white">
                  <IssueTypeIcon type={subtaskType} size={15} />
                  <input
                    autoFocus
                    value={subtaskSummary}
                    onChange={e => setSubtaskSummary(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && subtaskSummary.trim()) handleCreateSubtask();
                      if (e.key === 'Escape') { setShowSubtaskModal(false); setSubtaskSummary(''); }
                    }}
                    placeholder="Name this sub-task"
                    className="flex-1 text-[13px] text-gray-800 placeholder-gray-400 outline-none bg-transparent"
                  />
                  {/* Type selector */}
                  <div className="flex items-center gap-1 text-[12px] text-gray-500 border border-gray-200 rounded px-2 py-1 bg-gray-50 select-none">
                    <IssueTypeIcon type="subtask" size={12} />
                    <span>Sub-task</span>
                  </div>
                  {/* Enter icon */}
                  <button
                    onClick={handleCreateSubtask}
                    disabled={!subtaskSummary.trim() || subtaskSaving}
                    className="w-7 h-7 flex items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
                    title="Create (Enter)"
                  >
                    {subtaskSaving
                      ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
                    }
                  </button>
                </div>
                <div className="flex justify-end px-3 py-1.5 bg-gray-50 border-t border-gray-100">
                  <button
                    onClick={() => { setShowSubtaskModal(false); setSubtaskSummary(''); }}
                    className="text-[12px] text-gray-500 hover:text-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Linked Work Items — Jira style */}
          {(() => {
            const handleAddLink = async () => {
              if (!linkTarget.trim()) return;
              setLinkSaving(true);
              try {
                await api.addIssueLink(issue.key, { targetKey: linkTarget.trim().toUpperCase(), linkType });
                setLinkTarget(''); setShowLinkForm(false); loadIssue(issueKey);
              } catch (e: any) { alert(e.message); }
              finally { setLinkSaving(false); }
            };

            const grouped: Record<string, any[]> = {};
            (issue.links || []).forEach(link => {
              const t = link.type || 'related';
              if (!grouped[t]) grouped[t] = [];
              grouped[t].push(link);
            });

            const linkTypeLabels: Record<string, string> = {
              blocks: 'blocks', is_blocked_by: 'is blocked by',
              relates_to: 'relates to', duplicates: 'duplicates',
              is_duplicated_by: 'is duplicated by', related: 'relates to',
            };

            const hasLinks = (issue.links || []).length > 0;

            return (
              <div className="mb-7">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-gray-900">Linked work items</h3>
                    {hasLinks && <span className="text-xs text-gray-400 font-medium bg-gray-100 px-2 py-0.5 rounded-full">{issue.links!.length}</span>}
                  </div>
                  <button onClick={() => setShowLinkForm(v => !v)}
                    className={`p-1.5 rounded-lg transition-all ${showLinkForm ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600'}`}
                    title="Add link">
                    <Plus size={15} />
                  </button>
                </div>

                {/* Add Link Form */}
                {showLinkForm && (
                  <div className="mb-4 bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Add link</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] font-semibold text-gray-500 mb-1 block">Link type</label>
                        <select value={linkType} onChange={e => setLinkType(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400 bg-white">
                          <option value="blocks">blocks</option>
                          <option value="is_blocked_by">is blocked by</option>
                          <option value="relates_to">relates to</option>
                          <option value="duplicates">duplicates</option>
                          <option value="is_duplicated_by">is duplicated by</option>
                        </select>
                      </div>
                      <div className="relative">
                        <label className="text-[11px] font-semibold text-gray-500 mb-1 block">Search issues</label>
                        <input value={linkTarget} onChange={e => {
                          const q = e.target.value;
                          setLinkTarget(q);
                          setShowLinkDropdown(true);
                          if (linkSearchRef.current) clearTimeout(linkSearchRef.current);
                          if (!q.trim()) { setLinkSearchResults([]); setLinkSearching(false); return; }
                          setLinkSearching(true);
                          linkSearchRef.current = setTimeout(async () => {
                            try {
                              const res = await api.getIssues({ q: q.trim(), limit: '8' });
                              setLinkSearchResults((res.issues || []).filter((i: any) => i.key !== issueKey));
                            } catch { setLinkSearchResults([]); }
                            setLinkSearching(false);
                          }, 300);
                        }}
                          placeholder="Search by key or title…"
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                          onKeyDown={e => { if (e.key === 'Enter') { setShowLinkDropdown(false); handleAddLink(); } if (e.key === 'Escape') { setShowLinkDropdown(false); setShowLinkForm(false); } }}
                          onBlur={() => setTimeout(() => setShowLinkDropdown(false), 200)}
                          autoComplete="off"
                        />
                        {showLinkDropdown && (linkSearching || linkSearchResults.length > 0) && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 max-h-52 overflow-y-auto">
                            {linkSearching ? (
                              <div className="px-4 py-3 text-[12px] text-gray-400">Searching…</div>
                            ) : linkSearchResults.length === 0 ? (
                              <div className="px-4 py-3 text-[12px] text-gray-400">No issues found</div>
                            ) : linkSearchResults.map((r: any) => (
                              <button key={r.key} onMouseDown={() => { setLinkTarget(r.key); setLinkSearchResults([]); setShowLinkDropdown(false); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-blue-50 text-left transition-colors">
                                <span className="font-mono text-[11px] font-bold text-blue-600 flex-shrink-0">{r.key}</span>
                                <span className="text-[12.5px] text-gray-700 truncate">{r.summary}</span>
                                <span className="ml-auto text-[10px] text-white px-1.5 py-0.5 rounded flex-shrink-0"
                                  style={{ backgroundColor: r.status ? resolveStatusColor(r.status) : '#6B7280' }}>{r.status?.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleAddLink} disabled={!linkTarget.trim() || linkSaving}
                        className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-all">
                        {linkSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => { setShowLinkForm(false); setLinkTarget(''); }}
                        className="px-4 py-1.5 bg-white border border-gray-200 text-gray-600 text-sm font-semibold rounded-lg hover:bg-gray-50 transition-all">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Grouped link rows */}
                {hasLinks && (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    {Object.entries(grouped).map(([type, links], gi) => (
                      <div key={type} className={gi > 0 ? 'border-t border-gray-100' : ''}>
                        {/* Group label */}
                        <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
                          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                            {linkTypeLabels[type] || type.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {/* Issue rows */}
                        {links.map((link, idx) => {
                          const li = link.target?.key === issue.key ? link.source : link.target;
                          if (!li) return null;
                          const lt = typeIcons[li.type] || typeIcons.task;
                          const pm = getPriorityMeta(li.priority || 'medium');
                          return (
                            <div key={link.id}
                              className={`flex items-center gap-3 px-4 py-2.5 hover:bg-indigo-50/40 transition-colors group ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                              {/* Type icon */}
                              <span className="flex-shrink-0 text-base" style={{ color: lt.color }} title={li.type}>{lt.icon}</span>
                              {/* Issue key */}
                              <Link href={`/issues/${li.cfKey ?? li.key}`}
                                className="text-sm font-bold text-indigo-600 hover:text-indigo-800 hover:underline flex-shrink-0 transition-colors">
                                {li.cfKey ?? li.key}
                              </Link>
                              {/* Summary */}
                              <span className="text-sm text-gray-700 flex-1 truncate">{li.summary}</span>
                              {/* Status badge */}
                              {li.status && (
                                <span className="text-[10px] font-bold px-2.5 py-1 rounded text-white flex-shrink-0 shadow-sm"
                                  style={{ backgroundColor: resolveStatusColor(li.status) }}>
                                  {li.status.name?.toUpperCase()}
                                </span>
                              )}
                              {/* Priority icon */}
                              <span className="flex-shrink-0 opacity-60">
                                <PriorityIcon priority={li.priority || 'medium'} size={13} />
                              </span>
                              {/* Unlink button (appears on hover) */}
                              <button
                                onClick={async () => {
                                  try { await api.deleteIssueLink(link.id); loadIssue(issueKey); }
                                  catch (e: any) { alert(e.message); }
                                }}
                                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-400 transition-all flex-shrink-0"
                                title="Remove link">
                                <X size={12} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}

                {!hasLinks && !showLinkForm && (
                  <div className="text-sm text-gray-400 italic px-1">No linked issues yet.</div>
                )}
              </div>
            );
          })()}

          {/* Attachments Section */}
          {issue.attachments && issue.attachments.length > 0 && (
            <div className="mb-7">
              <div className="flex items-center gap-2 mb-3">
                <Paperclip size={14} className="text-indigo-500" />
                <h3 className="text-[13px] font-bold text-gray-900 uppercase tracking-wide">Attachments</h3>
                <span className="text-xs text-gray-400 font-medium bg-gray-100 px-2 py-0.5 rounded-full">{issue.attachments.length}</span>
              </div>
              <div className="flex flex-wrap gap-3">
                {issue.attachments.map((a: any) => {
                  const isImage = a.mimeType?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.originalName || '');
                  const handleOpen = (e: React.MouseEvent) => {
                    e.preventDefault();
                    const mime = a.mimeType || (a.originalName?.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
                    let url = a.url || '';
                    if (url.startsWith('data:')) {
                      try {
                        const b64 = url.split(',')[1];
                        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
                      } catch { /* keep original */ }
                    }
                    setPreviewAttach({ url, name: a.originalName || 'attachment', mime });
                  };
                  return isImage ? (
                    <button key={a.id} onClick={handleOpen}
                      className="block rounded-xl overflow-hidden border border-gray-200 hover:border-indigo-300 shadow-sm transition-all group text-left">
                      <img src={a.url} alt={a.originalName} className="w-32 h-24 object-cover group-hover:opacity-90 transition-opacity" onError={(e) => { (e.target as HTMLImageElement).style.display='none'; }} />
                      <div className="px-2 py-1 bg-white text-[10px] text-gray-500 truncate max-w-[128px]">{a.originalName}</div>
                    </button>
                  ) : (
                    <button key={a.id} onClick={handleOpen}
                      className="flex items-center gap-2.5 px-4 py-2.5 bg-white border border-gray-200 rounded-xl hover:bg-indigo-50 hover:border-indigo-200 transition-all text-sm shadow-sm group">
                      <Paperclip size={14} className="text-gray-400 group-hover:text-indigo-500 transition-colors flex-shrink-0" />
                      <span className="text-indigo-600 font-medium truncate max-w-[180px]">{a.originalName}</span>
                    </button>
                  );
                })}
              </div>

              {/* Inline preview modal */}
              {previewAttach && (
                <div className="fixed inset-0 z-[300] flex flex-col bg-black/80" onClick={() => setPreviewAttach(null)}>
                  <div className="flex items-center justify-between px-5 py-3 bg-gray-900 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-3">
                      <Paperclip size={15} className="text-gray-400" />
                      <span className="text-white text-sm font-medium truncate max-w-[400px]">{previewAttach.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <a href={previewAttach.url} download={previewAttach.name}
                        className="px-3 py-1.5 text-xs text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400 rounded-md transition-colors"
                        onClick={e => e.stopPropagation()}>
                        Download
                      </a>
                      <button onClick={() => setPreviewAttach(null)}
                        className="px-3 py-1.5 text-xs text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400 rounded-md transition-colors">
                        ✕ Close
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden" onClick={e => e.stopPropagation()}>
                    {previewAttach.mime.startsWith('image/') ? (
                      <div className="w-full h-full flex items-center justify-center p-6">
                        <img src={previewAttach.url} alt={previewAttach.name} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
                      </div>
                    ) : (
                      <iframe src={previewAttach.url} className="w-full h-full border-0" title={previewAttach.name} />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TESTBOARD: Test Details (Jira Xray-style layout) ── */}
          {issue.spaceKey === 'TESTBOARD' && (() => {
            const testTabs = ['Test details', 'Preconditions', 'Test Sets', 'Test Plans', 'Test Runs'];
            const activeTestTab = (issue as any).__testTab || 'Test details';
            // Use real Xray steps if available, otherwise fall back to description lines
            const realSteps: Array<{index:number; action:string; data:string; expectedResult:string; comments:string}> = (issue as any).testSteps || [];
            const descText: string = issue.description || '';
            const stepLines = descText.split('\n').filter((l: string) => l.trim());
            return (
              <div className="mt-6">
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  {/* Header */}
                  <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-gray-700">Test details</span>
                    <button className="text-gray-400 hover:text-gray-600 text-[18px] leading-none">···</button>
                  </div>
                  {/* Tabs */}
                  <div className="flex items-center border-b border-gray-200 bg-white px-2">
                    {testTabs.map(tab => (
                      <button key={tab}
                        className={`px-3 py-2.5 text-[12px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                          activeTestTab === tab
                            ? 'border-blue-600 text-blue-600'
                            : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}>
                        {tab}
                      </button>
                    ))}
                  </div>

                  {/* Test details tab content */}
                  <div className="p-4">
                    {/* Test Type row */}
                    <div className="flex items-center gap-3 mb-4">
                      <label className="text-[12px] text-gray-500 w-24 flex-shrink-0">Test Type</label>
                      <div className="flex items-center gap-1 border border-gray-300 rounded px-2 py-1 bg-white min-w-[120px]">
                        <span className="text-[12px] text-gray-700">Manual</span>
                        <svg className="ml-auto w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                      </div>
                    </div>

                    {/* Toolbar */}
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <div className="flex items-center gap-1">
                        <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="text-[12px] bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 flex items-center gap-1">
                          <span>+ Add Step</span>
                        </button>
                        <button className="text-[12px] border border-gray-300 text-gray-600 px-3 py-1 rounded hover:bg-gray-50">Import</button>
                        <button className="text-[12px] border border-gray-300 text-gray-600 px-3 py-1 rounded hover:bg-gray-50">Export</button>
                      </div>
                    </div>

                    {/* Steps table */}
                    <div className="border border-gray-200 rounded overflow-hidden">
                      {/* Table header */}
                      <div className="grid grid-cols-[32px_1fr_1fr_1fr] bg-gray-50 border-b border-gray-200">
                        <div className="px-2 py-2 text-[11px] font-semibold text-gray-500 border-r border-gray-200">#</div>
                        <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 border-r border-gray-200">Action</div>
                        <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 border-r border-gray-200">Data</div>
                        <div className="px-3 py-2 text-[11px] font-semibold text-gray-500">Expected Result</div>
                      </div>
                      {/* Real Xray steps */}
                      {realSteps.length > 0 ? realSteps.map((step) => (
                        <div key={step.index} className="border-b border-gray-100 last:border-0">
                          <div className="grid grid-cols-[32px_1fr_1fr_1fr] hover:bg-gray-50 group">
                            <div className="px-2 py-2.5 text-[12px] font-semibold text-gray-500 border-r border-gray-100 flex items-start justify-center">{step.index}</div>
                            <div className="px-3 py-2.5 text-[12px] text-gray-800 border-r border-gray-100">{step.action || <span className="text-gray-400 italic">—</span>}</div>
                            <div className="px-3 py-2.5 text-[12px] text-gray-700 border-r border-gray-100">{step.data || <span className="text-gray-400">N/A</span>}</div>
                            <div className="px-3 py-2.5 text-[12px] text-gray-700">{step.expectedResult || <span className="text-gray-400 italic">—</span>}</div>
                          </div>
                          {/* Expected result sub-row like Jira */}
                          {step.expectedResult && (
                            <div className="grid grid-cols-[32px_1fr] border-t border-gray-50 bg-gray-50/50">
                              <div className="border-r border-gray-100"></div>
                              <div className="px-3 py-1.5 text-[11px] text-gray-500">
                                <span className="font-medium text-gray-400 mr-2">Expected Result</span>
                                <span className="text-gray-600">{step.expectedResult}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )) : stepLines.length > 0 ? stepLines.map((line: string, idx: number) => (
                        <div key={idx} className="grid grid-cols-[32px_1fr_1fr_1fr] border-b border-gray-100 hover:bg-gray-50 group">
                          <div className="px-2 py-2.5 text-[12px] text-gray-400 border-r border-gray-100 flex items-start justify-center">{idx + 1}</div>
                          <div className="px-3 py-2.5 text-[12px] text-gray-700 border-r border-gray-100">{line}</div>
                          <div className="px-3 py-2.5 text-[12px] text-gray-400 border-r border-gray-100 italic">—</div>
                          <div className="px-3 py-2.5 text-[12px] text-gray-400 italic">—</div>
                        </div>
                      )) : (
                        <div className="grid grid-cols-[32px_1fr_1fr_1fr]">
                          <div className="px-2 py-3 text-[12px] text-gray-400 border-r border-gray-100 text-center">—</div>
                          <div className="px-3 py-3 text-[12px] text-gray-400 italic border-r border-gray-100">No steps added yet</div>
                          <div className="px-3 py-3 border-r border-gray-100"></div>
                          <div className="px-3 py-3"></div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── Root Cause & Fix Description — always shown ── */}
          {true && (
            <div className="mt-6 space-y-4">
              {/* Root Cause — always shown */}
              {true && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-gray-600 uppercase tracking-wide">Root Cause</span>
                  </div>
                  <div className="px-4 py-3">
                    {editingCustomField === 'l2b_rootCause' ? (
                      <div className="flex flex-col gap-2">
                        <textarea value={customFieldEditValue} onChange={e => { const words = e.target.value.trim().split(/\s+/).filter(Boolean); if (words.length <= 500 || e.target.value.length < customFieldEditValue.length) setCustomFieldEditValue(e.target.value); }} autoFocus rows={6}
                          className="w-full border border-blue-400 rounded px-3 py-2 text-[13px] focus:outline-none resize-y" placeholder="Describe the root cause…" />
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-gray-400">{customFieldEditValue.trim().split(/\s+/).filter(Boolean).length} / 500 words</span>
                          <div className="flex gap-2">
                            <button onClick={async () => { try { await api.updateIssue(issueKey, { rootCause: customFieldEditValue }); await loadIssue(issueKey); setEditingCustomField(null); } catch(e) { console.error('Save rootCause failed', e); alert('Failed to save. Please try again.'); } }}
                              className="text-[12px] bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">Save</button>
                            <button onClick={() => setEditingCustomField(null)}
                              className="text-[12px] text-gray-500 px-3 py-1 rounded hover:bg-gray-100">Cancel</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingCustomField('l2b_rootCause'); setCustomFieldEditValue((issue as any).rootCause || ''); }}
                        className="w-full text-left text-[13px] text-gray-700 hover:bg-gray-50 rounded px-1 py-0.5 transition-colors min-h-[32px]">
                        {(issue as any).rootCause
                          ? <span className="whitespace-pre-wrap break-words">{(issue as any).rootCause}</span>
                          : <span className="text-gray-400 italic">Click to add root cause…</span>}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Fix Description — always shown */}
              {true && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-gray-600 uppercase tracking-wide">Fix Description</span>
                  </div>
                  <div className="px-4 py-3">
                    {editingCustomField === 'l2b_fixDescription' ? (
                      <div className="flex flex-col gap-2">
                        <textarea value={customFieldEditValue} onChange={e => { const words = e.target.value.trim().split(/\s+/).filter(Boolean); if (words.length <= 500 || e.target.value.length < customFieldEditValue.length) setCustomFieldEditValue(e.target.value); }} autoFocus rows={6}
                          className="w-full border border-blue-400 rounded px-3 py-2 text-[13px] focus:outline-none resize-y" placeholder="Describe the fix…" />
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-gray-400">{customFieldEditValue.trim().split(/\s+/).filter(Boolean).length} / 500 words</span>
                          <div className="flex gap-2">
                            <button onClick={async () => { try { await api.updateIssue(issueKey, { fixDescription: customFieldEditValue }); await loadIssue(issueKey); setEditingCustomField(null); } catch(e) { console.error('Save fixDescription failed', e); alert('Failed to save. Please try again.'); } }}
                              className="text-[12px] bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">Save</button>
                            <button onClick={() => setEditingCustomField(null)}
                              className="text-[12px] text-gray-500 px-3 py-1 rounded hover:bg-gray-100">Cancel</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingCustomField('l2b_fixDescription'); setCustomFieldEditValue((issue as any).fixDescription || ''); }}
                        className="w-full text-left text-[13px] text-gray-700 hover:bg-gray-50 rounded px-1 py-0.5 transition-colors min-h-[32px]">
                        {(issue as any).fixDescription
                          ? <span className="whitespace-pre-wrap break-words">{(issue as any).fixDescription}</span>
                          : <span className="text-gray-400 italic">Click to add fix description…</span>}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tabs: Comments / Activity / History */}
          <div className="mt-6">
            <div className="flex items-center border-b border-gray-200">
              <button onClick={() => setActiveTab('comments')}
                className={`px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${activeTab === 'comments' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Comments ({(issue.comments || []).filter((c: any) => c.authorName !== 'System').length})
              </button>
<button onClick={() => setActiveTab('history')}
                className={`px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${activeTab === 'history' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                History ({(issue.activity?.length || 0) + (issue.comments || []).filter((c: any) => c.authorName === 'System').length})
              </button>
            </div>

            {activeTab === 'comments' && (
              <div className="pt-5 space-y-4">
                {/* Comment input */}
                <div className="flex gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-[11px] flex-shrink-0 mt-0.5 font-semibold">
                    {getInitials(user?.firstName, user?.lastName)}
                  </div>
                  <div className="flex-1 relative">
                    <RichTextEditor
                      value={commentText}
                      onChange={setCommentText}
                      placeholder="Add a comment… paste/drag images, attach files, type @ to mention"
                      minHeight="100px"
                      compact={true}
                      members={allMembers}
                      onUploadingChange={setIsUploadingComment}
                    />
                    <div className="flex items-center gap-3 mt-2">
                      <button onClick={handleAddComment} disabled={!commentText.trim() || submittingComment || isUploadingComment}
                        className="bg-blue-600 text-white text-[13px] font-medium px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                        {submittingComment && <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                        {submittingComment ? 'Saving…' : isUploadingComment ? 'Uploading…' : 'Save'}
                      </button>
                      <label className="flex items-center gap-1.5 text-[12px] text-gray-500 cursor-pointer select-none">
                        <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} className="rounded border-gray-300" />
                        Internal note
                      </label>
                    </div>
                  </div>
                </div>

                {/* Existing comments — newest first (exclude System auto-comments) */}
                {[...(issue.comments || [])].filter(c => c.authorName !== 'System' && c.author?.email !== 'system').reverse().map(comment => (
                  <div key={comment.id} className="flex gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-[11px] flex-shrink-0 font-semibold mt-0.5">
                      {getInitials(comment.author?.firstName ?? (comment.authorName ?? '').split(' ')[0], comment.author?.lastName ?? (comment.authorName ?? '').split(' ').slice(1).join(' '))}
                    </div>
                    <div className={`flex-1 ${comment.isInternal ? 'bg-yellow-50 border border-yellow-200 rounded p-3' : ''}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[13px] font-semibold text-gray-900">{comment.author?.firstName ? `${comment.author.firstName} ${comment.author.lastName ?? ''}`.trim() : (comment.authorName || 'Unknown')}</span>
                        <span className="text-[11px] text-gray-400">{timeAgo(comment.createdAt)}</span>
                        {comment.isInternal && <span className="text-[10px] font-semibold bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">Internal</span>}
                        {comment.updatedAt && comment.updatedAt !== comment.createdAt && (
                          <span className="text-[10px] text-gray-400 italic">edited</span>
                        )}
                      </div>

                      {/* Edit mode */}
                      {editingCommentId === comment.id ? (
                        <div className="mt-1">
                          <RichTextEditor
                            value={editingCommentText}
                            onChange={setEditingCommentText}
                            minHeight="80px"
                            compact={true}
                            members={allMembers}
                            onUploadingChange={setIsUploadingEditComment}
                          />
                          <div className="flex gap-2 mt-1.5">
                            <button
                              onClick={async () => {
                                if (!editingCommentText.trim() || isUploadingEditComment) return;
                                await api.updateComment(comment.id, { body: editingCommentText });
                                setEditingCommentId(null);
                                loadIssue(issueKey);
                              }}
                              disabled={isUploadingEditComment}
                              className="text-[12px] bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                            >{isUploadingEditComment ? 'Uploading…' : 'Save'}</button>
                            <button
                              onClick={() => setEditingCommentId(null)}
                              className="text-[12px] text-gray-500 px-3 py-1 rounded hover:bg-gray-100"
                            >Cancel</button>
                          </div>
                        </div>
                      ) : deletingCommentId === comment.id ? (
                        /* Delete confirmation */
                        <div className="mt-1 bg-red-50 border border-red-200 rounded-md p-3">
                          <p className="text-[12px] text-red-700 mb-2">Are you sure you want to delete this comment? This cannot be undone.</p>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                await api.deleteComment(comment.id);
                                setDeletingCommentId(null);
                                loadIssue(issueKey);
                              }}
                              className="text-[12px] bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 font-medium"
                            >Delete</button>
                            <button
                              onClick={() => setDeletingCommentId(null)}
                              className="text-[12px] text-gray-500 px-3 py-1 rounded hover:bg-gray-100"
                            >Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {renderCommentBody(comment.body)}
                          {/* Edit · Delete actions — show on hover */}
                          <div className="flex gap-3 mt-1">
                            <button
                              onClick={() => { setEditingCommentId(comment.id); setEditingCommentText(comment.body); }}
                              className="text-[11px] text-gray-400 hover:text-blue-600 flex items-center gap-0.5 transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                              Edit
                            </button>
                            <span className="text-gray-300 text-[11px]">·</span>
                            <button
                              onClick={() => setDeletingCommentId(comment.id)}
                              className="text-[11px] text-gray-400 hover:text-red-600 flex items-center gap-0.5 transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {(!issue.comments || issue.comments.length === 0) && (
                  <p className="text-[13px] text-gray-400 py-6 text-center">No comments yet</p>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <div className="pt-4">
                {/* System auto-comments (department changes, round robin) */}
                {(issue.comments || []).filter((c: any) => c.authorName === 'System').length > 0 && (
                  <div className="space-y-0 mb-2">
                    {[...(issue.comments || [])].filter((c: any) => c.authorName === 'System').map((c: any) => (
                      <div key={c.id} className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0 px-1">
                        <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-[10px] text-gray-500 flex-shrink-0 font-bold mt-0.5">S</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 mb-1">
                            <span className="font-semibold text-gray-700 text-[13px]">System</span>
                            <span className="text-gray-400 text-[11px]">{timeAgo(c.createdAt)}</span>
                          </div>
                          <div className="text-[12.5px] text-gray-600 break-words [&_img]:cursor-pointer" dangerouslySetInnerHTML={{ __html: c.body }}
                            onClick={(e) => { const t = e.target as HTMLElement; if (t.tagName === 'IMG') { const src = (t as HTMLImageElement).src; if (src) setLightboxSrc(src); } }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {issue.activity && issue.activity.length > 0 ? (
                  <div className="space-y-0">
                    {issue.activity.map(a => (
                        <div key={a.id} className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 px-1 rounded transition-colors">
                          {/* User avatar */}
                          <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-[10px] text-blue-700 flex-shrink-0 font-bold mt-0.5">
                            {a.user ? (() => { const parts = (a.user.firstName||'').split(' '); return ((parts[0]?.[0]||'') + (parts[1]?.[0]||parts[0]?.[1]||'')).toUpperCase() || 'U'; })() : 'S'}
                          </div>
                          <div className="flex-1 min-w-0">
                            {/* Who did what */}
                            <div className="flex items-center flex-wrap gap-1 text-[13px] mb-1">
                              <span className="font-semibold text-gray-800">{a.user?.firstName || 'System'}</span>
                              {a.field === 'comment' ? (
                                <span className="text-gray-500">added a comment</span>
                              ) : a.field === 'created' ? (
                                <span className="text-gray-500">created this issue</span>
                              ) : a.field === 'sla' ? (
                                <span className="text-gray-500">SLA update</span>
                              ) : (
                                <>
                                  <span className="text-gray-500">changed</span>
                                  <span className="font-semibold text-gray-700 capitalize">{a.field?.replace(/_/g, ' ')}</span>
                                </>
                              )}
                              <span className="text-gray-400 text-[11px] ml-1">{timeAgo(a.createdAt)}</span>
                            </div>
                            {/* Old → New value (skip for comments, created, and SLA events) */}
                            {a.field !== 'comment' && a.field !== 'created' && a.field !== 'sla' && (
                              <div className="flex items-center gap-2 text-[12px]">
                                {a.oldValue ? (
                                  <span className="bg-red-50 text-red-600 px-2 py-0.5 rounded line-through max-w-[200px] truncate" title={a.oldValue}>{a.oldValue}</span>
                                ) : (
                                  <span className="text-gray-300 italic text-[11px]">None</span>
                                )}
                                <span className="text-gray-400">→</span>
                                {a.newValue ? (
                                  <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded font-medium max-w-[200px] truncate" title={a.newValue}>{a.newValue}</span>
                                ) : (
                                  <span className="text-gray-300 italic text-[11px]">None</span>
                                )}
                              </div>
                            )}
                            {/* Comment preview */}
                            {a.field === 'comment' && a.newValue && (() => {
                              const plain = stripHtmlToText(a.newValue).trim();
                              return (
                                <div className="text-[12px] text-gray-500 italic truncate max-w-sm">"{plain.slice(0, 120)}{plain.length > 120 ? '…' : ''}"</div>
                              );
                            })()}
                            {/* SLA lifecycle event (started/resumed/paused/resolved/breached) */}
                            {a.field === 'sla' && a.newValue && (
                              <div className={`inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-full ${
                                a.newValue.startsWith('SLA breached') ? 'bg-red-50 text-red-600'
                                : a.newValue.startsWith('SLA resolved') ? 'bg-emerald-50 text-emerald-600'
                                : a.newValue.startsWith('SLA paused') ? 'bg-amber-50 text-amber-600'
                                : 'bg-blue-50 text-blue-600'
                              }`}>
                                <Clock size={11} />
                                {a.newValue}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="py-12 text-center">
                    <div className="text-gray-300 text-4xl mb-3">📋</div>
                    <p className="text-sm text-gray-400">No changes recorded yet</p>
                    <p className="text-xs text-gray-300 mt-1">Changes to this issue will appear here</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ===== DRAG HANDLE ===== */}
        <div
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-400 bg-gray-200 transition-colors relative group"
          onMouseDown={e => {
            isDragging.current = true;
            dragStartX.current = e.clientX;
            dragStartWidth.current = sidebarWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            const onMove = (ev: MouseEvent) => {
              if (!isDragging.current) return;
              const delta = dragStartX.current - ev.clientX;
              const newWidth = Math.min(500, Math.max(200, dragStartWidth.current + delta));
              setSidebarWidth(newWidth);
            };
            const onUp = () => {
              isDragging.current = false;
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* ===== RIGHT SIDEBAR ===== */}
        <div style={{ width: sidebarWidth }} className="flex-shrink-0 border-l border-gray-200 overflow-y-auto bg-white">

          {/* Status selector — Jira style */}
          <div className="px-4 pt-4 pb-3">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Status</p>
            <div className="relative">
              {/* Current status badge button — matches Jira's colored pill */}
              <button
                onClick={() => canEdit && setShowStatusDropdown(v => !v)}
                disabled={!canEdit}
                title={canEdit ? undefined : 'This ticket has moved to another queue — only that queue can change its status'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-bold uppercase tracking-wide transition-all select-none ${canEdit ? 'hover:brightness-95' : 'cursor-not-allowed opacity-70'}`}
                style={{
                  backgroundColor: issueStat.color + '25',
                  color: issueStat.color,
                  border: `1.5px solid ${issueStat.color}60`,
                }}
              >
                {issueStat.name}
                {canEdit && <ChevronDown size={11} strokeWidth={2.5} />}
              </button>

              {showStatusDropdown && (() => {
                // Build list of valid transition targets from the current status
                const validTransitions = workflowTransitions.filter(
                  (t: any) => t.fromStatusId === issueStat.id
                );
                const validToIds = validTransitions.map((t: any) => t.toStatusId);

                // If the workflow has transitions from this status, show only those targets.
                // Otherwise fall back to showing all other statuses (unconstrained workflow).
                const options: { status: any; transitionName: string }[] =
                  validToIds.length > 0
                    ? (validToIds
                        .map((toId: string) => {
                          const status = spaceStatuses.find((s: any) => s.id === toId);
                          const tr = validTransitions.find((t: any) => t.toStatusId === toId);
                          return status ? { status, transitionName: tr?.name || '' } : null;
                        })
                        .filter(Boolean) as { status: any; transitionName: string }[])
                        .filter(o => o.status.id !== issueStat.id)
                    : spaceStatuses
                        .filter((s: any) => s.id !== issueStat.id)
                        .map((s: any) => ({ status: s, transitionName: '' }));

                return (
                  <Dropdown onClose={() => setShowStatusDropdown(false)} width="w-60" align="left-0">
                    {/* Header */}
                    <div className="px-3 py-2 border-b border-gray-100">
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                        Move to status
                      </p>
                    </div>

                    {options.length === 0 ? (
                      <p className="px-3 py-3 text-[12px] text-gray-400 italic">
                        No transitions defined. {isSpaceAdmin && <Link href={resolveQueueWorkflowHref(issue.spaceKey, (issue as any).current_department)} className="text-blue-500 underline">Set up workflow</Link>}
                      </p>
                    ) : (
                      <div className="py-1">
                        {options.map(({ status: s, transitionName }) => (
                          <button
                            key={s.id}
                            onClick={() => handleStatusChange(s.id)}
                            className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors group"
                          >
                            <div className="flex-1 text-left">
                              {/* Status name */}
                              <p className="text-[13px] font-semibold text-gray-800 leading-tight">
                                {s.name}
                              </p>
                              {/* Transition name (sub-label) if different from status name */}
                              {transitionName && transitionName.toLowerCase() !== s.name.toLowerCase() && (
                                <p className="text-[10px] text-gray-400 leading-tight mt-0.5">
                                  via {transitionName}
                                </p>
                              )}
                            </div>
                            {/* Category chip */}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* View workflow link — admin/owner only */}
                    {isSpaceAdmin && (
                      <div className="border-t border-gray-100">
                        <Link
                          href={resolveQueueWorkflowHref(issue.spaceKey, (issue as any).current_department)}
                          onClick={() => setShowStatusDropdown(false)}
                          className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-gray-400 hover:text-blue-600 hover:bg-gray-50 transition-colors"
                        >
                          <Settings size={11} /> View workflow
                        </Link>
                      </div>
                    )}
                  </Dropdown>
                );
              })()}
            </div>
          </div>

          <div className="h-px bg-gray-200 mx-4" />

          {/* Properties */}
          <div className={`px-4 py-3 space-y-0 ${!canEdit ? 'pointer-events-none opacity-70' : ''}`}>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Properties</p>
            {!canEdit && (
              <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-2 -mt-1">
                This ticket has moved to another queue — you can view and comment, but only that queue can edit it.
              </p>
            )}

            {/* Pinned divider */}
            {pinnedFields.length > 0 && (
              <p className="text-[9.5px] font-semibold text-blue-400 uppercase tracking-widest mb-1 flex items-center gap-1"><Pin size={8} /> Pinned</p>
            )}

            {/* Pinned fields — rendered first */}
            {pinnedFields.includes('assignee') && (
              <PropRow label="Assignee" pinned onPin={() => togglePin('assignee')}>
                <div className="relative">
                  <button onClick={() => setShowAssigneeDropdown(!showAssigneeDropdown)}
                    className="flex items-center gap-2 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full">
                    {issue.assignee ? (
                      <>
                        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                          {getInitials(issue.assignee.firstName, issue.assignee.lastName)}
                        </div>
                        <span className="text-[13px] text-gray-800 font-medium truncate">{issue.assignee.firstName} {issue.assignee.lastName}</span>
                      </>
                    ) : (
                      <>
                        <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <User size={11} className="text-gray-400" />
                        </div>
                        <span className="text-[13px] text-gray-400">Unassigned</span>
                      </>
                    )}
                    <ChevronDown size={10} className="text-gray-300 ml-auto flex-shrink-0" />
                  </button>
                  {showAssigneeDropdown && (
                    <Dropdown onClose={() => { setShowAssigneeDropdown(false); setAssigneeSearch(''); }} width="w-72" align="left-0">
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Assign to</div>
                      <div className="px-2 py-2 border-b border-gray-100">
                        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
                          <Search size={12} className="text-gray-400 flex-shrink-0" />
                          <input autoFocus value={assigneeSearch} onChange={(e) => setAssigneeSearch(e.target.value)}
                            placeholder="Search assignee…"
                            className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400" />
                          {assigneeSearch && <button onClick={() => setAssigneeSearch('')}><X size={11} className="text-gray-400" /></button>}
                        </div>
                      </div>
                      <div className="max-h-52 overflow-y-auto py-1">
                        {!assigneeSearch && (
                          <>
                            <button onClick={() => { handleAssigneeChange(null); setAssigneeSearch(''); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 text-gray-500">
                              <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center"><User size={10} className="text-gray-400" /></div>
                              Unassigned {!issue.assignee && <Check size={11} className="ml-auto text-blue-600" />}
                            </button>
                            {user && (
                              <button onClick={() => { handleAssigneeChange(user.id); setAssigneeSearch(''); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-blue-50 ${issue.assignee?.id === user.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                                <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[8px] font-bold flex-shrink-0">{getInitials((user as any).firstName, (user as any).lastName)}</div>
                                <span className="flex-1 text-left truncate">
                                  {(user as any).firstName} {(user as any).lastName}
                                  <span className="ml-1 text-[11px] text-blue-500 font-normal">(Assign to me)</span>
                                </span>
                                {issue.assignee?.id === user.id && <Check size={11} className="ml-auto text-blue-600 flex-shrink-0" />}
                              </button>
                            )}
                          </>
                        )}
                        {spaceMembers
                          .filter(m => {
                            const mb = (m as any).user || m;
                            const name = `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase();
                            return name.includes(assigneeSearch.toLowerCase());
                          })
                          .map(m => {
                            const mb = (m as any).user || m;
                            const isSel = issue.assignee?.id === mb.id;
                            return (
                              <button key={mb.id} onClick={() => { handleAssigneeChange(mb.id); setAssigneeSearch(''); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${isSel ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                                <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[8px] font-bold">{getInitials(mb.firstName, mb.lastName)}</div>
                                <span className="flex-1 text-left truncate">{mb.firstName} {mb.lastName}</span>
                                {isSel && <Check size={11} className="ml-auto text-blue-600" />}
                              </button>
                            );
                          })}
                        {assigneeSearch && spaceMembers.filter(m => { const mb = (m as any).user || m; return `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase().includes(assigneeSearch.toLowerCase()); }).length === 0 && (
                          <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No members found</p>
                        )}
                      </div>
                    </Dropdown>
                  )}
                </div>
              </PropRow>
            )}
            {pinnedFields.includes('reporter') && (
              <PropRow label="Reporter" pinned onPin={() => togglePin('reporter')}>
                <div className="relative">
                  <button onClick={() => setShowReporterDropdown(!showReporterDropdown)}
                    className="flex items-center gap-2 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full">
                    {issue.reporter ? (
                      <>
                        <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                          {getInitials(issue.reporter.firstName, issue.reporter.lastName)}
                        </div>
                        <span className="text-[13px] text-gray-800 font-medium truncate">{issue.reporter.firstName} {issue.reporter.lastName}</span>
                      </>
                    ) : (
                      <>
                        <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <User size={11} className="text-gray-400" />
                        </div>
                        <span className="text-[13px] text-gray-400">None</span>
                      </>
                    )}
                    <ChevronDown size={10} className="text-gray-300 ml-auto flex-shrink-0" />
                  </button>
                  {showReporterDropdown && (
                    <Dropdown onClose={() => { setShowReporterDropdown(false); setReporterSearch(''); }} width="w-72" align="left-0">
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Reported by</div>
                      <div className="px-2 py-2 border-b border-gray-100">
                        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
                          <Search size={12} className="text-gray-400 flex-shrink-0" />
                          <input autoFocus value={reporterSearch} onChange={(e) => setReporterSearch(e.target.value)}
                            placeholder="Search reporter…"
                            className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400" />
                          {reporterSearch && <button onClick={() => setReporterSearch('')}><X size={11} className="text-gray-400" /></button>}
                        </div>
                      </div>
                      <div className="max-h-52 overflow-y-auto py-1">
                        {!reporterSearch && (
                          <button onClick={() => { handleReporterChange(null); setReporterSearch(''); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 text-gray-500">
                            <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center"><User size={10} className="text-gray-400" /></div>
                            None {!issue.reporter && <Check size={11} className="ml-auto text-blue-600" />}
                          </button>
                        )}
                        {spaceMembers
                          .filter(m => {
                            const mb = (m as any).user || m;
                            const name = `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase();
                            return name.includes(reporterSearch.toLowerCase());
                          })
                          .map(m => {
                            const mb = (m as any).user || m;
                            const isSel = issue.reporter?.id === mb.id;
                            return (
                              <button key={mb.id} onClick={() => { handleReporterChange(mb.id); setReporterSearch(''); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${isSel ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                                <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[8px] font-bold">{getInitials(mb.firstName, mb.lastName)}</div>
                                <span className="flex-1 text-left truncate">{mb.firstName} {mb.lastName}</span>
                                {isSel && <Check size={11} className="ml-auto text-blue-600" />}
                              </button>
                            );
                          })}
                        {reporterSearch && spaceMembers.filter(m => { const mb = (m as any).user || m; return `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase().includes(reporterSearch.toLowerCase()); }).length === 0 && (
                          <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No members found</p>
                        )}
                      </div>
                    </Dropdown>
                  )}
                </div>
              </PropRow>
            )}
            {pinnedFields.includes('priority') && (
              <PropRow label="Priority" pinned onPin={() => togglePin('priority')}>
                <div className="px-1.5 py-1">
                  <PriorityDropdown value={issue.priority} onChange={handlePriorityChange} />
                </div>
              </PropRow>
            )}
            {pinnedFields.includes('dueDate') && (
              <PropRow label="Due Date" pinned onPin={() => togglePin('dueDate')}>
                {editing === 'dueDate' ? (
                  <div className="flex items-center gap-1.5 px-1.5 py-1" onClick={e => e.stopPropagation()}>
                    <input type="date" value={editValue} onChange={e => setEditValue(e.target.value)}
                      className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none" autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') handleUpdate('dueDate', editValue || null); if (e.key === 'Escape') setEditing(null); }} />
                    <button onClick={() => handleUpdate('dueDate', editValue || null)} className="text-blue-600"><Check size={13} /></button>
                    <button onClick={() => setEditing(null)} className="text-gray-400"><X size={13} /></button>
                  </div>
                ) : (
                  <button onClick={() => { setEditing('dueDate'); setEditValue(issue.dueDate ? issue.dueDate.split('T')[0] : ''); }}
                    className="text-[13px] text-gray-700 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left">
                    {issue.dueDate ? formatDate(issue.dueDate) : <span className="text-gray-400">None</span>}
                  </button>
                )}
              </PropRow>
            )}
            {customFields.filter(cf => pinnedFields.includes(`cf_${cf.id}`) && cf.fieldType !== 'department-routing' && cf.type !== 'department-routing').map(cf => {
              const KNOWN_CF_OPTIONS: Record<string, string[]> = {
                'Product Type':    ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'],
                'Work Type':       ['New','Ongoing','Renewal','Upsell','Downgrade','Others'],
                'Project Manager': ['Abhishek','Abhishikth','Ajay Singh','Chandra Mouli','Harika','Lakshmi Prasanna','Raghu','Sri Ram','Sravan','Pranavi'],
                'Combination':     ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Box - Microsoft','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','MyDrive to MyDrive','Shared Drive- Shared Drive','Shared Drive- SharePoint','Shared Drive - Onedrive','Shared Drive - Egnyte','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','OneDrive - Amazon S3','Box - Amazon S3','SharePoint - Azure','Shared Drive - Azure','Amazon S3 - SharePoint','SharePoint - Shared Drive','SharePoint - Mydrive','SharePoint - SharePoint','Onedrive - Onedrive','Onedrive - MyDrive','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Teams to Slack','Chat To Slack','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Drive Change','Other'],
              };
              const effectiveType = cf.fieldType || cf.type || '';
              const fieldOptions: string[] = (cf.options?.length ? cf.options : KNOWN_CF_OPTIONS[cf.name]) || [];
              const isSelectType = (ft: string) => ft === 'select-single' || ft === 'radio' || ft === 'Select List (single choice)' || ft === 'Select List (multiple choices)' || ft === 'select-multi' || ft === 'Checkboxes' || ft === 'Radio Buttons';
              const isUserType = (ft: string) => ft === 'User' || ft === 'user';
              const isSelect = isSelectType(effectiveType);
              return (
              <PropRow key={`pinned_cf_${cf.id}`} label={cf.name} pinned onPin={() => togglePin(`cf_${cf.id}`)}>
                {editingCustomField === cf.id ? (
                  <div className="flex items-center gap-1.5 px-1.5 py-1" onClick={e => e.stopPropagation()}>
                    {effectiveType === 'date' ? (
                      <input type="date" value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)}
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none" autoFocus />
                    ) : isUserType(effectiveType) && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((name: string) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    ) : effectiveType === 'department-routing' && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((opt: string) => {
                          const deptName = String(opt).split('|')[0].trim();
                          return <option key={opt} value={deptName}>{deptName}</option>;
                        })}
                      </select>
                    ) : isSelect && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input type={cf.fieldType === 'number' ? 'number' : 'text'} value={customFieldEditValue}
                        onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none w-28"
                        onKeyDown={e => { if (e.key === 'Escape') setEditingCustomField(null); }} />
                    )}
                    <button onClick={() => {
                      const savePromises: Promise<any>[] = [
                        api.setCustomFieldValue(issue.id, cf.id, customFieldEditValue).catch(() => {}),
                      ];
                      if (nativeKey) {
                        savePromises.push(api.updateIssue(issueKey, { [nativeKey]: customFieldEditValue }).catch(() => {}));
                      }
                      Promise.all(savePromises).then(() => {
                        setCustomFieldValues(prev => ({ ...prev, [cf.id]: customFieldEditValue }));
                        setEditingCustomField(null);
                        loadIssue(issueKey);
                      });
                    }} className="text-blue-600"><Check size={13} /></button>
                    <button onClick={() => setEditingCustomField(null)} className="text-gray-400"><X size={13} /></button>
                  </div>
                ) : (
                  (() => {
                    const slaVal = getSLAFieldDisplayValue(cf);
                    const displayVal = slaVal ? slaVal.value : (currentVal || null);
                    return (
                      <button onClick={() => { setEditingCustomField(cf.id); setCustomFieldEditValue(currentVal); }}
                        className="text-[13px] hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left">
                        {displayVal ? (
                          <span className={
                            slaVal
                              ? (slaVal.isBreached ? 'font-semibold text-red-600' : 'font-medium text-green-600')
                              : 'text-gray-700'
                          }>{displayVal}</span>
                        ) : <span className="text-gray-400">None</span>}
                      </button>
                    );
                  })()
                )}
              </PropRow>
              );
            })}

            {/* Divider between pinned and rest */}
            {pinnedFields.length > 0 && (
              <div className="h-px bg-blue-100 my-1" />
            )}

            {/* Assignee */}
            {!pinnedFields.includes('assignee') && <PropRow label="Assignee" onPin={() => togglePin('assignee')}>
              <div className="relative">
                <button onClick={() => setShowAssigneeDropdown(!showAssigneeDropdown)}
                  className="flex items-center gap-2 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full">
                  {issue.assignee ? (
                    <>
                      <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                        {getInitials(issue.assignee.firstName, issue.assignee.lastName)}
                      </div>
                      <span className="text-[13px] text-gray-800 font-medium truncate">{issue.assignee.firstName} {issue.assignee.lastName}</span>
                    </>
                  ) : (
                    <>
                      <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                        <User size={11} className="text-gray-400" />
                      </div>
                      <span className="text-[13px] text-gray-400">Unassigned</span>
                    </>
                  )}
                  <ChevronDown size={10} className="text-gray-300 ml-auto flex-shrink-0" />
                </button>
                {showAssigneeDropdown && (
                  <Dropdown onClose={() => { setShowAssigneeDropdown(false); setAssigneeSearch(''); }} width="w-72" align="left-0">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Assign to</div>
                    <div className="px-2 py-2 border-b border-gray-100">
                      <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
                        <Search size={12} className="text-gray-400 flex-shrink-0" />
                        <input autoFocus value={assigneeSearch} onChange={(e) => setAssigneeSearch(e.target.value)}
                          placeholder="Search assignee…"
                          className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400" />
                        {assigneeSearch && <button onClick={() => setAssigneeSearch('')}><X size={11} className="text-gray-400" /></button>}
                      </div>
                    </div>
                    <div className="max-h-52 overflow-y-auto py-1">
                      {!assigneeSearch && (
                        <>
                          <button onClick={() => { handleAssigneeChange(null); setAssigneeSearch(''); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 text-gray-500">
                            <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center"><User size={10} className="text-gray-400" /></div>
                            Unassigned {!issue.assignee && <Check size={11} className="ml-auto text-blue-600" />}
                          </button>
                          {user && (
                            <button onClick={() => { handleAssigneeChange(user.id); setAssigneeSearch(''); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-blue-50 ${issue.assignee?.id === user.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                              <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[8px] font-bold flex-shrink-0">{getInitials(user.firstName, user.lastName)}</div>
                              <span className="flex-1 text-left truncate">
                                {user.firstName} {user.lastName}
                                <span className="ml-1 text-[11px] text-blue-500 font-normal">(Assign to me)</span>
                              </span>
                              {issue.assignee?.id === user.id && <Check size={11} className="ml-auto text-blue-600 flex-shrink-0" />}
                            </button>
                          )}
                        </>
                      )}
                      {spaceMembers
                        .filter(m => {
                          const mb = (m as any).user || m;
                          const name = `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase();
                          return name.includes(assigneeSearch.toLowerCase());
                        })
                        .map(m => {
                          const mb = (m as any).user || m;
                          const isSel = issue.assignee?.id === mb.id;
                          return (
                            <button key={mb.id} onClick={() => { handleAssigneeChange(mb.id); setAssigneeSearch(''); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${isSel ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                              <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[8px] font-bold">{getInitials(mb.firstName, mb.lastName)}</div>
                              <span className="flex-1 text-left truncate">{mb.firstName} {mb.lastName}</span>
                              {isSel && <Check size={11} className="ml-auto text-blue-600" />}
                            </button>
                          );
                        })}
                      {assigneeSearch && spaceMembers.filter(m => { const mb = (m as any).user || m; return `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase().includes(assigneeSearch.toLowerCase()); }).length === 0 && (
                        <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No members found</p>
                      )}
                    </div>
                  </Dropdown>
                )}
              </div>
            </PropRow>}

            {/* Reporter */}
            {!pinnedFields.includes('reporter') && <PropRow label="Reporter" onPin={() => togglePin('reporter')}>
              <div className="relative">
                <button onClick={() => setShowReporterDropdown(!showReporterDropdown)}
                  className="flex items-center gap-2 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full">
                  {issue.reporter ? (
                    <>
                      <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                        {getInitials(issue.reporter.firstName, issue.reporter.lastName)}
                      </div>
                      <span className="text-[13px] text-gray-800 font-medium truncate">{issue.reporter.firstName} {issue.reporter.lastName}</span>
                    </>
                  ) : (
                    <>
                      <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                        <User size={11} className="text-gray-400" />
                      </div>
                      <span className="text-[13px] text-gray-400">None</span>
                    </>
                  )}
                  <ChevronDown size={10} className="text-gray-300 ml-auto flex-shrink-0" />
                </button>
                {showReporterDropdown && (
                  <Dropdown onClose={() => { setShowReporterDropdown(false); setReporterSearch(''); }} width="w-72" align="left-0">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Reported by</div>
                    <div className="px-2 py-2 border-b border-gray-100">
                      <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
                        <Search size={12} className="text-gray-400 flex-shrink-0" />
                        <input autoFocus value={reporterSearch} onChange={(e) => setReporterSearch(e.target.value)}
                          placeholder="Search reporter…"
                          className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400" />
                        {reporterSearch && <button onClick={() => setReporterSearch('')}><X size={11} className="text-gray-400" /></button>}
                      </div>
                    </div>
                    <div className="max-h-52 overflow-y-auto py-1">
                      {!reporterSearch && (
                        <button onClick={() => { handleReporterChange(null); setReporterSearch(''); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 text-gray-500">
                          <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center"><User size={10} className="text-gray-400" /></div>
                          None {!issue.reporter && <Check size={11} className="ml-auto text-blue-600" />}
                        </button>
                      )}
                      {spaceMembers
                        .filter(m => {
                          const mb = (m as any).user || m;
                          const name = `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase();
                          return name.includes(reporterSearch.toLowerCase());
                        })
                        .map(m => {
                          const mb = (m as any).user || m;
                          const isSel = issue.reporter?.id === mb.id;
                          return (
                            <button key={mb.id} onClick={() => { handleReporterChange(mb.id); setReporterSearch(''); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${isSel ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                              <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[8px] font-bold">{getInitials(mb.firstName, mb.lastName)}</div>
                              <span className="flex-1 text-left truncate">{mb.firstName} {mb.lastName}</span>
                              {isSel && <Check size={11} className="ml-auto text-blue-600" />}
                            </button>
                          );
                        })}
                      {reporterSearch && spaceMembers.filter(m => { const mb = (m as any).user || m; return `${mb.firstName || ''} ${mb.lastName || ''}`.toLowerCase().includes(reporterSearch.toLowerCase()); }).length === 0 && (
                        <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No members found</p>
                      )}
                    </div>
                  </Dropdown>
                )}
              </div>
            </PropRow>}

            {/* Department — only shown when the field is assigned to this space */}
            <DepartmentField
              issueKey={issueKey}
              canEdit={canEdit}
              currentDepartment={(issue as any).current_department || null}
              spaceKey={issue.spaceKey || issueKey.split('-').slice(0, -1).join('-')}
              spaceId={issue.spaceId}
              currentBoardKey={issue.spaceKey || issueKey.split('-').slice(0, -1).join('-')}
              currentStatusName={issueStat?.name}
              onChanged={() => loadIssue(issueKey)}
              onDeptChangeBlocked={() => setDeptBlockModal(true)}
              onRequestDeptChange={(dept, execute) => {
                const missing = getMissingCoreFields();
                if (missing.length > 0) {
                  setMandatoryModal({ missingFields: missing, context: 'department' });
                  return;
                }
                setPendingDeptChange({ dept, execute });
              }}
              onSetWaitingStatus={async (deptName: string) => {
                const waitingStatus = spaceStatuses.find((s: any) =>
                  (s.name || '').toLowerCase() === `waiting for ${deptName.toLowerCase()}`
                );
                if (waitingStatus) {
                  await handleStatusChange(waitingStatus.id, waitingStatus);
                }
              }}
            />

            {/* Priority */}
            {!pinnedFields.includes('priority') && <PropRow label="Priority" onPin={() => togglePin('priority')}>
              <div className="px-1.5 py-1">
                <PriorityDropdown value={issue.priority} onChange={handlePriorityChange} />
              </div>
            </PropRow>}



            {/* Due Date */}
            {!pinnedFields.includes('dueDate') && <PropRow label="Due Date" onPin={() => togglePin('dueDate')}>
              {editing === 'dueDate' ? (
                <div className="flex items-center gap-1.5 px-1.5 py-1" onClick={e => e.stopPropagation()}>
                  <input type="date" value={editValue} onChange={e => setEditValue(e.target.value)}
                    className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none" autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') handleUpdate('dueDate', editValue || null); if (e.key === 'Escape') setEditing(null); }} />
                  <button onClick={() => handleUpdate('dueDate', editValue || null)} className="text-blue-600"><Check size={13} /></button>
                  <button onClick={() => setEditing(null)} className="text-gray-400"><X size={13} /></button>
                </div>
              ) : (
                <button onClick={() => { setEditing('dueDate'); setEditValue(issue.dueDate ? issue.dueDate.split('T')[0] : ''); }}
                  className="text-[13px] text-gray-700 hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left">
                  {issue.dueDate ? formatDate(issue.dueDate) : <span className="text-gray-400">None</span>}
                </button>
              )}
            </PropRow>}


            {/* Parent */}
            {issue.parent && (
              <PropRow label="Parent">
                <Link href={`/issues/${issue.parent.cfKey ?? issue.parent.key}`} className="text-[13px] text-blue-600 hover:underline px-1.5 py-1">{issue.parent.cfKey ?? issue.parent.key}</Link>
              </PropRow>
            )}

            {/* ── L2B Custom Fields ─────────────────────────────────────── */}
            {issue.spaceKey === 'L2BOARD' && (() => {
              // Root Cause & Fix Description moved to main body (below Linked Work Items)
              const l2bFields: { key: string; label: string; type: 'select' | 'multiselect' | 'textarea'; options?: string[] }[] = [
                { key: 'productType',    label: 'Product Type',    type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination',    label: 'Combination',     type: 'multiselect', options: ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','Shared Drive- Shared Drive','Shared Drive- SharePoint ','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','Box - Citrix','DropBox - Azure','Dropbox - Box','DropBox - Egnyte','Citrix - Citrix','Shared Drive - Egnyte','Shared Drive - Onedrive','SharePoint -  Shared Drive','SharePoint - Mydrive','SharePoint - SharePoint ','SharePoint - Egnyte','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','OneDrive - Amazon S3','Box - Amazon S3','Share Point - Amazon S3','Shared Drive - Amazon S3','Sharefile - Amazon S3','SharePoint - Azure','Shared Drive - Azure','Sharefile - Azure','Egnyte - Azure','Amazon S3 - SharePoint','Onedrive - Onedrive','Onedrive - MyDrive','Amazon workdocs - NFS','Slack to Slack','Chat to Chat','Teams to Teams','Meta to Chat','Meta to Viva','Meta to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Other','Amazon workdocs - Onedrive/SharePoint','MyDrive to MyDrive','ShareFile to SharePoint','ShareFile to ShareDrive','Drive Change','Box - Microsoft','Chat to Team','Teams to Slack','Chat To Slack'] },
                { key: 'projectManager', label: 'Project Manager',  type: 'multiselect', options: ['Harika','Abhishek','Ajay Singh','Abhishikth','Raghu','Lakshmi Prasanna','Sri Ram','Chandra Mouli','Sravan','Pranavi'] },
                { key: 'customerName',  label: 'Customer Name',   type: 'multiselect', options: ['Accenture','Adobe','Airbnb','Amazon','American Airlines','Apple','AT&T','Bank of America','Best Buy','Boeing','Capital One','Cisco','Citigroup','Coca-Cola','Comcast','CVS Health','Dell','Delta Air Lines','Deloitte','Disney','eBay','ExxonMobil','Facebook','FedEx','Ford','General Electric','General Motors','Goldman Sachs','Google','HP','IBM','Intel','J.P. Morgan','Johnson & Johnson','JPMorgan Chase','KPMG','Lockheed Martin','McDonald\'s','McKinsey','Merck','MetLife','Microsoft','Morgan Stanley','Netflix','Nike','Oracle','PepsiCo','Pfizer','Procter & Gamble','Raytheon','Salesforce','Samsung','SAP','Siemens','Sony','Sprint','Target','Tesla','Texas Instruments','The Home Depot','Twitter','UnitedHealth','UPS','US Bancorp','Verizon','Visa','Walmart','Wells Fargo','Xerox','Yahoo','Other'] },
                { key: 'clientName',    label: 'Client Name',     type: 'multiselect', options: ['Accenture','Adobe','Airbnb','Amazon','American Airlines','Apple','AT&T','Bank of America','Best Buy','Boeing','Capital One','Cisco','Citigroup','Coca-Cola','Comcast','CVS Health','Dell','Delta Air Lines','Deloitte','Disney','eBay','ExxonMobil','Facebook','FedEx','Ford','General Electric','General Motors','Goldman Sachs','Google','HP','IBM','Intel','J.P. Morgan','Johnson & Johnson','JPMorgan Chase','KPMG','Lockheed Martin','McDonald\'s','McKinsey','Merck','MetLife','Microsoft','Morgan Stanley','Netflix','Nike','Oracle','PepsiCo','Pfizer','Procter & Gamble','Raytheon','Salesforce','Samsung','SAP','Siemens','Sony','Sprint','Target','Tesla','Texas Instruments','The Home Depot','Twitter','UnitedHealth','UPS','US Bancorp','Verizon','Visa','Walmart','Wells Fargo','Xerox','Yahoo','Other'] },
              ];
              return l2bFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'l2b'));
            })()}

            {/* ── TESTBOARD Custom Fields ───────────────────────────────── */}
            {issue.spaceKey === 'TESTBOARD' && (() => {
              const testFields: { key: string; label: string; type: 'select' | 'multiselect' | 'text'; options?: string[] }[] = [
                { key: 'workType',         label: 'Work Type',         type: 'select',      options: ['Test','Task','Sub-task','Story','Bug','Epic','Test Set','Test Plan','Test Execution','Precondition'] },
                { key: 'productType',      label: 'Product Type',      type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination',      label: 'Combination',       type: 'multiselect', options: ['Box - OneDrive','Box - SharePoint','Box - Teams','Box - Google Drive','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox - Google Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive to MyDrive','Shared Drive - Shared Drive','Shared Drive - Onedrive','Shared Drive - SharePoint','Egnyte - Onedrive','Egnyte - SharePoint','NFS - Onedrive','NFS - SharePoint','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Teams to Slack','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Other','Others'] },
                { key: 'testEnvironment',  label: 'Test Environment',  type: 'text' },
                { key: 'manageClientName', label: 'Manage Client Name',type: 'multiselect', options: ['ab-inbev','cloudfuze','MarmicFire','global-v','manypets','medifast','cms','epiq-global','nfl','365datacenters','icf','concertai','utopia','hyland','bluebeaminc','cadence','manhattanassociates','noahmedical','insight','kbcadvisors','warnermedia','aresmanagement','exactsciences','nextiva','gearbox','nozominetworks','casepoint','trevitherapeutics','restorixhealth','getweave','bossdesign','onespan','lgads','savvymoney','None'] },
                { key: 'customerPlan',     label: 'Customer Plan',     type: 'multiselect', options: ['Starter','Professional','Enterprise','Custom','Trial','None'] },
                { key: 'testStatus',       label: 'Test Status',       type: 'select',      options: ['Open','In Progress','Pass','Fail','Blocked','Not Executed','Skipped'] },
              ];
              return testFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'test'));
            })()}

            {/* ── L3B Custom Fields ─────────────────────────────────────── */}
            {issue.spaceKey === 'L3BOARD' && (() => {
              // Root Cause & Fix Description shown in main body (below Linked Work Items)
              const l3bFields: { key: string; label: string; type: 'select' | 'multiselect'; options?: string[] }[] = [
                { key: 'productType', label: 'Product Type', type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination',    label: 'Combination',     type: 'multiselect', options: ['Box - OneDrive','Box - SharePoint','Box - Teams','Box - Google Drive','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox - Google Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive to MyDrive','Shared Drive - Shared Drive','Shared Drive - Onedrive','Shared Drive - SharePoint','Egnyte - Onedrive','Egnyte - SharePoint','NFS - Onedrive','NFS - SharePoint','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Teams to Slack','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Other','Others'] },
                { key: 'projectManager', label: 'Project Manager',  type: 'multiselect', options: ['Harika','Abhishek','Ajay Singh','Abhishikth','Raghu','Lakshmi Prasanna','Sri Ram','Chandra Mouli','Sravan','Pranavi'] },
                { key: 'customerName',   label: 'Customer Name',    type: 'multiselect', options: ['Accenture','Adobe','Airbnb','Amazon','American Airlines','Apple','AT&T','Bank of America','Best Buy','Boeing','Capital One','Cisco','Citigroup','Coca-Cola','Comcast','CVS Health','Dell','Delta Air Lines','Deloitte','Disney','eBay','ExxonMobil','Facebook','FedEx','Ford','General Electric','General Motors','Goldman Sachs','Google','HP','IBM','Intel','J.P. Morgan','Johnson & Johnson','JPMorgan Chase','KPMG','Lockheed Martin','McDonald\'s','McKinsey','Merck','MetLife','Microsoft','Morgan Stanley','Netflix','Nike','Oracle','PepsiCo','Pfizer','Procter & Gamble','Raytheon','Salesforce','Samsung','SAP','Siemens','Sony','Sprint','Target','Tesla','Texas Instruments','The Home Depot','Twitter','UnitedHealth','UPS','US Bancorp','Verizon','Visa','Walmart','Wells Fargo','Xerox','Yahoo','Other'] },
                { key: 'clientName',     label: 'Client Name',      type: 'multiselect', options: ['Accenture','Adobe','Airbnb','Amazon','American Airlines','Apple','AT&T','Bank of America','Best Buy','Boeing','Capital One','Cisco','Citigroup','Coca-Cola','Comcast','CVS Health','Dell','Delta Air Lines','Deloitte','Disney','eBay','ExxonMobil','Facebook','FedEx','Ford','General Electric','General Motors','Goldman Sachs','Google','HP','IBM','Intel','J.P. Morgan','Johnson & Johnson','JPMorgan Chase','KPMG','Lockheed Martin','McDonald\'s','McKinsey','Merck','MetLife','Microsoft','Morgan Stanley','Netflix','Nike','Oracle','PepsiCo','Pfizer','Procter & Gamble','Raytheon','Salesforce','Samsung','SAP','Siemens','Sony','Sprint','Target','Tesla','Texas Instruments','The Home Depot','Twitter','UnitedHealth','UPS','US Bancorp','Verizon','Visa','Walmart','Wells Fargo','Xerox','Yahoo','Other'] },
              ];
              return l3bFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'l3b'));
            })()}

            {/* ── CFMBOARD (Service Management) Custom Fields ──────────── */}
            {issue.spaceKey === 'CFMBOARD' && (() => {
              const CFM_COMBO_OPTIONS = ['Box - OneDrive','Box - SharePoint','Box - Teams','Box - Google Drive','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox - Google Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive to MyDrive','Shared Drive - Shared Drive','Shared Drive - Onedrive','Shared Drive - SharePoint','Egnyte - Onedrive','Egnyte - SharePoint','NFS - Onedrive','NFS - SharePoint','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Teams to Slack','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Other','Others'];
              const cfmFields: { key: string; label: string; type: 'select' | 'multiselect' | 'text'; options?: string[] }[] = [
                { key: 'workType',         label: 'Work Type',          type: 'select',      options: ['Task','Bug','Story','Epic','Sub-task','Demo','POC','Emailed Request','Technical Assistance','Security Assistance'] },
                { key: 'productType',      label: 'Product Type',       type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination',      label: 'Combination',        type: 'multiselect', options: CFM_COMBO_OPTIONS },
                { key: 'manageClientName', label: 'Manage Client Name', type: 'text' },
                { key: 'customerPlan',     label: 'Customer Plan',      type: 'text' },
                { key: 'testEnvironment',  label: 'Environment',        type: 'text' },
              ];
              return cfmFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'cfm'));
            })()}

            {/* ── L1B Custom Fields — also shown for dept-queue tickets (Migration/QA/Dev/etc),
                 or for any ticket that already has one of these fields set (e.g. created
                 manually without picking a department — department and these fields are
                 independent, so a missing department shouldn't hide saved values) ── */}
            {(issue.spaceKey === 'L1BOAR' || !!(issue as any).current_department
              || !!(issue as any).productType || !!(issue as any).combination || !!(issue as any).projectManager
              || !!(issue as any).customerName || !!(issue as any).clientName) && (() => {
              // Exact options from Jira CFITS customfield_10236
              const L1_COMBO_OPTIONS = ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','Shared Drive- Shared Drive','Shared Drive- SharePoint ','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','Box - Citrix','DropBox - Azure','Dropbox - Box','DropBox - Egnyte','Citrix - Citrix','Shared Drive - Egnyte','Shared Drive - Onedrive','SharePoint -  Shared Drive','SharePoint - Mydrive','SharePoint - SharePoint ','SharePoint - Egnyte','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','OneDrive - Amazon S3','Box - Amazon S3','Share Point - Amazon S3','Shared Drive - Amazon S3','Sharefile - Amazon S3','SharePoint - Azure','Shared Drive - Azure','Sharefile - Azure','Egnyte - Azure','Amazon S3 - SharePoint','Onedrive - Onedrive','Onedrive - MyDrive','Amazon workdocs - NFS','Slack to Slack','Chat to Chat','Teams to Teams','Meta to Chat','Meta to Viva','Meta to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Other','Amazon workdocs - Onedrive/SharePoint','MyDrive to MyDrive','ShareFile to SharePoint','ShareFile to ShareDrive','Drive Change','Box - Microsoft','Chat to Team','Teams to Slack','Chat To Slack'];
              // Exact options from Jira CFITS customfield_10883
              const L1_CLIENT_OPTIONS = ['ab-inbev','cloudfuze','MarmicFire','global-v','manypets','medifast','cms','epiq-global','computer_headquarters','groundedpackaging','nfl','realtimecloudservicesllc','capmation/aaron.salazar@capmation.com','365datacenters','icf','amputeecoalitionofamerica','concertai','xica','digantararesearchandtechnologiespvtltd','utopia','oassetmanagement','hyland','bluebeaminc','secloudexperts','tandemengineeringgroup','astoundbroadband','cadence','manhattanassociates','ovo','noahmedical','lighthouselearning','insight','roccoforte','phillipsexeteracademy','kbcadvisors','palmettotechnologygroup','convergetechnologysolutions','traditionone','tvsebike','alphabest','cheilagencynetwork','steelecanvasbasket','viasuninternal','rpmtechnologies','caseware','foundationcitizengo','curtlandryministries','nferenceinc.(pramana)','aplazame','alexandriarealeestateequitiesinc','warnermedia','atlasprimary','cuorementelab','curtlandryindustries','aresmanagement','kizantechnologies','instituteofinternationaleducation(iie)','ivyrehabnetworkinc','adventinternationalltd','exactsciencescorporation','glenno.hawbaker','barrattassetmanagementllc','aqueity','ontarionursesassociation','xavier','nationalgeographic','harvardbusinesspublishing','thirdpackettechnologies','butlercohen','alliancetechnologysolutions','Washington Post','schott','roccoforte&family','wegochemicalgroup','pilottravelcenters','aptlogix','nextiva','gearboxsoftware','nozominetworks','twelvebenefitcorporation','casepoint','jamessteelelaw','trevitherapeutics','restorixhealth','wheeleezinc','getweave','None','regala_consulting','binaryevolution','softmax','gearbox','nubius','IVYREHAB-Network-Inc.','MIG','goh-inc','bossdesigncenter','onespan','lgads','savvymoney','phoenixgamesholding','todaydentalnetwork','phillipseexeter','cheil','Chryselis','papereducation','synergygatewayverified','blackeducatordevelopment','morrisconsultinggroup','convergetechnologies','tunneltotowersfoundation','gadero','wasteprosUSA','krishservices','ForvisMazars'];
              const l1bFields: { key: string; label: string; type: 'select' | 'multiselect' | 'tags'; options?: string[] }[] = [
                { key: 'productType',    label: 'Product Type',    type: 'select',      options: ['Content Migration','Message Migration','Email Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination',    label: 'Combination',     type: 'multiselect', options: L1_COMBO_OPTIONS },
                { key: 'projectManager', label: 'Project Manager', type: 'multiselect', options: ['Harika','Abhishek','Ajay Singh','Abhishikth','Raghu','Lakshmi Prasanna','Sri Ram','Chandra Mouli','Sravan','Pranavi'] },
                { key: 'customerName',   label: 'Customer Name',   type: 'multiselect', options: ['Ab-Inbev','CloudFuze','CMS','Epiq_Global','EPIQ-GLOBAL','Global-V','Manypets','MarmicFire','NoahMedical','Thirdpacket'] },
                { key: 'clientName',     label: 'Client Name',     type: 'multiselect', options: L1_CLIENT_OPTIONS },
              ];
              return l1bFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'l1b'));
            })()}

            {/* ── INFRABOARD Custom Fields ─────────────────────────────── */}
            {issue.spaceKey === 'INFRABOARD' && (() => {
              const IB_COMBO_OPTIONS = ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','MyDrive to MyDrive','Shared Drive- Shared Drive','Shared Drive- SharePoint','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Onedrive - Onedrive','Other','Drive Change','Box - Microsoft','Teams to Slack','Chat To Slack'];
              const ibFields: { key: string; label: string; type: 'select' | 'multiselect'; options: string[] }[] = [
                { key: 'productType', label: 'Product Type', type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination', label: 'Combination',  type: 'multiselect', options: IB_COMBO_OPTIONS },
              ];
              return ibFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'ib'));
            })()}

            {/* ── QABOAR Custom Fields ──────────────────────────────────── */}
            {issue.spaceKey === 'QABOAR' && (() => {
              const QAB_COMBO_OPTIONS = ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','MyDrive to MyDrive','Shared Drive- Shared Drive','Shared Drive- SharePoint','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Onedrive - Onedrive','Other','Drive Change','Box - Microsoft','Teams to Slack','Chat To Slack'];
              const qabFields: { key: string; label: string; type: 'select' | 'multiselect'; options: string[] }[] = [
                { key: 'productType', label: 'Product Type', type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination', label: 'Combination',  type: 'multiselect', options: QAB_COMBO_OPTIONS },
              ];
              return qabFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'qab'));
            })()}

            {/* ── PSMBOARD Custom Fields ────────────────────────────────── */}
            {issue.spaceKey === 'PSMBOARD' && (() => {
              const PSM_COMBO_OPTIONS = ['Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','Shared Drive- Shared Drive','Shared Drive- SharePoint ','Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','Box - Citrix','DropBox - Azure','Dropbox - Box','DropBox - Egnyte','Citrix - Citrix','Shared Drive - Egnyte','Shared Drive - Onedrive','SharePoint -  Shared Drive','SharePoint - Mydrive','SharePoint - SharePoint ','SharePoint - Egnyte','NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive','OneDrive - Amazon S3','Box - Amazon S3','Share Point - Amazon S3','Shared Drive - Amazon S3','Sharefile - Amazon S3','SharePoint - Azure','Shared Drive - Azure','Sharefile - Azure','Egnyte - Azure','Amazon S3 - SharePoint','Onedrive - Onedrive','Onedrive - MyDrive','Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail','Other','Drive Change','Box - Microsoft','Teams to Slack','Chat To Slack','MyDrive to MyDrive','ShareFile to SharePoint','ShareFile to ShareDrive'];
              const psmFields: { key: string; label: string; type: 'select' | 'multiselect'; options: string[] }[] = [
                { key: 'productType', label: 'Product Type', type: 'select',      options: ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'] },
                { key: 'combination', label: 'Combination',  type: 'multiselect', options: PSM_COMBO_OPTIONS },
              ];
              return psmFields.map(({ key, label, type, options }) => renderCustomField(key, label, type, options, 'psm'));
            })()}

            {/* Custom Fields — skip department-routing fields (handled by dedicated DepartmentField above) */}
            {(() => {
              // Known options for migrated fields that don't store options in DB
              const KNOWN_CF_OPTIONS: Record<string, string[]> = {
                'Product Type':    ['Content Migration','Email Migration','Message Migration','Board Migration','CF Connect','CF Manage','UI','others'],
                'Work Type':       ['New','Ongoing','Renewal','Upsell','Downgrade','Others'],
                'Project Manager': ['Abhishek','Abhishikth','Ajay Singh','Chandra Mouli','Harika','Lakshmi Prasanna','Raghu','Sri Ram','Sravan','Pranavi'],
                'Combination':     [
                  'Box - OneDrive','Box - SharePoint','Box - MyDrive','Box - Shared Drive','Box - Dropbox','Box - Box','Box - Microsoft',
                  'Dropbox - Onedrive','Dropbox - SharePoint','Dropbox- MyDrive','Dropbox - Shared Drive','Dropbox - Box','DropBox - Azure','DropBox - Egnyte',
                  'MyDrive - Onedrive','MyDrive - SharePoint','MyDrive - Dropbox','MyDrive - Egnyte','MyDrive - Box','MyDrive to MyDrive',
                  'Shared Drive- Shared Drive','Shared Drive- SharePoint','Shared Drive - Onedrive','Shared Drive - Egnyte','Shared Drive - Azure',
                  'Citrix - OneDrive','Citrix - SharePoint','Citrix - MyDrive','Citrix - Shared Drive','Citrix - Citrix',
                  'Egnyte - Onedrive','Egnyte - SharePoint','Egnyte - MyDrive','Egnyte - Shared Drive','Egnyte - Azure',
                  'NFS - Onedrive','NFS - SharePoint','NFS - MyDrive','NFS - Shared Drive',
                  'OneDrive - Amazon S3','Box - Amazon S3','Share Point - Amazon S3','Shared Drive - Amazon S3','Sharefile - Amazon S3',
                  'SharePoint - Azure','Sharefile - Azure','Amazon S3 - SharePoint',
                  'SharePoint - Shared Drive','SharePoint - Mydrive','SharePoint - SharePoint','SharePoint - Egnyte',
                  'Onedrive - Onedrive','Onedrive - MyDrive',
                  'Slack to Slack','Chat to Chat','Teams to Teams','Slack to Teams','Slack to Chat','Teams to Chat','Chat to Teams','Teams to Slack','Chat To Slack',
                  'Gmail - Gmail','Gmail - Outlook','Outlook - Outlook','Outlook - Gmail',
                  'Meta to Chat','Meta to Viva','Meta to Teams',
                  'Amazon workdocs - NFS','Amazon workdocs - Onedrive/SharePoint',
                  'ShareFile to SharePoint','ShareFile to ShareDrive',
                  'Drive Change','Other',
                ],
              };
              const isSelectType = (ft: string) =>
                ft === 'select-single' || ft === 'radio' ||
                ft === 'Select List (single choice)' || ft === 'Select List (multiple choices)' ||
                ft === 'select-multi' || ft === 'Checkboxes' || ft === 'Radio Buttons';
              const isMultiType = (ft: string) =>
                ft === 'select-multi' || ft === 'Select List (multiple choices)' || ft === 'Checkboxes';
              const isUserType = (ft: string) => ft === 'User' || ft === 'user';

              // Map custom field names to native issue columns
              const NATIVE_FIELD_MAP: Record<string, string> = {
                'Customer Name': 'customerName',
                'Client Name':   'clientName',
                'Work Type':     'workType',
                'Product Type':  'productType',
                'Combination':   'combination',
                'Project Manager': 'projectManager',
              };

              // Skip fields already rendered in the l1bFields section above (native columns)
              const ALREADY_SHOWN = new Set(Object.keys(NATIVE_FIELD_MAP));
              return customFields.filter(cf => !pinnedFields.includes(`cf_${cf.id}`) && cf.fieldType !== 'department-routing' && cf.type !== 'department-routing' && !ALREADY_SHOWN.has(cf.name)).map(cf => {
                // Use fieldType or type (mock stores as 'type', DB stores as 'fieldType')
                const effectiveType = cf.fieldType || cf.type || '';
                // Merge DB options with known options fallback
                const fieldOptions: string[] = (cf.options?.length ? cf.options : KNOWN_CF_OPTIONS[cf.name]) || [];
                const isSelect = isSelectType(effectiveType);
                const isMulti  = isMultiType(effectiveType);
                // For native columns, read value from issue object, not customFieldValues
                const nativeKey = NATIVE_FIELD_MAP[cf.name];
                const nativeVal = nativeKey ? ((issue as any)[nativeKey] || '') : '';
                const currentVal = customFieldValues[cf.id] || nativeVal || '';

              return (
              <PropRow key={cf.id} label={cf.name} onPin={() => togglePin(`cf_${cf.id}`)}>
                {editingCustomField === cf.id ? (
                  <div className="flex items-center gap-1.5 px-1.5 py-1" onClick={e => e.stopPropagation()}>
                    {effectiveType === 'date' ? (
                      <input type="date" value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)}
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none" autoFocus />
                    ) : isUserType(effectiveType) && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((name: string) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    ) : effectiveType === 'department-routing' && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((opt: string) => {
                          const deptName = String(opt).split('|')[0].trim();
                          return <option key={opt} value={deptName}>{deptName}</option>;
                        })}
                      </select>
                    ) : isSelect && fieldOptions.length > 0 ? (
                      <select value={customFieldEditValue} onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none bg-white">
                        <option value="">None</option>
                        {fieldOptions.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input type={cf.fieldType === 'number' ? 'number' : 'text'} value={customFieldEditValue}
                        onChange={e => setCustomFieldEditValue(e.target.value)} autoFocus
                        className="border border-blue-400 rounded px-2 py-0.5 text-sm focus:outline-none w-28"
                        onKeyDown={e => { if (e.key === 'Escape') setEditingCustomField(null); }} />
                    )}
                    <button onClick={() => {
                      const savePromises: Promise<any>[] = [
                        api.setCustomFieldValue(issue.id, cf.id, customFieldEditValue).catch(() => {}),
                      ];
                      if (nativeKey) {
                        savePromises.push(api.updateIssue(issueKey, { [nativeKey]: customFieldEditValue }).catch(() => {}));
                      }
                      Promise.all(savePromises).then(() => {
                        setCustomFieldValues(prev => ({ ...prev, [cf.id]: customFieldEditValue }));
                        setEditingCustomField(null);
                        loadIssue(issueKey);
                      });
                    }} className="text-blue-600"><Check size={13} /></button>
                    <button onClick={() => setEditingCustomField(null)} className="text-gray-400"><X size={13} /></button>
                  </div>
                ) : (
                  (() => {
                    const slaVal = getSLAFieldDisplayValue(cf);
                    const displayVal = slaVal ? slaVal.value : (currentVal || null);
                    return (
                      <button onClick={() => { setEditingCustomField(cf.id); setCustomFieldEditValue(currentVal); }}
                        className="text-[13px] hover:bg-white rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left">
                        {displayVal ? (
                          <span className={
                            slaVal
                              ? (slaVal.isBreached ? 'font-semibold text-red-600' : 'font-medium text-green-600')
                              : 'text-gray-700'
                          }>{displayVal}</span>
                        ) : <span className="text-gray-400">None</span>}
                      </button>
                    );
                  })()
                )}
              </PropRow>
              );
            });
            })()}
          </div>

          {/* SLA Section — Jira style */}
          {issue.sla && issue.sla.length > 0 && (() => {
            // ── helpers ────────────────────────────────────────────────────────
            const fmtTime = (d: Date) =>
              d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

            const fmtRemaining = (ms: number) => {
              if (ms <= 0) return null;
              const totalSecs = Math.floor(ms / 1000);
              const s = totalSecs % 60;
              const totalMins = Math.floor(totalSecs / 60);
              const m = totalMins % 60;
              const h = Math.floor(totalMins / 60);
              if (h > 0) return `${h}h ${m}m remaining`;
              if (m > 0) return `${m}m ${s}s remaining`;
              return `${s}s remaining`;
            };

            const fmtOverdue = (ms: number) => {
              const totalSecs = Math.floor(Math.abs(ms) / 1000);
              const totalMins = Math.floor(totalSecs / 60);
              const m = totalMins % 60;
              const h = Math.floor(totalMins / 60);
              if (h > 0) return `${h}h ${m}m overdue`;
              if (m > 0) return `${m}m overdue`;
              return `${totalSecs}s overdue`;
            };

            const fmtGoal = (ms: number) => {
              const m = Math.round(ms / 60000);
              if (m < 60) return `${m}m`;
              const h = Math.round(ms / 3600000);
              if (h < 24) return `${h}h`;
              return `${Math.round(ms / 86400000)}d`;
            };

            // ── top-level SLA entries — show every SLA that applies to this ticket's dept ──
            const seen = new Set<string>();
            const dedupedEntries = (issue.sla as any[])
              .sort((a, b) => Number(b.isBreached) - Number(a.isBreached))
              .filter(s => {
                const k = s.policyId || s.policyName || s.id;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
            // The API already scopes issue.sla to this ticket's department (plus any
            // space-wide, no-dept SLAs), so every deduped entry is relevant — show them all
            // instead of collapsing down to a single "best match".
            const finalEntries = dedupedEntries;

            // Any SLA breached right now (live check)? A completed ticket's due time
            // is frozen in the past, which read as breached forever once resolved —
            // exclude completed entries the same way paused ones already are.
            const anyBreached = finalEntries.some(s => !s.isPaused && !s.isCompleted && (s.isBreached || new Date(s.dueTime).getTime() - slaNow <= 0));

            return (
              <>
                <div className="h-px bg-gray-200 mx-4" />
                <div className="px-4 py-3">
                  {/* Header */}
                  <button
                    onClick={() => setSlaExpanded(v => !v)}
                    className="flex items-center gap-1.5 w-full mb-2.5 group"
                  >
                    <ChevronDown size={13} className={`transition-transform duration-150 ${anyBreached ? 'text-red-500' : 'text-gray-500'} ${slaExpanded ? '' : '-rotate-90'}`} />
                    <span className={`text-[12.5px] font-semibold ${anyBreached ? 'text-red-600' : 'text-gray-700 group-hover:text-gray-900'}`}>SLAs</span>
                    {anyBreached && (
                      <span className="ml-1 flex items-center gap-1 text-[10.5px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full animate-pulse">
                        ⚠ BREACHED
                      </span>
                    )}
                  </button>

                  {slaExpanded && (
                    <div className="space-y-2">
                      {finalEntries.map((s: any) => {
                        const startedAt = s.startedAt ? new Date(s.startedAt) : null;
                        const dueAt = new Date(s.dueTime);
                        const remainingMs = dueAt.getTime() - slaNow;
                        const isPaused = s.isPaused === true;
                        const isCompleted = s.isCompleted === true;
                        const isBreached = !isPaused && !isCompleted && (s.isBreached || remainingMs <= 0);
                        const goalMs: number = s.goalDurationMs || 0;
                        // Paused: freeze elapsed at pause time (now - start), don't count up
                        const elapsedMs = isPaused
                          ? dueAt.getTime() - (startedAt?.getTime() ?? dueAt.getTime()) + (goalMs - Math.max(0, dueAt.getTime() - (startedAt?.getTime() ?? dueAt.getTime())))
                          : slaNow - (startedAt?.getTime() ?? slaNow);
                        const pct = goalMs > 0 ? Math.min(100, Math.round((elapsedMs / goalMs) * 100)) : 0;
                        const baseName = (s.policyName || 'SLA').replace(/ - (highest|high|medium|low|lowest)$/i, '');

                        const warnMs = 30 * 60 * 1000;
                        const isNotified = s.isNotified === true && (remainingMs <= warnMs);

                        return (
                          <div key={s.id} className={`rounded-xl border p-3 ${isBreached ? 'border-red-300 bg-red-50' : isCompleted ? 'border-emerald-300 bg-emerald-50' : isPaused ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}>

                            {/* Row 1: policy name + status badges */}
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Clock size={13} className={isBreached ? 'text-red-500' : isCompleted ? 'text-emerald-500' : isPaused ? 'text-amber-500' : 'text-blue-500'} />
                                <span className="text-[12px] font-semibold text-gray-800">{baseName}</span>
                                {goalMs > 0 && (
                                  <span className="text-[10px] text-gray-400 font-medium">({fmtGoal(goalMs)})</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                {isNotified && (
                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                                    🔔 NOTIFIED
                                  </span>
                                )}
                                <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full ${
                                  isBreached ? 'bg-red-100 text-red-700 border border-red-200 animate-pulse'
                                  : isCompleted ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                                  : isPaused ? 'bg-amber-100 text-amber-700 border border-amber-200'
                                  : 'bg-green-100 text-green-700'
                                }`}>
                                  {isBreached ? '⚠ BREACHED' : isCompleted ? '✓ RESOLVED' : isPaused ? '⏸ PAUSED' : '● RUNNING'}
                                </span>
                              </div>
                            </div>

                            {/* Row 2: countdown / paused / overdue / resolved time — a
                                resolved ticket must stop counting down, not keep ticking
                                toward (or past) its due time forever. */}
                            <div className={`text-[17px] font-bold tabular-nums mb-2 ${isBreached ? 'text-red-600' : isCompleted ? 'text-emerald-600' : isPaused ? 'text-amber-600' : 'text-gray-900'}`}>
                              {isCompleted ? 'Resolved' : isPaused ? 'SLA paused' : isBreached ? fmtOverdue(remainingMs) : (fmtRemaining(remainingMs) || '—')}
                            </div>

                            {/* Row 3: progress bar */}
                            {goalMs > 0 && (
                              <div className="w-full h-1.5 rounded-full bg-gray-200 overflow-hidden mb-3">
                                <div
                                  className={`h-1.5 rounded-full transition-none ${isBreached ? 'bg-red-500' : isCompleted ? 'bg-emerald-500' : isPaused ? 'bg-amber-400' : pct > 80 ? 'bg-amber-400' : 'bg-blue-500'}`}
                                  style={{ width: `${Math.min(pct, 100)}%` }}
                                />
                              </div>
                            )}

                            {/* Row 4: Start time / Due time — always visible, stacked */}
                            {startedAt && (
                              <div className="grid grid-cols-2 gap-2 mt-1">
                                <div className="bg-gray-50 rounded-lg px-2.5 py-1.5">
                                  <p className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Start</p>
                                  <p className="text-[11px] font-semibold text-gray-700">{fmtTime(startedAt)}</p>
                                </div>
                                <div className={`rounded-lg px-2.5 py-1.5 ${isBreached ? 'bg-red-100' : 'bg-gray-50'}`}>
                                  <p className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Due</p>
                                  <p className={`text-[11px] font-semibold ${isBreached ? 'text-red-600' : 'text-gray-700'}`}>{fmtTime(dueAt)}</p>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {/* Timestamps */}
          <div className="h-px bg-gray-200 mx-4" />
          <div className="px-4 py-3 space-y-1">
            <p className="text-[11px] text-gray-400">Created · {formatJiraDateTime(issue.createdAt)}</p>
            <p className="text-[11px] text-gray-400">Updated · {formatJiraDateTime(issue.updatedAt)}</p>
            {issue.resolvedAt && <p className="text-[11px] text-gray-400">Resolved · {formatJiraDateTime(issue.resolvedAt)}</p>}
          </div>
        </div>
      </div>

      {/* ── Create Subtask Modal (removed — now inline) ── */}
      {false && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => !subtaskSaving && setShowSubtaskModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-[15px] font-bold text-gray-900">Create subtask</h2>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  Parent: <span className="font-semibold text-blue-600">{issueKey}</span>
                  {' · '}{issue.summary?.slice(0, 40)}{(issue.summary?.length ?? 0) > 40 ? '…' : ''}
                </p>
              </div>
              <button onClick={() => setShowSubtaskModal(false)} disabled={subtaskSaving}
                className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              {/* Summary */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">
                  Summary <span className="text-red-500">*</span>
                </label>
                <input
                  autoFocus
                  value={subtaskSummary}
                  onChange={e => setSubtaskSummary(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handleCreateSubtask(); }}
                  placeholder="What needs to be done?"
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-xl text-[13.5px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow"
                />
              </div>

              {/* Type + Priority row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Issue type</label>
                  <select
                    value={subtaskType}
                    onChange={e => setSubtaskType(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-xl text-[13px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="subtask">Sub-task</option>
                    <option value="task">Task</option>
                    <option value="bug">Bug</option>
                    <option value="story">Story</option>
                    <option value="improvement">Improvement</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Priority</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setSubtaskPriorityOpen(p => !p)}
                      className="w-full flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-xl text-[13px] text-gray-800 bg-white hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                    >
                      <PriorityIcon priority={subtaskPriority} size={14} />
                      <span className="flex-1 text-left">{getPriorityMeta(subtaskPriority).label}</span>
                      <ChevronDown size={13} className="text-gray-400" />
                    </button>
                    {subtaskPriorityOpen && (
                      <>
                        <div className="fixed inset-0 z-[10000]" onClick={() => setSubtaskPriorityOpen(false)} />
                        <div className="absolute left-0 top-full mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-xl z-[10001] py-1 overflow-hidden">
                          {PRIORITIES.map(p => (
                            <button
                              key={p.value}
                              type="button"
                              onClick={() => { setSubtaskPriority(p.value); setSubtaskPriorityOpen(false); }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-gray-50 transition-colors ${subtaskPriority === p.value ? 'bg-blue-50 font-semibold' : 'text-gray-700'}`}
                            >
                              <PriorityIcon priority={p.value} size={14} />
                              <span style={{ color: p.color }}>{p.label}</span>
                              {subtaskPriority === p.value && <Check size={13} className="ml-auto text-blue-600" />}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Assignee */}
              <div>
                <label className="block text-[12px] font-semibold text-gray-600 mb-1.5">Assignee</label>
                <select
                  value={subtaskAssigneeId || ''}
                  onChange={e => setSubtaskAssigneeId(e.target.value || null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl text-[13px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Unassigned</option>
                  {spaceMembers.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.firstName} {m.lastName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 pb-5 flex gap-3 justify-end border-t border-gray-100 pt-4">
              <button
                onClick={() => setShowSubtaskModal(false)}
                disabled={subtaskSaving}
                className="px-4 py-2 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSubtask}
                disabled={!subtaskSummary.trim() || subtaskSaving}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {subtaskSaving
                  ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…</>
                  : <><Plus size={14} />Create subtask</>
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal (admin only) ── */}
      {/* Mandatory fields validation modal */}
      {mandatoryModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: 'rgba(9,30,66,0.54)' }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-orange-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">Required fields missing</h3>
                <p className="text-[12.5px] text-gray-500 mt-0.5">
                  {mandatoryModal.context === 'department'
                    ? 'Complete all required fields before changing the department.'
                    : 'Complete all required fields before closing this ticket.'}
                </p>
              </div>
            </div>
            <div className="px-6 py-4">
              <p className="text-[13px] text-gray-700 mb-3">
                The following fields are mandatory and must be filled before {mandatoryModal.context === 'department' ? 'changing the department' : 'resolving this ticket'}:
              </p>
              <ul className="space-y-2">
                {mandatoryModal.missingFields.map(field => (
                  <li key={field} className="flex items-center gap-2.5 px-3 py-2 bg-red-50 border border-red-100 rounded-lg">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    <span className="text-[13px] font-semibold text-red-700">{field}</span>
                    <span className="text-[12px] text-red-500 ml-auto">This field is mandatory</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setMandatoryModal(null)}
                className="px-4 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors">
                Go back &amp; fill fields
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDeptChange && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
            <div className="px-6 py-5">
              <h3 className="text-[15px] font-semibold text-gray-900 mb-1">Change Department?</h3>
              <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">
                {(() => {
                  const waitingName = `Waiting for ${pendingDeptChange.dept.name}`;
                  const alreadyWaiting = issueStat?.name?.toLowerCase() === waitingName.toLowerCase();
                  return alreadyWaiting ? (
                    <>The ticket will move to <span className="font-semibold text-blue-700">{pendingDeptChange.dept.name}</span>.</>
                  ) : (
                    <>The current status in <span className="font-semibold text-gray-800">{(issue as any).current_department || 'current'}</span> will
                    first be set to <span className="font-semibold text-amber-600">{waitingName}</span>,
                    then the ticket will move to <span className="font-semibold text-blue-700">{pendingDeptChange.dept.name}</span>.</>
                  );
                })()}
              </p>
              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={() => setPendingDeptChange(null)}
                  className="px-4 py-1.5 text-[13px] text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { const fn = pendingDeptChange.execute; setPendingDeptChange(null); fn(); }}
                  className="px-4 py-1.5 text-[13px] font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Yes, Change Department
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deptBlockModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: 'rgba(9,30,66,0.54)' }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-amber-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">Status change required</h3>
                <p className="text-[12.5px] text-gray-500 mt-0.5">You must change the status first.</p>
              </div>
            </div>
            <div className="px-6 py-4">
              <p className="text-[13.5px] text-gray-600 leading-relaxed">
                Please change the status to{' '}
                <span className="font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">Waiting for Dev</span>{' '}
                before changing the department.
              </p>
            </div>
            <div className="flex justify-end px-6 py-4 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setDeptBlockModal(false)}
                className="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 rounded-lg hover:bg-gray-700 transition-colors">
                OK, got it
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: 'rgba(9,30,66,0.54)' }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-6 pt-6 pb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900">Delete issue?</h2>
                <p className="text-sm text-gray-500 mt-0.5">Issue <span className="font-semibold text-gray-700">{issue.cfKey ?? issue.key}</span></p>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 pb-5">
              <p className="text-sm text-gray-600 leading-relaxed">
                This will permanently delete <span className="font-semibold text-gray-800">"{issue.summary}"</span> and all its comments, attachments, and history.
              </p>
              <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700 font-medium">This action cannot be undone.</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50 border-t border-gray-100">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60 flex items-center gap-2"
              >
                {deleting ? (
                  <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                ) : (
                  <><Trash2 size={13} /> Delete issue</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lightbox modal for images in description / comments ── */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
          >
            <X size={18} />
          </button>
          <img
            src={lightboxSrc}
            alt=""
            className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

/* ===== Department Field ===== */
function DepartmentField({ issueKey, currentDepartment, spaceKey, spaceId, currentBoardKey, currentStatusName, canEdit = true, onChanged, onDeptChangeBlocked, onSetWaitingStatus, onRequestDeptChange }: {
  issueKey: string;
  currentDepartment: string | null;
  spaceKey: string;
  spaceId?: string;
  currentBoardKey?: string;
  currentStatusName?: string;
  canEdit?: boolean;
  onChanged: () => void;
  onDeptChangeBlocked?: () => void;
  onSetWaitingStatus?: (deptName: string) => Promise<void>;
  onRequestDeptChange?: (dept: { name: string; boardKey: string }, execute: () => void) => void;
}) {
  const router = useRouter();
  const [deptOptions, setDeptOptions] = React.useState<{ name: string; boardKey: string }[]>([]);
  // A ticket that already has a department is itself proof this board uses
  // department routing — show it immediately instead of waiting on the
  // separate custom-fields/rr-config fetch below to confirm that. Previously
  // this always started at null (hides the field) regardless of the ticket's
  // own data, so any slowness or failure in that other fetch — unrelated to
  // whether the field should show at all — left Department invisible on
  // every queue, not just Migration, until the fetch happened to resolve.
  const [spaceAssigned, setSpaceAssigned] = React.useState<boolean | null>(currentDepartment ? true : null);
  const [showDrop, setShowDrop] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [optimisticDept, setOptimisticDept] = React.useState<string | null>(null);
  const [deptToast, setDeptToast] = React.useState<{ dept: string; board: string; newKey: string; assignee: string; queueUrl?: string; fromDept?: string; fromSpaceKey?: string } | null>(null);
  const [pendingDept, setPendingDept] = React.useState<{ name: string; boardKey: string } | null>(null);
  // Surfaces WHY a transfer failed (e.g. someone else's queue already moved
  // it, or a network hiccup) -- previously the request just silently
  // reverted the optimistic update with no explanation, which read as the
  // department change "randomly not working."
  const [deptError, setDeptError] = React.useState<string | null>(null);

  // When parent updates currentDepartment, clear the optimistic value
  React.useEffect(() => { setOptimisticDept(null); }, [currentDepartment]);

  const displayDept = optimisticDept ?? currentDepartment;

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';

  React.useEffect(() => {
    if (!spaceKey) return;
    const headers = { Authorization: `Bearer ${getToken()}` };

    Promise.allSettled([
      fetch(`/api/spaces/${spaceKey}/rr-config`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`/api/custom-fields`, { headers }).then(r => r.ok ? r.json() : null),
    ]).then(([rrRes, cfRes]) => {
      const combined: { name: string; boardKey: string }[] = [];
      let allDeptFieldsCount = 0;

      // 1. From Department Routing custom fields (options encoded as "DeptName|boardKey|emp1,emp2")
      if (cfRes.status === 'fulfilled' && cfRes.value) {
        const fields: any[] = cfRes.value?.fields || cfRes.value || [];
        const allDeptFields = fields.filter((f: any) =>
          f.fieldType === 'department-routing' || f.type === 'Department Routing'
        );
        allDeptFieldsCount = allDeptFields.length;
        const deptFields = allDeptFields.filter((f: any) => {
          // Only show if this space is assigned to the field (Manage boards checkbox)
          if (spaceId) {
            const assignedIds: string[] = Array.isArray(f.spaceIds) ? f.spaceIds : [];
            if (assignedIds.length > 0 && !assignedIds.includes(spaceId)) return false;
          }
          return true;
        });
        // If a dept-routing field exists but this space is not assigned, mark as not assigned
        if (allDeptFields.length > 0) {
          setSpaceAssigned(deptFields.length > 0);
        }
        for (const field of deptFields) {
          for (const opt of (field.options || [])) {
            const parts = String(opt).split('|');
            const deptName = parts[0]?.trim();
            const boardKey = parts[1]?.trim() || '';
            if (deptName && !combined.find(x => x.name.toUpperCase() === deptName.toUpperCase())) {
              combined.push({ name: deptName, boardKey });
            }
          }
        }
      }

      // Covers both "no department-routing custom field exists anywhere" and
      // "the custom-fields fetch itself failed" — either way we still know
      // the answer from the ticket's own data: if it already has a
      // department, this board obviously uses department routing.
      if (allDeptFieldsCount === 0) {
        setSpaceAssigned(prev => prev === true ? true : Boolean(currentDepartment));
      }

      // 2. From RR config — add any missing depts, and clear boardKey for existing ones
      // so single-board setups don't accidentally hide all routing targets
      if (rrRes.status === 'fulfilled' && rrRes.value) {
        const sorted = [...(rrRes.value?.config?.departments || [])].sort((a: any, b: any) => a.order - b.order);
        for (const d of sorted) {
          const existing = combined.find(x => x.name.toUpperCase() === d.name.toUpperCase());
          if (existing) {
            existing.boardKey = ''; // RR config wins — don't filter out by board
          } else {
            combined.push({ name: d.name, boardKey: '' });
          }
        }
      }

      setDeptOptions(combined);
    });
  }, [spaceKey]);

  const changeDept = async (dept: { name: string; boardKey: string }) => {
    if (dept.name.toUpperCase() === (currentDepartment || '').toUpperCase()) { return; }
    setSaving(true);
    setShowDrop(false);
    setDeptError(null);
    const prevDept = optimisticDept ?? currentDepartment;
    setOptimisticDept(dept.name);
    // Only set waiting status if not already in it (avoids redundant reload)
    const alreadyWaiting = (currentStatusName || '').toLowerCase() === `waiting for ${dept.name.toLowerCase()}`;
    // Fire the "waiting status" update alongside the actual transfer instead of
    // waiting for it first — the transfer endpoint doesn't depend on the status
    // already being set, so sequencing them just doubled the wait for no reason.
    const waitingStatusPromise = alreadyWaiting
      ? Promise.resolve()
      : Promise.resolve(onSetWaitingStatus?.(dept.name)).catch(() => {});
    try {
      const res = await fetch(`/api/issues/${issueKey}/department`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ department: dept.name, fromDept: currentDepartment || (issue as any).current_department || '' }),
      });
      if (res.ok) {
        const data = await res.json();
        const fromDeptVal = currentDepartment || (issue as any).current_department || '';
        setDeptToast({
          dept: dept.name,
          board: data.sameBoard ? (data.boardKey || spaceKey) : (data.targetBoardKey || firstBoard || dept.name),
          newKey: data.sameBoard ? '' : (data.newKey || ''),
          assignee: data.sameBoard
            ? (data.assigneeName ? `${data.assigneeName} (Round Robin)` : 'Unassigned — waiting for agent')
            : (data.assignee?.name || ''),
          queueUrl: '',
          fromDept: fromDeptVal,
          fromSpaceKey: spaceKey,
        });
        // Do NOT call onChanged() here — that would reload the issue with the new dept
        // and make the sidebar jump to Dev while the popup is still showing.
        // Navigation on OK click handles the transition.
      } else {
        setOptimisticDept(prevDept);
        let message = 'Could not change department — please try again.';
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch { /* non-JSON error body */ }
        setDeptError(message);
      }
    } catch {
      setOptimisticDept(prevDept);
      setDeptError('Network error — could not reach the server. Please try again.');
    }
    await waitingStatusPromise;
    setSaving(false);
  };

  React.useEffect(() => {
    if (!deptError) return;
    const t = setTimeout(() => setDeptError(null), 6000);
    return () => clearTimeout(t);
  }, [deptError]);

  // Wait until we know assignment status (null = still loading)
  if (spaceAssigned !== true) return null;

  return (
    <div
      className="flex items-start gap-2 py-1.5 px-1.5 -mx-1.5 border-b border-gray-100 last:border-0 group relative rounded-md"
      style={displayDept ? { backgroundColor: getDeptColor(displayDept) + '0c', borderLeft: `2px solid ${getDeptColor(displayDept)}` } : undefined}
    >
      <div className="w-[90px] flex-shrink-0 pt-1.5">
        <span className="text-[11.5px] text-gray-400 leading-none">Department</span>
      </div>
      <div className="flex-1 min-w-0 relative">
        {showDrop && <div className="fixed inset-0 z-40" onClick={() => setShowDrop(false)} />}

        <button
          onClick={() => !saving && canEdit && setShowDrop(s => !s)}
          disabled={!canEdit}
          title={canEdit ? undefined : 'This ticket has moved to another queue — only that queue can change its department'}
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1.5 transition-colors w-full text-left ${canEdit ? 'hover:bg-gray-50' : 'cursor-not-allowed opacity-70'}`}
        >
          {displayDept ? (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border"
              style={{ backgroundColor: getDeptColor(displayDept) + '15', color: getDeptColor(displayDept), borderColor: getDeptColor(displayDept) + '40' }}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: getDeptColor(displayDept) }} />
              {displayDept}
            </span>
          ) : (
            <span className="text-[13px] text-gray-400">None</span>
          )}
          <ChevronDown size={10} className="text-gray-300 ml-auto flex-shrink-0" />
        </button>

        {/* Department change error -- shown inline instead of failing silently */}
        {deptError && (
          <div className="mt-1.5 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
            <AlertTriangle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
            <span className="text-[11px] text-red-700 leading-snug flex-1">{deptError}</span>
            <button onClick={() => setDeptError(null)} className="text-red-400 hover:text-red-600 flex-shrink-0">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Department change success popup */}
        {deptToast && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-2xl w-[400px] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
              <div className="px-6 py-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                    <Check size={18} className="text-green-600" />
                  </div>
                  <h3 className="text-[15px] font-semibold text-gray-900">Successfully Moved to {deptToast.dept}</h3>
                </div>
                <div className="space-y-2 pl-12">
                  <div className="flex items-center gap-2 text-[13px] text-gray-600">
                    <span className="w-24 text-gray-400 flex-shrink-0">Department</span>
                    <span className="font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">{deptToast.dept}</span>
                  </div>
                  {deptToast.assignee && (
                    <div className="flex items-center gap-2 text-[13px] text-gray-600">
                      <span className="w-24 text-gray-400 flex-shrink-0">Assigned to</span>
                      <span className="font-semibold text-gray-800">{deptToast.assignee}</span>
                    </div>
                  )}
                </div>
                <div className="flex justify-end mt-5">
                  <button
                    onClick={() => {
                      const sk = deptToast?.fromSpaceKey;
                      const fd = deptToast?.fromDept;
                      setDeptToast(null);
                      if (sk && fd) {
                        router.push(`/spaces/${sk}?queue=dept_all&dept=${encodeURIComponent(fd)}`);
                      } else {
                        router.back();
                      }
                    }}
                    className="px-5 py-1.5 text-[13px] font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Department change confirmation popup */}
        {pendingDept && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
              <div className="px-6 py-5">
                <h3 className="text-[15px] font-semibold text-gray-900 mb-1">Change Department?</h3>
                <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">
                  The current status in <span className="font-semibold text-gray-800">{currentDepartment || 'Dev'}</span> will
                  first be set to <span className="font-semibold text-amber-600">Waiting for {pendingDept.name}</span>,
                  then the ticket will move to <span className="font-semibold text-blue-700">{pendingDept.name}</span>.
                </p>
                <div className="flex items-center justify-end gap-2 mt-5">
                  <button
                    onClick={() => setPendingDept(null)}
                    className="px-4 py-1.5 text-[13px] text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { const d = pendingDept; setPendingDept(null); changeDept(d); }}
                    className="px-4 py-1.5 text-[13px] font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Yes, Change Department
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showDrop && (
          <div className="absolute top-full left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-lg w-64 py-1 mt-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">
              Change Department
            </div>
            {deptOptions.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-gray-400 text-center">
                No departments configured.<br />
                <span className="text-[11px]">Add in Settings → Fields (Department Routing)</span>
              </div>
            ) : (
              deptOptions
                // Hide the department the ticket is currently in
                .filter(d => d.name.toUpperCase() !== (displayDept || '').toUpperCase())
                .map(d => {
                const isActive = d.name.toUpperCase() === (displayDept || '').toUpperCase();
                return (
                  <button
                    key={d.name}
                    onClick={() => {
                    setShowDrop(false);
                    if (onRequestDeptChange) {
                      onRequestDeptChange(d, () => changeDept(d));
                    } else {
                      setPendingDept(d);
                    }
                  }}
                    className={`w-full text-left px-3 py-2.5 text-[12.5px] hover:bg-gray-50 flex items-center gap-2 ${isActive ? 'text-blue-600 font-medium bg-blue-50/40' : 'text-gray-700'}`}
                  >
                    {isActive
                      ? <Check size={11} className="text-blue-600 flex-shrink-0" />
                      : <span className="w-[11px] flex-shrink-0" />}
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getDeptColor(d.name) }} />
                    <span className="flex-1">{d.name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== Sub-components ===== */

function PropRow({ label, children, pinned, onPin }: { label: string; children: React.ReactNode; pinned?: boolean; onPin?: () => void }) {
  return (
    <div className={`grid grid-cols-[100px_1fr] items-center min-h-[32px] py-1 border-b border-gray-100 last:border-0 group relative ${pinned ? 'bg-blue-50/40' : ''}`}>
      <div className="flex items-center gap-1 self-start pt-[7px]">
        <span className="text-[11px] font-medium text-gray-400 leading-none">{label}</span>
        {onPin && (
          <button
            onClick={onPin}
            title={pinned ? 'Unpin' : 'Pin field'}
            className={`flex-shrink-0 transition-all ${pinned ? 'text-blue-500' : 'opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-500'}`}
          >
            <Pin size={9} />
          </button>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Dropdown({ children, onClose, width = 'w-52', align = 'left-0' }: { children: React.ReactNode; onClose: () => void; width?: string; align?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    // Calculate position from parent button using fixed coords to escape overflow containers
    const parent = anchorRef.current?.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      const isRight = align === 'right-0';
      setPos({
        top: rect.bottom + 4,
        left: isRight ? rect.right - 224 : rect.left,
      });
    }
  }, [align]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.parentElement?.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  if (!pos) return <div ref={anchorRef} />;

  return (
    <>
      <div ref={anchorRef} />
      <div ref={ref}
        className={`fixed ${width} bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-[9999] max-h-72 overflow-y-auto`}
        style={{ top: pos.top, left: pos.left }}>
        {children}
      </div>
    </>
  );
}
