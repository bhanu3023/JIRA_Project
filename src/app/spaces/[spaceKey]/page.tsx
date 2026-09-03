'use client';

import { useEffect, useState, useRef, useCallback, useMemo, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { typeIcons, getInitials, getIssueStatus, getEffectiveIssueStatus, timeAgo, formatJiraDateTime, resolveStatusColor, getDeptColor, buildMentionHtml } from '@/lib/utils';
import CommentReactions from '@/components/ui/CommentReactions';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { trackRecentItem } from '@/lib/recent-items';
import { PriorityIcon, getPriorityMeta, PRIORITIES } from '@/components/ui/PriorityIcon';
import SpaceIcon from '@/components/ui/SpaceIcon';
import DotLoader from '@/components/ui/DotLoader';
import RichTextEditor from '@/components/ui/RichTextEditor';
import {
  LayoutGrid, Settings, ChevronDown, Check, User, Users,
  Search, CheckCircle2, ClipboardList, X, Tag, Calendar, UserCheck,
  Briefcase, Package, Layers, Monitor, Clock, AlertCircle, Building2, SlidersHorizontal, RefreshCw, BarChart2,
  ChevronRight, Inbox as InboxIcon, AlertTriangle, Trophy, PieChart
} from 'lucide-react';

// ── Addable filter field definitions ─────────────────────────────────────────
const ADDABLE_FILTER_DEFS = [
  { id: 'workType',         label: 'Work Type',         icon: 'briefcase' },
  { id: 'productType',      label: 'Product Type',      icon: 'package'   },
  { id: 'combination',      label: 'Combination',       icon: 'layers'    },
  { id: 'testEnvironment',  label: 'Test Environment',  icon: 'monitor'   },
  { id: 'updated',          label: 'Updated',           icon: 'calendar'  },
  { id: 'dueDate',          label: 'Due Date',          icon: 'clock'     },
  { id: 'rootCause',        label: 'Root Cause',        icon: 'alert'     },
  { id: 'fixDescription',   label: 'Fix Description',   icon: 'alert'     },
  { id: 'customerName',     label: 'Customer Name',     icon: 'building'  },
  { id: 'clientName',       label: 'Client Name',       icon: 'building'  },
  { id: 'projectManager',   label: 'Project Manager',   icon: 'briefcase' },
  { id: 'manageClientName', label: 'Manage Client Name',icon: 'building'  },
  { id: 'customerPlan',     label: 'Customer Plan',     icon: 'layers'    },
] as const;

function AddableIcon({ icon, size = 12 }: { icon: string; size?: number }) {
  const cls = `flex-shrink-0 text-gray-500`;
  if (icon === 'briefcase') return <Briefcase size={size} className={cls} />;
  if (icon === 'package')   return <Package   size={size} className={cls} />;
  if (icon === 'layers')    return <Layers    size={size} className={cls} />;
  if (icon === 'monitor')   return <Monitor   size={size} className={cls} />;
  if (icon === 'calendar')  return <Calendar  size={size} className={cls} />;
  if (icon === 'clock')     return <Clock     size={size} className={cls} />;
  if (icon === 'alert')     return <AlertCircle size={size} className={cls} />;
  if (icon === 'building')  return <Building2  size={size} className={cls} />;
  return null;
}
import CreateIssueModal from '@/components/issues/CreateIssueModal';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500',
  'bg-rose-500',  'bg-teal-500',  'bg-indigo-500','bg-amber-500',
  'bg-cyan-500',  'bg-pink-500',  'bg-lime-600',  'bg-sky-500',
];
function avatarColor(name?: string) {
  const code = (name || '').charCodeAt(0) || 0;
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}

function InlineDropdown({ children, onClose, anchorRect, triggerRef, width }: {
  children: React.ReactNode;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  triggerRef?: React.RefObject<HTMLElement>;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Resolve position: use anchorRect if given, else read triggerRef, else fallback
  const [pos, setPos] = useState<{ top: number; left: number; transform: string } | null>(null);

  useEffect(() => {
    const rect = anchorRect ?? triggerRef?.current?.getBoundingClientRect() ?? null;
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow < 260 ? rect.top - 4 : rect.bottom + 4;
      const transform = spaceBelow < 260 ? 'translateY(-100%)' : 'none';
      setPos({ top, left: rect.left, transform });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (!pos) return null;
  return (
    <div ref={ref}
      className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200 py-1 max-h-80 overflow-hidden flex flex-col"
      style={{ top: pos.top, left: pos.left, transform: pos.transform, minWidth: width ?? 180 }}>
      {children}
    </div>
  );
}

function SpaceDetailContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const queueFilter = searchParams?.get('queue') || 'queues';
  const deptParam = searchParams?.get('dept') || '';
  // Set when an admin clicks a name in the per-queue Summary's "Per user"
  // table -- points the "Worked on" (dept_closed) view at that person's
  // tickets instead of the viewer's own.
  const viewUserParam = searchParams?.get('viewUser') || '';
  const viewUserNameParam = searchParams?.get('viewUserName') || '';
  const rawKey = params?.spaceKey;
  const spaceKey =
    typeof rawKey === 'string'
      ? rawKey.toUpperCase()
      : Array.isArray(rawKey)
        ? (rawKey[0] || '').toUpperCase()
        : '';
  const { currentSpace, currentSpaceError, loadSpace, issues, issueTotal, loadIssues, prefetchIssues, clearIssuesCache, loading, user, issuesVersion, bumpIssuesVersion } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      currentSpaceError: s.currentSpaceError,
      loadSpace: s.loadSpace,
      issues: s.issues,
      issueTotal: s.issueTotal,
      loadIssues: s.loadIssues,
      prefetchIssues: s.prefetchIssues,
      clearIssuesCache: s.clearIssuesCache,
      loading: s.loading,
      user: s.user,
      issuesVersion: s.issuesVersion,
      bumpIssuesVersion: s.bumpIssuesVersion,
    })),
  );
  // Declared this early (rather than down near the access-check block) because
  // an effect above the early-return spinner closes over it -- if it stayed
  // below those early returns, a render that bails out early would never run
  // its own initializer, and the deferred effect callback from that render
  // would hit the TDZ ("Cannot access 'isAdmin' before initialization").
  const isAdmin = user?.role === 'admin';
  // "Worked on" opened directly from the sidebar (no explicit ?viewUser=)
  // was showing every Dev queue member's worked tickets mixed together --
  // Assignee column jumping between different people on a screen someone
  // expects to be "my own worked tickets". Default it to the viewer's own
  // id; only the admin-only per-user drill-down (see viewUserParam's own
  // comment above) should ever show someone else's.
  const effectiveViewUserParam = viewUserParam || user?.id || '';
  // Static column definitions (always available)
  const STATIC_COLUMNS = [
    { id: 'reporter',       label: 'Reporter',            width: '150px' },
    { id: 'assignee',       label: 'Assignee',            width: '150px' },
    { id: 'priority',       label: 'Priority',            width: '120px' },
    { id: 'status',         label: 'Status',              width: '165px' },
    { id: 'created',        label: 'Created',             width: '150px' },
    { id: 'updated',        label: 'Updated',             width: '150px' },
    { id: 'dueDate',        label: 'Due Date',            width: '120px' },
    { id: 'breached',       label: 'Breached',            width: '90px'  },
    { id: 'labels',         label: 'Labels',              width: '130px' },
    { id: 'storyPoints',    label: 'Story Points',        width: '90px'  },
    { id: 'workType',       label: 'Work Type',           width: '130px' },
    { id: 'productType',    label: 'Product Type',        width: '130px' },
    { id: 'combination',    label: 'Combination',         width: '130px' },
    { id: 'customerName',   label: 'Customer Name',       width: '140px' },
    { id: 'clientName',     label: 'Client Name',         width: '130px' },
    { id: 'projectManager', label: 'Project Manager',     width: '140px' },
    { id: 'rootCause',      label: 'Root Cause',          width: '150px' },
    { id: 'fixDescription', label: 'Fix Description',     width: '150px' },
    { id: 'environment',    label: 'Environment',         width: '120px' },
    { id: 'resolvedAt',     label: 'Resolved At',         width: '150px' },
    { id: 'department',     label: 'Department',          width: '130px' },
  ];
  const DEFAULT_COLS = ['reporter','assignee','priority','status','created'];

  const [showCreate, setShowCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Component-local fetch state — never gets stuck because cleanup always resets it
  const [isFetching, setIsFetching] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  const [closedIssues, setClosedIssues] = useState<any[]>([]);
  const fetchClosedIssues = useCallback(async (sk: string, dept: string, viewUser?: string) => {
    if (!sk || !dept) return;
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') : null;
      const res = await fetch(
        `/api/spaces/${sk}/dept-queue/closed?dept=${encodeURIComponent(dept)}&page=1${viewUser ? `&viewUser=${encodeURIComponent(viewUser)}` : ''}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (res.ok) {
        const data = await res.json();
        setClosedIssues(data.issues || []);
      }
    } catch { /* non-fatal */ }
  }, []);
  // Per-queue Summary (admin-only) -- range-aware status/priority/SLA
  // breakdown plus a per-user "tickets worked" table, computed server-side
  // rather than client-side from whatever's in `issues` (which is capped at
  // 200 and not range-aware), since this needs to be accurate for a whole
  // team, not just whatever happens to already be loaded.
  const [summaryRange, setSummaryRange] = useState<string>('all');
  const [deptSummaryData, setDeptSummaryData] = useState<any>(null);
  const [deptSummaryLoading, setDeptSummaryLoading] = useState(false);
  const [deptSummaryError, setDeptSummaryError] = useState<string | null>(null);
  useEffect(() => {
    if (queueFilter !== 'summary' || !deptParam || !spaceKey || !isAdmin) { setDeptSummaryData(null); return; }
    let cancelled = false;
    setDeptSummaryLoading(true);
    setDeptSummaryError(null);
    (async () => {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') : null;
        const res = await fetch(
          `/api/spaces/${spaceKey}/dept-queue/summary?dept=${encodeURIComponent(deptParam)}&range=${encodeURIComponent(summaryRange)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} }
        );
        if (cancelled) return;
        const data = await res.json();
        if (!res.ok) { setDeptSummaryError(data.error || 'Failed to load summary'); setDeptSummaryData(null); return; }
        setDeptSummaryData(data);
      } catch {
        if (!cancelled) setDeptSummaryError('Failed to load summary');
      } finally {
        if (!cancelled) setDeptSummaryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [queueFilter, deptParam, spaceKey, summaryRange, isAdmin]);
  const [deptFilter, setDeptFilter] = useState<string>(''); // '' = all departments
  const [allCustomQueues, setAllCustomQueues] = useState<{ id: string; name: string; memberIds: string[] }[]>([]);
  // Track which spaceKey the queues were loaded for — avoids stale-spaceKey race condition
  const [customQueuesLoadedFor, setCustomQueuesLoadedFor] = useState<string>('');
  // True while waiting for custom-queue metadata (prevents "No issues found" flash before queues load)
  const isQueuesLoading = queueFilter.startsWith('cq_') && customQueuesLoadedFor !== spaceKey;
  useEffect(() => {
    if (!spaceKey) return;
    // Reset loaded marker immediately (synchronous — blocks issues effect until fresh queues arrive)
    setCustomQueuesLoadedFor('');
    // Pre-populate from localStorage so the correct queue is known before the API resolves
    try {
      const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
      if (stored) {
        setAllCustomQueues(JSON.parse(stored));
        setCustomQueuesLoadedFor(spaceKey); // localStorage is fast enough — mark ready immediately
      }
    } catch {}
    api.request<any[]>(`custom-queues/${spaceKey}`).then((q) => {
      if (Array.isArray(q)) {
        setAllCustomQueues(q);
        try { localStorage.setItem(`custom_queues_${spaceKey}`, JSON.stringify(q)); } catch {}
      }
      setCustomQueuesLoadedFor(spaceKey);
    }).catch(() => { setCustomQueuesLoadedFor(spaceKey); });
  }, [spaceKey]);

  // A plain board with no custom queues to pick from has no use for the
  // "Queues" landing page, so landing on the bare board URL (no ?queue=)
  // showed a dead-end "Select a queue... No queues available" page instead
  // of any tickets — while the sidebar still highlighted "All Tickets" as
  // active, since it defaults the missing param to 'all-open', not 'queues'.
  // Once we actually know (custom queues fetched + space loaded) that this
  // board has none, redirect straight to the tickets list instead of the
  // queue-picker landing page.
  //
  // Used to gate the wait-for-queues check on currentSpace?.type ===
  // 'dept_queue' (skip waiting and redirect immediately for anything else,
  // on the theory that only a dept_queue-typed space can have custom queues
  // configured) -- confirmed false for real: TESTIN ("CloudFuze Board") is
  // stored as type 'service_desk' but has 4 genuinely configured department
  // queues (Migration/Dev/QA/Infra), so every visit to its bare board URL
  // skipped the wait and redirected straight past this landing page to the
  // generic "All Tickets" list, which is exactly the messy board-wide status
  // list (every legacy status ever imported, mixed departments) this
  // landing page exists to avoid. allCustomQueues.length > 0 is the actual
  // signal that matters -- already used that way by the "queues" page's own
  // render check just below (isDeptQueue) -- so wait for the fetch and use
  // the same check here regardless of the space's stored type.
  useEffect(() => {
    if (!spaceKey || queueFilter !== 'queues') return;
    if (currentSpace?.key !== spaceKey) return;
    if (customQueuesLoadedFor !== spaceKey) return;
    if (allCustomQueues.length > 0) return;
    router.replace(`/spaces/${spaceKey}?queue=all-open`);
  }, [spaceKey, queueFilter, customQueuesLoadedFor, currentSpace?.key, allCustomQueues.length, router]);

  // Extract stable primitives from the matched queue so activeCustomQueue only gets a new
  // reference when the queue's id or name actually changes — not every time allCustomQueues
  // gets a new array reference (e.g. localStorage load → API response with same data).
  const _rawMatch = queueFilter.startsWith('cq_') ? allCustomQueues.find(q => q.id === queueFilter) : undefined;
  const _matchId   = _rawMatch?.id   ?? null;
  const _matchName = _rawMatch?.name ?? null;
  const _matchMembers = JSON.stringify(_rawMatch?.memberIds ?? null);
  const activeCustomQueue = useMemo(() => {
    if (!_matchId) return null;
    return { id: _matchId, name: _matchName ?? '', memberIds: JSON.parse(_matchMembers) ?? [] };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_matchId, _matchName, _matchMembers]);
  const [rrDepartments, setRrDepartments] = useState<string[]>([]); // from RR config

  // Load departments from both RR config + Department Routing custom fields, and
  // derive this space's dynamic custom-field columns from the same custom-fields
  // response — these used to be two separate effects that each independently
  // fetched the exact same (space-agnostic) GET /custom-fields list, doubling
  // that call on every board load for no reason since it's the same data either
  // way. Gated on currentSpace.id too now (not just spaceKey) since the column
  // computation needs it to filter fields by spaceIds.
  useEffect(() => {
    if (!spaceKey || !currentSpace?.id) return;
    const spaceId = currentSpace.id;
    const combined: string[] = [];

    // Routed through api.request so identical concurrent calls (e.g. the sidebar
    // fetching the same space's rr-config) are coalesced into one network call.
    Promise.allSettled([
      api.request<any>(`spaces/${spaceKey}/rr-config`).catch(() => null),
      api.request<any>(`custom-fields`).catch(() => null),
    ]).then(([rrRes, cfRes]) => {
      // 1. Department Routing custom fields (options: "DeptName|boardKey|employees")
      if (cfRes.status === 'fulfilled' && cfRes.value) {
        const fields: any[] = cfRes.value?.fields || cfRes.value || [];
        const deptFields = fields.filter((f: any) => f.fieldType === 'department-routing' || f.type === 'Department Routing');
        for (const field of deptFields) {
          for (const opt of (field.options || [])) {
            const deptName = String(opt).split('|')[0]?.trim();
            if (deptName && !combined.find(x => x.toUpperCase() === deptName.toUpperCase())) {
              combined.push(deptName);
            }
          }
        }

        // Dynamic columns for this space (previously its own effect + fetch)
        const spaceFields = fields.filter((f: any) =>
          !f.isDeleted &&
          f.source !== 'system' &&
          Array.isArray(f.spaceIds) &&
          f.spaceIds.includes(spaceId)
        );
        // Disambiguate custom fields whose name collides with a system column (or each
        // other) so the table header never shows the same label twice with no way to
        // tell which is which.
        const staticLabels = new Set(STATIC_COLUMNS.map(c => c.label.toLowerCase()));
        const seenLabels = new Set<string>();
        setCustomFieldCols(spaceFields.map((f: any) => {
          const baseLabel = String(f.name);
          const key = baseLabel.toLowerCase();
          const label = (staticLabels.has(key) || seenLabels.has(key)) ? `${baseLabel} (Field)` : baseLabel;
          seenLabels.add(key);
          return { id: `cf_${f.id}`, label, width: '110px', fieldId: f.id };
        }));
      }
      // 2. RR config — add any not already in list
      if (rrRes.status === 'fulfilled' && rrRes.value?.config?.departments?.length) {
        const sorted = [...rrRes.value.config.departments].sort((a: any, b: any) => a.order - b.order);
        for (const d of sorted) {
          if (!combined.find(x => x.toUpperCase() === d.name.toUpperCase())) combined.push(d.name);
        }
      }
      if (combined.length) setRrDepartments(combined);
    }).catch(() => {});
  }, [spaceKey, currentSpace?.id]);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  // Clear selection whenever the issues list reloads (filter/page change)
  const prevIssueIdsRef = useRef<string>('');
  useEffect(() => {
    const ids = issues.map(i => i.id).sort().join(',');
    if (ids !== prevIssueIdsRef.current) {
      prevIssueIdsRef.current = ids;
      setSelectedRows(new Set());
    }
  }, [issues]);

  const [openDropdown, setOpenDropdown] = useState<{ key: string; field: 'status' | 'priority' | 'assignee'; rect: DOMRect } | null>(null);
  const [inlineAssigneeSearch, setInlineAssigneeSearch] = useState('');
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('type');
  const [dropdownSearch, setDropdownSearch] = useState<string>('');
  const [filterCatSearch, setFilterCatSearch] = useState<string>('');
  const colsStorageKey    = `visibleCols_${spaceKey}`;

  const [addFilterDropPos, setAddFilterDropPos] = useState<{ top: number; left: number } | null>(null);
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_COLS);
  const [serverFieldOptions, setServerFieldOptions] = useState<Record<string, string[]>>({});
  // Tracks field-value fetches currently in flight, keyed the same way as
  // serverFieldOptions -- separate from that state because the effect below
  // only sees serverFieldOptions AFTER a fetch has actually resolved, so two
  // renders close together (e.g. effectiveDept settling right after mount)
  // both read it as empty and both fire the same 11 requests, doubling every
  // queue-open's request burst for no reason. This ref is set synchronously
  // the instant a fetch starts, so the second render's loop sees it and
  // skips, not just the render after the response comes back.
  const fieldValuesInFlight = useRef<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string | null>(null);
  // Safety net: a row dims (opacity-50) while `updating` names its key, cleared
  // in the `finally` of whatever inline edit set it. If that edit's request
  // hangs on something outside normal success/failure (a dropped connection,
  // a browser tab going to sleep mid-request, etc.) the row would stay dimmed
  // indefinitely with no way to clear itself short of a full page reload.
  // Force it back to normal a few seconds after any edit starts, regardless.
  useEffect(() => {
    if (!updating) return;
    const t = setTimeout(() => setUpdating(null), 6000);
    return () => clearTimeout(t);
  }, [updating]);
  const [assigneeRequiredModal, setAssigneeRequiredModal] = useState(false);
  const [missingFieldsModal, setMissingFieldsModal] = useState<string[] | null>(null);
  // Same mandatory-before-resolve rule as the issue detail page's
  // getMissingCoreFields -- duplicated here because this row's inline status
  // dropdown lets a ticket be resolved directly from the list view without
  // ever opening the detail page, which was bypassing that check entirely.
  const getMissingCoreFieldsInline = (iss: any): string[] => {
    const missing: string[] = [];
    const required: { name: string; key: string }[] = [
      { name: 'Project Manager', key: 'projectManager' },
      { name: 'Product Type', key: 'productType' },
      { name: 'Combination', key: 'combination' },
    ];
    if (String(iss.current_department || '').toLowerCase() === 'dev') {
      required.push({ name: 'Root Cause', key: 'rootCause' }, { name: 'Fix Description', key: 'fixDescription' });
    }
    for (const f of required) {
      const val = iss[f.key];
      if (!val || String(val).trim() === '') missing.push(f.name);
    }
    return missing;
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  // Queue types with real pagination (fetch currentPage/PAGE_SIZE and trust the
  // backend's total) rather than a one-shot fixed-size fetch — a whole
  // department's open tickets can run into the thousands, same as All Requests
  // and custom queues.
  const isPaginatedQueue = queueFilter === 'all-requests' || queueFilter.startsWith('cq_')
    || queueFilter === 'dept_all' || queueFilter === 'dept_unassigned' || queueFilter === 'dept_assigned';
  // Reset to page 1 when queue changes (including switching departments within
  // the same dept_all/dept_unassigned/dept_assigned queue type)
  useEffect(() => { setCurrentPage(1); }, [queueFilter, deptParam]);

  // Immediately clear stale issues when the queue changes so old tickets never
  // flash while the new fetch is in flight (handles early-return guard cases too)
  useEffect(() => {
    if (queueFilter && queueFilter !== 'queues') {
      useStore.setState({ issues: [], issueTotal: 0 });
    }
  }, [queueFilter]);

  // Fetch distinct values from server for every field filter. Scoped to the
  // currently-viewed department when there is one — without this, a filter's options
  // came from the WHOLE space regardless of which queue you were looking at, so you
  // could pick e.g. a Product Type value that no ticket in "Dev" has ever had, and
  // the filter would correctly (but confusingly) always return zero results. Cache
  // key includes the department so switching queues re-fetches instead of reusing
  // another department's (or the space-wide) option list.
  const effectiveDept = queueFilter.startsWith('cq_') ? (activeCustomQueue?.name || '') : deptParam;
  useEffect(() => {
    if (!spaceKey) return;
    const textFields = new Set(['workType','productType','combination','testEnvironment','rootCause',
      'fixDescription','customerName','clientName','projectManager','manageClientName','customerPlan']);
    ADDABLE_FILTER_DEFS.forEach(({ id: fieldId }) => {
      if (!textFields.has(fieldId)) return;
      const cacheKey = `${fieldId}::${effectiveDept}`;
      if (serverFieldOptions[cacheKey]) return; // already loaded
      if (fieldValuesInFlight.current.has(cacheKey)) return; // already fetching
      fieldValuesInFlight.current.add(cacheKey);
      const deptQuery = effectiveDept ? `&dept=${encodeURIComponent(effectiveDept)}` : '';
      fetch(`/api/spaces/${spaceKey}/field-values?field=${fieldId}${deptQuery}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('jira_token') || ''}` },
      })
        .then(r => r.ok ? r.json() : [])
        .then((vals: string[]) => {
          setServerFieldOptions(prev => ({ ...prev, [cacheKey]: vals }));
        })
        .catch(() => {})
        .finally(() => { fieldValuesInFlight.current.delete(cacheKey); });
    });
  }, [spaceKey, effectiveDept]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted columns once spaceKey is known
  useEffect(() => {
    if (!spaceKey) return;
    try {
      const savedCols = localStorage.getItem(`visibleCols_${spaceKey}`);
      if (savedCols) {
        const parsed = JSON.parse(savedCols) as string[];
        // One-time migration: previously Reporter was saved before Assignee — swap
        // only if that old order is still present, so this doesn't re-flip on reload.
        const ai = parsed.indexOf('assignee');
        const ri = parsed.indexOf('reporter');
        if (ai !== -1 && ri !== -1 && ri < ai) [parsed[ai], parsed[ri]] = [parsed[ri], parsed[ai]];
        setVisibleCols(parsed);
      }
    } catch {}
  }, [spaceKey]);

  // Persist visible columns to localStorage
  useEffect(() => {
    if (!spaceKey) return;
    try { localStorage.setItem(colsStorageKey, JSON.stringify(visibleCols)); } catch {}
  }, [visibleCols, colsStorageKey, spaceKey]);

  // Dynamic custom-field columns for this space
  const [customFieldCols, setCustomFieldCols] = useState<Array<{ id: string; label: string; width: string; fieldId: string }>>([]);
  const [cfValuesMap, setCfValuesMap] = useState<Map<string, Record<string, string>>>(new Map());
  const [slaPolicies, setSlaPolicies] = useState<any[]>([]);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const [reporterSearch, setReporterSearch] = useState('');

  // Refs for filter trigger buttons (needed for fixed-position dropdowns inside overflow container)
  const typeFilterRef      = useRef<HTMLButtonElement>(null);
  const statusFilterRef    = useRef<HTMLButtonElement>(null);
  const priorityFilterRef  = useRef<HTMLButtonElement>(null);
  const labelFilterRef     = useRef<HTMLButtonElement>(null);
  const createdFilterRef   = useRef<HTMLButtonElement>(null);
  const columnsFilterRef   = useRef<HTMLButtonElement>(null);
  const assigneeFilterRef  = useRef<HTMLButtonElement>(null);
  const reporterFilterRef  = useRef<HTMLButtonElement>(null);
  const addFilterRef       = useRef<HTMLButtonElement>(null);
  // Fixed-position coords for Assignee / Reporter (full-panel dropdowns)
  const [assigneeDropPos, setAssigneeDropPos] = useState<{ top: number; left: number } | null>(null);
  const [reporterDropPos, setReporterDropPos] = useState<{ top: number; left: number } | null>(null);
  const [statusDropPos, setStatusDropPos] = useState<{ top: number; left: number } | null>(null);
  const [typeDropPos, setTypeDropPos] = useState<{ top: number; left: number } | null>(null);

  // Combined columns: static + any custom fields assigned to this space
  const ALL_COLUMNS = [...STATIC_COLUMNS, ...customFieldCols];

  const toggleCol = (id: string) =>
    setVisibleCols(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);

  // Filtering by one of the "More filters" fields (Product Type, Combination,
  // Root Cause, etc.) and seeing that field's column in the table were two
  // completely disconnected actions -- picking a value there never made its
  // column visible, so the table kept showing the same default columns
  // regardless of what you'd just filtered by. Right after Status, not
  // appended at the end, so a newly-filtered field reads next to the field
  // most people scan first rather than getting lost off to the right.
  const ensureColumnAfterStatus = (id: string) => {
    setVisibleCols(prev => {
      if (prev.includes(id)) return prev;
      const statusIdx = prev.indexOf('status');
      if (statusIdx === -1) return [...prev, id];
      const next = [...prev];
      next.splice(statusIdx + 1, 0, id);
      return next;
    });
  };

  // Build dynamic grid template: checkbox + type + key + summary + visible optional cols
  // Preserve the order columns were added (visibleCols order), not STATIC_COLUMNS order
  const orderedVisibleCols = visibleCols
    .map(id => ALL_COLUMNS.find(c => c.id === id))
    .filter(Boolean) as typeof ALL_COLUMNS;

  // Use minmax so summary never shrinks below 220px when extra columns are added
  const gridCols = ['36px', '34px', '110px', 'minmax(220px, 1fr)',
    ...orderedVisibleCols.map(c => c.width)
  ].join(' ');

  // Dynamically compute min table width: fixed cols + all visible col widths + padding
  const tableMinWidth = 36 + 34 + 110 + 220 +
    orderedVisibleCols.reduce((sum, c) => sum + parseInt(c.width), 0) + 32;

  // Always load space metadata (needed for breadcrumb etc.)
  useEffect(() => {
    if (!spaceKey) return;
    loadSpace(spaceKey);
  }, [spaceKey, loadSpace]);

  // loadSpace no longer rejects on failure (it sets currentSpaceError in the
  // store instead, so a slow/failed fetch doesn't leave every OTHER caller
  // silently swallowing a rejection with no visible state change) -- redirect
  // here instead, on the error actually appearing, so a space that 404s or
  // times out still lands back on the spaces list instead of spinning on the
  // "Loading space..." screen forever with nothing to ever break out of it.
  useEffect(() => {
    if (currentSpaceError) router.replace('/spaces');
  }, [currentSpaceError, router]);

  useEffect(() => {
    if (!spaceKey || queueFilter === 'queues') return;
    // For custom queues, wait until allCustomQueues has loaded so activeCustomQueue is resolved
    if (queueFilter.startsWith('cq_') && customQueuesLoadedFor !== spaceKey) return;
    // If queue ID is known but can't be resolved to a queue object, don't load without dept filter
    if (queueFilter.startsWith('cq_') && !activeCustomQueue) return;
    let cancelled = false;
    setLoadError(null);
    setIsFetching(true);
    (async () => {
      try {
        if (cancelled) return;
        // Build API params — push filters server-side so large boards (e.g. L2B 12k+) work correctly
        const params: Record<string, string> = { spaceKey };
        if (queueFilter === 'all-requests' || queueFilter.startsWith('cq_')) {
          // Paginated views — show all tickets (no excludeDone), use page navigation
          params.page  = String(currentPage);
          params.limit = String(PAGE_SIZE);
          // Custom queue — filter by current_department matching queue name
          if (queueFilter.startsWith('cq_') && activeCustomQueue?.name) {
            params.dept = activeCustomQueue.name;
          }
        } else {
          params.page  = '1';
          params.limit = '100';
          // Exclude done issues at DB level for open queues. "all-open" is
          // deliberately NOT here — renamed to "All Tickets" in the sidebar, it
          // now shows every ticket in the space regardless of status.
          if (queueFilter === 'assigned' || queueFilter === 'unassigned' || queueFilter === 'my-dept' || queueFilter === 'my-queue') {
            params.excludeDone = 'true';
          }
          // Closed tickets (service_desk boards) — the inverse of "All Tickets": only
          // resolved/done tickets. This used to link to all-requests, which has no
          // status filtering at all, so open tickets showed up under "Closed tickets".
          if (queueFilter === 'closed') {
            params.statusCategory = 'done';
          }
          // Unassigned queue — pass unassigned flag; dept-scoped users get filtered by dept
          if (queueFilter === 'unassigned') {
            params.unassigned = 'true';
            if (deptParam) params.dept = deptParam;
          }
          // Sent/Watching — show all tickets that moved OUT of this dept (no reporter filter)
          if (queueFilter === 'sent-watching') {
            params.limit = '100';
            if (deptParam) params.sentDept = deptParam;
          }
          // Dept sub-queue: all open tickets in dept (any assignee) — a whole
          // department's open tickets can run into the thousands (unlike the
          // personal views above), so this needs real pagination instead of the
          // fixed page 1 / 100-row cap every other branch here uses, or anything
          // past the first 100 is silently unreachable.
          if (queueFilter === 'dept_all') {
            // Deliberately NOT excludeDone -- same "All Tickets" convention
            // already used space-wide (see the all-open comment above): the
            // literal "All Tickets — {dept}" label should mean all of them,
            // not just the still-open ones. A migrated department where 99%
            // of tickets are already Resolved/Closed was showing a single-
            // digit count here and nowhere obvious to see the rest.
            params.page = String(currentPage);
            params.limit = String(PAGE_SIZE);
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: unassigned in dept
          if (queueFilter === 'dept_unassigned') {
            params.unassigned = 'true';
            params.excludeDone = 'true';
            params.page = String(currentPage);
            params.limit = String(PAGE_SIZE);
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: assigned to me in dept — strictly current and
          // still-open. A ticket leaves this list the moment it's resolved
          // (it belongs in "Worked on" instead, see dept_closed) or handed
          // to another department (it belongs in "Sent / Watching" instead).
          // Used to also pass includeHistory to keep resolved/moved tickets
          // showing here too — dropped since that meant a resolved ticket
          // could show under BOTH "Assigned to me" and "Worked on" at once.
          if (queueFilter === 'dept_assigned') {
            if (user?.id) params.assignee = user.id;
            params.excludeDone = 'true';
            params.page = String(currentPage);
            params.limit = String(PAGE_SIZE);
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: closed tickets — fetched separately, auto-refreshed every 30s
          if (queueFilter === 'dept_closed') {
            if (!cancelled) await fetchClosedIssues(spaceKey, deptParam, effectiveViewUserParam);
            return; // skip normal loadIssues for closed view
          }
          // Summary opened from inside a specific queue (sidebar's per-queue
          // "Summary" link) has its own dedicated, range-aware endpoint and
          // effect (deptSummaryData) instead of this generic issue list --
          // skip the fetch here entirely either way.
          if (queueFilter === 'summary' && deptParam) {
            return;
          }
        }
        // Pass active filters to the API so server handles them (large boards like L2B)
        if (filters.status)   params.status   = filters.status;
        if (filters.type)     params.type     = filters.type;
        if (filters.priority) params.priority = filters.priority;
        if (filters.label)    params.labels   = filters.label;
        if (filters.created)  params.createdRange = filters.created;
        if (filters.assignee) {
          if (filters.assignee === '__unassigned') {
            params.unassigned = 'true';
          } else if (filters.assignee === '__current') {
            if (user?.id) params.assignee = user.id;
          } else {
            params.assignee = filters.assignee;
          }
        }
        if (filters.reporter) {
          if (filters.reporter === '__current') {
            if (user?.id) params.reporter = user.id;
          } else {
            params.reporter = filters.reporter;
          }
        }
        if (debouncedSearch)  params.q        = debouncedSearch;
        // Custom field filters — pass to API so server filters across ALL issues
        if (filters.combination)      params.combination      = filters.combination;
        if (filters.productType)      params.productType      = filters.productType;
        if (filters.workType)         params.workType         = filters.workType;
        if (filters.testEnvironment)  params.testEnvironment  = filters.testEnvironment;
        if (filters.rootCause)        params.rootCause        = filters.rootCause;
        if (filters.fixDescription)   params.fixDescription   = filters.fixDescription;
        if (filters.customerName)     params.customerName     = filters.customerName;
        if (filters.clientName)       params.clientName       = filters.clientName;
        if (filters.projectManager)   params.projectManager   = filters.projectManager;
        if (filters.manageClientName) params.manageClientName = filters.manageClientName;
        if (filters.customerPlan)     params.customerPlan     = filters.customerPlan;
        // NOTE: previously cleared this exact param set's cache here before every load,
        // which defeated prefetching entirely — every queue switch (esp. custom queues)
        // was forced into a full network round-trip even when the data was already warm.
        // The store's activeQueueKey guard already prevents a slow in-flight fetch from
        // overwriting the display once the user has switched away, so no clear is needed.
        await loadIssues(params);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load space');
      } finally {
        if (!cancelled) setIsFetching(false);
      }
    })();
    return () => { cancelled = true; setIsFetching(false); };
  }, [spaceKey, currentPage, queueFilter, deptParam, effectiveViewUserParam, activeCustomQueue, customQueuesLoadedFor, filters, debouncedSearch, loadSpace, loadIssues, clearIssuesCache, fetchClosedIssues, user?.id, issuesVersion]);

  // Auto-refresh Sent/Watching every 15s — silent background refresh, never clears display
  useEffect(() => {
    if (queueFilter !== 'sent-watching' || !spaceKey || !deptParam) return;
    const interval = setInterval(() => {
      const params: Record<string, string> = { spaceKey, page: '1', limit: '100', sentDept: deptParam };
      prefetchIssues(params).catch(() => {});
    }, 15_000);
    return () => clearInterval(interval);
  }, [queueFilter, spaceKey, deptParam, prefetchIssues]);

  // Deliberately NOT prefetching all-open/assigned/unassigned/my-queue/all-requests here
  // either — same reasoning as above. This fired 5 more background API calls the moment
  // the space loaded, regardless of which (if any) of those views the user was about to
  // open.

  // Deliberately NOT prefetching every custom queue here. This used to warm the cache
  // for every queue on the board as soon as it loaded (2 requests each — a dept-scoped
  // list plus Sent/Watching), which meant opening a board with, say, 8 queues fired 16+
  // background API calls whether or not you ever looked at most of them, plus 2 more per
  // sidebar sub-item Next.js prefetched on hover/viewport. A queue's data should only be
  // fetched when someone actually opens it — that's what the main load effect below
  // already does the moment queueFilter/deptParam changes.

  // Auto-refresh every 15s for all dept_queue spaces — silent background refresh, never clears display
  useEffect(() => {
    const isDeptQueue = currentSpace?.type === 'dept_queue' || allCustomQueues.length > 0;
    if (!isDeptQueue) return;
    if (queueFilter === 'dept_closed') return; // handled by its own interval below
    const id = setInterval(() => {
      const params: Record<string, string> = { spaceKey };
      if (queueFilter.startsWith('cq_') && activeCustomQueue?.name) {
        params.dept = activeCustomQueue.name;
        params.page = String(currentPage);
        params.limit = '50';
      } else if (queueFilter.startsWith('cq_')) {
        return;
      } else if (queueFilter === 'all-requests') {
        params.page = String(currentPage);
        params.limit = '50';
      } else if (queueFilter === 'sent-watching') {
        params.page = '1';
        params.limit = '100';
        if (deptParam) params.sentDept = deptParam;
      } else if (queueFilter && queueFilter !== 'queues') {
        params.queue = queueFilter;
        if (deptParam) params.dept = deptParam;
      }
      prefetchIssues(params).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [spaceKey, queueFilter, deptParam, currentPage, activeCustomQueue, currentSpace?.type, allCustomQueues.length, prefetchIssues]);

  // Auto-refresh Worked on (dept_closed) every 30s
  useEffect(() => {
    if (queueFilter !== 'dept_closed' || !spaceKey || !deptParam) return;
    const id = setInterval(() => {
      fetchClosedIssues(spaceKey, deptParam, effectiveViewUserParam);
    }, 30_000);
    return () => clearInterval(id);
  }, [queueFilter, spaceKey, deptParam, effectiveViewUserParam, fetchClosedIssues]);

  // Auto-refresh every 30s for regular (non-dept-queue) spaces — silent background refresh, never clears display
  useEffect(() => {
    const isDeptQueue = currentSpace?.type === 'dept_queue' || allCustomQueues.length > 0;
    if (isDeptQueue) return; // dept_queue spaces already handled above
    if (!spaceKey || !queueFilter || queueFilter === 'queues' || queueFilter === 'summary') return;
    const id = setInterval(() => {
      const params: Record<string, string> = { spaceKey, page: String(currentPage), limit: '100' };
      if (queueFilter === 'assigned' || queueFilter === 'unassigned' || queueFilter === 'my-queue') params.excludeDone = 'true';
      if (queueFilter === 'unassigned') params.unassigned = 'true';
      if (queueFilter === 'assigned' && user?.id) params.assignee = user.id;
      if (queueFilter === 'closed') params.statusCategory = 'done';
      if (queueFilter === 'all-requests') params.limit = '50';
      prefetchIssues(params).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [spaceKey, queueFilter, currentPage, currentSpace?.type, allCustomQueues.length, user?.id, prefetchIssues]);

  // Custom-field columns are now derived in the RR-departments effect above,
  // from the same GET /custom-fields response instead of a second fetch.

  // Load SLA policies for this space (used to compute SLA field values inline)
  useEffect(() => {
    if (!spaceKey) return;
    api.getSLAs(spaceKey).then((policies: any[]) => setSlaPolicies(policies || [])).catch(() => {});
  }, [spaceKey]);

  // Fetch custom-field values for all issues when any custom column is visible.
  // For SLA-type columns (Time to First Response / Time to Resolution), breach status
  // is computed directly from SLA policies so new tickets show the right value
  // even before the detail page has been visited.
  useEffect(() => {
    const visibleCustom = customFieldCols.filter(cc => visibleCols.includes(cc.id));
    if (visibleCustom.length === 0 || issues.length === 0) return;
    let cancelled = false;

    // Identify SLA vs non-SLA custom columns
    const isSLACol = (label: string) => {
      const l = label.toLowerCase();
      return l.includes('time to first response') || l.includes('time to resolution');
    };

    Promise.all(
      issues.map(issue =>
        api.getCustomFieldValues(issue.id)
          .then((vals: any[]) => ({ issueId: issue.id, issue, vals: vals || [] }))
          .catch(() => ({ issueId: issue.id, issue, vals: [] as any[] }))
      )
    ).then(results => {
      if (cancelled) return;
      const now = new Date();
      const newMap = new Map<string, Record<string, string>>();

      results.forEach(({ issueId, issue, vals }) => {
        const m: Record<string, string> = {};
        // Populate from stored values first
        (vals as any[]).forEach((v: any) => { m[v.fieldId] = v.value; });

        // For SLA columns: compute breach status from policies (overrides stored if policies exist)
        if (slaPolicies.length > 0) {
          const priority = (issue.priority || 'medium').toLowerCase();
          const isResolved = (issue as any).status?.category === 'done';

          visibleCustom
            .filter(cc => isSLACol(cc.label))
            .forEach(cc => {
              const colLabel = cc.label.toLowerCase();
              const isFirstResponse = colLabel.includes('time to first response');

              const matchedPolicy = slaPolicies
                .filter((p: any) => p.status === 'active')
                .find((p: any) => {
                  const pName = (p.name || '').toLowerCase();
                  return isFirstResponse
                    ? pName.includes('time to first response')
                    : pName.includes('time to resolution');
                });

              if (!matchedPolicy) return;

              // Replicate computeIssueSLAs duration logic from jira-dev-mock.ts
              let durationMs = 8 * 60 * 60 * 1000; // default 8h
              for (const goal of (matchedPolicy.goals || [])) {
                if (goal.isPriorityGroup && goal.priorityRows) {
                  const row = (goal.priorityRows as any[]).find((r: any) => r.priority?.toLowerCase() === priority);
                  if (row?.timeValue) {
                    const val = parseFloat(row.timeValue);
                    const unit = (row.timeUnit || 'hours').toLowerCase();
                    durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
                    break;
                  }
                } else if (goal.timeValue) {
                  const val = parseFloat(goal.timeValue);
                  const unit = (goal.timeUnit || 'hours').toLowerCase();
                  durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
                  break;
                }
              }
              const startedAt = (issue as any).createdAt || new Date().toISOString();
              const dueTime = new Date(new Date(startedAt).getTime() + durationMs);
              const isBreached = !isResolved && dueTime < now;
              m[cc.fieldId] = isBreached ? 'Yes' : 'No';
            });
        }

        newMap.set(issueId, m);
      });

      setCfValuesMap(newMap);
    });
    return () => { cancelled = true; };
  }, [customFieldCols, visibleCols, issues, slaPolicies]);

  const setFilter = (key: string, value: string) => {
    setFilters(f => value ? { ...f, [key]: value } : Object.fromEntries(Object.entries(f).filter(([k]) => k !== key)));
    setCurrentPage(1); // reset pagination when filter changes
    // Closing the panel is each call site's decision — single-select options close it
    // explicitly via setOpenFilter(null); multi-select checkboxes deliberately don't,
    // so the panel stays open to pick more than one value.
  };
  const clearFilter = (key: string) => { setFilters(f => Object.fromEntries(Object.entries(f).filter(([k]) => k !== key))); setCurrentPage(1); };
  const clearAllFilters = () => {
    setFilters({});
    setSearch('');
    setCurrentPage(1);
  };

  // Track recently visited space — per user
  useEffect(() => {
    if (currentSpace?.key && currentSpace?.name) {
      trackRecentItem({
        id: currentSpace.key,
        type: 'space',
        title: currentSpace.name,
        href: `/spaces/${currentSpace.key}`,
        spaceKey: currentSpace.key,
      }, user?.id);
    }
  }, [currentSpace?.key, user?.id]);

  // displayPatch covers relational fields (assignee, status) whose visible name lives
  // on a different key than the raw id being saved (issue.assignee vs assigneeId).
  const handleInlineUpdate = useCallback(async (issueKey: string, field: string, value: any, displayPatch?: Record<string, any>) => {
    setOpenDropdown(null); setUpdating(issueKey);
    const prevIssues = useStore.getState().issues;
    // Reflect the change in the row immediately — don't wait on a PATCH plus a full
    // list reload (up to 500 rows) before the row shows the new value.
    useStore.setState(s => ({
      issues: s.issues.map((i: any) => i.key === issueKey ? { ...i, [field]: value, ...(displayPatch || {}) } : i),
    }));
    try {
      await api.updateIssue(issueKey, { [field]: value });
      // Force a fresh fetch (not a cache hit) so the background reconcile reflects
      // this edit and any server-side side effects, instead of re-showing stale
      // data. Guessing the reload params here (as this used to) drops whatever
      // this view's actual filter state is (dept, excludeDone, custom filters,
      // etc.) -- bumping the version instead lets the main load effect re-fetch
      // with its own already-correct params, same as any other list mutation.
      clearIssuesCache();
      bumpIssuesVersion();
    }
    catch (err) {
      console.error(err);
      useStore.setState({ issues: prevIssues });
    }
    finally { setUpdating(null); }
  }, [clearIssuesCache, bumpIssuesVersion]);

  // Custom-queue statuses (qst_...) aren't real Status rows — they live in
  // dept_statuses[dept], set via queueStatusId/Name/Color/Category, same as
  // handleStatusChange on the issue detail page.
  const handleInlineQueueStatusUpdate = useCallback(async (issueKey: string, dept: string, s: any) => {
    setOpenDropdown(null); setUpdating(issueKey);
    const prevIssues = useStore.getState().issues;
    const queueSt = { id: s.id, name: s.name, color: s.color || '#64748B', category: s.category || 'todo' };
    useStore.setState(st => ({
      issues: st.issues.map((i: any) => i.key === issueKey
        ? { ...i, dept_statuses: { ...(i.dept_statuses || {}), [dept]: queueSt } }
        : i),
    }));
    try {
      await api.updateIssue(issueKey, {
        queueStatusId: queueSt.id,
        queueStatusName: queueSt.name,
        queueStatusColor: queueSt.color,
        queueStatusCategory: queueSt.category,
      } as any);
      clearIssuesCache();
      bumpIssuesVersion();
    } catch (err) {
      console.error(err);
      useStore.setState({ issues: prevIssues });
    }
    finally { setUpdating(null); }
  }, [clearIssuesCache, bumpIssuesVersion]);

  const recallIssue = async (issueKey: string) => {
    const prevIssues = useStore.getState().issues;
    // Remove from the list immediately — recalling should make the ticket
    // disappear from Sent/Watching right away, not after two round-trips.
    useStore.setState(s => ({ issues: s.issues.filter((i: any) => i.key !== issueKey) }));
    try {
      await api.updateIssue(issueKey, { recall: true } as any);
    } catch (e) {
      console.error('Recall failed', e);
      alert('Failed to recall ticket');
      useStore.setState({ issues: prevIssues });
      return;
    }
    // Background reconcile — no need to block the UI on this. Bump the
    // version instead of guessing reload params (this only covered
    // sent-watching, so recalling from a dept-filtered view like "All
    // Tickets — Migration" reloaded without the dept filter and could
    // flash "0 Tickets").
    clearIssuesCache();
    bumpIssuesVersion();
  };

  const [commentingOn, setCommentingOn] = useState<string | null>(null); // issueKey
  // Which comment (if any) the currently-open composer is replying to --
  // null means it's a plain new top-level comment, opened via "Add a
  // comment...". Lets the same composer render either inline right under a
  // specific comment (Reply) or at the bottom of the thread (Add a comment),
  // matching where the ticket detail page's own Reply now opens too.
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [richCommentHtml, setRichCommentHtml] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  // Same upload-in-flight guard as the ticket detail page's comment box — saving
  // before an attachment upload resolves bakes its inert "Uploading…" placeholder
  // into the stored comment permanently.
  const [isUploadingSentComment, setIsUploadingSentComment] = useState(false);
  const submitComment = async (issueKey: string) => {
    const body = richCommentHtml.replace(/<[^>]+>/g, '').trim() ? richCommentHtml : commentText.trim();
    if (!body) return;
    const tempId = `opt-${Date.now()}`;
    const optimisticComment = {
      id: tempId,
      body,
      isInternal: false,
      authorName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || 'You',
      author: user,
      createdAt: new Date().toISOString(),
    };
    const prevIssues = useStore.getState().issues;
    // Show the comment immediately — don't wait on a PATCH plus a full list
    // reload (up to 100-500 rows) before the card reflects anything.
    useStore.setState(s => ({
      issues: s.issues.map((i: any) => i.key === issueKey ? { ...i, comments: [...((i as any).comments || []), optimisticComment] } : i),
    }));
    setCommentText('');
    setRichCommentHtml('');
    setCommentingOn(null);
    setReplyingToCommentId(null);
    setSubmittingComment(true);
    try {
      const saved = await api.addComment(issueKey, { body });
      // Swap the placeholder for the real saved comment
      useStore.setState(s => ({
        issues: s.issues.map((i: any) => i.key === issueKey
          ? { ...i, comments: ((i as any).comments || []).map((c: any) => c.id === tempId ? (saved || c) : c) }
          : i),
      }));
      // The optimistic update above already swapped the placeholder comment
      // for the real saved one directly in the visible `issues` list, and
      // nothing else this list displays (summary/assignee/status/SLA) is
      // affected by adding a comment -- a background loadIssues() used to run
      // here too "to be safe", but clearIssuesCache() right before it forced
      // loadIssues into its own no-cache branch (issues: [], loading: true),
      // blanking the whole list and showing a full spinner for a second just
      // to redraw the exact same rows, including the comment already visible.
      // Reported as "adding a comment shows a loader" -- removed both; the
      // optimistic update is already the correct, final state here.
    } catch (e) {
      console.error(e);
      useStore.setState({ issues: prevIssues });
    }
    finally { setSubmittingComment(false); }
  };

  const handleToggleReaction = async (issueKey: string, commentId: string, emoji: string) => {
    const myId = user?.id;
    const applyReaction = (c: any) => {
      if (c.id !== commentId) return c;
      const reactions = { ...(c.reactions || {}) };
      const existing: string[] = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      const already = myId && existing.includes(myId);
      const next = already ? existing.filter((id) => id !== myId) : [...existing, myId].filter(Boolean);
      if (next.length) reactions[emoji] = next; else delete reactions[emoji];
      return { ...c, reactions };
    };
    useStore.setState(s => ({
      issues: s.issues.map((i: any) => i.key === issueKey ? { ...i, comments: ((i as any).comments || []).map(applyReaction) } : i),
    }));
    try {
      const result = await api.toggleCommentReaction(commentId, emoji);
      useStore.setState(s => ({
        issues: s.issues.map((i: any) => i.key === issueKey
          ? { ...i, comments: ((i as any).comments || []).map((c: any) => c.id === commentId ? { ...c, reactions: result?.reactions ?? c.reactions } : c) }
          : i),
      }));
    } catch { /* optimistic state stands; next reload will correct it if this truly failed */ }
  };

  const toggleDropdown = (e: React.MouseEvent, key: string, field: 'status' | 'priority' | 'assignee') => {
    e.stopPropagation(); e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpenDropdown(prev => prev?.key === key && prev?.field === field ? null : { key, field, rect });
  };

  const toggleRow = (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); e.preventDefault();
    setSelectedRows(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  };

  const toggleAll = () => setSelectedRows(prev => prev.size === issues.length ? new Set() : new Set(issues.map(i => i.id)));

  const handleBulkDelete = async () => {
    const keys = issues.filter(i => selectedRows.has(i.id)).map(i => i.key);
    if (keys.length === 0) return;
    if (!confirm(`Delete ${keys.length} issue${keys.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    for (const key of keys) {
      try {
        await api.deleteIssue(key);
      } catch { /* ignore individual errors */ }
    }
    setSelectedRows(new Set());
    // Re-run the main load effect's own (correctly dept/filter-scoped) params instead
    // of rebuilding a partial copy here — this reload used to drop the dept/queue
    // scoping entirely (no `dept`, no `excludeDone`), so after deleting from a
    // custom queue or a department view the list would silently repopulate with an
    // unscoped, unrelated set of tickets — looking like "delete didn't work" even
    // though the deletes themselves succeeded.
    clearIssuesCache();
    bumpIssuesVersion();
  };

  if (!spaceKey) {
    return (
      <div className="p-8 text-center text-gray-600">
        <p>Invalid space URL.</p>
        <Link href="/spaces" className="mt-3 inline-block text-sm text-blue-600 hover:underline">
          Back to spaces
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
        <p className="font-medium">Could not load this space</p>
        <p className="mt-1 text-sm">{loadError}</p>
        <Link href="/spaces" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          Back to spaces
        </Link>
      </div>
    );
  }

  // Only show full-page spinner on the very first load (no data at all yet).
  // On tab/section navigation currentSpace retains its last value so the page
  // renders immediately without a blank flash.
  if (!currentSpace && !loadError) {
    return (
      <DotLoader className="h-64" />
    );
  }

  if (!currentSpace) return null;

  // Access check — admins always pass; others must be a member of this space
  const isMember = isAdmin || (currentSpace.members || []).some(
    (m: any) => (m.email || m.user?.email || '').toLowerCase() === (user?.email || '').toLowerCase()
  );

  if (!isMember) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh] text-center px-6">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mb-4">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Access Restricted</h2>
        <p className="text-gray-500 text-[14px] max-w-sm mb-6">
          You don't have access to the <strong>{currentSpace.name}</strong> board.<br/>
          Contact your administrator to request access.
        </p>
        <Link href="/spaces"
          className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors">
          Back to Spaces
        </Link>
      </div>
    );
  }

  const members = currentSpace.members || [];
  const statuses = currentSpace.statuses || [];

  // Current user's department in this space (from space membership)
  const mySpaceDept: string = (() => {
    if (!user) return '';
    const me = members.find((m: any) => m.userId === user.id || m.email === user.email);
    return (me as any)?.department || '';
  })();

  const QUEUE_LABELS: Record<string, string> = {
    'all-open':        'All Tickets',
    'assigned':        'Assigned to me',
    'unassigned':      'Unassigned',
    'all-requests':    'All Requests',
    'closed':          'Closed tickets',
    'my-dept':         'My Dept',
    'my-queue':        'My Queue',
    'sent-watching':   'Sent / Watching',
    'dept_all':        deptParam ? `All Tickets — ${deptParam}` : 'All Tickets',
    'dept_unassigned': deptParam ? `Unassigned — ${deptParam}` : 'Unassigned',
    'dept_assigned':   deptParam ? `Assigned to me — ${deptParam}` : 'Assigned to me',
    'dept_closed':     deptParam
      ? `Worked on — ${deptParam}${viewUserNameParam ? ` — ${viewUserNameParam}` : ''}`
      : 'Worked on',
  };
  const queueLabel = (activeCustomQueue?.name) || QUEUE_LABELS[queueFilter] || 'Queues';
  const isQueueView = ['all-open', 'assigned', 'unassigned', 'all-requests', 'closed', 'my-dept', 'my-queue', 'sent-watching', 'dept_all', 'dept_unassigned', 'dept_assigned', 'dept_closed'].includes(queueFilter) || queueFilter.startsWith('cq_');

  const filteredIssues = issues.filter((issue) => {
    // Queue filter — skip category check when user has explicitly selected a status
    if (!filters.status) {
      if (queueFilter === 'closed') {
        // Inverse of "All Tickets" — only resolved/done tickets. Matching on
        // category alone (not a name substring like "done"/"resolved") — this
        // codebase has real in-progress statuses whose NAME happens to contain
        // one of those words (e.g. "ASSUMED CODE DONE", "API NOT AVAILABLE
        // DONE"), which a substring match would wrongly treat as done and hide
        // from "All Tickets" / wrongly show under "Closed tickets".
        const cat = (issue.status?.category || '').toLowerCase();
        if (cat !== 'done') return false;
      } else if (queueFilter === 'assigned') {
        if (!user || issue.assignee?.id !== user.id) return false;
      } else if (queueFilter === 'unassigned') {
        // Only show open tickets with no assignee
        const cat = (issue.status?.category || '').toLowerCase();
        // Category alone, not a name substring — this codebase has real non-done
        // statuses whose NAME happens to contain "done"/"resolved" (e.g. "ASSUMED
        // CODE DONE", "API NOT AVAILABLE DONE"), which a substring match would
        // wrongly treat as done and hide from these views.
        if (cat === 'done') return false;
        if (issue.assignee) return false;
        // If dept-scoped (user clicked Unassigned (Dev) etc.), filter by that dept
        if (deptParam) {
          const issueDept = ((issue as any).current_department || '').toLowerCase();
          if (issueDept !== deptParam.toLowerCase()) return false;
        }
      } else if (queueFilter === 'my-dept') {
        // Show open tickets that have a department set (unassigned or assigned to me)
        const cat = (issue.status?.category || '').toLowerCase();
        // Category alone, not a name substring — this codebase has real non-done
        // statuses whose NAME happens to contain "done"/"resolved" (e.g. "ASSUMED
        // CODE DONE", "API NOT AVAILABLE DONE"), which a substring match would
        // wrongly treat as done and hide from these views.
        if (cat === 'done') return false;
        const issueDept = ((issue as any).current_department || '').toLowerCase();
        if (!issueDept) return false;
        const userDept = mySpaceDept.toLowerCase();
        // If user has a dept set, filter to that dept only; otherwise show all dept tickets
        if (userDept && issueDept !== userDept) return false;
        // Show only unassigned or assigned to current user
        if (issue.assignee && issue.assignee.id !== user?.id) return false;
      } else if (queueFilter === 'my-queue') {
        // Show open tickets where current_department matches user's dept
        const cat = (issue.status?.category || '').toLowerCase();
        // Category alone, not a name substring — this codebase has real non-done
        // statuses whose NAME happens to contain "done"/"resolved" (e.g. "ASSUMED
        // CODE DONE", "API NOT AVAILABLE DONE"), which a substring match would
        // wrongly treat as done and hide from these views.
        if (cat === 'done') return false;
        const issueDept = ((issue as any).current_department || '').toLowerCase();
        const userDept = (mySpaceDept || '').toLowerCase();
        if (!userDept || issueDept !== userDept) return false;
      } else if (queueFilter === 'sent-watching') {
        // Show all tickets that were sent FROM this dept (now in a different dept)
        const issueDept = ((issue as any).current_department || '').toLowerCase();
        if (!issueDept) return false;
        // Exclude tickets still in this dept (they haven't been sent anywhere)
        if (deptParam && issueDept === deptParam.toLowerCase()) return false;
      } else if (queueFilter === 'dept_all') {
        // Every ticket in this dept, regardless of assignee OR status — the
        // server no longer excludes done tickets here (see the fetch effect),
        // so re-applying a done/name-substring exclusion client-side used to
        // silently throw away most of each page it returned (a page mostly
        // full of already-resolved migrated tickets would come back from the
        // server correctly, then get filtered down to a handful in the
        // browser, with the "Total" pill and the visible rows disagreeing).
        if (deptParam) {
          const issueDept = ((issue as any).current_department || '').toLowerCase();
          if (issueDept !== deptParam.toLowerCase()) return false;
        }
      } else if (queueFilter === 'dept_unassigned') {
        const cat = (issue.status?.category || '').toLowerCase();
        const stName = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || stName.includes('done') || stName.includes('resolved') || stName.includes('closed')) return false;
        if (issue.assignee) return false;
        if (deptParam) {
          const issueDept = ((issue as any).current_department || '').toLowerCase();
          if (issueDept !== deptParam.toLowerCase()) return false;
        }
      } else if (queueFilter === 'dept_assigned') {
        // Server already does all the scoping (assignee, dept, excludeDone) via
        // includeHistory — re-applying "still open, still in this dept, still
        // assigned to me" here undid that: a resolved or moved-on ticket the
        // server correctly kept (with its real current status/department) got
        // silently stripped right back out, so the list shrank below the
        // "Open" pill's server-reported total. No client-side filter needed;
        // just pass through what the server returned, same as custom queues.
      } else if (queueFilter.startsWith('cq_')) {
        // Custom queue — server already filters by current_department (dept param sent to API)
        // No client-side dept filter needed; just pass through all server-returned issues
      }
    }
    // Department filter — when selected, only show tickets in that department
    if (deptFilter) {
      const issueDept = ((issue as any).current_department || '').toUpperCase();
      if (issueDept !== deptFilter.toUpperCase()) return false;
    }
    // Type/Status/Priority/Label (and the "extra added" fields below) all support
    // comma-separated multi-select — a filter value of "a,b" matches either.
    const matchesMulti = (filterVal: string, issueVal: string) => {
      const selected = filterVal.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
      return selected.length === 0 || selected.includes((issueVal || '').toLowerCase());
    };
    // Type filter
    if (filters.type && !matchesMulti(filters.type, issue.type || '')) return false;
    // Status filter
    if (filters.status && !matchesMulti(filters.status, issue.status?.name || '')) return false;
    // Assignee filter — match by email (member id ≠ user id in seeded data).
    // Now multi-select (comma-separated ids), same pattern as matchesMulti above.
    if (filters.assignee) {
      if (filters.assignee === '__unassigned') { if (issue.assignee) return false; }
      else if (filters.assignee === '__current') {
        const matches = issue.assignee?.email === user?.email ||
                        issue.assignee?.id    === user?.id;
        if (!matches) return false;
      } else {
        const selectedAssigneeIds = filters.assignee.split(',').map((v: string) => v.trim()).filter(Boolean);
        if (!issue.assignee?.id || !selectedAssigneeIds.includes(issue.assignee.id)) return false;
      }
    }
    // Priority filter
    if (filters.priority && !matchesMulti(filters.priority, issue.priority || '')) return false;
    // Reporter filter
    if (filters.reporter) {
      if (filters.reporter === '__current') {
        if (issue.reporter?.id !== user?.id) return false;
      } else {
        if (issue.reporter?.id !== filters.reporter) return false;
      }
    }
    // Label filter — match if the issue has ANY of the selected labels
    if (filters.label) {
      const issueLabels: string[] = Array.isArray(issue.labels)
        ? issue.labels.map((l: any) => (typeof l === 'string' ? l : l?.name || '')).filter(Boolean)
        : [];
      const selectedLabels = filters.label.split(',').map(v => v.trim()).filter(Boolean);
      if (!selectedLabels.some(l => issueLabels.includes(l))) return false;
    }
    // Created date filter (client-side fallback)
    if (filters.created && issue.createdAt) {
      const created = new Date(issue.createdAt).getTime();
      const now = Date.now();
      const DAY = 86400000;
      const ranges: Record<string, number> = { today: DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };
      const ms = ranges[filters.created];
      if (ms && created < now - ms) return false;
    }
    // Extra added filters — reuse the same comma-separated multi-select matcher
    if (filters.workType)         { if (!matchesMulti(filters.workType,        (issue as any).workType        || '')) return false; }
    if (filters.productType)      { if (!matchesMulti(filters.productType,     (issue as any).productType     || '')) return false; }
    if (filters.combination)      { if (!matchesMulti(filters.combination,     (issue as any).combination     || '')) return false; }
    if (filters.testEnvironment)  { if (!matchesMulti(filters.testEnvironment, (issue as any).testEnvironment || '')) return false; }
    if (filters.rootCause)        { if (!matchesMulti(filters.rootCause,       (issue as any).rootCause       || '')) return false; }
    if (filters.fixDescription)   { if (!matchesMulti(filters.fixDescription,  (issue as any).fixDescription  || '')) return false; }
    if (filters.customerName)     { if (!matchesMulti(filters.customerName,    (issue as any).customerName    || '')) return false; }
    if (filters.clientName)       { if (!matchesMulti(filters.clientName,      (issue as any).clientName      || '')) return false; }
    if (filters.projectManager)   { if (!matchesMulti(filters.projectManager,  (issue as any).projectManager  || '')) return false; }
    if (filters.manageClientName) { if (!matchesMulti(filters.manageClientName,(issue as any).manageClientName|| '')) return false; }
    if (filters.customerPlan)     { if (!matchesMulti(filters.customerPlan,    (issue as any).customerPlan    || '')) return false; }
    if (filters.updated && issue.updatedAt) {
      const updated = new Date(issue.updatedAt).getTime();
      const now = Date.now(); const DAY = 86400000;
      const ranges: Record<string, number> = { today: DAY, '7d': 7*DAY, '30d': 30*DAY, '90d': 90*DAY };
      const ms = ranges[filters.updated];
      if (ms && updated < now - ms) return false;
    }
    if (filters.dueDate) {
      const dd = (issue as any).dueDate ? new Date((issue as any).dueDate).getTime() : null;
      const now = Date.now();
      if (filters.dueDate === 'overdue')    { if (!dd || dd >= now) return false; }
      if (filters.dueDate === 'this_week')  { if (!dd || dd < now || dd > now + 7*86400000) return false; }
      if (filters.dueDate === 'this_month') { if (!dd || dd < now || dd > now + 30*86400000) return false; }
      if (filters.dueDate === 'no_due')     { if (dd) return false; }
    }
    // Search is already applied server-side (params.q, above) against summary/key/
    // cf_key/description for every queue variant. A second, cruder client-side
    // re-filter used to run here on top of that — plain lowercase .includes() with
    // no key normalization — which could re-exclude a result the server had
    // already correctly matched (e.g. searching "CF - 29236" reached the server
    // as-is, which normalizes it to "CF-29236" and matches; this client filter
    // then compared literal "cf - 29236" against "cf-29236" and dropped it,
    // showing "No issues found" for a query that had a real match).
    return true;
  // Newest first — sort by createdAt descending
  }).sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  // Unique labels from all loaded issues (for label filter dropdown)
  const allLabels: string[] = Array.from(new Set(
    issues.flatMap((i) => Array.isArray(i.labels)
      ? i.labels.map((l: any) => typeof l === 'string' ? l : l?.name || '').filter(Boolean)
      : [])
  )).sort();

  // Unique values for addable select filters
  const uniqueValues = (field: string): string[] =>
    Array.from(new Set(issues.map((i: any) => i[field]).filter(Boolean))).sort() as string[];
  // Merge server-fetched values with any locally visible values (dedup + sort).
  // Server values are keyed by `${field}::${effectiveDept}` (see the fetch effect
  // above) since they're scoped to the currently-viewed department.
  const mergedOptions = (field: string): string[] => {
    const server = serverFieldOptions[`${field}::${effectiveDept}`] || [];
    const local  = uniqueValues(field);
    return Array.from(new Set([...server, ...local])).sort();
  };
  const fieldOptions: Record<string, string[]> = {
    workType:         mergedOptions('workType'),
    productType:      mergedOptions('productType'),
    combination:      mergedOptions('combination'),
    testEnvironment:  mergedOptions('testEnvironment'),
    rootCause:        mergedOptions('rootCause'),
    fixDescription:   mergedOptions('fixDescription'),
    customerName:     mergedOptions('customerName'),
    clientName:       mergedOptions('clientName'),
    projectManager:   mergedOptions('projectManager'),
    manageClientName: mergedOptions('manageClientName'),
    customerPlan:     mergedOptions('customerPlan'),
  };

  const openCount = issues.filter(i => i.status?.category === 'todo' || !i.status?.category).length;
  const inProgressCount = issues.filter(i => i.status?.category === 'in_progress').length;
  const doneCount = issues.filter(i => i.status?.category === 'done').length;

  return (
    <div className="flex flex-col h-full">

      {/* ── Page Header ── */}
      <div className="px-6 pt-5 pb-4 bg-[#FAFBFC] border-b border-[#DFE1E6]">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11.5px] text-gray-400 mb-3">
          <Link href="/spaces" className="hover:text-blue-600 transition-colors">Spaces</Link>
          <span>/</span>
          <Link href={`/spaces/${spaceKey}`} className="hover:text-blue-600 transition-colors">{currentSpace.name}</Link>
          {isQueueView && queueFilter !== 'queues' && <><span>/</span><span className="text-gray-700 font-medium">{queueLabel}</span></>}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {queueFilter === 'queues' ? (
              <div>
                <h1 className="text-[17px] font-semibold text-gray-900">Queues</h1>
                <p className="text-[11.5px] text-gray-400 mt-0.5">{currentSpace?.name}</p>
              </div>
            ) : isQueueView ? (
              <div>
                <h1 className="text-[17px] font-semibold text-gray-900">{queueLabel}</h1>
              </div>
            ) : (
              <>
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <SpaceIcon icon={currentSpace.icon} spaceKey={spaceKey} spaceName={currentSpace.name} size="md" />
                </div>
                <div>
                  <h1 className="text-[17px] font-semibold text-gray-900">{currentSpace.name}</h1>
                  <p className="text-[11.5px] text-gray-400 mt-0.5">
                    {currentSpace.type === 'scrum' ? 'Scrum Project' : currentSpace.type === 'kanban' ? 'Kanban Project' : 'Service Management'}
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {currentSpace.type === 'scrum' && (
              <Link href={`/spaces/${spaceKey}/backlog`}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-md text-[12.5px] font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                <ClipboardList size={13} /> Backlog
              </Link>
            )}
            {isAdmin && (
              <Link href={`/spaces/${spaceKey}/settings`}
                className="w-8 h-8 border border-gray-300 rounded-md flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors">
                <Settings size={14} />
              </Link>
            )}
          </div>
        </div>

        {/* Stat pills — hidden on queues overview */}
        <div className="flex items-center gap-3 mt-4">
          {queueFilter === 'queues' ? null : (queueFilter === 'all-requests' || queueFilter.startsWith('cq_')) ? (
            // All Requests / Custom queues — total count with pagination
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-medium bg-blue-50 text-blue-700 border-blue-200">
              <span className="font-bold text-[15px]">{(issueTotal ?? issues.length).toLocaleString()}</span>
              <span>{queueFilter.startsWith('cq_') ? 'Total' : 'Total Requests'}</span>
            </div>
          ) : ['dept_all', 'dept_unassigned', 'dept_assigned'].includes(queueFilter) ? (
            // Department-wide queues — also paginated, so use the real backend
            // total rather than the current page's row count (which used to show
            // as e.g. "100 Open" even when the department actually had thousands).
            // dept_all is no longer excludeDone-scoped (see the fetch effect above),
            // so its count is a true total, not an "open" count like the other two.
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-medium bg-blue-50 text-blue-700 border-blue-200">
              <span className="font-bold text-[15px]">{(issueTotal ?? filteredIssues.length).toLocaleString()}</span>
              <span>{queueFilter === 'dept_all' ? 'Total' : 'Open'}</span>
            </div>
          ) : (
            // All Tickets / Assigned — show only filtered count
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-medium bg-blue-50 text-blue-700 border-blue-200">
              <span className="font-bold text-[15px]">{filteredIssues.length}</span>
              <span>{queueFilter === 'assigned' ? 'Assigned to me' : queueFilter === 'all-open' ? 'Tickets' : 'Open'}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Queues overview — default landing when clicking a space ── */}
      {queueFilter === 'queues' && (() => {
        // Until the custom-queues fetch resolves, we don't yet know whether
        // this board has any — rendering "No queues available." here was a
        // premature (and usually wrong) conclusion that flashed for however
        // long the fetch took, right before the redirect effect above sent
        // plain boards on to the tickets list. Show a spinner instead of a
        // false negative while that's still in flight.
        //
        // Used to also gate on currentSpace?.type !== 'dept_queue' (spinner
        // forever for anything else, on the assumption the redirect effect
        // above was always about to fire for a non-dept_queue space) --
        // removed alongside that same fixed assumption in the redirect
        // effect: TESTIN is stored as type 'service_desk' but has 4 real
        // configured queues, so this kept the spinner spinning forever
        // instead of ever reaching the actual queue list below. The redirect
        // effect and this render check now share the exact same condition
        // (wait for customQueuesLoadedFor, then allCustomQueues.length),
        // so whichever one is correct for this space, both agree on it.
        if (customQueuesLoadedFor !== spaceKey) {
          return (
            <div className="flex-1 flex items-center justify-center">
              <DotLoader className="h-64" />
            </div>
          );
        }
        const isDeptQueue = currentSpace?.type === 'dept_queue' || allCustomQueues.length > 0;
        const customQueues = isDeptQueue
          ? (isAdmin ? allCustomQueues : allCustomQueues.filter(q => q.memberIds.includes(user?.id || '')))
          : [];
        return (
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="flex items-center gap-2.5 mb-1">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                <LayoutGrid size={16} className="text-blue-600" />
              </div>
              <h2 className="text-[17px] font-semibold text-gray-800">Queues</h2>
            </div>
            <p className="text-[12.5px] text-gray-400 mb-6 ml-[42px]">Select a queue to view its tickets</p>
            {customQueues.length === 0 && (
              <p className="text-[13px] text-gray-400 py-4">No queues available.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 max-w-5xl">
              {customQueues.map(q => {
                // Exact dark blue already used for the app's own top header
                // bar (Header.tsx, bg-[#0129AC]) paired with a lighter steel-
                // blue -- the specific pair asked for, sampled from a swatch,
                // not just "some blue" like the earlier #2563EB/#DBEAFE pass.
                const accentDark = '#0129AC';
                const accentLight = '#5B9BD5';
                return (
                  // Same fix as the sidebar's queue-name link (commit e78b353): route to
                  // dept_all (open tickets, paginated) instead of the cq_<id> custom-queue
                  // view, which loads every ticket ever routed there including closed ones
                  // — for a queue with years of history that's thousands of rows, and this
                  // page appeared to hang because that load was so much heavier than expected.
                  <Link key={q.id} href={`/spaces/${spaceKey}?queue=dept_all&dept=${encodeURIComponent(q.name)}`}
                    className="relative flex flex-col gap-3 px-5 pt-5 pb-4 rounded-xl border border-gray-200 bg-white overflow-hidden
                      hover:border-transparent hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 group">
                    <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: accentDark }} />
                    <div className="flex items-start justify-between">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105"
                        style={{ backgroundColor: accentLight }}>
                        <Layers size={20} className="text-white" />
                      </div>
                      <ChevronRight size={16} className="text-gray-300 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all mt-1.5" />
                    </div>
                    <div>
                      <p className="text-[14.5px] font-semibold text-gray-800 group-hover:text-blue-700 transition-colors">{q.name}</p>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">Custom department queue</p>
                    </div>
                    <div className="flex items-center gap-1.5 pt-2 mt-auto border-t border-gray-100 text-[11.5px] text-gray-500">
                      <Users size={12} className="text-gray-400" />
                      <span>{q.memberIds.length} {q.memberIds.length === 1 ? 'member' : 'members'}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Summary view ── */}
      {queueFilter === 'summary' && deptParam && !isAdmin && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-sm">
            <p className="text-[14px] font-semibold text-gray-700 mb-1">Admins only</p>
            <p className="text-[12.5px] text-gray-400">Only an admin can view a queue's summary.</p>
          </div>
        </div>
      )}
      {/* Per-queue summary (admin-only) — range-aware, server-computed, with
          a per-user "tickets worked" breakdown. Separate branch from the
          space-wide one below since it has its own data source entirely. */}
      {queueFilter === 'summary' && deptParam && isAdmin && (() => {
        const RANGE_OPTIONS = [
          { id: 'all', label: 'All time' },
          { id: 'today', label: 'Today' },
          { id: '7d', label: 'Last 7 days' },
          { id: '30d', label: 'Last 30 days' },
          { id: '90d', label: 'Last 90 days' },
        ];
        const CAT_ORDER: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };
        const statusData: [string, { count: number; color: string; category: string }][] =
          (deptSummaryData?.statusBreakdown || [])
            .map((s: any) => [s.name, { count: s.count, color: s.color, category: s.category }] as [string, any])
            .sort((a: any, b: any) => {
              const catDiff = (CAT_ORDER[a[1].category] ?? 1) - (CAT_ORDER[b[1].category] ?? 1);
              return catDiff !== 0 ? catDiff : b[1].count - a[1].count;
            });
        const maxStatus = Math.max(...statusData.map(([, v]) => v.count), 1);

        const PRIORITY_COLORS: Record<string, string> = { highest: '#EF4444', high: '#F97316', medium: '#F59E0B', low: '#64748B', lowest: '#94A3B8' };
        const priorityData = (deptSummaryData?.priorityBreakdown || []).map((p: any) => ({
          id: p.priority, label: p.priority.charAt(0).toUpperCase() + p.priority.slice(1), count: p.count, color: PRIORITY_COLORS[p.priority] || '#94A3B8',
        }));
        const maxPriority = Math.max(...priorityData.map((d: any) => d.count), 1);

        const BAR_H = 180;
        const perUser: any[] = deptSummaryData?.perUser || [];
        const perUserByProduct: Record<string, any[]> = deptSummaryData?.perUserByProduct || {};

        const USER_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16'];

        // Builds one pie chart's slices/gradient from a perUser-shaped array,
        // ranked by whichever field this chart cares about ('currentTotal' for
        // "All Status", 'currentDone' for "Resolved") -- each chart gets its
        // OWN color assignment/order since who's carrying the most current
        // load isn't necessarily who's resolved the most.
        const buildAssigneeChart = (rows: any[], field: 'currentTotal' | 'currentDone') => {
          const total = rows.reduce((s: number, u: any) => s + (u[field] || 0), 0);
          let cumulative = 0;
          const slices = [...rows]
            .sort((a: any, b: any) => (b[field] || 0) - (a[field] || 0))
            .map((u: any, idx: number) => ({ u, color: USER_COLORS[idx % USER_COLORS.length] }))
            .filter(({ u }: any) => (u[field] || 0) > 0)
            .map(({ u, color }: any) => {
              const pct = total > 0 ? (u[field] / total) * 100 : 0;
              const start = cumulative;
              cumulative += pct;
              return { userId: u.userId, color, pct, start, end: cumulative };
            });
          const gradient = slices.length ? `conic-gradient(${slices.map((s: any) => `${s.color} ${s.start}% ${s.end}%`).join(', ')})` : undefined;
          return { total, slices, gradient };
        };

        const allChart      = buildAssigneeChart(perUser, 'currentTotal');
        const resolvedChart = buildAssigneeChart(perUser, 'currentDone');
        const pieColorByUser: Record<string, string> = Object.fromEntries(allChart.slices.map((s: any) => [s.userId, s.color]));
        const totalWorked = allChart.total;

        // Jira runs Content/Message/Email migration as separate boards with
        // their own dashboards -- "who's carrying the load" needs its own
        // Resolved/All-Status pair per product line, not just one chart that
        // blends all three together.
        const PRODUCT_TYPES = ['Content Migration', 'Message Migration', 'Email Migration'];
        const assigneeGroups = [
          { label: 'All Products', rows: perUser },
          ...PRODUCT_TYPES.map((pt) => ({ label: pt, rows: perUserByProduct[pt] || [] })),
        ].map((g) => ({
          ...g,
          resolved: buildAssigneeChart(g.rows, 'currentDone'),
          all: buildAssigneeChart(g.rows, 'currentTotal'),
        }));

        const STAT_CARDS = [
          { label: 'Total Issues', value: deptSummaryData?.totalIssues ?? 0, icon: ClipboardList,
            ring: 'ring-indigo-100', iconWrap: 'bg-gradient-to-br from-indigo-500 to-violet-600', text: 'text-gray-800' },
          { label: 'To Do', value: statusData.filter(([, v]) => v.category === 'todo').reduce((s, [, v]) => s + v.count, 0), icon: Clock,
            ring: 'ring-slate-100', iconWrap: 'bg-gradient-to-br from-slate-400 to-slate-600', text: 'text-slate-700' },
          { label: 'In Progress', value: statusData.filter(([, v]) => v.category === 'in_progress').reduce((s, [, v]) => s + v.count, 0), icon: RefreshCw,
            ring: 'ring-blue-100', iconWrap: 'bg-gradient-to-br from-blue-500 to-cyan-500', text: 'text-blue-700' },
          { label: 'Done', value: statusData.filter(([, v]) => v.category === 'done').reduce((s, [, v]) => s + v.count, 0), icon: CheckCircle2,
            ring: 'ring-emerald-100', iconWrap: 'bg-gradient-to-br from-emerald-500 to-teal-500', text: 'text-emerald-700' },
          { label: 'SLA Breached', value: deptSummaryData?.slaBreachedCount ?? 0, icon: AlertTriangle,
            ring: 'ring-rose-100', iconWrap: 'bg-gradient-to-br from-rose-500 to-red-600', text: 'text-rose-700' },
        ];
        const RANK_COLORS = ['text-amber-500', 'text-slate-400', 'text-orange-700'];

        return (
          <div className="flex-1 overflow-auto px-8 py-7 bg-gradient-to-b from-slate-50 via-white to-slate-50">
            <div className="flex items-start justify-between mb-6 gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-600 to-purple-700 shadow-lg shadow-indigo-200 flex items-center justify-center flex-shrink-0">
                  <BarChart2 size={19} className="text-white" />
                </div>
                <div>
                  <h2 className="text-[17px] font-bold text-gray-900 tracking-tight">Summary <span className="text-gray-300 mx-1">·</span> {deptParam}</h2>
                  <p className="text-[12px] text-gray-400 mt-0.5">Computed from tickets in the {deptParam} queue.</p>
                </div>
              </div>
              {/* Segmented range control */}
              <div className="flex items-center gap-0.5 bg-white border border-gray-200/80 rounded-full p-1 shadow-sm flex-shrink-0">
                {RANGE_OPTIONS.map((r) => (
                  <button key={r.id} onClick={() => setSummaryRange(r.id)}
                    className={`text-[12px] font-medium px-3 py-1.5 rounded-full transition-all whitespace-nowrap ${
                      summaryRange === r.id
                        ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-200'
                        : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
                    }`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {deptSummaryLoading && (
              <div className="py-16 flex items-center justify-center"><DotLoader /></div>
            )}
            {deptSummaryError && !deptSummaryLoading && (
              <p className="text-[13px] text-red-500 py-8 text-center">{deptSummaryError}</p>
            )}

            {!deptSummaryLoading && !deptSummaryError && deptSummaryData && (
              <>
                {/* Stat cards */}
                <div className="grid grid-cols-5 gap-4 mb-6">
                  {STAT_CARDS.map((s) => (
                    <div key={s.label} className={`group relative bg-white rounded-2xl px-5 py-4 ring-1 ${s.ring} shadow-sm hover:shadow-lg transition-shadow overflow-hidden`}>
                      <div className={`absolute -right-4 -top-4 w-20 h-20 rounded-full ${s.iconWrap} opacity-[0.07] group-hover:opacity-[0.12] transition-opacity`} />
                      <div className={`w-9 h-9 rounded-xl ${s.iconWrap} shadow-sm flex items-center justify-center mb-3`}>
                        <s.icon size={16} className="text-white" />
                      </div>
                      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">{s.label}</p>
                      <p className={`text-[24px] font-extrabold tracking-tight ${s.text}`}>{s.value}</p>
                    </div>
                  ))}
                </div>

                <div className="flex gap-5">
                  {/* Status Distribution */}
                  <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-6 flex-1 min-w-0">
                    <h3 className="text-[13.5px] font-bold text-gray-800 mb-5 flex items-center gap-2">
                      <span className="w-1.5 h-4 rounded-full bg-gradient-to-b from-indigo-500 to-violet-600" />
                      Status Distribution
                    </h3>
                    <div className="flex items-end gap-4" style={{ height: BAR_H + 40 }}>
                      {statusData.map(([name, v]) => {
                        const barH = Math.max(4, Math.round((v.count / maxStatus) * BAR_H));
                        return (
                          <div key={name} className="flex flex-col items-center gap-1.5 flex-1 min-w-[48px] group">
                            <span className="text-[11px] font-semibold text-gray-600">{v.count}</span>
                            <div className="w-full rounded-t-lg transition-all shadow-sm group-hover:brightness-110"
                              style={{ height: barH, background: `linear-gradient(180deg, ${v.color}, ${v.color}cc)` }} />
                            <span className="text-[11px] text-gray-500 text-center leading-tight">{name}</span>
                          </div>
                        );
                      })}
                      {statusData.length === 0 && <p className="text-[12.5px] text-gray-400">No tickets in this range.</p>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-5 pt-4 border-t border-gray-50">
                      {statusData.map(([name, v]) => (
                        <span key={name} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white shadow-sm" style={{ background: v.color }} />
                          {name} <span className="text-gray-300">·</span> <span className="font-medium text-gray-600">{v.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Priority Distribution */}
                  <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-6 flex-1 min-w-0">
                    <h3 className="text-[13.5px] font-bold text-gray-800 mb-5 flex items-center gap-2">
                      <span className="w-1.5 h-4 rounded-full bg-gradient-to-b from-amber-500 to-rose-600" />
                      Priority Distribution
                    </h3>
                    <div className="flex items-end gap-4" style={{ height: BAR_H + 40 }}>
                      {priorityData.map((d: any) => {
                        const barH = Math.max(d.count > 0 ? 4 : 2, Math.round((d.count / maxPriority) * BAR_H));
                        return (
                          <div key={d.id} className="flex flex-col items-center gap-1.5 flex-1 min-w-[48px] group">
                            <span className="text-[11px] font-semibold text-gray-600">{d.count}</span>
                            <div className="w-full rounded-t-lg transition-all shadow-sm group-hover:brightness-110"
                              style={{ height: barH, background: d.count > 0 ? `linear-gradient(180deg, ${d.color}, ${d.color}cc)` : '#E5E7EB' }} />
                            <span className="text-[11px] text-gray-500 text-center">{d.label}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-5 pt-4 border-t border-gray-50">
                      {priorityData.map((d: any) => (
                        <span key={d.id} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white shadow-sm" style={{ background: d.count > 0 ? d.color : '#E5E7EB' }} />
                          {d.label} <span className="text-gray-300">·</span> <span className="font-medium text-gray-600">{d.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Assignee Breakdown -- one card per product line (All
                    Products, then Content/Message/Email Migration
                    separately), each with two pie charts (Resolved-only, All
                    Status) and a colored legend of assignee: count --
                    mirroring the pair of pie-chart gadgets Jira shows per
                    board/dashboard, since Content/Message/Email run as
                    separate boards there too. Separate from the detailed
                    "Per user" table below, which stays for the extra
                    Open/In-Progress/SLA/Worked columns these charts don't
                    show, and isn't split by product type. */}
                {assigneeGroups.filter((g) => g.rows.length > 0).map((group) => (
                  <div key={group.label} className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm mt-5 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-50 flex items-center gap-2">
                      <span className="w-1.5 h-4 rounded-full bg-gradient-to-b from-fuchsia-500 to-purple-600" />
                      <div>
                        <h3 className="text-[13.5px] font-bold text-gray-800">Assignee Breakdown <span className="text-gray-300 mx-1">·</span> {group.label}</h3>
                        <p className="text-[11.5px] text-gray-400 mt-0.5">Live ticket share per assignee, currently in the {deptParam} queue.</p>
                      </div>
                    </div>
                    <div className="flex divide-x divide-gray-50">
                      {[
                        { title: 'Resolved Status', chart: group.resolved, field: 'currentDone' as const, empty: 'No resolved tickets currently in this queue.' },
                        { title: 'All Status', chart: group.all, field: 'currentTotal' as const, empty: 'No tickets currently in this queue.' },
                      ].map((panel) => (
                        <div key={panel.title} className="flex-1 min-w-0 p-6">
                          <div className="flex items-center gap-2 mb-4">
                            <PieChart size={14} className="text-gray-400" />
                            <h4 className="text-[12.5px] font-semibold text-gray-700">{panel.title}</h4>
                            <span className="text-[11px] text-gray-400">· {panel.chart.total} issue{panel.chart.total === 1 ? '' : 's'}</span>
                          </div>
                          {panel.chart.total === 0 ? (
                            <p className="text-[12px] text-gray-400 py-6">{panel.empty}</p>
                          ) : (
                            <div className="flex items-center gap-6">
                              <div className="relative rounded-full flex items-center justify-center shadow-inner ring-1 ring-black/5 flex-shrink-0"
                                style={{ width: 120, height: 120, background: panel.chart.gradient || '#EEF0F3' }}>
                                <div className="rounded-full bg-white flex items-center justify-center shadow-md" style={{ width: 72, height: 72 }}>
                                  <span className="text-[16px] font-extrabold text-gray-800">{panel.chart.total}</span>
                                </div>
                              </div>
                              <div className="flex-1 min-w-0 space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                                {panel.chart.slices.map((s: any) => {
                                  const u = group.rows.find((pu: any) => pu.userId === s.userId);
                                  if (!u) return null;
                                  const displayName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Unknown';
                                  return (
                                    <div key={s.userId} className="flex items-center gap-2 text-[12px]">
                                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
                                      <span className="text-gray-600 truncate flex-1">{displayName}</span>
                                      <span className="font-semibold text-gray-800">{u[panel.field]}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Per-user breakdown */}
                <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm mt-5 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-50 flex items-center gap-2">
                    <span className="w-1.5 h-4 rounded-full bg-gradient-to-b from-emerald-500 to-teal-600" />
                    <div>
                      <h3 className="text-[13.5px] font-bold text-gray-800">Per user</h3>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">
                        Total/Open/In Progress/SLA Breached are live counts for every ticket currently in this queue (older tickets included, regardless of range). "Worked (range)" is how many they passed, returned, or closed in the selected range.
                      </p>
                    </div>
                  </div>
                  {perUser.length === 0 ? (
                    <p className="text-[12.5px] text-gray-400 py-8 text-center">No queue members found.</p>
                  ) : (
                    <div className="flex gap-8 p-6">
                      {/* Donut chart -- share of CURRENT ticket load per user */}
                      <div className="flex flex-col items-center gap-3 flex-shrink-0" style={{ width: 168 }}>
                        <div className="relative rounded-full flex items-center justify-center shadow-inner ring-1 ring-black/5"
                          style={{ width: 152, height: 152, background: allChart.gradient || '#EEF0F3' }}>
                          <div className="rounded-full bg-white flex flex-col items-center justify-center shadow-md" style={{ width: 96, height: 96 }}>
                            <span className="text-[20px] font-extrabold text-gray-800 leading-none">{totalWorked}</span>
                            <span className="text-[9.5px] font-medium text-gray-400 uppercase tracking-wide mt-0.5">Tickets</span>
                          </div>
                        </div>
                        {totalWorked === 0 && (
                          <p className="text-[11px] text-gray-400 text-center">No tickets currently in this queue.</p>
                        )}
                      </div>
                      <table className="w-full text-[12.5px]">
                        <thead>
                          <tr className="text-left text-[10.5px] font-semibold text-gray-400 uppercase tracking-wide">
                            <th className="pb-2.5">User</th>
                            <th className="pb-2.5 text-right">Total</th>
                            <th className="pb-2.5 text-right">Open</th>
                            <th className="pb-2.5 text-right">In Progress</th>
                            <th className="pb-2.5 text-right">SLA Breached</th>
                            <th className="pb-2.5 text-right">Worked ({RANGE_OPTIONS.find((r) => r.id === summaryRange)?.label})</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perUser.map((u: any, idx: number) => {
                            const displayName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Unknown';
                            const goToWorkedOn = () => router.push(
                              `/spaces/${spaceKey}?queue=dept_closed&dept=${encodeURIComponent(deptParam)}&viewUser=${encodeURIComponent(u.userId)}&viewUserName=${encodeURIComponent(displayName)}`
                            );
                            const ringColor = pieColorByUser[u.userId] || '#D1D5DB';
                            return (
                              <tr key={u.userId} onClick={goToWorkedOn}
                                className="border-t border-gray-50 cursor-pointer hover:bg-indigo-50/40 transition-colors">
                                <td className="py-2.5 flex items-center gap-2.5">
                                  <span className="w-4 text-center flex-shrink-0">
                                    {idx < 3 && u.currentTotal > 0
                                      ? <Trophy size={13} className={RANK_COLORS[idx]} />
                                      : <span className="text-[10.5px] text-gray-300 font-medium">{idx + 1}</span>}
                                  </span>
                                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-[9.5px] font-bold flex-shrink-0 ring-2"
                                    style={{ boxShadow: `0 0 0 2px white, 0 0 0 3.5px ${ringColor}` }}>
                                    {getInitials(u.firstName, u.lastName)}
                                  </div>
                                  <span className="text-gray-700 font-medium group-hover:text-indigo-600">{displayName}</span>
                                </td>
                                <td className="py-2.5 text-right">
                                  <span className="font-bold text-gray-800">{u.currentTotal}</span>
                                </td>
                                <td className="py-2.5 text-right text-gray-600">{u.currentOpen}</td>
                                <td className="py-2.5 text-right text-gray-600">{u.currentInProgress}</td>
                                <td className="py-2.5 text-right">
                                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${u.slaBreached > 0 ? 'bg-rose-50 text-rose-600' : 'bg-gray-50 text-gray-400'}`}>
                                    {u.slaBreached}
                                  </span>
                                </td>
                                <td className="py-2.5 text-right text-gray-500">{u.ticketsWorked}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── Space-wide Summary view ── */}
      {queueFilter === 'summary' && !deptParam && (() => {
        const allIssues = issues;
        // Status distribution
        const statusMap: Record<string, { count: number; color: string; category: string }> = {};
        for (const issue of allIssues) {
          const name = issue.status?.name || 'Unknown';
          const cat  = issue.status?.category || 'todo';
          const color = cat === 'done' ? '#10B981' : cat === 'in_progress' ? '#3B82F6' : '#64748B';
          if (!statusMap[name]) statusMap[name] = { count: 0, color, category: cat };
          statusMap[name].count++;
        }
        const CAT_ORDER: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };
        const statusData = Object.entries(statusMap).sort((a, b) => {
          const catDiff = (CAT_ORDER[a[1].category] ?? 1) - (CAT_ORDER[b[1].category] ?? 1);
          if (catDiff !== 0) return catDiff;
          return b[1].count - a[1].count;
        });
        const maxStatus = Math.max(...statusData.map(([, v]) => v.count), 1);

        // Priority distribution
        const PRIORITY_ORDER = ['highest','high','medium','low','lowest'];
        const PRIORITY_COLORS: Record<string,string> = { highest:'#EF4444', high:'#F97316', medium:'#F59E0B', low:'#64748B', lowest:'#94A3B8' };
        const priorityMap: Record<string, number> = { highest:0, high:0, medium:0, low:0, lowest:0 };
        for (const issue of allIssues) {
          const p = (issue.priority || 'medium').toLowerCase();
          if (p in priorityMap) priorityMap[p]++;
        }
        const priorityData = PRIORITY_ORDER.map(p => ({ id: p, label: p.charAt(0).toUpperCase()+p.slice(1), count: priorityMap[p], color: PRIORITY_COLORS[p] }));
        const maxPriority = Math.max(...priorityData.map(d => d.count), 1);

        const BAR_H = 180;
        const chartCard = 'bg-white border border-gray-200 rounded-xl p-6 flex-1 min-w-0';

        return (
          <div className="flex-1 overflow-auto px-6 py-6 bg-gray-50">
            <div className="mb-5">
              <h2 className="text-[15px] font-semibold text-gray-800">Summary</h2>
              <p className="text-[12px] text-gray-400 mt-0.5">Computed from all issues in {currentSpace?.name || spaceKey}.</p>
            </div>
            <div className="flex gap-6">
              {/* Status Distribution */}
              <div className={chartCard}>
                <h3 className="text-[14px] font-semibold text-gray-800 mb-5">Status Distribution</h3>
                <div className="flex items-end gap-4" style={{ height: BAR_H + 40 }}>
                  {statusData.map(([name, v]) => {
                    const barH = Math.max(4, Math.round((v.count / maxStatus) * BAR_H));
                    return (
                      <div key={name} className="flex flex-col items-center gap-1 flex-1 min-w-[48px]">
                        <span className="text-[11px] font-medium text-gray-500">{v.count}</span>
                        <div className="w-full rounded-t-md transition-all" style={{ height: barH, background: v.color }} />
                        <span className="text-[11px] text-gray-500 text-center leading-tight">{name}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-4">
                  {statusData.map(([name, v]) => (
                    <span key={name} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: v.color }} />
                      {name} · {v.count}
                    </span>
                  ))}
                </div>
              </div>

              {/* Priority Distribution */}
              <div className={chartCard}>
                <h3 className="text-[14px] font-semibold text-gray-800 mb-5">Priority Distribution</h3>
                <div className="flex items-end gap-4" style={{ height: BAR_H + 40 }}>
                  {priorityData.map(d => {
                    const barH = Math.max(d.count > 0 ? 4 : 2, Math.round((d.count / maxPriority) * BAR_H));
                    return (
                      <div key={d.id} className="flex flex-col items-center gap-1 flex-1 min-w-[48px]">
                        <span className="text-[11px] font-medium text-gray-500">{d.count}</span>
                        <div className="w-full rounded-t-md transition-all" style={{ height: barH, background: d.count > 0 ? d.color : '#E5E7EB' }} />
                        <span className="text-[11px] text-gray-500 text-center">{d.label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-4">
                  {priorityData.map(d => (
                    <span key={d.id} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.count > 0 ? d.color : '#E5E7EB' }} />
                      {d.label} · {d.count}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Totals row */}
            <div className="flex gap-4 mt-6">
              {[
                { label: 'Total Issues',  value: allIssues.length, color: 'text-gray-700', bg: 'bg-white' },
                { label: 'To Do',         value: allIssues.filter(i => i.status?.category === 'todo' || (!i.status?.category)).length, color: 'text-slate-600', bg: 'bg-slate-50' },
                { label: 'In Progress',   value: allIssues.filter(i => i.status?.category === 'in_progress').length, color: 'text-blue-600',  bg: 'bg-blue-50'  },
                { label: 'Done',          value: allIssues.filter(i => i.status?.category === 'done').length,        color: 'text-green-600', bg: 'bg-green-50' },
              ].map(s => (
                <div key={s.label} className={`flex-1 ${s.bg} border border-gray-200 rounded-xl px-5 py-4`}>
                  <p className="text-[11.5px] text-gray-400 mb-1">{s.label}</p>
                  <p className={`text-[26px] font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Filters bar ── */}
      {queueFilter !== 'summary' && queueFilter !== 'queues' && <div className="px-6 py-2.5 bg-[#FAFBFC] border-b border-[#DFE1E6] flex items-center gap-2 overflow-x-auto scrollbar-hide min-h-[44px]">
        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search issues…" value={search} onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-[12.5px] border border-gray-300 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44" />
        </div>

        {/* ── Unified Filter button ── */}
        {(() => {
          const allMembers = members.map((m: any) => m.user || m);
          // The Assignee filter used to always list every member of the whole
          // space, even while viewing one department's queue (e.g. Migration) --
          // so it showed people from Dev, QA, etc. who have no access to this
          // queue at all and could never actually be its assignee. Scope it down
          // to that queue's own memberIds (same access-control list
          // isUserAuthorizedForDeptQueue checks server-side) whenever a
          // department is selected and has one configured; fall back to every
          // space member otherwise (matches the fail-open behavior of that same
          // server-side check when a dept has no queue config).
          const deptQueueForAssignee = deptParam
            ? allCustomQueues.find((q) => (q.name || '').toLowerCase() === deptParam.toLowerCase())
            : undefined;
          // Admins aren't added to a queue's memberIds anywhere in this app --
          // they get access through their role, not membership -- but every
          // server-side check that gates on queue membership (status changes,
          // department transfers, isUserAuthorizedForDeptQueue) already lets
          // an admin through regardless. This filter list was scoping down to
          // memberIds alone with no such bypass, so an admin who legitimately
          // holds a ticket in this queue (assigned directly, or via
          // round-robin) couldn't even be selected to filter by, even though
          // every other queue-access rule in the app already treats admins as
          // implicitly authorized everywhere.
          const assigneeFilterMembers = (deptQueueForAssignee?.memberIds?.length)
            ? allMembers.filter((mb: any) => deptQueueForAssignee.memberIds.includes(mb.id) || mb.role === 'admin')
            : allMembers;

          // Assignee, Status, and Request type (Type) each get their own standalone
          // button — like Jira's toolbar. Everything else lives under "More filters".
          const activeFilterCount = [
            filters.priority, filters.reporter, filters.label, filters.created,
            deptFilter,
            ...ADDABLE_FILTER_DEFS.map(d => filters[d.id]).filter(Boolean),
          ].filter(Boolean).length;

          // Full category list (used for label lookups regardless of which button opened it) —
          // every field (Product Type, Combination, Project Manager, etc.) is listed directly
          // instead of behind a "+ More Fields" sub-step, so it's reachable in a single click.
          const filterCats = [
            { id: 'type', label: 'Request type', icon: <SlidersHorizontal size={13} /> },
            ...(rrDepartments.length > 0 ? [{ id: 'department', label: 'Department', icon: <Building2 size={13} /> }] : []),
            { id: 'status', label: 'Status', icon: <SlidersHorizontal size={13} /> },
            { id: 'assignee', label: 'Assignee', icon: <User size={13} /> },
            { id: 'priority', label: 'Priority', icon: <BarChart2 size={13} /> },
            { id: 'reporter', label: 'Reporter', icon: <UserCheck size={13} /> },
            { id: 'label', label: 'Label', icon: <Tag size={13} /> },
            { id: 'created', label: 'Created', icon: <Calendar size={13} /> },
            ...ADDABLE_FILTER_DEFS.map(def => ({ id: def.id, label: def.label, icon: <AddableIcon icon={def.icon} size={13} /> })),
          ];
          // "More filters" left panel — everything except the fields with their own button
          const moreFilterCats = filterCats.filter(c => !['type', 'status', 'assignee'].includes(c.id));

          // Helper: is a category active?
          const isCatActive = (catId: string) => {
            if (catId === 'department') return !!deptFilter;
            return !!filters[catId];
          };

          // Right panel content
          const renderRightPanel = () => {
            const cat = filterCategory;

            if (cat === 'type') {
              const selectedVals = filters.type ? filters.type.split(',').map((v: string) => v.trim()).filter(Boolean) : [];
              const toggle = (val: string) => {
                const next = selectedVals.includes(val) ? selectedVals.filter((v: string) => v !== val) : [...selectedVals, val];
                if (next.length === 0) clearFilter('type'); else setFilter('type', next.join(','));
              };
              const allTypes: [string, string][] = [['epic','Epic'],['story','Story'],['task','Task'],['bug','Bug'],['subtask','Subtask']];
              const tq = dropdownSearch.trim().toLowerCase();
              const filteredTypes = allTypes.filter(([, lbl]) => lbl.toLowerCase().includes(tq));
              return (
                <div className="flex flex-col max-h-[380px]">
                  <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 text-[12px] text-gray-500">
                    Type <span className="font-semibold text-gray-700">= (equals)</span>
                  </div>
                  <div className="px-2 pt-2 pb-1 flex-shrink-0 relative">
                    <Search size={12} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input autoFocus type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search Type…"
                      className="w-full pl-7 pr-2.5 py-1.5 text-[12.5px] border border-blue-300 rounded-md outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {filteredTypes.length === 0
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredTypes.map(([val, lbl]) => {
                          const checked = selectedVals.includes(val);
                          return (
                            <button key={val} onClick={() => toggle(val)}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${checked ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                              <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </span>
                              <IssueTypeIcon type={val} size={14} />
                              <span>{lbl}</span>
                            </button>
                          );
                        })
                    }
                  </div>
                  <div className="px-3 py-1.5 border-t border-gray-100 text-[11px] text-gray-400 text-right flex-shrink-0">{filteredTypes.length} of {allTypes.length}</div>
                </div>
              );
            }

            if (cat === 'department') {
              const dq2 = dropdownSearch.trim().toLowerCase();
              const filteredDepts = rrDepartments.filter(d => d.toLowerCase().includes(dq2));
              return (
                <div className="flex flex-col max-h-[340px]">
                  <div className="px-2 pt-2 pb-1 flex-shrink-0 relative">
                    <Search size={12} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input autoFocus type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search Department…"
                      className="w-full pl-7 pr-2.5 py-1.5 text-[12.5px] border border-blue-300 rounded-md outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {!dq2 && (
                      <button onClick={() => { setDeptFilter(''); setOpenFilter(null); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${!deptFilter ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <span>All Departments</span>
                        {!deptFilter && <Check size={12} className="ml-auto text-blue-600" />}
                      </button>
                    )}
                    {filteredDepts.length === 0 && dq2
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredDepts.map(dept => (
                          <button key={dept} onClick={() => { setDeptFilter(dept); setOpenFilter(null); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${deptFilter === dept ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                            <span>{dept}</span>
                            {deptFilter === dept && <Check size={12} className="ml-auto text-blue-600" />}
                          </button>
                        ))
                    }
                  </div>
                </div>
              );
            }

            if (cat === 'status') {
              const selectedVals = filters.status ? filters.status.split(',').map((v: string) => v.trim()) : [];
              const toggle = (name: string) => {
                const next = selectedVals.includes(name) ? selectedVals.filter((v: string) => v !== name) : [...selectedVals, name];
                if (next.length === 0) clearFilter('status'); else setFilter('status', next.join(','));
              };
              // Scope to the current queue's own configured workflow (same
              // queueStatuses used by the inline per-row status dropdown)
              // instead of the space's full status list — that list is every
              // status from every department's workflow combined (50+ for a
              // board with several queues), most of which this queue's own
              // tickets can never actually be set to. Falls back to the full
              // list outside a specific queue (All Requests, space-wide).
              const scopedQueue: any = effectiveDept
                ? allCustomQueues.find((q: any) => (q.name || '').toLowerCase() === effectiveDept.toLowerCase())
                : null;
              const scopedStatusList: any[] = scopedQueue?.queueStatuses || [];
              const statusSource: any[] = scopedStatusList.length > 0 ? scopedStatusList : statuses;
              const sq = dropdownSearch.trim().toLowerCase();
              const filteredStatuses = statusSource.filter((s: any) => s.name.toLowerCase().includes(sq));
              return (
                <div className="flex flex-col max-h-[380px]">
                  <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 text-[12px] text-gray-500">
                    Status <span className="font-semibold text-gray-700">= (equals)</span>
                  </div>
                  <div className="px-2 pt-2 pb-1 flex-shrink-0 relative">
                    <Search size={12} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input autoFocus type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search Status…"
                      className="w-full pl-7 pr-2.5 py-1.5 text-[12.5px] border border-blue-300 rounded-md outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {filteredStatuses.length === 0
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredStatuses.map((s: any) => {
                          const checked = selectedVals.includes(s.name);
                          const color = s.color || '#6B7280';
                          return (
                            <button key={s.id} onClick={() => toggle(s.name)}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${checked ? 'bg-blue-50' : ''}`}>
                              <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </span>
                              <span className="text-[11.5px] font-medium px-2 py-0.5 rounded-full border truncate"
                                style={{ backgroundColor: `${color}18`, color, borderColor: `${color}40` }}>
                                {s.name}
                              </span>
                            </button>
                          );
                        })
                    }
                  </div>
                  <div className="px-3 py-1.5 border-t border-gray-100 text-[11px] text-gray-400 text-right flex-shrink-0">{filteredStatuses.length} of {statusSource.length}</div>
                </div>
              );
            }

            if (cat === 'assignee') {
              const aq = assigneeSearch.trim().toLowerCase();
              // Was single-select (picking a person replaced whoever was already
              // selected, closing the dropdown immediately) -- every other
              // multi-value filter in this same panel (Type, Status, Priority)
              // already uses a comma-joined toggle instead, and the backend
              // already accepts a comma-separated assignee list (resolveUserIds
              // splits on it) -- this was the one holdout still limited to one
              // person at a time. __current/__unassigned are special, mutually
              // exclusive with picking specific people (selecting one clears
              // the other kind), same as Jira's own "Unassigned" acting as its
              // own distinct choice rather than combining with named people.
              const selectedIds = filters.assignee && filters.assignee !== '__current' && filters.assignee !== '__unassigned'
                ? filters.assignee.split(',').map((v: string) => v.trim()).filter(Boolean)
                : [];
              // Already-selected people were left in whatever order
              // assigneeFilterMembers happened to arrive in -- for a long
              // roster, an active selection could sit well below the fold,
              // invisible without scrolling every time this dropdown reopens.
              // Same stable-sort fix already applied to the Filters page's
              // own Assignee dropdown: selected people bubble to the top,
              // stable within each group so the rest of the ordering doesn't
              // jump around.
              const filtered = (aq
                ? assigneeFilterMembers.filter((mb: any) => `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(aq) || (mb.email || '').toLowerCase().includes(aq))
                : assigneeFilterMembers
              )
                .map((mb: any, idx: number) => ({ mb, idx, sel: selectedIds.includes(mb.id) ? 0 : 1 }))
                .sort((a: any, b: any) => a.sel - b.sel || a.idx - b.idx)
                .map(({ mb }: any) => mb);
              const toggleAssignee = (id: string) => {
                const next = selectedIds.includes(id) ? selectedIds.filter((v: string) => v !== id) : [...selectedIds, id];
                if (next.length === 0) clearFilter('assignee'); else setFilter('assignee', next.join(','));
              };
              return (
                <div className="flex flex-col max-h-[380px]">
                  <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 text-[12px] text-gray-500">
                    Assignee <span className="font-semibold text-gray-700">in</span>
                  </div>
                  <div className="px-2 pt-2 pb-1 flex-shrink-0">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input autoFocus type="text" value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)}
                        placeholder="Search assignee…" autoComplete="off"
                        className="w-full pl-7 pr-3 py-1.5 text-[12.5px] border border-blue-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white" />
                    </div>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {!aq && <>
                      <button onClick={() => { setFilter('assignee', filters.assignee === '__current' ? '' : '__current'); setAssigneeSearch(''); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.assignee === '__current' ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center flex-shrink-0">
                          <span className="text-[8px] font-bold text-white">{getInitials(user?.firstName, user?.lastName)}</span>
                        </div>
                        <span>Current User</span>
                        {filters.assignee === '__current' && <Check size={11} className="ml-auto text-blue-600" />}
                      </button>
                      <button onClick={() => { setFilter('assignee', filters.assignee === '__unassigned' ? '' : '__unassigned'); setAssigneeSearch(''); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.assignee === '__unassigned' ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <div className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <User size={10} className="text-gray-400" />
                        </div>
                        <span>Unassigned</span>
                        {filters.assignee === '__unassigned' && <Check size={11} className="ml-auto text-blue-600" />}
                      </button>
                      <div className="border-t border-gray-100 mx-2 my-1" />
                    </>}
                    {filtered.map((mb: any) => {
                      const isSelected = selectedIds.includes(mb.id);
                      const colors = ['bg-blue-500','bg-purple-500','bg-green-500','bg-orange-500','bg-rose-500','bg-teal-500','bg-indigo-500'];
                      const color = colors[(mb.firstName?.charCodeAt(0) || 0) % colors.length];
                      return (
                        <button key={mb.id} onClick={() => toggleAssignee(mb.id)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${isSelected ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                          <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                            {isSelected && <Check size={10} className="text-white" strokeWidth={3} />}
                          </span>
                          <div className={`w-5 h-5 rounded-full ${color} flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0`}>
                            {getInitials(mb.firstName, mb.lastName)}
                          </div>
                          <span className="truncate">{mb.firstName} {mb.lastName}</span>
                        </button>
                      );
                    })}
                    {filtered.length === 0 && <p className="px-3 py-4 text-[12.5px] text-gray-400 text-center">No users found</p>}
                  </div>
                </div>
              );
            }

            if (cat === 'priority') {
              const selectedVals = filters.priority ? filters.priority.split(',').map((v: string) => v.trim()) : [];
              const toggle = (val: string) => {
                const next = selectedVals.includes(val) ? selectedVals.filter((v: string) => v !== val) : [...selectedVals, val];
                if (next.length === 0) clearFilter('priority'); else setFilter('priority', next.join(','));
              };
              const pq = dropdownSearch.trim().toLowerCase();
              const filteredPriorities = PRIORITIES.filter(p => p.label.toLowerCase().includes(pq));
              return (
                <div className="flex flex-col max-h-[380px]">
                  <div className="px-2 pt-2 pb-1 flex-shrink-0 relative">
                    <Search size={12} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input autoFocus type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search Priority…"
                      className="w-full pl-7 pr-2.5 py-1.5 text-[12.5px] border border-blue-300 rounded-md outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {filteredPriorities.length === 0
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredPriorities.map(p => {
                          const checked = selectedVals.includes(p.value);
                          return (
                            <button key={p.value} onClick={() => toggle(p.value)}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${checked ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                              <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </span>
                              <PriorityIcon priority={p.value} size={14} />
                              <span>{p.label}</span>
                            </button>
                          );
                        })
                    }
                  </div>
                  <div className="px-3 py-1.5 border-t border-gray-100 text-[11px] text-gray-400 text-right flex-shrink-0">{filteredPriorities.length} of {PRIORITIES.length}</div>
                </div>
              );
            }

            if (cat === 'reporter') {
              const rq = reporterSearch.trim().toLowerCase();
              const filtered = rq
                ? allMembers.filter((mb: any) => `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(rq) || (mb.email || '').toLowerCase().includes(rq))
                : allMembers;
              return (
                <div className="flex flex-col max-h-[340px]">
                  <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input autoFocus type="text" value={reporterSearch} onChange={e => setReporterSearch(e.target.value)}
                        placeholder="Search reporter…"
                        className="w-full pl-7 pr-3 py-1.5 text-[12.5px] border border-blue-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white" />
                    </div>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {!rq && <>
                      <button onClick={() => { setFilter('reporter', '__current'); setReporterSearch(''); setOpenFilter(null); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.reporter === '__current' ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center flex-shrink-0">
                          <span className="text-[8px] font-bold text-white">{getInitials(user?.firstName, user?.lastName)}</span>
                        </div>
                        <span>Current User</span>
                        {filters.reporter === '__current' && <Check size={11} className="ml-auto text-blue-600" />}
                      </button>
                      <div className="border-t border-gray-100 mx-2 my-1" />
                    </>}
                    {filtered.map((mb: any) => {
                      const isSelected = filters.reporter === mb.id;
                      const color = avatarColor(mb.firstName);
                      return (
                        <button key={mb.id} onClick={() => { setFilter('reporter', mb.id); setReporterSearch(''); setOpenFilter(null); }}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${isSelected ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                          <div className={`w-5 h-5 rounded-full ${color} flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0`}>
                            {getInitials(mb.firstName, mb.lastName)}
                          </div>
                          <span className="truncate">{mb.firstName} {mb.lastName}</span>
                          {isSelected && <Check size={11} className="ml-auto flex-shrink-0 text-blue-600" />}
                        </button>
                      );
                    })}
                    {filtered.length === 0 && <p className="px-3 py-4 text-[12.5px] text-gray-400 text-center">No users found</p>}
                  </div>
                </div>
              );
            }

            if (cat === 'label') {
              const selectedVals = filters.label ? filters.label.split(',').map((v: string) => v.trim()) : [];
              const toggle = (lbl: string) => {
                const next = selectedVals.includes(lbl) ? selectedVals.filter((v: string) => v !== lbl) : [...selectedVals, lbl];
                if (next.length === 0) clearFilter('label'); else setFilter('label', next.join(','));
              };
              const lq = dropdownSearch.trim().toLowerCase();
              const filteredLabels = allLabels.filter(l => l.toLowerCase().includes(lq));
              return (
                <div className="flex flex-col max-h-[380px]">
                  <div className="px-2 pt-2 pb-1 flex-shrink-0 relative">
                    <Search size={12} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input autoFocus type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search Label…"
                      className="w-full pl-7 pr-2.5 py-1.5 text-[12.5px] border border-blue-300 rounded-md outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {allLabels.length === 0
                      ? <p className="px-3 py-4 text-[12.5px] text-gray-400 text-center">No labels</p>
                      : filteredLabels.length === 0
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredLabels.map(lbl => {
                          const checked = selectedVals.includes(lbl);
                          return (
                            <button key={lbl} onClick={() => toggle(lbl)}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${checked ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                              <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </span>
                              <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                              <span className="truncate">{lbl}</span>
                            </button>
                          );
                        })
                    }
                  </div>
                  {allLabels.length > 0 && <div className="px-3 py-1.5 border-t border-gray-100 text-[11px] text-gray-400 text-right flex-shrink-0">{filteredLabels.length} of {allLabels.length}</div>}
                </div>
              );
            }

            if (cat === 'created') {
              const dateOpts: [string, string][] = [['today','Today'],['7d','Last 7 days'],['30d','Last 30 days'],['90d','Last 90 days']];
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {dateOpts.map(([val, lbl]) => (
                    <button key={val} onClick={() => { setFilter('created', val); setOpenFilter(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.created === val ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                      <Calendar size={13} className="text-gray-400 flex-shrink-0" />
                      <span>{lbl}</span>
                      {filters.created === val && <Check size={12} className="ml-auto text-blue-600" />}
                    </button>
                  ))}
                </div>
              );
            }

            // Extra field filter (Product Type, Combination, etc.)
            const def = ADDABLE_FILTER_DEFS.find(d => d.id === cat);
            if (def) {
              const isDate = def.id === 'updated' || def.id === 'dueDate';
              const activeVal = filters[cat];
              const selectedVals = activeVal ? activeVal.split(',').map((v: string) => v.trim()).filter(Boolean) : [];
              const toggleMultiVal = (opt: string) => {
                const exists = selectedVals.includes(opt);
                const next = exists ? selectedVals.filter((v: string) => v !== opt) : [...selectedVals, opt];
                if (next.length === 0) clearFilter(cat);
                else { setFilter(cat, next.join(',')); ensureColumnAfterStatus(def.id); }
              };
              const dateLabels: Record<string, string> = {
                today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days',
                overdue: 'Overdue', this_week: 'This week', this_month: 'This month', no_due: 'No due date',
              };
              const dateOptions: [string,string][] = def.id === 'updated'
                ? [['today','Today'],['7d','Last 7 days'],['30d','Last 30 days'],['90d','Last 90 days']]
                : [['overdue','Overdue'],['this_week','This week'],['this_month','This month'],['no_due','No due date']];
              const options = isDate ? [] : (fieldOptions[cat] || []);
              if (isDate) {
                return (
                  <div className="overflow-y-auto max-h-[340px]">
                    {dateOptions.map(([val, lbl]) => (
                      <button key={val} onClick={() => { setFilter(cat, val); ensureColumnAfterStatus(def.id); setOpenFilter(null); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${selectedVals.includes(val) ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <AddableIcon icon={def.icon} size={13} />
                        <span>{lbl}</span>
                        {selectedVals.includes(val) && <Check size={12} className="ml-auto text-blue-600" />}
                      </button>
                    ))}
                  </div>
                );
              }
              const dq = dropdownSearch.toLowerCase();
              const filteredOpts = options.filter((o: string) => o.toLowerCase().includes(dq));
              return (
                <div className="flex flex-col max-h-[340px]">
                  <div className="px-2 pt-2 pb-1 flex-shrink-0">
                    <input type="text" value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)}
                      placeholder="Search…"
                      className="w-full px-2.5 py-1.5 text-[12.5px] border border-gray-200 rounded-md outline-none focus:border-blue-400 placeholder-gray-400" />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {filteredOpts.length === 0
                      ? <p className="px-3 py-3 text-[12.5px] text-gray-400 text-center">No matches</p>
                      : filteredOpts.map((opt: string) => {
                          const checked = selectedVals.includes(opt);
                          return (
                            <button key={opt} onClick={() => toggleMultiVal(opt)}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-blue-50 truncate ${checked ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                              <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'}`}>
                                {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                              </span>
                              <span className="truncate">{opt}</span>
                            </button>
                          );
                        })
                    }
                  </div>
                </div>
              );
            }

            return null;
          };

          // Filter chips for active filters
          // Multi-select fields store comma-separated values — join formatted labels,
          // or collapse to a count once there are more than a couple selected.
          const joinMulti = (vals: string[], formatOne: (v: string) => string): string => {
            if (vals.length <= 2) return vals.map(formatOne).join(', ');
            return `${vals.length} selected`;
          };

          const getChipLabel = (key: string, val: string): string => {
            if (key === 'type') return joinMulti(val.split(','), v => v.charAt(0).toUpperCase() + v.slice(1));
            if (key === 'department') return val;
            if (key === 'status') return joinMulti(val.split(','), v => v);
            if (key === 'priority') return joinMulti(val.split(','), v => getPriorityMeta(v).label);
            if (key === 'assignee') {
              if (val === '__unassigned') return 'Unassigned';
              if (val === '__current') return 'Current User';
              // Multi-select (comma-separated ids) -- same joinMulti collapse-to-
              // count pattern already used above for the other multi-value filters.
              return joinMulti(val.split(','), (id) => {
                const mb = allMembers.find((m: any) => m.id === id);
                return mb ? `${mb.firstName} ${mb.lastName}` : id;
              });
            }
            if (key === 'reporter') {
              if (val === '__current') return 'Current User';
              const mb = allMembers.find((m: any) => m.id === val);
              return mb ? `${mb.firstName} ${mb.lastName}` : val;
            }
            if (key === 'label') return joinMulti(val.split(','), v => v);
            if (key === 'created') return ({ today: 'Today', '7d': 'Last 7d', '30d': 'Last 30d', '90d': 'Last 90d' } as Record<string,string>)[val] || val;
            const def = ADDABLE_FILTER_DEFS.find(d => d.id === key);
            return def ? `${def.label}: ${val}` : val;
          };

          const chips: { key: string; val: string }[] = [];
          if (filters.type) chips.push({ key: 'type', val: filters.type });
          if (deptFilter) chips.push({ key: 'department', val: deptFilter });
          if (filters.status) chips.push({ key: 'status', val: filters.status });
          if (filters.assignee) chips.push({ key: 'assignee', val: filters.assignee });
          if (filters.priority) chips.push({ key: 'priority', val: filters.priority });
          if (filters.reporter) chips.push({ key: 'reporter', val: filters.reporter });
          if (filters.label) chips.push({ key: 'label', val: filters.label });
          if (filters.created) chips.push({ key: 'created', val: filters.created });
          ADDABLE_FILTER_DEFS.forEach(({ id }) => { if (filters[id]) chips.push({ key: id, val: filters[id] }); });

          // Standalone single-panel button — one per quick-access field (Assignee,
          // Status, Request type), matching Jira's toolbar instead of one mega-menu.
          const QuickFilterButton = ({
            catId, label, buttonRef, dropPos, setDropPos,
          }: {
            catId: string; label: string;
            buttonRef: React.RefObject<HTMLButtonElement | null>;
            dropPos: { top: number; left: number } | null;
            setDropPos: (p: { top: number; left: number } | null) => void;
          }) => {
            const isOpen = openFilter === catId;
            const active = isCatActive(catId);
            return (
              <div className="relative flex-shrink-0">
                <button ref={buttonRef}
                  onClick={() => {
                    if (isOpen) { setOpenFilter(null); return; }
                    const rect = buttonRef.current?.getBoundingClientRect();
                    if (rect) setDropPos({ top: rect.bottom + 4, left: rect.left });
                    setFilterCategory(catId);
                    setOpenFilter(catId);
                    setAssigneeSearch('');
                    setDropdownSearch('');
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] rounded-md border transition-colors whitespace-nowrap
                    ${isOpen || active
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
                  <span>{label}</span>
                  <ChevronDown size={11} />
                </button>
                {isOpen && dropPos && (
                  <>
                    <div className="fixed inset-0 z-[9998]" onClick={() => setOpenFilter(null)} />
                    <div className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200"
                      style={{ top: dropPos.top, left: dropPos.left, minWidth: 260 }}
                      onMouseDown={e => e.stopPropagation()}>
                      {renderRightPanel()}
                    </div>
                  </>
                )}
              </div>
            );
          };

          return (
            <>
              <QuickFilterButton catId="assignee" label="Assignee" buttonRef={assigneeFilterRef} dropPos={assigneeDropPos} setDropPos={setAssigneeDropPos} />
              <QuickFilterButton catId="status" label="Status" buttonRef={statusFilterRef} dropPos={statusDropPos} setDropPos={setStatusDropPos} />
              <QuickFilterButton catId="type" label="Request type" buttonRef={typeFilterRef} dropPos={typeDropPos} setDropPos={setTypeDropPos} />

              {/* Active filter chips -- moved here (right after the fixed quick-filter
                  buttons, before "More filters") instead of trailing after every other
                  toolbar control, so a field added from More filters shows up grouped
                  with the rest of the active filtering, not hidden past it. */}
              {chips.map(chip => (
                <span key={chip.key} className="flex items-center gap-1 pl-0.5 pr-1 py-1 text-[11.5px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full whitespace-nowrap flex-shrink-0 font-medium">
                  <button
                    title="Click to change this filter's values"
                    onClick={(e) => {
                      // Single-panel editor (same bare renderRightPanel() the
                      // Assignee/Status/Request type buttons already use) instead
                      // of reopening the full "browse all fields" two-panel menu
                      // -- once a filter is already active, editing its value
                      // shouldn't require seeing the whole field list beside it
                      // again, same as clicking any of those three buttons never
                      // shows one either.
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setAddFilterDropPos({ top: rect.bottom + 4, left: rect.left });
                      setFilterCategory(chip.key === 'department' ? 'department' : chip.key);
                      setOpenFilter('__chipEdit');
                      setAssigneeSearch(''); setReporterSearch(''); setDropdownSearch('');
                    }}
                    className="max-w-[120px] truncate px-1.5 py-0.5 rounded-full hover:bg-blue-100 transition-colors">
                    {getChipLabel(chip.key, chip.val)}
                  </button>
                  <button onClick={() => {
                    if (chip.key === 'department') setDeptFilter('');
                    else clearFilter(chip.key);
                  }} className="hover:text-blue-900 flex-shrink-0"><X size={10} /></button>
                </span>
              ))}
              {openFilter === '__chipEdit' && addFilterDropPos && (
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setOpenFilter(null)} />
                  <div className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200"
                    style={{ top: addFilterDropPos.top, left: addFilterDropPos.left, minWidth: 260 }}
                    onMouseDown={e => e.stopPropagation()}>
                    {renderRightPanel()}
                  </div>
                </>
              )}

              {/* More filters button — everything else, still a two-panel category menu */}
              <div className="relative flex-shrink-0">
                <button ref={addFilterRef}
                  onClick={() => {
                    if (openFilter === '__filterPanel') { setOpenFilter(null); return; }
                    const rect = addFilterRef.current?.getBoundingClientRect();
                    if (rect) setAddFilterDropPos({ top: rect.bottom + 4, left: rect.left });
                    // Land on a category that actually lives in this menu
                    if (!moreFilterCats.some(c => c.id === filterCategory)) {
                      setFilterCategory(moreFilterCats[0]?.id || 'priority');
                    }
                    setOpenFilter('__filterPanel');
                    setAssigneeSearch('');
                    setReporterSearch('');
                    setDropdownSearch('');
                    setFilterCatSearch('');
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] rounded-md border transition-colors whitespace-nowrap
                    ${openFilter === '__filterPanel' || activeFilterCount > 0
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
                  <span>More filters</span>
                  {activeFilterCount > 0 && (
                    <span className="ml-0.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0">
                      {activeFilterCount}
                    </span>
                  )}
                  <ChevronDown size={11} />
                </button>

                {/* Two-panel dropdown */}
                {openFilter === '__filterPanel' && addFilterDropPos && (
                  <>
                    <div className="fixed inset-0 z-[9998]" onClick={() => { setOpenFilter(null); }} />
                    <div className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200 flex"
                      style={{ top: addFilterDropPos.top, left: addFilterDropPos.left, minWidth: 440 }}
                      onMouseDown={e => e.stopPropagation()}>

                      {/* Left panel — categories */}
                      <div className="w-[180px] border-r border-gray-100 flex-shrink-0 flex flex-col max-h-[380px]">
                        <div className="px-3 pt-2 pb-1.5 flex-shrink-0">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Filters</p>
                          <div className="relative">
                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                            <input autoFocus type="text" value={filterCatSearch} onChange={e => setFilterCatSearch(e.target.value)}
                              placeholder="Search filters…"
                              className="w-full pl-7 pr-2.5 py-1.5 text-[12px] border border-gray-200 rounded-md outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 placeholder-gray-400" />
                          </div>
                        </div>
                        <div className="overflow-y-auto flex-1 pb-1.5">
                          {(() => {
                            const fq = filterCatSearch.trim().toLowerCase();
                            const visibleCats = fq ? moreFilterCats.filter(c => c.label.toLowerCase().includes(fq)) : moreFilterCats;
                            if (visibleCats.length === 0) return <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No matching filters</p>;
                            return visibleCats.map(cat => {
                              const active = isCatActive(cat.id);
                              const isSelected = filterCategory === cat.id;
                              return (
                                <button key={cat.id}
                                  onClick={() => { setFilterCategory(cat.id); setAssigneeSearch(''); setReporterSearch(''); setDropdownSearch(''); }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors text-left
                                    ${isSelected ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}
                                    ${active && !isSelected ? 'text-blue-600' : ''}`}>
                                  <span className="flex-shrink-0 text-gray-400">{cat.icon}</span>
                                  <span className="flex-1 truncate">{cat.label}</span>
                                  {active && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
                                </button>
                              );
                            });
                          })()}
                        </div>
                      </div>

                      {/* Right panel — options for selected category, header matches
                          the "Field = (equals)" style used by the Type/Status/Assignee
                          quick-filter buttons so every filter dropdown looks consistent. */}
                      <div className="flex-1 min-w-[200px] max-w-[260px]">
                        <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between gap-2">
                          <p className="text-[12px] text-gray-500 truncate">
                            {moreFilterCats.find(c => c.id === filterCategory)?.label || ''} <span className="font-semibold text-gray-700">= (equals)</span>
                          </p>
                          {isCatActive(filterCategory) && (
                            <button onClick={() => {
                              if (filterCategory === 'department') setDeptFilter('');
                              else clearFilter(filterCategory);
                            }} className="text-[11px] text-red-400 hover:text-red-600 transition-colors flex-shrink-0">Clear</button>
                          )}
                        </div>
                        {renderRightPanel()}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          );
        })()}

        {/* Columns toggle */}
        <div className="relative flex-shrink-0">
          <button ref={columnsFilterRef}
            onClick={() => setOpenFilter(openFilter === 'columns' ? null : 'columns')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] rounded-md border transition-colors whitespace-nowrap ${openFilter === 'columns' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="4" height="14" rx="1" fill="currentColor" fillOpacity="0.7"/>
              <rect x="6" y="1" width="4" height="14" rx="1" fill="currentColor" fillOpacity="0.5"/>
              <rect x="11" y="1" width="4" height="14" rx="1" fill="currentColor" fillOpacity="0.3"/>
            </svg>
            Columns
            <ChevronDown size={11} />
          </button>
          {openFilter === 'columns' && (
            <InlineDropdown onClose={() => setOpenFilter(null)} triggerRef={columnsFilterRef} width={230}>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Toggle Columns</div>
              <div className="max-h-[380px] overflow-y-auto">
                <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">System Fields</div>
                {STATIC_COLUMNS.map(col => (
                  <button key={col.id} onClick={() => toggleCol(col.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-[7px] text-[12.5px] text-gray-700 hover:bg-gray-50 transition-colors">
                    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${visibleCols.includes(col.id) ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'}`}>
                      {visibleCols.includes(col.id) && <Check size={10} className="text-white" />}
                    </span>
                    {col.label}
                  </button>
                ))}
                {customFieldCols.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-t border-gray-100 mt-1">Custom Fields</div>
                    {customFieldCols.map(col => (
                      <button key={col.id} onClick={() => toggleCol(col.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-[7px] text-[12.5px] text-gray-700 hover:bg-gray-50 transition-colors">
                        <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${visibleCols.includes(col.id) ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'}`}>
                          {visibleCols.includes(col.id) && <Check size={10} className="text-white" />}
                        </span>
                        {col.label}
                      </button>
                    ))}
                  </>
                )}
              </div>
              <div className="px-3 py-2 border-t border-gray-100 flex gap-2">
                <button onClick={() => setVisibleCols(DEFAULT_COLS)}
                  className="flex-1 text-[11.5px] text-gray-500 border border-gray-200 rounded px-2 py-1 hover:bg-gray-50">Reset</button>
                <button onClick={() => setVisibleCols(ALL_COLUMNS.map(c => c.id))}
                  className="flex-1 text-[11.5px] text-blue-600 border border-blue-200 rounded px-2 py-1 hover:bg-blue-50">All</button>
              </div>
            </InlineDropdown>
          )}
        </div>

        {/* Clear all filters */}
        {(Object.keys(filters).length > 0 || search) && (
          <button onClick={clearAllFilters} className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-md hover:bg-red-50 transition-colors">
            <X size={11} /> Clear
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-gray-400">
            {(isFetching || isQueuesLoading) ? 'Loading…' : `${filteredIssues.length} issue${filteredIssues.length !== 1 ? 's' : ''}`}
          </span>
          <button
            onClick={() => {
              setRefreshing(true);
              try {
                // Same fix as bulk delete — re-run the main load effect's own
                // dept/filter-scoped params instead of a partial rebuild that
                // used to drop dept/excludeDone scoping on refresh.
                clearIssuesCache();
                bumpIssuesVersion();
              } finally {
                setRefreshing(false);
              }
            }}
            disabled={refreshing || isFetching}
            title="Refresh"
            className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-40">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>}

      {/* ── Closed Tickets view ── */}
      {queueFilter === 'dept_closed' && (
        <div className="flex-1 overflow-auto bg-gray-50 p-4">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="grid px-4 py-2 bg-gray-50 border-b border-gray-200 text-[10.5px] font-semibold text-gray-500 uppercase tracking-wide"
              style={{ gridTemplateColumns: '110px minmax(200px,1fr) 140px 140px 110px 110px' }}>
              <div>Key</div>
              <div>Summary</div>
              <div>Status</div>
              <div>Assignee</div>
              <div>SLA Used</div>
              <div>Closed At</div>
            </div>
            {loading && (
              <div className="py-16 flex items-center justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-blue-200 border-t-blue-600 rounded-full" />
              </div>
            )}
            {!loading && closedIssues.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-[13px] text-gray-500 font-medium">No closed tickets found</p>
                <p className="text-[12px] text-gray-400 mt-1">Tickets processed through this queue will appear here</p>
              </div>
            )}
            {closedIssues.map((issue: any) => {
              const slaLog = issue.dept_sla_log || {};
              const deptKey = Object.keys(slaLog).find(k => k.toLowerCase() === (issue.dept_name || '').toLowerCase()) || issue.dept_name;
              const elapsedMs: number = slaLog[deptKey]?.elapsed_ms || 0;
              const fmtMs = (ms: number) => {
                if (!ms || ms < 60000) return ms > 0 ? `${Math.floor(ms / 1000)}s` : '—';
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                return h > 0 ? `${h}h ${m}m` : `${m}m`;
              };
              return (
              // Carries which queue this "Worked on" row was opened from, so the
              // issue detail page can show THIS queue's own frozen status/assignee
              // snapshot (matching what this list itself already shows, per
              // dept_statuses above) instead of the ticket's current live global
              // state if it's since moved to a different department.
              <a key={issue.id} href={`/issues/${issue.cfKey ?? issue.key}?viewDept=${encodeURIComponent(deptParam)}`}
                className="grid px-4 py-3 border-b border-gray-100 hover:bg-blue-50 transition-colors cursor-pointer items-center"
                style={{ gridTemplateColumns: '110px minmax(200px,1fr) 140px 140px 110px 110px' }}>
                <span className="text-[12px] font-semibold text-blue-600 font-mono">{issue.cfKey ?? issue.key}</span>
                <span className="text-[12.5px] text-gray-800 truncate">{issue.title || issue.summary}</span>
                <span className="flex items-center gap-1.5">
                  {issue.status_name && (() => {
                    const sc = resolveStatusColor({ name: issue.status_name, color: issue.status_color, category: issue.status_category });
                    return (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border"
                        style={{ borderColor: sc, color: sc, backgroundColor: sc + '18' }}>
                        {issue.status_name}
                      </span>
                    );
                  })()}
                </span>
                <span className="text-[12px] text-gray-600 truncate">
                  {issue.assignee_name?.trim() || <span className="text-gray-400 italic">Unassigned</span>}
                </span>
                <span className="text-[12px] font-medium text-amber-700">{fmtMs(elapsedMs)}</span>
                <span className="text-[11.5px] text-gray-400">
                  {issue.closed_at ? new Date(issue.closed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                </span>
              </a>
              );
            })}
          </div>
        </div>
      )}

      {queueFilter !== 'summary' && queueFilter !== 'queues' && queueFilter !== 'dept_closed' && <>
      {/* ── Bulk action bar (admin only) ── */}
      {isAdmin && selectedRows.size > 0 && (() => { const activeCount = issues.filter(i => selectedRows.has(i.id)).length; return activeCount > 0 ? (
        <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 border-b border-blue-200">
          <span className="text-sm font-medium text-blue-700">{activeCount} selected</span>
          <button
            onClick={handleBulkDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Delete
          </button>
          <button
            onClick={() => setSelectedRows(new Set())}
            className="text-xs text-blue-600 hover:text-blue-800 underline">
            Clear selection
          </button>
        </div>
      ) : null; })()}

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto bg-[#F4F5F7]">
        <div style={{ minWidth: `${tableMinWidth}px` }}>
          {/* Table header */}
          <div className="grid items-center px-4 py-2 bg-[#FAFBFC] border-b border-[#DFE1E6] sticky top-0 z-10"
            style={{ gridTemplateColumns: gridCols }}>
            <div className="flex items-center justify-center" onClick={isAdmin ? toggleAll : undefined}>
              {isAdmin && (() => {
                const allChecked = selectedRows.size === issues.length && issues.length > 0;
                return (
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-colors
                    ${allChecked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-400 hover:border-blue-400'}`}>
                    {allChecked && <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                );
              })()}
            </div>
            {['Type', 'Key', 'Summary',
              ...orderedVisibleCols.map(c => c.label)
            ].map(h => (
              <div key={h} className="text-[10.5px] font-semibold text-gray-500 uppercase tracking-wide px-2">{h}</div>
            ))}
          </div>

          {/* Rows */}
          {queueFilter === 'sent-watching' ? (
            <div className="p-4 space-y-3">
              {filteredIssues.length === 0 && !loading && (
                <div className="bg-white rounded-xl border border-dashed border-gray-200 py-16 text-center">
                  <p className="text-[14px] text-gray-500 font-medium">No tickets currently out with other teams</p>
                  <p className="text-[12.5px] text-gray-400 mt-1">Tickets you send to Dev or QA will appear here</p>
                </div>
              )}
              {loading && (
                <div className="bg-white rounded-xl border border-gray-100 py-16 flex items-center justify-center">
                  <div className="animate-spin w-6 h-6 border-2 border-blue-200 border-t-blue-600 rounded-full" />
                </div>
              )}
              {filteredIssues.map(issue => {
                const currentDept = (issue as any).current_department || '';
                const deptLower = currentDept.toLowerCase();
                const deptBadge = deptLower === 'dev'
                  ? 'bg-blue-100 text-blue-700 border-blue-200'
                  : deptLower === 'qa'
                  ? 'bg-purple-100 text-purple-700 border-purple-200'
                  : 'bg-gray-100 text-gray-600 border-gray-200';
                const deptAssignees: Record<string, any> = (issue as any).dept_assignees || {};
                const currentAssignee = deptAssignees[currentDept];
                const assigneeName = currentAssignee
                  ? `${currentAssignee.firstName || ''} ${currentAssignee.lastName || ''}`.trim()
                  : null;
                // "Assigned to" above is whoever holds it in its CURRENT department --
                // useful, but doesn't answer this page's own question: who from OUR
                // side (deptParam, the queue this Sent/Watching list belongs to) is
                // the one actually watching it. That's this dept's own saved snapshot
                // from right before it left, same dept_assignees map keyed the other
                // way around.
                const watchingDeptKey = Object.keys(deptAssignees).find(
                  (k) => k.toLowerCase() === deptParam.toLowerCase()
                );
                const watchingAssignee = watchingDeptKey ? deptAssignees[watchingDeptKey] : null;
                const watchingName = watchingAssignee
                  ? `${watchingAssignee.firstName || ''} ${watchingAssignee.lastName || ''}`.trim()
                  : null;
                // Sent/Watching exists so the sending dept can watch what happens to a
                // ticket after it leaves — always show the real current status, not a
                // frozen snapshot of whatever it was right before the transfer. That
                // snapshot used to be shown for every non-"done" status too, so once
                // the receiving dept moved the ticket along (e.g. To Do -> In Progress)
                // this view kept showing the old pre-transfer status forever.
                //
                // getIssueStatus alone reads only the global statusId, which can lag
                // behind the receiving dept's own per-dept status (dept_statuses) --
                // the same stale-status class of bug getEffectiveIssueStatus already
                // exists to fix everywhere else in the app (see its own comment in
                // lib/utils.ts), just never applied to this specific card before.
                const st = getEffectiveIssueStatus(issue as any);
                const stColor = st ? resolveStatusColor(st) : '#6B7280';
                // Last comment from issue (if comments loaded)
                const comments: any[] = (issue as any).comments || [];
                const lastComment = comments.length > 0 ? comments[comments.length - 1] : null;
                // Paused SLA (computed by API from SLA definitions)
                const pausedSla: any = (issue as any).paused_sla || null;
                const fmtDuration = (ms: number) => {
                  if (!ms || ms < 0) return '0m';
                  const h = Math.floor(ms / 3600000);
                  const m = Math.floor((ms % 3600000) / 60000);
                  const s = Math.floor((ms % 60000) / 1000);
                  if (h > 0) return `${h}h ${m}m`;
                  if (m > 0) return `${m}m ${s}s`;
                  return `${s}s`;
                };
                const slaIsPaused = !!pausedSla;
                const pausedElapsedMs: number = pausedSla?.elapsed_ms || 0;
                return (
                  <div key={issue.id}
                    className="bg-white rounded-xl border border-gray-150 shadow-sm hover:shadow-md hover:border-blue-200 transition-all cursor-pointer group"
                    onClick={() => { router.push(`/issues/${issue.cfKey ?? issue.key}`); }}>
                    {/* Card top row */}
                    <div className="flex items-start gap-3 px-4 pt-4 pb-3">
                      {/* Main content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-[12px] text-blue-600 font-semibold font-mono">{issue.cfKey ?? issue.key}</span>
                          {/* Transferred-to queue */}
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${deptBadge}`} title="Transferred to this queue">→ {currentDept || '—'}</span>
                          {/* Status */}
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border"
                            style={{ background: stColor + '18', color: stColor, borderColor: stColor + '40' }}>
                            {st?.name || 'Open'}
                          </span>
                        </div>
                        <p className="text-[13.5px] font-medium text-gray-800 group-hover:text-blue-700 line-clamp-1">{issue.summary}</p>
                      </div>
                      {/* Recall */}
                      <div className="flex-shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => recallIssue(issue.key)}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-orange-50 text-orange-600 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors">
                          ↩ Recall
                        </button>
                      </div>
                    </div>

                    {/* Info row */}
                    <div className="flex items-center gap-4 px-4 pb-3 border-t border-gray-50 pt-2.5 flex-wrap">
                      {/* Reporter */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10.5px] text-gray-400 font-medium uppercase tracking-wide">Reporter</span>
                        {issue.reporter ? (
                          <div className="flex items-center gap-1">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white bg-blue-500`}>
                              {`${(issue.reporter.firstName||'')[0]||''}${(issue.reporter.lastName||'')[0]||''}`.toUpperCase()}
                            </div>
                            <span className="text-[12px] text-gray-600">{issue.reporter.firstName} {issue.reporter.lastName}</span>
                          </div>
                        ) : <span className="text-[12px] text-gray-400">—</span>}
                      </div>
                      {/* Divider */}
                      <div className="h-3 w-px bg-gray-200" />
                      {/* Assigned to in that dept */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10.5px] text-gray-400 font-medium uppercase tracking-wide">Assigned to</span>
                        {assigneeName ? (
                          <div className="flex items-center gap-1">
                            <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center text-[8px] font-bold text-white">
                              {assigneeName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0,2)}
                            </div>
                            <span className="text-[12px] text-gray-600">{assigneeName}</span>
                          </div>
                        ) : (
                          // Just "Unassigned" -- the actual current status (shown as its
                          // own badge above, now reading the correct per-dept snapshot)
                          // already answers "what's happening with it"; a second, separate
                          // hardcoded "waiting for X" phrase here could say something that
                          // doesn't match that badge (e.g. it's already been picked up and
                          // moved past Open, but this still said "waiting").
                          <span className="text-[12px] text-gray-400 italic">Unassigned</span>
                        )}
                      </div>
                      {/* Divider */}
                      <div className="h-3 w-px bg-gray-200" />
                      {/* Who from OUR queue (deptParam) is watching this -- our own
                          saved assignee snapshot from right before it left, distinct
                          from "Assigned to" above (whoever holds it in ITS CURRENT
                          department right now). */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10.5px] text-gray-400 font-medium uppercase tracking-wide">Watching</span>
                        {watchingName ? (
                          <div className="flex items-center gap-1">
                            <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center text-[8px] font-bold text-white">
                              {watchingName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0,2)}
                            </div>
                            <span className="text-[12px] text-gray-600">{watchingName}</span>
                          </div>
                        ) : (
                          <span className="text-[12px] text-gray-400 italic">—</span>
                        )}
                      </div>
                    </div>

                    {/* Paused SLA panel — how much was worked, when it paused, how much remains */}
                    {slaIsPaused && pausedSla && (
                      <div className={`mx-4 mb-2 rounded-lg border px-3 py-2 ${pausedSla.isBreached ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={pausedSla.isBreached ? '#dc2626' : '#d97706'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
                            <span className={`text-[11.5px] font-bold ${pausedSla.isBreached ? 'text-red-700' : 'text-amber-700'}`}>
                              SLA Paused — {pausedSla.policyName}
                            </span>
                          </div>
                          <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full ${pausedSla.isBreached ? 'bg-red-100 text-red-700 border border-red-300' : 'bg-green-100 text-green-700 border border-green-300'}`}>
                            {pausedSla.isBreached ? '⚠ BREACHED' : '✓ On Track'}
                          </span>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="flex flex-col">
                            <span className="text-[9.5px] uppercase tracking-wide text-gray-400 font-medium">Time Worked</span>
                            <span className={`text-[13px] font-bold ${pausedSla.isBreached ? 'text-red-600' : 'text-amber-600'}`}>{fmtDuration(pausedSla.elapsed_ms)}</span>
                          </div>
                          <div className="h-6 w-px bg-gray-200" />
                          <div className="flex flex-col">
                            <span className="text-[9.5px] uppercase tracking-wide text-gray-400 font-medium">Actual SLA</span>
                            <span className="text-[13px] font-bold text-gray-600">{fmtDuration(pausedSla.goalDurationMs)}</span>
                          </div>
                          <div className="h-6 w-px bg-gray-200" />
                          <div className="flex flex-col">
                            <span className="text-[9.5px] uppercase tracking-wide text-gray-400 font-medium">Paused At</span>
                            <span className="text-[13px] font-bold text-gray-600" title={pausedSla.paused_at ? timeAgo(pausedSla.paused_at) : undefined}>
                              {pausedSla.paused_at
                                ? new Date(pausedSla.paused_at).toLocaleString('en-GB', {
                                    day: '2-digit', month: 'short', year: 'numeric',
                                    hour: '2-digit', minute: '2-digit', hour12: false,
                                  })
                                : '—'}
                            </span>
                          </div>
                          <div className="h-6 w-px bg-gray-200" />
                          <div className="flex flex-col">
                            <span className="text-[9.5px] uppercase tracking-wide text-gray-400 font-medium">{pausedSla.isBreached ? 'Overdue By' : 'Remaining'}</span>
                            <span className={`text-[13px] font-bold ${pausedSla.isBreached ? 'text-red-600' : 'text-green-600'}`}>
                              {pausedSla.isBreached ? fmtDuration(pausedSla.elapsed_ms - pausedSla.goalDurationMs) : fmtDuration(pausedSla.remainingMs)}
                            </span>
                          </div>
                        </div>
                        {/* Progress bar */}
                        <div className="mt-2 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${pausedSla.isBreached ? 'bg-red-500' : 'bg-amber-400'}`}
                            style={{ width: `${Math.min(100, (pausedSla.elapsed_ms / pausedSla.goalDurationMs) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Composer, reused for both the general "Add a comment" slot at
                        the bottom and an inline Reply opened right under a specific
                        comment -- same instance either way, just a different mount
                        point, so Cancel/Send/upload-state never has to know which. */}
                    {(() => {
                      const renderComposer = () => (
                        <div className="border border-blue-200 rounded-xl overflow-hidden shadow-sm bg-white">
                          <RichTextEditor
                            value={richCommentHtml}
                            onChange={html => { setRichCommentHtml(html); setCommentText(html.replace(/<[^>]+>/g,'').trim()); }}
                            placeholder="Write a comment… (Ctrl+Enter to send)"
                            minHeight="80px"
                            compact
                            members={members}
                            onUploadingChange={setIsUploadingSentComment}
                          />
                          <div className="flex items-center justify-between px-3 pb-2.5 border-t border-gray-100 pt-2 bg-gray-50">
                            <span className="text-[11px] text-gray-400">Ctrl+Enter to send · Esc to cancel</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => { setCommentingOn(null); setReplyingToCommentId(null); setCommentText(''); setRichCommentHtml(''); }}
                                className="px-3 py-1.5 text-[12px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">
                                Cancel
                              </button>
                              <button
                                onClick={() => submitComment(issue.key)}
                                disabled={!commentText.trim() || submittingComment || isUploadingSentComment}
                                className="px-4 py-1.5 text-[12px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                                {submittingComment && <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                                {isUploadingSentComment ? 'Uploading…' : 'Send'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                      return (
                        <>
                          {/* Full comment thread */}
                          {comments.length > 0 && (
                            <div className="mx-4 mb-3 flex flex-col gap-1.5">
                              {comments.map((c: any, ci: number) => {
                                const firstName = c.author?.firstName || c.authorName?.split(' ')[0] || '?';
                                const initials = firstName[0]?.toUpperCase() || '?';
                                const cleanBody = (c.body || '').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
                                return (
                                  <div key={c.id || ci}>
                                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 group/comment">
                                      <div className="w-5 h-5 rounded-full bg-blue-200 flex items-center justify-center text-[8px] font-bold text-blue-700 flex-shrink-0 mt-0.5">
                                        {initials}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                          <span className="text-[11px] font-semibold text-blue-700">{firstName}</span>
                                          <span className="text-[11px] text-blue-400">·</span>
                                          <span className="text-[11px] text-blue-400">{timeAgo(c.createdAt)}</span>
                                        </div>
                                        <p className="text-[12px] text-gray-700 whitespace-pre-wrap break-words">{cleanBody || '...'}</p>
                                        <CommentReactions
                                          reactions={c.reactions}
                                          currentUserId={user?.id}
                                          onToggle={(emoji) => handleToggleReaction(issue.key, c.id, emoji)}
                                          className="mt-0.5"
                                        />
                                        {/* Jira-style reply -- no real threading here either, same
                                            @mention convention as the main ticket page's own Reply. */}
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const authorId = c.author?.id || c.authorId;
                                            const mentionHtml = authorId
                                              ? buildMentionHtml({ id: authorId, firstName: c.author?.firstName, lastName: c.author?.lastName, email: c.author?.email ?? c.authorEmail })
                                              : (firstName !== '?' ? `@${firstName} ` : '');
                                            setCommentingOn(issue.key);
                                            setReplyingToCommentId(c.id);
                                            setRichCommentHtml(mentionHtml);
                                            setCommentText(mentionHtml.replace(/<[^>]+>/g, '').trim());
                                          }}
                                          className="mt-0.5 text-[10.5px] text-blue-400 hover:text-blue-600 opacity-0 group-hover/comment:opacity-100 transition-opacity"
                                        >
                                          Reply
                                        </button>
                                      </div>
                                    </div>
                                    {/* Inline reply box -- directly under THIS comment. */}
                                    {commentingOn === issue.key && replyingToCommentId === c.id && (
                                      <div className="mt-1.5" onClick={e => e.stopPropagation()}>
                                        {renderComposer()}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {/* General "Add a comment" slot -- only shows the composer here
                              when it's a plain new comment, not a reply to a specific one
                              (that renders inline above instead). */}
                          <div className="mx-4 mb-3" onClick={e => e.stopPropagation()}>
                            {commentingOn === issue.key && replyingToCommentId === null ? (
                              renderComposer()
                            ) : commentingOn !== issue.key ? (
                              <button
                                onClick={() => { setCommentingOn(issue.key); setReplyingToCommentId(null); setCommentText(''); setRichCommentHtml(''); }}
                                className="flex items-center gap-2 w-full px-3 py-2 rounded-xl border border-dashed border-gray-200 text-[12.5px] text-gray-400 hover:border-blue-300 hover:text-blue-500 hover:bg-blue-50 transition-colors group/cmt">
                                <div className="w-6 h-6 rounded-full bg-gray-100 group-hover/cmt:bg-blue-100 flex items-center justify-center flex-shrink-0 transition-colors">
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                </div>
                                <span>Add a comment…</span>
                              </button>
                            ) : null}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="divide-y divide-gray-100">
            {filteredIssues.map(issue => {
              const t = typeIcons[issue.type] || typeIcons.task;
              const pm = getPriorityMeta(issue.priority ?? 'medium');
              // Show the status for the dept the ticket is currently in (from dept_statuses)
              const deptStatusMap: Record<string, any> = (issue as any).dept_statuses || {};
              const ticketCurrentDept: string = (issue as any).current_department || '';
              const deptSt = ticketCurrentDept && deptStatusMap[ticketCurrentDept]
                ? deptStatusMap[ticketCurrentDept]
                : null;
              const st = deptSt || getIssueStatus(issue);
              const isUpdating = updating === issue.key;
              const isSelected = selectedRows.has(issue.id);

              const col = (id: string) => visibleCols.includes(id);

              return (
                <div key={issue.id}
                  className={`grid items-center px-4 py-2.5 cursor-pointer transition-colors group
                    ${isUpdating ? 'opacity-50' : ''}
                    ${isSelected ? 'bg-blue-50' : 'bg-[#FAFBFC] hover:bg-gray-50'}`}
                  style={{ gridTemplateColumns: gridCols }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      window.open(`/issues/${issue.cfKey ?? issue.key}`, '_blank');
                    } else {
                      router.push(`/issues/${issue.cfKey ?? issue.key}`);
                    }
                  }}>

                  {/* Checkbox (admin only) */}
                  <div className="flex items-center justify-center" onClick={isAdmin ? (e => toggleRow(e, issue.id)) : undefined}>
                    {isAdmin && (
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-colors flex-shrink-0
                        ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-400 group-hover:border-blue-400'}`}>
                        {isSelected && <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                    )}
                  </div>
                  {/* Type */}
                  <div className="px-1 flex items-center"><IssueTypeIcon type={issue.type || 'task'} size={14} /></div>
                  {/* Key */}
                  <div className="px-2"><span className="text-[12px] text-blue-600 font-semibold font-mono hover:underline">{issue.cfKey ?? issue.key}</span></div>
                  {/* Summary */}
                  <div className="px-2 min-w-0"><span className="text-[13px] text-gray-800 line-clamp-1 group-hover:text-blue-600 transition-colors">{issue.summary}</span></div>

                  {/* Render columns in orderedVisibleCols order so header and cells always align */}
                  {orderedVisibleCols.map(colDef => {
                    const id = colDef.id;

                    // ── Custom field (cf_xxx) ──
                    if (id.startsWith('cf_')) {
                      const cc = customFieldCols.find(c => c.id === id);
                      if (!cc) return null;
                      const val = cfValuesMap.get(issue.id)?.[cc.fieldId];
                      const isYes = val?.toLowerCase() === 'yes';
                      const isNo  = val?.toLowerCase() === 'no';
                      return (
                        <div key={id} className="px-2">
                          {val ? (
                            isYes ? <span className="text-[11px] font-medium text-red-600 bg-red-50 border border-red-100 rounded px-1.5 py-0.5">Yes</span>
                            : isNo ? <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-100 rounded px-1.5 py-0.5">No</span>
                            : <span className="text-[12px] text-gray-600">{val}</span>
                          ) : <span className="text-[11px] text-gray-300">—</span>}
                        </div>
                      );
                    }

                    // ── Static columns ──
                    if (id === 'reporter') return (
                      <div key={id} className="px-2">
                        {issue.reporter ? (
                          <div className="flex items-center gap-1.5">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0 ${avatarColor(issue.reporter.firstName)}`}>{getInitials(issue.reporter.firstName, issue.reporter.lastName)}</div>
                            <span className="text-[12px] text-gray-600 truncate">{issue.reporter.firstName}</span>
                          </div>
                        ) : <span className="text-[12px] text-gray-300">—</span>}
                      </div>
                    );

                    if (id === 'assignee') {
                    // Dept-aware assignee: when dept filter active, show that dept's assignee
                    const deptMap: Record<string, any> = (issue as any).dept_assignees || {};
                    const activeDept = deptFilter || (queueFilter === 'my-dept' ? mySpaceDept : mySpaceDept);
                    // "Assigned to me" is this viewer's own personal tracking list (how many
                    // tickets they've been assigned/worked, current or past) — a ticket lands
                    // here either because it's currently assigned to them, or because they're
                    // credited with having worked it before it moved on/got reassigned. Showing
                    // the ticket's real current owner (now someone else) in that second case reads
                    // as if the page mislabeled whose list this is; show the viewer's own name
                    // here instead, since by definition every row is "theirs" for this view.
                    const displayAssignee = queueFilter === 'dept_assigned'
                      ? (user ? { firstName: user.firstName, lastName: user.lastName, id: user.id } : issue.assignee)
                      : (activeDept && activeDept in deptMap ? (deptMap[activeDept] ?? issue.assignee) : issue.assignee);
                    return (
                      <div key={id} className="px-2" onClick={e => e.stopPropagation()}>
                        <button onClick={e => toggleDropdown(e, issue.key, 'assignee')}
                          className="flex items-center gap-1.5 hover:bg-gray-100 rounded px-1.5 py-1 transition-colors max-w-full">
                          {displayAssignee ? (<>
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0 ${avatarColor(displayAssignee.firstName)}`}>{getInitials(displayAssignee.firstName, displayAssignee.lastName)}</div>
                            <span className="text-[12px] text-gray-600 truncate">{displayAssignee.firstName}</span>
                          </>) : <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0"><User size={11} className="text-gray-400" /></div>}
                          <ChevronDown size={9} className="text-gray-300 flex-shrink-0" />
                        </button>
                        {openDropdown?.key === issue.key && openDropdown.field === 'assignee' && (
                          <InlineDropdown onClose={() => { setOpenDropdown(null); setInlineAssigneeSearch(''); }} anchorRect={openDropdown.rect}>
                            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Assign to</div>
                            <div className="px-2 py-2 border-b border-gray-100">
                              <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
                                <Search size={12} className="text-gray-400 flex-shrink-0" />
                                <input autoFocus value={inlineAssigneeSearch} onChange={(e) => setInlineAssigneeSearch(e.target.value)}
                                  placeholder="Search assignee…" className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400" />
                                {inlineAssigneeSearch && <button onClick={() => setInlineAssigneeSearch('')}><X size={11} className="text-gray-400 hover:text-gray-600" /></button>}
                              </div>
                            </div>
                            <div className="max-h-52 overflow-y-auto py-1">
                              {!inlineAssigneeSearch && (
                                <button onClick={() => { handleInlineUpdate(issue.key, 'assigneeId', null, { assignee: null }); setInlineAssigneeSearch(''); }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${!issue.assignee ? 'text-blue-600 font-medium' : 'text-gray-500'}`}>
                                  <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center"><User size={10} className="text-gray-400" /></div>
                                  Unassigned {!issue.assignee && <Check size={11} className="ml-auto text-blue-600" />}
                                </button>
                              )}
                              {members
                                .filter((m: any) => {
                                  if (!inlineAssigneeSearch.trim()) return true;
                                  const member = m.user || m;
                                  const name = `${member.firstName || ''} ${member.lastName || ''}`.toLowerCase();
                                  return name.includes(inlineAssigneeSearch.toLowerCase());
                                })
                                .map((m: any) => {
                                  const member = m.user || m;
                                  const isSel = issue.assignee?.email === member.email || issue.assignee?.id === member.id;
                                  return (
                                    <button key={member.id} onClick={() => { handleInlineUpdate(issue.key, 'assigneeId', member.id, { assignee: { id: member.id, firstName: member.firstName, lastName: member.lastName, email: member.email, avatarUrl: member.avatarUrl ?? null } }); setInlineAssigneeSearch(''); }}
                                      className={`w-full flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-gray-50 ${isSel ? 'text-blue-600 font-medium' : 'text-gray-700'}`}>
                                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${avatarColor(member.firstName)}`}>{getInitials(member.firstName, member.lastName)}</div>
                                      <span className="flex-1 text-left truncate">{member.firstName} {member.lastName}</span>
                                      {isSel && <Check size={11} className="ml-auto text-blue-600" />}
                                    </button>
                                  );
                                })}
                              {inlineAssigneeSearch && members.filter((m: any) => {
                                const member = m.user || m;
                                const name = `${member.firstName || ''} ${member.lastName || ''}`.toLowerCase();
                                return name.includes(inlineAssigneeSearch.toLowerCase());
                              }).length === 0 && <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No members found</p>}
                            </div>
                          </InlineDropdown>
                        )}
                      </div>
                    );
                    } // end if (id === 'assignee')

                    if (id === 'priority') return (
                      <div key={id} className="px-2" onClick={e => e.stopPropagation()}>
                        <button onClick={e => toggleDropdown(e, issue.key, 'priority')}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-full border transition-colors hover:opacity-90"
                          style={{ backgroundColor: pm.bg, borderColor: `${pm.color}40`, color: pm.color }}>
                          <PriorityIcon priority={issue.priority} size={12} />
                          <span className="text-[11.5px] font-semibold">{pm.label}</span>
                          <ChevronDown size={9} />
                        </button>
                        {openDropdown?.key === issue.key && openDropdown.field === 'priority' && (
                          <InlineDropdown onClose={() => setOpenDropdown(null)} anchorRect={openDropdown.rect}>
                            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Priority</div>
                            {PRIORITIES.map(p => (
                              <button key={p.value} onClick={() => handleInlineUpdate(issue.key, 'priority', p.value)}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-gray-50 text-gray-700 transition-colors">
                                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border"
                                  style={{ backgroundColor: p.bg, borderColor: `${p.color}40`, color: p.color }}>
                                  <PriorityIcon priority={p.value} size={12} />
                                  <span className="text-[11.5px] font-semibold">{p.label}</span>
                                </span>
                                {issue.priority === p.value && <Check size={11} className="ml-auto text-blue-600" />}
                              </button>
                            ))}
                          </InlineDropdown>
                        )}
                      </div>
                    );

                    if (id === 'status') return (
                      <div key={id} className="px-2" onClick={e => e.stopPropagation()}>
                        <button onClick={e => toggleDropdown(e, issue.key, 'status')}
                          className="flex items-center gap-1 rounded border border-gray-300 bg-gray-100 px-2 py-1 text-[11.5px] font-medium text-gray-800 transition-all hover:bg-gray-200 whitespace-nowrap max-w-[150px] min-w-0">
                          <span className="truncate">{st.name}</span><ChevronDown size={8} className="flex-shrink-0" />
                        </button>
                        {openDropdown?.key === issue.key && openDropdown.field === 'status' && (() => {
                          // If this ticket's current department maps to a configured custom
                          // queue, show THAT queue's statuses/transitions (matching the issue
                          // detail page) instead of the space's full/generic status list —
                          // otherwise this dropdown offers moves the queue's workflow doesn't
                          // even have, and disagrees with what the detail page shows.
                          const rowQueue: any = ticketCurrentDept
                            ? allCustomQueues.find((q: any) => (q.name || '').toLowerCase() === ticketCurrentDept.toLowerCase())
                            : null;
                          const queueStatusList: any[] = rowQueue?.queueStatuses || [];
                          const isQueueStatus = queueStatusList.length > 0;
                          const optionStatuses = isQueueStatus ? queueStatusList : statuses;
                          const optionTransitions: {fromStatusId:string; toStatusId:string}[] = isQueueStatus
                            ? (rowQueue?.queueTransitions || []).map((t: any) => ({ fromStatusId: t.fromStatusId ?? t.from, toStatusId: t.toStatusId ?? t.to }))
                            : ((currentSpace as any).transitions || []);
                          const validIds = optionTransitions.filter(t => t.fromStatusId === st.id).map(t => t.toStatusId);
                          const options = validIds.length > 0 ? optionStatuses.filter(s => validIds.includes(s.id)) : optionStatuses.filter(s => s.id !== st.id);
                          return (
                            <InlineDropdown onClose={() => setOpenDropdown(null)} anchorRect={openDropdown.rect}>
                              <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">Move to</div>
                              {options.map(s => (
                                <button key={s.id} onClick={() => {
                                  if (!issue.assignee) {
                                    setOpenDropdown(null);
                                    setAssigneeRequiredModal(true);
                                    return;
                                  }
                                  if ((s as any).category === 'done') {
                                    const missing = getMissingCoreFieldsInline(issue);
                                    if (missing.length > 0) {
                                      setOpenDropdown(null);
                                      setMissingFieldsModal(missing);
                                      return;
                                    }
                                  }
                                  if (isQueueStatus) {
                                    handleInlineQueueStatusUpdate(issue.key, ticketCurrentDept, s);
                                  } else {
                                    handleInlineUpdate(issue.key, 'statusId', s.id, { status: { id: s.id, name: s.name, category: (s as any).category, color: (s as any).color } });
                                  }
                                }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50 transition-colors">
                                  {s.name}
                                </button>
                              ))}
                            </InlineDropdown>
                          );
                        })()}
                      </div>
                    );

                    if (id === 'sprint') return <div key={id} className="px-2">{(issue as any).sprintName ? <span className="text-[11px] text-gray-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5 truncate max-w-[100px] inline-block">{(issue as any).sprintName}</span> : <span className="text-[11px] text-gray-300">—</span>}</div>;
                    if (id === 'created') return <div key={id} className="px-2 text-[11px] text-gray-500 whitespace-nowrap">{formatJiraDateTime(issue.createdAt)}</div>;
                    if (id === 'updated') return <div key={id} className="px-2 text-[11px] text-gray-500 whitespace-nowrap">{formatJiraDateTime(issue.updatedAt)}</div>;
                    if (id === 'dueDate') return <div key={id} className="px-2 text-[11px] whitespace-nowrap">{issue.dueDate ? <span className={`font-medium ${new Date(issue.dueDate) < new Date() ? 'text-red-500' : 'text-gray-500'}`}>{new Date(issue.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span> : <span className="text-gray-300">—</span>}</div>;
                    if (id === 'breached') return <div key={id} className="px-2">{(issue as any).sla_breached ? <span className="text-[11px] font-medium text-red-600 bg-red-50 border border-red-100 rounded px-1.5 py-0.5">Yes</span> : <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-100 rounded px-1.5 py-0.5">No</span>}</div>;
                    if (id === 'labels') return <div key={id} className="px-2 flex flex-wrap gap-1">{(issue.labels||[]).length > 0 ? ((issue.labels as unknown) as string[]).slice(0,2).map((l:string) => <span key={l} className="text-[10px] bg-blue-50 text-blue-600 border border-blue-100 rounded px-1.5 py-0.5">{l}</span>) : <span className="text-[11px] text-gray-300">—</span>}</div>;
                    if (id === 'storyPoints') return <div key={id} className="px-2">{issue.storyPoints ? <span className="text-[11.5px] font-semibold text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">{issue.storyPoints}</span> : <span className="text-[11px] text-gray-300">—</span>}</div>;
                    if (id === 'workType') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).workType || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'productType') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).productType || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'combination') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).combination || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'customerName') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).customerName || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'clientName') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).manageClientName || (issue as any).clientName || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'projectManager') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).projectManager || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'rootCause') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate max-w-[150px]">{(issue as any).rootCause || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'fixDescription') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate max-w-[150px]">{(issue as any).fixDescription || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'environment') return <div key={id} className="px-2 text-[11px] text-gray-600 truncate">{(issue as any).environment || <span className="text-gray-300">—</span>}</div>;
                    if (id === 'resolvedAt') return <div key={id} className="px-2 text-[11px] text-gray-500 whitespace-nowrap">{(issue as any).resolvedAt ? formatJiraDateTime((issue as any).resolvedAt) : <span className="text-gray-300">—</span>}</div>;
                    if (id === 'department') return <div key={id} className="px-2">{(issue as any).current_department ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">{(issue as any).current_department}</span> : <span className="text-gray-300 text-[11px]">—</span>}</div>;

                    return null;
                  })}
                </div>
              );
            })}

            {filteredIssues.length === 0 && !isFetching && !isQueuesLoading && (
              <div className="bg-white py-16 text-center">
                <CheckCircle2 size={28} className="text-gray-200 mx-auto mb-3" />
                <p className="text-[13px] text-gray-500 font-medium">No issues found</p>
                <button onClick={() => setShowCreate(true)} className="text-[12px] text-blue-600 hover:underline mt-1">Create your first issue</button>
              </div>
            )}

            {(isFetching || isQueuesLoading) && (
              <div className="bg-white py-16 flex items-center justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-blue-200 border-t-blue-600 rounded-full" />
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {/* ── Pagination bar — for All Requests, custom queues, and department-wide queues (a whole department's tickets can run into the thousands) ── */}
      {(queueFilter === 'all-requests' || queueFilter.startsWith('cq_') || queueFilter === 'dept_all' || queueFilter === 'dept_unassigned' || queueFilter === 'dept_assigned') && issueTotal > PAGE_SIZE && (
        <div className="flex items-center justify-between px-6 py-3 bg-white border-t border-gray-200 flex-shrink-0">
          <span className="text-[12px] text-gray-500">
            Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, issueTotal)} of <strong>{issueTotal.toLocaleString()}</strong> issues
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1}
              className="px-2 py-1 text-[12px] rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">«</button>
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
              className="px-3 py-1 text-[12px] rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Prev</button>
            {Array.from({ length: Math.min(5, Math.ceil(issueTotal / PAGE_SIZE)) }, (_, i) => {
              const totalPages = Math.ceil(issueTotal / PAGE_SIZE);
              let start = Math.max(1, currentPage - 2);
              if (start + 4 > totalPages) start = Math.max(1, totalPages - 4);
              const p = start + i;
              if (p > totalPages) return null;
              return (
                <button key={p} onClick={() => setCurrentPage(p)}
                  className={`px-3 py-1 text-[12px] rounded border transition-colors ${p === currentPage ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {p}
                </button>
              );
            })}
            <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(issueTotal / PAGE_SIZE), p + 1))} disabled={currentPage >= Math.ceil(issueTotal / PAGE_SIZE)}
              className="px-3 py-1 text-[12px] rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
            <button onClick={() => setCurrentPage(Math.ceil(issueTotal / PAGE_SIZE))} disabled={currentPage >= Math.ceil(issueTotal / PAGE_SIZE)}
              className="px-2 py-1 text-[12px] rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">»</button>
          </div>
        </div>
      )}
      {/* All open — simple count footer (hidden once the paginated bar above is
          showing a real total, so this doesn't contradict it with just the
          current page's count) */}
      {queueFilter !== 'all-requests' && !(
        ['dept_all', 'dept_unassigned', 'dept_assigned'].includes(queueFilter) && issueTotal > PAGE_SIZE
      ) && (
        <div className="px-6 py-2.5 bg-white border-t border-gray-200 flex-shrink-0">
          <span className="text-[12px] text-gray-400">
            Showing <strong>{filteredIssues.length}</strong> {filters.status ? `"${filters.status}" issues` : 'open issues'}
          </span>
        </div>
      )}
      </>}

      {showCreate && (
        <CreateIssueModal spaceKey={spaceKey} statuses={currentSpace.statuses || []} members={currentSpace.members || []}
          initialDept={
            deptParam
              ? deptParam
              : (queueFilter.startsWith('cq_') && activeCustomQueue?.name)
                ? activeCustomQueue.name
                : undefined
          }
          onClose={() => setShowCreate(false)}
          onCreated={(newIssue) => {
            setShowCreate(false);
            const navKey = newIssue?.cfKey || newIssue?.cf_key || newIssue?.key;
            // Refresh the queue list in the background so it's already
            // correct if/when the user navigates back to it.
            clearIssuesCache();
            bumpIssuesVersion();
            if (navKey) {
              router.push(`/issues/${navKey}`);
            }
          }} />
      )}

      {/* Assignee required popup */}
      {assigneeRequiredModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={() => setAssigneeRequiredModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <h3 className="text-[15px] font-semibold text-gray-900">Assignee Required</h3>
              </div>
              <p className="text-[13px] text-gray-600 mb-5">Please assign this ticket to someone before changing its status.</p>
              <button onClick={() => setAssigneeRequiredModal(false)}
                className="w-full bg-amber-500 hover:bg-amber-600 text-white text-[13px] font-medium py-2 rounded-lg transition-colors">
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {missingFieldsModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={() => setMissingFieldsModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <h3 className="text-[15px] font-semibold text-gray-900">Required fields missing</h3>
              </div>
              <p className="text-[13px] text-gray-600 mb-3">The following fields must be filled in before this ticket can be resolved:</p>
              <ul className="space-y-1.5 mb-5">
                {missingFieldsModal.map(f => (
                  <li key={f} className="text-[13px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5">{f}</li>
                ))}
              </ul>
              <button onClick={() => setMissingFieldsModal(null)}
                className="w-full bg-amber-500 hover:bg-amber-600 text-white text-[13px] font-medium py-2 rounded-lg transition-colors">
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Suspense wrapper — required so useSearchParams() works on hard refresh ──
export default function SpaceDetailPage() {
  return (
    <Suspense fallback={
      <DotLoader className="h-64" />
    }>
      <SpaceDetailContent />
    </Suspense>
  );
}
