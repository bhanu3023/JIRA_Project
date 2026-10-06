'use client';

import { useEffect, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { formatDate, getInitials } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import Link from 'next/link';
import {
  Search, ChevronDown, Filter, RefreshCw, Layers,
  LayoutGrid, List, Clock, CheckCircle2, Circle, AlertCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type ViewMode = 'list' | 'group';

const STATUS_COLORS: Record<string, string> = {
  todo:       '#6b7280',
  'in-progress': '#3b82f6',
  done:       '#22c55e',
  blocked:    '#ef4444',
};

function statusCategory(status: any): string {
  const cat = (status?.category || '').toLowerCase();
  const name = (status?.name || '').toLowerCase();
  if (cat === 'done' || name.includes('done') || name.includes('resolved') || name.includes('closed')) return 'done';
  if (cat === 'in_progress' || cat === 'inprogress' || name.includes('progress') || name.includes('review')) return 'in-progress';
  return 'todo';
}

function StatusBadge({ status }: { status: any }) {
  const cat = statusCategory(status);
  const color = status?.color || STATUS_COLORS[cat] || '#6b7280';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ backgroundColor: color + '20', color }}
    >
      {cat === 'done' ? <CheckCircle2 size={10} /> : cat === 'in-progress' ? <Clock size={10} /> : <Circle size={10} />}
      {status?.name || 'Open'}
    </span>
  );
}

export default function AllIssuesPage() {
  const { spaces, loadSpaces } = useStore(
    useShallow((s) => ({ spaces: s.spaces, loadSpaces: s.loadSpaces })),
  );

  const [issues, setIssues]         = useState<any[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(false);
  const [page, setPage]             = useState(1);
  const [search, setSearch]         = useState('');
  const [spaceFilter, setSpaceFilter] = useState('');
  const [typeFilter, setTypeFilter]   = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [viewMode, setViewMode]     = useState<ViewMode>('list');
  const [showFilters, setShowFilters] = useState(false);
  const PAGE_SIZE = 50;

  const fetchIssues = useCallback(async (pg = 1) => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: String(PAGE_SIZE), page: String(pg) };
      if (spaceFilter)   params.spaceKey  = spaceFilter;
      if (typeFilter)    params.type      = typeFilter;
      if (priorityFilter) params.priority = priorityFilter;
      if (search)        params.search    = search;
      const data: any = await api.getIssues(params);
      if (pg === 1) setIssues(data.issues ?? []);
      else setIssues(prev => [...prev, ...(data.issues ?? [])]);
      setTotal(data.total ?? 0);
    } finally { setLoading(false); }
  }, [spaceFilter, typeFilter, priorityFilter, search]);

  useEffect(() => { loadSpaces(); }, [loadSpaces]);
  useEffect(() => { setPage(1); fetchIssues(1); }, [fetchIssues]);

  const loadMore = () => { const next = page + 1; setPage(next); fetchIssues(next); };

  // Group by space
  const grouped = spaces.reduce<Record<string, any[]>>((acc, sp) => {
    const its = issues.filter(i => i.spaceKey === sp.key || i.spaceName === sp.name);
    if (its.length) acc[sp.key] = its;
    return acc;
  }, {});

  const filtered = statusFilter
    ? issues.filter(i => statusCategory(i.status) === statusFilter)
    : issues;

  const counts = {
    todo:  issues.filter(i => statusCategory(i.status) === 'todo').length,
    inprogress: issues.filter(i => statusCategory(i.status) === 'in-progress').length,
    done:  issues.filter(i => statusCategory(i.status) === 'done').length,
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Layers size={20} className="text-blue-600" />
              All Spaces
            </h1>
            <p className="text-[12px] text-gray-500 mt-0.5">Issues across all spaces · {total.toLocaleString()} total</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchIssues(1)}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-0.5 bg-gray-50">
              <button onClick={() => setViewMode('list')} className={cn('px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors flex items-center gap-1.5', viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700')}>
                <List size={13} /> List
              </button>
              <button onClick={() => setViewMode('group')} className={cn('px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors flex items-center gap-1.5', viewMode === 'group' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700')}>
                <LayoutGrid size={13} /> By Space
              </button>
            </div>
          </div>
        </div>

        {/* ── Status summary cards ── */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'Open', count: counts.todo, cat: 'todo', color: 'text-gray-600', bg: 'bg-gray-50', border: 'border-gray-200', icon: <Circle size={14} className="text-gray-400" /> },
            { label: 'In Progress', count: counts.inprogress, cat: 'in-progress', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', icon: <Clock size={14} className="text-blue-500" /> },
            { label: 'Done', count: counts.done, cat: 'done', color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200', icon: <CheckCircle2 size={14} className="text-green-500" /> },
          ].map(s => (
            <button
              key={s.cat}
              onClick={() => setStatusFilter(statusFilter === s.cat ? '' : s.cat)}
              className={cn('flex items-center gap-3 rounded-xl border px-4 py-3 transition-all text-left', statusFilter === s.cat ? `${s.bg} ${s.border} ring-2 ring-offset-1` : 'bg-white border-gray-200 hover:border-gray-300')}
              style={statusFilter === s.cat ? { ringColor: s.color } : {}}
            >
              {s.icon}
              <div>
                <p className={cn('text-lg font-bold leading-none', s.color)}>{s.count.toLocaleString()}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{s.label}</p>
              </div>
            </button>
          ))}
        </div>

        {/* ── Search + Filters ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-sm bg-gray-100 rounded-lg px-3 py-2">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search issues..."
              className="flex-1 bg-transparent text-[13px] text-gray-900 placeholder-gray-400 outline-none"
            />
          </div>
          <button
            onClick={() => setShowFilters(v => !v)}
            className={cn('flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[12.5px] font-medium transition-colors', showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}
          >
            <Filter size={13} /> Filters
            {(spaceFilter || typeFilter || priorityFilter) && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
          </button>
          {showFilters && (
            <>
              <select value={spaceFilter} onChange={e => setSpaceFilter(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-[12.5px] text-gray-700 outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">All Spaces</option>
                {spaces.map(s => <option key={s.id} value={s.key}>{s.name}</option>)}
              </select>
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-[12.5px] text-gray-700 outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">All Types</option>
                {['epic', 'story', 'task', 'bug', 'subtask'].map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
              </select>
              <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-[12.5px] text-gray-700 outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">All Priority</option>
                {/* Highest removed per explicit request -- see filters/page.tsx's own PRIORITIES comment. */}
                {['high', 'medium', 'low', 'lowest'].map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
              </select>
              {(spaceFilter || typeFilter || priorityFilter || statusFilter) && (
                <button onClick={() => { setSpaceFilter(''); setTypeFilter(''); setPriorityFilter(''); setStatusFilter(''); }} className="px-3 py-2 rounded-lg text-[12.5px] text-red-600 hover:bg-red-50 border border-red-200 transition-colors">
                  Clear all
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && issues.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertCircle size={36} className="text-gray-300 mb-3" />
            <p className="text-[14px] font-semibold text-gray-500">No issues found</p>
            <p className="text-[12px] text-gray-400 mt-1">Try adjusting your filters or search</p>
          </div>
        ) : viewMode === 'list' ? (
          <IssueTable issues={filtered} loadMore={loadMore} total={total} loading={loading} />
        ) : (
          <GroupedView grouped={grouped} spaces={spaces} />
        )}
      </div>
    </div>
  );
}

/* ── Issue table (flat list) ─────────────────────────────────────────── */
function IssueTable({ issues, loadMore, total, loading }: { issues: any[]; loadMore: () => void; total: number; loading: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-8"></th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-28">Key</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Summary</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-32">Space</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-32">Status</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-8">P</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-32">Assignee</th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide w-28">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {issues.map(issue => (
            <IssueRow key={issue.id} issue={issue} showSpace />
          ))}
        </tbody>
      </table>
      {issues.length < total && (
        <div className="flex justify-center py-3 border-t border-gray-100">
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-4 py-2 text-[12.5px] font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? 'Loading…' : `Load more (${total - issues.length} remaining)`}
          </button>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, showSpace }: { issue: any; showSpace?: boolean }) {
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-2.5">
        <IssueTypeIcon type={issue.type || 'task'} size={14} />
      </td>
      <td className="px-4 py-2.5">
        <Link href={`/issues/${issue.cfKey ?? issue.key}`} className="text-[12.5px] text-blue-600 font-semibold hover:underline whitespace-nowrap">
          {issue.cfKey ?? issue.key}
        </Link>
      </td>
      <td className="px-4 py-2.5 text-[13px] text-gray-900 truncate max-w-xs">{issue.summary}</td>
      {showSpace && (
        <td className="px-4 py-2.5">
          <Link href={`/spaces/${issue.spaceKey}`} className="text-[11.5px] text-gray-500 hover:text-blue-600 bg-gray-100 hover:bg-blue-50 px-2 py-0.5 rounded-full transition-colors whitespace-nowrap">
            {issue.spaceKey}
          </Link>
        </td>
      )}
      <td className="px-4 py-2.5">
        <StatusBadge status={issue.status} />
      </td>
      <td className="px-4 py-2.5">
        <PriorityIcon priority={issue.priority} size={15} />
      </td>
      <td className="px-4 py-2.5">
        {issue.assignee ? (
          <div className="flex items-center gap-1.5">
            {issue.assignee.avatarUrl ? (
              <img src={issue.assignee.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
            ) : (
              <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px] font-bold">
                {getInitials(issue.assignee.firstName, issue.assignee.lastName)}
              </div>
            )}
            <span className="text-[12px] text-gray-600 truncate max-w-[80px]">
              {issue.assignee.firstName} {issue.assignee.lastName}
            </span>
          </div>
        ) : (
          <span className="text-[12px] text-gray-400">Unassigned</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-[11.5px] text-gray-400 whitespace-nowrap">{formatDate(issue.updatedAt)}</td>
    </tr>
  );
}

/* ── Grouped by space view ───────────────────────────────────────────── */
function GroupedView({ grouped, spaces }: { grouped: Record<string, any[]>; spaces: any[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed(prev => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  const spaceList = spaces.filter(s => grouped[s.key]);

  if (spaceList.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <AlertCircle size={36} className="text-gray-300 mb-3" />
      <p className="text-[14px] font-semibold text-gray-500">No issues found</p>
    </div>
  );

  return (
    <div className="space-y-4">
      {spaceList.map(space => {
        const its = grouped[space.key] || [];
        const isOpen = !collapsed.has(space.key);
        return (
          <div key={space.key} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {/* Space header */}
            <button
              onClick={() => toggle(space.key)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left border-b border-gray-200"
            >
              <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                {space.key.slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-semibold text-gray-900">{space.name}</span>
                <span className="ml-2 text-[11px] text-gray-500">{space.key}</span>
              </div>
              <span className="text-[11.5px] font-semibold text-gray-500 bg-gray-200 rounded-full px-2 py-0.5">
                {its.length}
              </span>
              <Link
                href={`/spaces/${space.key}`}
                onClick={e => e.stopPropagation()}
                className="text-[11.5px] text-blue-600 hover:underline px-2 py-0.5 rounded hover:bg-blue-50 transition-colors"
              >
                Open space
              </Link>
              <ChevronDown size={14} className={cn('text-gray-400 transition-transform flex-shrink-0', !isOpen && '-rotate-90')} />
            </button>

            {/* Issue rows */}
            {isOpen && (
              <table className="w-full">
                <tbody className="divide-y divide-gray-100">
                  {its.map(issue => <IssueRow key={issue.id} issue={issue} showSpace={false} />)}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
