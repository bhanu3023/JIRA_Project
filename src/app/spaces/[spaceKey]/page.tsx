'use client';

import { useEffect, useState, useRef, useCallback, useMemo, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { typeIcons, getInitials, getIssueStatus, timeAgo, formatJiraDateTime, resolveStatusColor, getDeptColor } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { trackRecentItem } from '@/lib/recent-items';
import { PriorityIcon, getPriorityMeta, PRIORITIES } from '@/components/ui/PriorityIcon';
import SpaceIcon from '@/components/ui/SpaceIcon';
import DotLoader from '@/components/ui/DotLoader';
import RichTextEditor from '@/components/ui/RichTextEditor';
import {
  Plus, LayoutGrid, Settings, ChevronDown, Check, User,
  Search, CheckCircle2, ClipboardList, X, Tag, Calendar, UserCheck,
  Briefcase, Package, Layers, Monitor, Clock, AlertCircle, Building2, SlidersHorizontal, RefreshCw, BarChart2,
  ChevronRight, Inbox as InboxIcon
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
  const rawKey = params?.spaceKey;
  const spaceKey =
    typeof rawKey === 'string'
      ? rawKey.toUpperCase()
      : Array.isArray(rawKey)
        ? (rawKey[0] || '').toUpperCase()
        : '';
  const { currentSpace, loadSpace, issues, issueTotal, loadIssues, prefetchIssues, clearIssuesCache, loading, user, issuesVersion } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      loadSpace: s.loadSpace,
      issues: s.issues,
      issueTotal: s.issueTotal,
      loadIssues: s.loadIssues,
      prefetchIssues: s.prefetchIssues,
      clearIssuesCache: s.clearIssuesCache,
      loading: s.loading,
      user: s.user,
      issuesVersion: s.issuesVersion,
    })),
  );
  // Static column definitions (always available)
  const STATIC_COLUMNS = [
    { id: 'reporter',       label: 'Reporter',            width: '150px' },
    { id: 'assignee',       label: 'Assignee',            width: '150px' },
    { id: 'priority',       label: 'Priority',            width: '120px' },
    { id: 'status',         label: 'Status',              width: '165px' },
    { id: 'created',        label: 'Created',             width: '150px' },
    { id: 'updated',        label: 'Updated',             width: '150px' },
    { id: 'dueDate',        label: 'Due Date',            width: '120px' },
    { id: 'labels',         label: 'Labels',              width: '130px' },
    { id: 'storyPoints',    label: 'Story Points',        width: '90px'  },
    { id: 'type',           label: 'Type',                width: '100px' },
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
  const [createdToast, setCreatedToast] = useState<{ key: string; cfKey: string } | null>(null);
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
  const fetchClosedIssues = useCallback(async (sk: string, dept: string) => {
    if (!sk || !dept) return;
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') : null;
      const res = await fetch(
        `/api/spaces/${sk}/dept-queue/closed?dept=${encodeURIComponent(dept)}&page=1`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (res.ok) {
        const data = await res.json();
        setClosedIssues(data.issues || []);
      }
    } catch { /* non-fatal */ }
  }, []);
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

  // Load departments from both RR config + Department Routing custom fields
  useEffect(() => {
    if (!spaceKey) return;
    const headers = { Authorization: `Bearer ${localStorage.getItem('jira_token')}` };
    const combined: string[] = [];

    Promise.allSettled([
      fetch(`/api/spaces/${spaceKey}/rr-config`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`/api/custom-fields`, { headers }).then(r => r.ok ? r.json() : null),
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
  }, [spaceKey]);
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
  // Extra ("added") filter fields – persisted per space in localStorage
  const colsStorageKey    = `visibleCols_${spaceKey}`;
  const fieldsStorageKey  = `addedFields_${spaceKey}`;

  const [addedFilterIds, setAddedFilterIds] = useState<string[]>([]);
  const [addFilterDropPos, setAddFilterDropPos] = useState<{ top: number; left: number } | null>(null);
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_COLS);
  const [serverFieldOptions, setServerFieldOptions] = useState<Record<string, string[]>>({});
  const [updating, setUpdating] = useState<string | null>(null);
  const [assigneeRequiredModal, setAssigneeRequiredModal] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  // Reset to page 1 when queue changes
  useEffect(() => { setCurrentPage(1); }, [queueFilter]);

  // Immediately clear stale issues when the queue changes so old tickets never
  // flash while the new fetch is in flight (handles early-return guard cases too)
  useEffect(() => {
    if (queueFilter && queueFilter !== 'queues') {
      useStore.setState({ issues: [], issueTotal: 0 });
    }
  }, [queueFilter]);

  // Fetch distinct values from server whenever addedFilterIds changes
  useEffect(() => {
    if (!spaceKey || addedFilterIds.length === 0) return;
    const textFields = new Set(['workType','productType','combination','testEnvironment','rootCause',
      'fixDescription','customerName','clientName','projectManager','manageClientName','customerPlan']);
    addedFilterIds.forEach(fieldId => {
      if (!textFields.has(fieldId) || serverFieldOptions[fieldId]) return; // already loaded
      fetch(`/api/spaces/${spaceKey}/field-values?field=${fieldId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('jira_token') || ''}` },
      })
        .then(r => r.ok ? r.json() : [])
        .then((vals: string[]) => {
          setServerFieldOptions(prev => ({ ...prev, [fieldId]: vals }));
        })
        .catch(() => {});
    });
  }, [spaceKey, addedFilterIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted columns and added field filters once spaceKey is known
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
    try {
      const savedFields = localStorage.getItem(`addedFields_${spaceKey}`);
      if (savedFields) setAddedFilterIds(JSON.parse(savedFields));
    } catch {}
  }, [spaceKey]);

  // Persist visible columns and added field filters to localStorage
  useEffect(() => {
    if (!spaceKey) return;
    try { localStorage.setItem(colsStorageKey, JSON.stringify(visibleCols)); } catch {}
  }, [visibleCols, colsStorageKey, spaceKey]);

  useEffect(() => {
    if (!spaceKey) return;
    try { localStorage.setItem(fieldsStorageKey, JSON.stringify(addedFilterIds)); } catch {}
  }, [addedFilterIds, fieldsStorageKey, spaceKey]);

  // Dynamic custom-field columns for this space
  const [customFieldCols, setCustomFieldCols] = useState<Array<{ id: string; label: string; width: string; fieldId: string }>>([]);
  const [spaceFieldLabels, setSpaceFieldLabels] = useState<Set<string>>(new Set());
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

  // Combined columns: static + any custom fields assigned to this space
  const ALL_COLUMNS = [...STATIC_COLUMNS, ...customFieldCols];

  const toggleCol = (id: string) =>
    setVisibleCols(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);

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
    loadSpace(spaceKey).catch(() => {
      router.replace('/spaces');
    });
  }, [spaceKey, loadSpace, router]);

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
          // Exclude done issues at DB level for open queues
          if (queueFilter === 'all-open' || queueFilter === 'assigned' || queueFilter === 'unassigned' || queueFilter === 'my-dept' || queueFilter === 'my-queue') {
            params.excludeDone = 'true';
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
          // Dept sub-queue: all open tickets in dept (any assignee)
          if (queueFilter === 'dept_all') {
            params.excludeDone = 'true';
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: unassigned in dept
          if (queueFilter === 'dept_unassigned') {
            params.unassigned = 'true';
            params.excludeDone = 'true';
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: assigned to me in dept
          if (queueFilter === 'dept_assigned') {
            if (user?.id) params.assignee = user.id;
            params.excludeDone = 'true';
            if (deptParam) params.dept = deptParam;
          }
          // Dept sub-queue: closed tickets — fetched separately, auto-refreshed every 30s
          if (queueFilter === 'dept_closed') {
            if (!cancelled) await fetchClosedIssues(spaceKey, deptParam);
            return; // skip normal loadIssues for closed view
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
  }, [spaceKey, currentPage, queueFilter, deptParam, activeCustomQueue, customQueuesLoadedFor, filters, debouncedSearch, loadSpace, loadIssues, clearIssuesCache, fetchClosedIssues, user?.id, issuesVersion]);

  // Auto-refresh Sent/Watching every 15s — silent background refresh, never clears display
  useEffect(() => {
    if (queueFilter !== 'sent-watching' || !spaceKey || !deptParam) return;
    const interval = setInterval(() => {
      const params: Record<string, string> = { spaceKey, page: '1', limit: '100', sentDept: deptParam };
      prefetchIssues(params).catch(() => {});
    }, 15_000);
    return () => clearInterval(interval);
  }, [queueFilter, spaceKey, deptParam, prefetchIssues]);

  // Prefetch common queues once after the space loads so switching feels instant
  // NOTE: queueFilter intentionally NOT in deps — prefetch runs once per space/user,
  // not on every queue switch (which caused stale setTimeout callbacks to overwrite
  // the active queue's data after the user navigated away).
  useEffect(() => {
    if (!spaceKey || !user?.id) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const QUEUES_TO_PREFETCH = ['all-open', 'assigned', 'unassigned', 'my-queue', 'all-requests'];
    QUEUES_TO_PREFETCH.forEach((q, i) => {
      timers.push(setTimeout(() => {
        const p: Record<string, string> = { spaceKey, page: '1', limit: '100' };
        if (q === 'all-open' || q === 'assigned' || q === 'unassigned' || q === 'my-queue') p.excludeDone = 'true';
        if (q === 'unassigned') p.unassigned = 'true';
        if (q === 'assigned' && user?.id) p.assignee = user.id;
        if (q === 'all-requests') { p.limit = '50'; }
        prefetchIssues(p).catch(() => {});
      }, (i + 1) * 1200));
    });
    return () => timers.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceKey, user?.id]);

  // Prefetch every custom queue (Dev/Migration/Bug/etc.) for this space once the queue
  // list is known, so switching between them hits a warm cache instead of a cold fetch.
  // Safe to re-run whenever allCustomQueues changes — prefetchIssues never touches display.
  useEffect(() => {
    if (!spaceKey || allCustomQueues.length === 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    allCustomQueues.forEach((q, i) => {
      timers.push(setTimeout(() => {
        prefetchIssues({ spaceKey, page: '1', limit: String(PAGE_SIZE), dept: q.name }).catch(() => {});
      }, (i + 1) * 400));
    });
    return () => timers.forEach(clearTimeout);
  }, [spaceKey, allCustomQueues, prefetchIssues]);

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
      fetchClosedIssues(spaceKey, deptParam);
    }, 30_000);
    return () => clearInterval(id);
  }, [queueFilter, spaceKey, deptParam, fetchClosedIssues]);

  // Auto-refresh every 30s for regular (non-dept-queue) spaces — silent background refresh, never clears display
  useEffect(() => {
    const isDeptQueue = currentSpace?.type === 'dept_queue' || allCustomQueues.length > 0;
    if (isDeptQueue) return; // dept_queue spaces already handled above
    if (!spaceKey || !queueFilter || queueFilter === 'queues' || queueFilter === 'summary') return;
    const id = setInterval(() => {
      const params: Record<string, string> = { spaceKey, page: String(currentPage), limit: '100' };
      if (queueFilter === 'all-open' || queueFilter === 'assigned' || queueFilter === 'unassigned' || queueFilter === 'my-queue') params.excludeDone = 'true';
      if (queueFilter === 'unassigned') params.unassigned = 'true';
      if (queueFilter === 'assigned' && user?.id) params.assignee = user.id;
      if (queueFilter === 'all-requests') params.limit = '50';
      prefetchIssues(params).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [spaceKey, queueFilter, currentPage, currentSpace?.type, allCustomQueues.length, user?.id, prefetchIssues]);

  // Load custom fields assigned to this space → dynamic columns
  useEffect(() => {
    if (!currentSpace?.id) return;
    api.getCustomFields().then((fields: any[]) => {
      const spaceFields = fields.filter((f: any) =>
        !f.isDeleted &&
        f.source !== 'system' &&
        Array.isArray(f.spaceIds) &&
        f.spaceIds.includes(currentSpace.id)
      );
      setCustomFieldCols(spaceFields.map((f: any) => ({
        id: `cf_${f.id}`,
        label: f.name,
        width: '110px',
        fieldId: f.id,
      })));
      // Track field names enabled for this space (used to filter the "+ Fields" dropdown)
      setSpaceFieldLabels(new Set(spaceFields.map((f: any) => (f.name as string).toLowerCase().trim())));
    }).catch(() => {});
  }, [currentSpace?.id]);

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
    setOpenFilter(null);
    setCurrentPage(1); // reset pagination when filter changes
  };
  const clearFilter = (key: string) => { setFilters(f => Object.fromEntries(Object.entries(f).filter(([k]) => k !== key))); setCurrentPage(1); };
  const clearAllFilters = () => {
    setFilters({});
    setSearch('');
    // Remove any field-filter columns that were auto-added, keeping only manually toggled ones
    const fieldFilterIds = ADDABLE_FILTER_DEFS.map(d => d.id);
    setVisibleCols(prev => prev.filter(c => !fieldFilterIds.includes(c) || DEFAULT_COLS.includes(c)));
    setAddedFilterIds([]);
    setCurrentPage(1);
    // Clear persisted field state
    try { localStorage.removeItem(fieldsStorageKey); } catch {}
  };

  const addExtraFilter = (id: string) => {
    setAddedFilterIds(prev => prev.includes(id) ? prev : [...prev, id]);
    // Also make the column visible so data shows immediately
    setVisibleCols(prev => prev.includes(id) ? prev : [...prev, id]);
    setOpenFilter(null);
    setAddFilterDropPos(null);
  };
  const removeExtraFilter = (id: string) => {
    setAddedFilterIds(prev => prev.filter(x => x !== id));
    clearFilter(id);
    // Remove column visibility when filter is removed
    setVisibleCols(prev => prev.filter(x => x !== id));
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

  const handleInlineUpdate = useCallback(async (issueKey: string, field: string, value: any) => {
    setOpenDropdown(null); setUpdating(issueKey);
    try { await api.updateIssue(issueKey, { [field]: value }); await loadIssues({ spaceKey, page: (queueFilter === 'all-requests' || queueFilter.startsWith('cq_')) ? String(currentPage) : '1', limit: (queueFilter === 'all-requests' || queueFilter.startsWith('cq_')) ? String(PAGE_SIZE) : '500' }); }
    catch (err) { console.error(err); }
    finally { setUpdating(null); }
  }, [spaceKey, loadIssues]);

  const recallIssue = async (issueKey: string) => {
    try {
      await api.updateIssue(issueKey, { recall: true } as any);
    } catch (e) {
      console.error('Recall failed', e);
      alert('Failed to recall ticket');
      return;
    }
    // Recall succeeded — reload the Sent/Watching view so the ticket disappears
    try {
      const reloadParams: Record<string, string> = { spaceKey, page: '1', limit: '500' };
      if (queueFilter === 'sent-watching' && deptParam) reloadParams.sentDept = deptParam;
      clearIssuesCache(reloadParams);
      await loadIssues(reloadParams);
    } catch { /* non-critical */ }
  };

  const [commentingOn, setCommentingOn] = useState<string | null>(null); // issueKey
  const [commentText, setCommentText] = useState('');
  const [richCommentHtml, setRichCommentHtml] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const submitComment = async (issueKey: string) => {
    const body = richCommentHtml.replace(/<[^>]+>/g, '').trim() ? richCommentHtml : commentText.trim();
    if (!body) return;
    setSubmittingComment(true);
    try {
      await api.addComment(issueKey, { body });
      setCommentText('');
      setRichCommentHtml('');
      setCommentingOn(null);
      // Reload with current queue params (not a hardcoded reporter filter)
      const params: Record<string, string> = { spaceKey, page: '1', limit: '100' };
      if (queueFilter === 'sent-watching') {
        if (deptParam) params.sentDept = deptParam;
      } else if (queueFilter === 'dept_all' || queueFilter === 'dept_unassigned' || queueFilter === 'dept_assigned') {
        params.excludeDone = 'true';
        if (deptParam) params.dept = deptParam;
      } else if (queueFilter === 'all-open' || queueFilter === 'assigned' || queueFilter === 'unassigned') {
        params.excludeDone = 'true';
      } else if (queueFilter.startsWith('cq_') && activeCustomQueue?.name) {
        params.dept = activeCustomQueue.name;
        params.page = String(currentPage);
        params.limit = String(PAGE_SIZE);
      } else {
        params.reporter = user?.id || '';
      }
      clearIssuesCache(params);
      await loadIssues(params);
    } catch (e) { console.error(e); }
    finally { setSubmittingComment(false); }
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
    await loadIssues({ spaceKey, page: String(currentPage), limit: queueFilter === 'all-requests' ? String(PAGE_SIZE) : '500' });
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
  const isAdmin = user?.role === 'admin';
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
    'all-open':        'All open',
    'assigned':        'Assigned to me',
    'unassigned':      'Unassigned',
    'all-requests':    'All Requests',
    'my-dept':         'My Dept',
    'my-queue':        'My Queue',
    'sent-watching':   'Sent / Watching',
    'dept_all':        deptParam ? `All Tickets — ${deptParam}` : 'All Tickets',
    'dept_unassigned': deptParam ? `Unassigned — ${deptParam}` : 'Unassigned',
    'dept_assigned':   deptParam ? `Assigned to me — ${deptParam}` : 'Assigned to me',
    'dept_closed':     deptParam ? `Closed Tickets — ${deptParam}` : 'Closed Tickets',
  };
  const queueLabel = (activeCustomQueue?.name) || QUEUE_LABELS[queueFilter] || 'Queues';
  const isQueueView = ['all-open', 'assigned', 'unassigned', 'all-requests', 'my-dept', 'my-queue', 'sent-watching', 'dept_all', 'dept_unassigned', 'dept_assigned', 'dept_closed'].includes(queueFilter) || queueFilter.startsWith('cq_');

  const filteredIssues = issues.filter((issue) => {
    // Queue filter — skip category check when user has explicitly selected a status
    if (!filters.status) {
      if (queueFilter === 'all-open') {
        // Only show open (non-done) tickets
        const cat = (issue.status?.category || '').toLowerCase();
        const name = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || name.includes('done') || name.includes('resolved') || name.includes('closed')) return false;
      } else if (queueFilter === 'assigned') {
        if (!user || issue.assignee?.id !== user.id) return false;
      } else if (queueFilter === 'unassigned') {
        // Only show open tickets with no assignee
        const cat = (issue.status?.category || '').toLowerCase();
        const name = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || name.includes('done') || name.includes('resolved') || name.includes('closed')) return false;
        if (issue.assignee) return false;
        // If dept-scoped (user clicked Unassigned (Dev) etc.), filter by that dept
        if (deptParam) {
          const issueDept = ((issue as any).current_department || '').toLowerCase();
          if (issueDept !== deptParam.toLowerCase()) return false;
        }
      } else if (queueFilter === 'my-dept') {
        // Show open tickets that have a department set (unassigned or assigned to me)
        const cat = (issue.status?.category || '').toLowerCase();
        const name = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || name.includes('done') || name.includes('resolved') || name.includes('closed')) return false;
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
        const name = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || name.includes('done') || name.includes('resolved') || name.includes('closed')) return false;
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
        // All open tickets in this dept regardless of assignee
        const cat = (issue.status?.category || '').toLowerCase();
        const stName = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || stName.includes('done') || stName.includes('resolved') || stName.includes('closed')) return false;
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
        const cat = (issue.status?.category || '').toLowerCase();
        const stName = (issue.status?.name || '').toLowerCase();
        if (cat === 'done' || stName.includes('done') || stName.includes('resolved') || stName.includes('closed')) return false;
        if (!user || issue.assignee?.id !== user.id) return false;
        if (deptParam) {
          const issueDept = ((issue as any).current_department || '').toLowerCase();
          if (issueDept !== deptParam.toLowerCase()) return false;
        }
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
    // Type filter
    if (filters.type && (issue.type || '').toLowerCase() !== filters.type.toLowerCase()) return false;
    // Status filter
    if (filters.status && (issue.status?.name || '') !== filters.status) return false;
    // Assignee filter — match by email (member id ≠ user id in seeded data)
    if (filters.assignee) {
      if (filters.assignee === '__unassigned') { if (issue.assignee) return false; }
      else if (filters.assignee === '__current') {
        const matches = issue.assignee?.email === user?.email ||
                        issue.assignee?.id    === user?.id;
        if (!matches) return false;
      } else {
        if (issue.assignee?.id !== filters.assignee) return false;
      }
    }
    // Priority filter
    if (filters.priority && (issue.priority || '').toLowerCase() !== filters.priority.toLowerCase()) return false;
    // Reporter filter
    if (filters.reporter) {
      if (filters.reporter === '__current') {
        if (issue.reporter?.id !== user?.id) return false;
      } else {
        if (issue.reporter?.id !== filters.reporter) return false;
      }
    }
    // Label filter
    if (filters.label) {
      const issueLabels: string[] = Array.isArray(issue.labels)
        ? issue.labels.map((l: any) => (typeof l === 'string' ? l : l?.name || '')).filter(Boolean)
        : [];
      if (!issueLabels.includes(filters.label)) return false;
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
    // Extra added filters — all support comma-separated multi-select
    const matchesMulti = (filterVal: string, issueVal: string) => {
      const selected = filterVal.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
      return selected.length === 0 || selected.includes((issueVal || '').toLowerCase());
    };
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
    // Search filter
    if (search) {
      const q = search.toLowerCase();
      const sum = String(issue.summary ?? '').toLowerCase();
      const k = String(issue.cfKey ?? issue.key ?? '').toLowerCase();
      if (!sum.includes(q) && !k.includes(q)) return false;
    }
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
  // Merge server-fetched values with any locally visible values (dedup + sort)
  const mergedOptions = (field: string): string[] => {
    const server = serverFieldOptions[field] || [];
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
      <div className="px-6 pt-5 pb-4 bg-white border-b border-gray-200">
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
          ) : (
            // All open / Assigned — show only filtered open count
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-medium bg-blue-50 text-blue-700 border-blue-200">
              <span className="font-bold text-[15px]">{filteredIssues.length}</span>
              <span>{queueFilter === 'assigned' ? 'Assigned to me' : 'Open'}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Queues overview — default landing when clicking a space ── */}
      {queueFilter === 'queues' && (() => {
        const isDeptQueue = currentSpace?.type === 'dept_queue' || allCustomQueues.length > 0;
        const customQueues = isDeptQueue
          ? (isAdmin ? allCustomQueues : allCustomQueues.filter(q => q.memberIds.includes(user?.id || '')))
          : [];
        return (
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <h2 className="text-[15px] font-semibold text-gray-800 mb-1">Queues</h2>
            <p className="text-[12px] text-gray-400 mb-5">Select a queue to view its tickets</p>
            <div className="grid grid-cols-1 gap-2 max-w-2xl">
              {customQueues.length === 0 && (
                <p className="text-[13px] text-gray-400 py-4">No queues available.</p>
              )}
              {customQueues.map(q => (
                <Link key={q.id} href={`/spaces/${spaceKey}?queue=${q.id}`}
                  className="flex items-center gap-4 px-4 py-3 rounded-lg border border-gray-200 bg-white hover:bg-blue-50 hover:border-blue-300 transition-all group">
                  <div className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: getDeptColor(q.name) + '20' }}>
                    <Layers size={15} style={{ color: getDeptColor(q.name) }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-gray-800 group-hover:text-blue-700">{q.name}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">Custom department queue</p>
                  </div>
                  <ChevronRight size={14} className="text-gray-300 group-hover:text-blue-400" />
                </Link>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Summary view ── */}
      {queueFilter === 'summary' && (() => {
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
      {queueFilter !== 'summary' && queueFilter !== 'queues' && <div className="px-6 py-2.5 bg-white border-b border-gray-200 flex items-center gap-2 overflow-x-auto scrollbar-hide min-h-[44px]">
        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search issues…" value={search} onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-[12.5px] border border-gray-300 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44" />
        </div>

        {/* ── Unified Filter button ── */}
        {(() => {
          const allMembers = members.map((m: any) => m.user || m);
          const ALWAYS_AVAILABLE = new Set(['updated', 'dueDate']);
          const availableToAdd = ADDABLE_FILTER_DEFS.filter(d =>
            !addedFilterIds.includes(d.id) &&
            (ALWAYS_AVAILABLE.has(d.id) || spaceFieldLabels.has(d.label.toLowerCase().trim()))
          );

          // Count active filters for badge
          const activeFilterCount = [
            filters.type, filters.status, filters.priority, filters.assignee,
            filters.reporter, filters.label, filters.created,
            deptFilter,
            ...addedFilterIds.filter(id => filters[id]),
          ].filter(Boolean).length;

          // Build filter category list
          const filterCats = [
            { id: 'type', label: 'Type', icon: <SlidersHorizontal size={13} /> },
            ...(rrDepartments.length > 0 ? [{ id: 'department', label: 'Department', icon: <SlidersHorizontal size={13} /> }] : []),
            { id: 'status', label: 'Status', icon: <SlidersHorizontal size={13} /> },
            { id: 'assignee', label: 'Assignee', icon: <User size={13} /> },
            { id: 'priority', label: 'Priority', icon: <SlidersHorizontal size={13} /> },
            { id: 'reporter', label: 'Reporter', icon: <UserCheck size={13} /> },
            { id: 'label', label: 'Label', icon: <Tag size={13} /> },
            { id: 'created', label: 'Created', icon: <Calendar size={13} /> },
            ...addedFilterIds.map(id => {
              const def = ADDABLE_FILTER_DEFS.find(d => d.id === id);
              return def ? { id, label: def.label, icon: <AddableIcon icon={def.icon} size={13} />, isExtra: true } : null;
            }).filter(Boolean) as { id: string; label: string; icon: React.ReactNode; isExtra?: boolean }[],
            ...(availableToAdd.length > 0 ? [{ id: '__addFields', label: '+ More Fields', icon: <Plus size={13} /> }] : []),
          ];

          // Helper: is a category active?
          const isCatActive = (catId: string) => {
            if (catId === 'department') return !!deptFilter;
            if (catId === '__addFields') return false;
            return !!filters[catId];
          };

          // Right panel content
          const renderRightPanel = () => {
            const cat = filterCategory;

            if (cat === 'type') {
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {[['epic','Epic'],['story','Story'],['task','Task'],['bug','Bug'],['subtask','Subtask']].map(([val, lbl]) => (
                    <button key={val} onClick={() => { setFilter('type', val); setOpenFilter(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.type === val ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                      <IssueTypeIcon type={val} size={14} />
                      <span>{lbl}</span>
                      {filters.type === val && <Check size={12} className="ml-auto text-blue-600" />}
                    </button>
                  ))}
                </div>
              );
            }

            if (cat === 'department') {
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  <button onClick={() => { setDeptFilter(''); setOpenFilter(null); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${!deptFilter ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                    <span>All Departments</span>
                    {!deptFilter && <Check size={12} className="ml-auto text-blue-600" />}
                  </button>
                  {rrDepartments.map(dept => (
                    <button key={dept} onClick={() => { setDeptFilter(dept); setOpenFilter(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${deptFilter === dept ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                      <span>{dept}</span>
                      {deptFilter === dept && <Check size={12} className="ml-auto text-blue-600" />}
                    </button>
                  ))}
                </div>
              );
            }

            if (cat === 'status') {
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {statuses.map((s: any) => (
                    <button key={s.id} onClick={() => { setFilter('status', s.name); setOpenFilter(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.status === s.name ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                      <span>{s.name}</span>
                      {filters.status === s.name && <Check size={12} className="ml-auto text-blue-600" />}
                    </button>
                  ))}
                </div>
              );
            }

            if (cat === 'assignee') {
              const aq = assigneeSearch.trim().toLowerCase();
              const filtered = aq
                ? allMembers.filter((mb: any) => `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(aq) || (mb.email || '').toLowerCase().includes(aq))
                : allMembers;
              return (
                <div className="flex flex-col max-h-[340px]">
                  <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input autoFocus type="text" value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)}
                        placeholder="Search assignee…"
                        className="w-full pl-7 pr-3 py-1.5 text-[12.5px] border border-blue-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white" />
                    </div>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {!aq && <>
                      <button onClick={() => { setFilter('assignee', '__current'); setAssigneeSearch(''); setOpenFilter(null); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.assignee === '__current' ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center flex-shrink-0">
                          <span className="text-[8px] font-bold text-white">{getInitials(user?.firstName, user?.lastName)}</span>
                        </div>
                        <span>Current User</span>
                        {filters.assignee === '__current' && <Check size={11} className="ml-auto text-blue-600" />}
                      </button>
                      <button onClick={() => { setFilter('assignee', '__unassigned'); setAssigneeSearch(''); setOpenFilter(null); }}
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
                      const isSelected = filters.assignee === mb.id;
                      const colors = ['bg-blue-500','bg-purple-500','bg-green-500','bg-orange-500','bg-rose-500','bg-teal-500','bg-indigo-500'];
                      const color = colors[(mb.firstName?.charCodeAt(0) || 0) % colors.length];
                      return (
                        <button key={mb.id} onClick={() => { setFilter('assignee', mb.id); setAssigneeSearch(''); setOpenFilter(null); }}
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

            if (cat === 'priority') {
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {PRIORITIES.map(p => (
                    <button key={p.value} onClick={() => { setFilter('priority', p.value); setOpenFilter(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.priority === p.value ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                      <PriorityIcon priority={p.value} size={14} />
                      <span>{p.label}</span>
                      {filters.priority === p.value && <Check size={12} className="ml-auto text-blue-600" />}
                    </button>
                  ))}
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
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {allLabels.length === 0
                    ? <p className="px-3 py-4 text-[12.5px] text-gray-400 text-center">No labels</p>
                    : allLabels.map(lbl => (
                      <button key={lbl} onClick={() => { setFilter('label', lbl); setOpenFilter(null); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] hover:bg-blue-50 transition-colors ${filters.label === lbl ? 'text-blue-600 font-semibold bg-blue-50' : 'text-gray-700'}`}>
                        <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                        <span>{lbl}</span>
                        {filters.label === lbl && <Check size={12} className="ml-auto text-blue-600" />}
                      </button>
                    ))
                  }
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

            if (cat === '__addFields') {
              return (
                <div className="overflow-y-auto max-h-[340px]">
                  {availableToAdd.length === 0
                    ? <p className="px-3 py-4 text-[12.5px] text-gray-400 text-center">All fields added</p>
                    : availableToAdd.map(def => (
                        <button key={def.id} onClick={() => { addExtraFilter(def.id); setFilterCategory(def.id); }}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                          <AddableIcon icon={def.icon} size={13} />
                          <span>{def.label}</span>
                          <Plus size={11} className="ml-auto text-gray-300" />
                        </button>
                      ))
                  }
                </div>
              );
            }

            // Extra added field filter
            const def = ADDABLE_FILTER_DEFS.find(d => d.id === cat);
            if (def) {
              const isDate = def.id === 'updated' || def.id === 'dueDate';
              const activeVal = filters[cat];
              const selectedVals = activeVal ? activeVal.split(',').map((v: string) => v.trim()).filter(Boolean) : [];
              const toggleMultiVal = (opt: string) => {
                const exists = selectedVals.includes(opt);
                const next = exists ? selectedVals.filter((v: string) => v !== opt) : [...selectedVals, opt];
                if (next.length === 0) clearFilter(cat);
                else setFilter(cat, next.join(','));
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
                      <button key={val} onClick={() => { setFilter(cat, val); setOpenFilter(null); }}
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
          const getChipLabel = (key: string, val: string): string => {
            if (key === 'type') return val.charAt(0).toUpperCase() + val.slice(1);
            if (key === 'department') return val;
            if (key === 'status') return val;
            if (key === 'priority') return getPriorityMeta(val).label;
            if (key === 'assignee') {
              if (val === '__unassigned') return 'Unassigned';
              if (val === '__current') return 'Current User';
              const mb = allMembers.find((m: any) => m.id === val);
              return mb ? `${mb.firstName} ${mb.lastName}` : val;
            }
            if (key === 'reporter') {
              if (val === '__current') return 'Current User';
              const mb = allMembers.find((m: any) => m.id === val);
              return mb ? `${mb.firstName} ${mb.lastName}` : val;
            }
            if (key === 'label') return val;
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
          addedFilterIds.forEach(id => { if (filters[id]) chips.push({ key: id, val: filters[id] }); });

          return (
            <>
              {/* Filter button */}
              <div className="relative flex-shrink-0">
                <button ref={addFilterRef}
                  onClick={() => {
                    if (openFilter === '__filterPanel') { setOpenFilter(null); return; }
                    const rect = addFilterRef.current?.getBoundingClientRect();
                    if (rect) setAddFilterDropPos({ top: rect.bottom + 4, left: rect.left });
                    setOpenFilter('__filterPanel');
                    setAssigneeSearch('');
                    setReporterSearch('');
                    setDropdownSearch('');
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] rounded-md border transition-colors whitespace-nowrap
                    ${openFilter === '__filterPanel' || activeFilterCount > 0
                      ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
                  <SlidersHorizontal size={13} className="flex-shrink-0" />
                  <span>Filter</span>
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
                      <div className="w-[160px] border-r border-gray-100 py-1.5 flex-shrink-0">
                        <div className="px-3 pb-1 pt-0.5">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Filters</p>
                        </div>
                        {filterCats.map(cat => {
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
                        })}
                      </div>

                      {/* Right panel — options for selected category */}
                      <div className="flex-1 min-w-[200px] max-w-[260px]">
                        <div className="px-3 py-2 border-b border-gray-100">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-semibold text-gray-500 capitalize">{filterCats.find(c => c.id === filterCategory)?.label || ''}</p>
                            {isCatActive(filterCategory) && (
                              <button onClick={() => {
                                if (filterCategory === 'department') setDeptFilter('');
                                else clearFilter(filterCategory);
                              }} className="text-[11px] text-red-400 hover:text-red-600 transition-colors">Clear</button>
                            )}
                          </div>
                        </div>
                        {renderRightPanel()}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Active filter chips */}
              {chips.map(chip => (
                <span key={chip.key} className="flex items-center gap-1 px-2 py-1 text-[11.5px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full whitespace-nowrap flex-shrink-0 font-medium">
                  <span className="text-blue-400 text-[10px] font-normal capitalize">{chip.key === 'department' ? 'Dept' : chip.key}:</span>
                  <span className="max-w-[100px] truncate">{getChipLabel(chip.key, chip.val)}</span>
                  <button onClick={() => {
                    if (chip.key === 'department') setDeptFilter('');
                    else clearFilter(chip.key);
                  }} className="ml-0.5 hover:text-blue-900 flex-shrink-0"><X size={10} /></button>
                </span>
              ))}
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
            onClick={async () => {
              setRefreshing(true);
              try {
                await loadIssues({ spaceKey, page: String(currentPage), limit: queueFilter === 'all-requests' ? String(PAGE_SIZE) : '500' });
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
              <a key={issue.id} href={`/issues/${issue.cfKey ?? issue.key}`}
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
      <div className="flex-1 overflow-auto bg-gray-50">
        <div style={{ minWidth: `${tableMinWidth}px` }}>
          {/* Table header */}
          <div className="grid items-center px-4 py-2 bg-white border-b border-gray-200 sticky top-0 z-10"
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
                // Show dept_statuses[current_dept] so Migration's "Resolved" shows correctly here
                const sentDeptStatusMap: Record<string, any> = (issue as any).dept_statuses || {};
                const sentCurrentDept: string = (issue as any).current_department || '';
                const st = (sentCurrentDept && sentDeptStatusMap[sentCurrentDept]) ? sentDeptStatusMap[sentCurrentDept] : getIssueStatus(issue);
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
                    onClick={() => { window.location.href = `/issues/${issue.cfKey ?? issue.key}`; }}>
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
                          <span className="text-[12px] text-gray-400 italic">Unassigned — waiting for {currentDept}</span>
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
                            <span className="text-[9.5px] uppercase tracking-wide text-gray-400 font-medium">Paused At</span>
                            <span className="text-[13px] font-bold text-gray-600">{pausedSla.paused_at ? timeAgo(pausedSla.paused_at) : '—'}</span>
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

                    {/* Full comment thread */}
                    {comments.length > 0 && (
                      <div className="mx-4 mb-3 flex flex-col gap-1.5">
                        {comments.map((c: any, ci: number) => {
                          const firstName = c.author?.firstName || c.authorName?.split(' ')[0] || '?';
                          const initials = firstName[0]?.toUpperCase() || '?';
                          const cleanBody = (c.body || '').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
                          return (
                            <div key={c.id || ci} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100">
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
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Inline comment area */}
                    <div className="mx-4 mb-3" onClick={e => e.stopPropagation()}>
                      {commentingOn === issue.key ? (
                        <div className="border border-blue-200 rounded-xl overflow-hidden shadow-sm bg-white">
                          <RichTextEditor
                            value={richCommentHtml}
                            onChange={html => { setRichCommentHtml(html); setCommentText(html.replace(/<[^>]+>/g,'').trim()); }}
                            placeholder="Write a comment… (Ctrl+Enter to send)"
                            minHeight="80px"
                            compact
                            members={members}
                          />
                          <div className="flex items-center justify-between px-3 pb-2.5 border-t border-gray-100 pt-2 bg-gray-50">
                            <span className="text-[11px] text-gray-400">Ctrl+Enter to send · Esc to cancel</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => { setCommentingOn(null); setCommentText(''); setRichCommentHtml(''); }}
                                className="px-3 py-1.5 text-[12px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">
                                Cancel
                              </button>
                              <button
                                onClick={() => submitComment(issue.key)}
                                disabled={!commentText.trim() || submittingComment}
                                className="px-4 py-1.5 text-[12px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                                {submittingComment && <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                                Send
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setCommentingOn(issue.key); setCommentText(''); setRichCommentHtml(''); }}
                          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl border border-dashed border-gray-200 text-[12.5px] text-gray-400 hover:border-blue-300 hover:text-blue-500 hover:bg-blue-50 transition-colors group/cmt">
                          <div className="w-6 h-6 rounded-full bg-gray-100 group-hover/cmt:bg-blue-100 flex items-center justify-center flex-shrink-0 transition-colors">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                          </div>
                          <span>Add a comment…</span>
                        </button>
                      )}
                    </div>
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
                    ${isSelected ? 'bg-blue-50' : 'bg-white hover:bg-gray-50'}`}
                  style={{ gridTemplateColumns: gridCols }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      window.open(`/issues/${issue.cfKey ?? issue.key}`, '_blank');
                    } else {
                      window.location.href = `/issues/${issue.cfKey ?? issue.key}`;
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
                    // If dept key exists but value is null, fall back to issue.assignee (they may have self-assigned after handoff)
                    const displayAssignee = activeDept && activeDept in deptMap ? (deptMap[activeDept] ?? issue.assignee) : issue.assignee;
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
                                <button onClick={() => { handleInlineUpdate(issue.key, 'assigneeId', null); setInlineAssigneeSearch(''); }}
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
                                    <button key={member.id} onClick={() => { handleInlineUpdate(issue.key, 'assigneeId', member.id); setInlineAssigneeSearch(''); }}
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
                          const spaceTransitions: {fromStatusId:string; toStatusId:string}[] = (currentSpace as any).transitions || [];
                          const validIds = spaceTransitions.filter(t => t.fromStatusId === st.id).map(t => t.toStatusId);
                          const options = validIds.length > 0 ? statuses.filter(s => validIds.includes(s.id)) : statuses.filter(s => s.id !== st.id);
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
                                  handleInlineUpdate(issue.key, 'statusId', s.id);
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
                    if (id === 'labels') return <div key={id} className="px-2 flex flex-wrap gap-1">{(issue.labels||[]).length > 0 ? ((issue.labels as unknown) as string[]).slice(0,2).map((l:string) => <span key={l} className="text-[10px] bg-blue-50 text-blue-600 border border-blue-100 rounded px-1.5 py-0.5">{l}</span>) : <span className="text-[11px] text-gray-300">—</span>}</div>;
                    if (id === 'storyPoints') return <div key={id} className="px-2">{issue.storyPoints ? <span className="text-[11.5px] font-semibold text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">{issue.storyPoints}</span> : <span className="text-[11px] text-gray-300">—</span>}</div>;
                    if (id === 'type') return <div key={id} className="px-2 text-[11px] text-gray-600 capitalize">{issue.type || '—'}</div>;
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

      {/* ── Pagination bar — for All Requests and custom queues ── */}
      {(queueFilter === 'all-requests' || queueFilter.startsWith('cq_')) && issueTotal > PAGE_SIZE && (
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
      {/* All open — simple count footer */}
      {queueFilter !== 'all-requests' && (
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
            if (navKey) {
              setCreatedToast({ key: newIssue.key, cfKey: navKey });
              setTimeout(() => setCreatedToast(null), 10000);
            }
            // Stay on current queue — just refresh the list
            const params: Record<string, string> = { spaceKey, page: '1', limit: '500' };
            if (queueFilter === 'sent-watching' && deptParam) params.sentDept = deptParam;
            if (queueFilter === 'dept_all' || queueFilter === 'dept_unassigned' || queueFilter === 'dept_assigned') {
              params.excludeDone = 'true';
              if (deptParam) params.dept = deptParam;
            }
            if (queueFilter === 'all-open' || queueFilter === 'assigned' || queueFilter === 'unassigned') {
              params.excludeDone = 'true';
            }
            if (['all-requests'].includes(queueFilter) || queueFilter.startsWith('cq_')) {
              params.page = String(currentPage);
              params.limit = String(PAGE_SIZE);
              if (queueFilter.startsWith('cq_') && activeCustomQueue?.name) params.dept = activeCustomQueue.name;
            }
            loadIssues(params);
          }} />
      )}

      {/* Bottom-left creation toast */}
      {createdToast && (
        <div className="fixed bottom-6 left-6 z-50 flex items-center gap-3 bg-gray-900 text-white px-4 py-3 rounded-xl shadow-2xl animate-slide-up">
          <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
          <span className="text-sm">Ticket created:</span>
          <span className="text-sm font-bold font-mono text-green-300">{createdToast.cfKey}</span>
          <button
            onClick={() => {
              const text = createdToast.cfKey;
              const doCopy = () => {
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(text).catch(() => {
                    const el = document.createElement('textarea');
                    el.value = text; document.body.appendChild(el); el.select();
                    document.execCommand('copy'); document.body.removeChild(el);
                  });
                } else {
                  const el = document.createElement('textarea');
                  el.value = text; document.body.appendChild(el); el.select();
                  document.execCommand('copy'); document.body.removeChild(el);
                }
              };
              doCopy();
              setCreatedToast(t => t ? { ...t, copied: true } : t);
              setTimeout(() => setCreatedToast(t => t ? { ...t, copied: false } : t), 2000);
            }}
            className={`ml-1 px-2 py-0.5 text-xs rounded-md transition-colors ${(createdToast as any).copied ? 'bg-green-500 text-white' : 'bg-white/10 hover:bg-white/20'}`}
            title="Copy ticket key"
          >{(createdToast as any).copied ? '✓ Copied!' : 'Copy'}</button>
          <button onClick={() => setCreatedToast(null)} className="ml-1 text-white/50 hover:text-white text-lg leading-none">×</button>
        </div>
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
