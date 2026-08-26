'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { timeAgo, cn } from '@/lib/utils';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import DotLoader from '@/components/ui/DotLoader';
import {
  AlertTriangle, RefreshCw, Clock, ChevronDown, X, Check,
  ChevronRight, TrendingUp, Users, Zap, AlertCircle, Shield,
} from 'lucide-react';

const PRODUCT_TYPES = ['Email', 'Message', 'Manage', 'Content'];

interface BreachedIssue {
  key: string;
  summary: string;
  priority: string;
  issueType: string;
  status: { name: string; category: string };
  assignee: { displayName: string; avatarUrl?: string } | null;
  spaceKey: string;
  spaceName: string;
  queueId: string | null;
  queueName: string | null;
  createdAt: string;
  breachedMs: number;
  policyName: string;
  productType: string | null;
}

interface SpaceOption { key: string; name: string; }
interface QueueOption { id: string; name: string; spaceKey: string; }

function msToHuman(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 2) return `${d}d overdue`;
  if (d === 1) return `1d ${h % 24}h overdue`;
  return `${h}h overdue`;
}

function msToShort(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  return `${h}h`;
}

function severityColor(ms: number) {
  const h = ms / 3600000;
  if (h > 48) return { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', border: 'border-red-200', badge: 'bg-red-600' };
  if (h > 24) return { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500', border: 'border-orange-200', badge: 'bg-orange-500' };
  return { bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-500', border: 'border-yellow-200', badge: 'bg-yellow-500' };
}

/* ── Multi-select dropdown ── */
function MultiSelect({ label, options, selected, onChange, colorClass = 'bg-blue-50 text-blue-700 border-blue-200' }: {
  label: string; options: { value: string; label: string }[];
  selected: string[]; onChange: (v: string[]) => void; colorClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  const label_ = selected.length === 0 ? label : selected.length === 1
    ? (options.find(o => o.value === selected[0])?.label || selected[0]) : `${selected.length} selected`;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)} className={cn(
        'flex items-center gap-2 text-xs font-medium border rounded-lg px-3 py-2 transition-colors min-w-[140px] bg-white shadow-sm',
        selected.length > 0 ? colorClass : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'
      )}>
        <span className="flex-1 text-left truncate">{label_}</span>
        {selected.length > 0 && (
          <span role="button" onClick={e => { e.stopPropagation(); onChange([]); }} className="text-gray-400 hover:text-gray-700"><X size={11} /></span>
        )}
        <ChevronDown size={12} className={cn('text-gray-400 transition-transform flex-shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl py-1 min-w-[190px] max-h-56 overflow-y-auto">
          {options.length === 0
            ? <div className="px-3 py-3 text-xs text-gray-400">No options</div>
            : options.map(o => (
              <button key={o.value} onClick={() => toggle(o.value)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors">
                <span className={cn('w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center',
                  selected.includes(o.value) ? 'bg-blue-600 border-blue-600' : 'border-gray-300')}>
                  {selected.includes(o.value) && <Check size={10} className="text-white" />}
                </span>
                {o.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ── Stat card ── */
function StatCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; color: string }) {
  return (
    <div className={cn('rounded-xl border p-4 flex items-start gap-3', color)}>
      <div className="mt-0.5">{icon}</div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="text-xs font-medium mt-1 opacity-80">{label}</p>
        {sub && <p className="text-[11px] mt-0.5 opacity-60">{sub}</p>}
      </div>
    </div>
  );
}

export default function BreachedPage() {
  const { user } = useStore(useShallow(s => ({ user: s.user })));
  const [allIssues, setAllIssues] = useState<BreachedIssue[]>([]);
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [allQueues, setAllQueues] = useState<QueueOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selectedBoards, setSelectedBoards] = useState<string[]>([]);
  const [selectedQueues, setSelectedQueues] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';

  useEffect(() => {
    if (selectedBoards.length === 0) { setAllQueues([]); setSelectedQueues([]); return; }
    const headers = { Authorization: `Bearer ${getToken()}` };
    Promise.all(selectedBoards.map(sk =>
      fetch(`/api/custom-queues/${sk}`, { headers }).then(r => r.ok ? r.json() : [])
        .then((qs: any[]) => qs.map((q: any) => ({ id: q.id, name: q.name, spaceKey: sk })))
    )).then(r => { setAllQueues(r.flat()); setSelectedQueues([]); });
  }, [selectedBoards.join(',')]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${getToken()}` };
      const spacesData: any = await fetch('/api/spaces', { headers }).then(r => r.ok ? r.json() : {});
      const allSpaces: any[] = spacesData?.spaces || spacesData || [];
      const deskSpaces = allSpaces.filter((s: any) => s.type === 'service_desk' || s.type === 'dept_queue');
      setSpaces(deskSpaces.map((s: any) => ({ key: s.key, name: s.name })));
      if (!deskSpaces.length) { setAllIssues([]); setLoading(false); return; }

      const now = new Date();
      const results = await Promise.allSettled(deskSpaces.map(async (space: any) => {
        const [issuesData, policies, queueData] = await Promise.all([
          fetch(`/api/issues?spaceKey=${space.key}&limit=500`, { headers }).then(r => r.ok ? r.json() : { issues: [] }),
          fetch(`/api/sla/${space.key}`, { headers }).then(r => r.ok ? r.json() : []),
          fetch(`/api/custom-queues/${space.key}`, { headers }).then(r => r.ok ? r.json() : []),
        ]);
        const slaPolicies: any[] = Array.isArray(policies) ? policies : (policies?.policies || []);
        const queues: any[] = Array.isArray(queueData) ? queueData : [];
        const open = (issuesData?.issues || []).filter((i: any) =>
          i.status?.category !== 'done' && i.status?.category !== 'Done');

        const breached: BreachedIssue[] = [];
        for (const issue of open) {
          const priority = (issue.priority || 'medium').toLowerCase();
          for (const policy of slaPolicies) {
            const goals: any[] = policy.goals || [];
            const goal = goals.find((g: any) => (g.priority || '').toLowerCase() === priority)
              || goals.find((g: any) => !g.priority || g.priority === 'all');
            if (!goal) continue;
            const unit = (goal.unit || 'hours').toLowerCase();
            const val = Number(goal.duration || goal.value || 0);
            const durMs = unit.startsWith('min') ? val * 60000 : unit.startsWith('day') ? val * 86400000 : val * 3600000;
            if (!durMs) continue;
            const due = new Date(new Date(issue.createdAt || now).getTime() + durMs);
            if (due < now) {
              const mq = queues.find((q: any) => issue.queueId === q.id);
              const pt = issue.productType || issue.product_type || issue.customFieldValues?.productType || null;
              breached.push({
                key: issue.key, summary: issue.summary || issue.title || '',
                priority: issue.priority || 'medium', issueType: issue.issueType || issue.type || 'task',
                status: issue.status || { name: 'Open', category: 'todo' },
                assignee: issue.assignee || null, spaceKey: space.key, spaceName: space.name,
                queueId: issue.queueId || mq?.id || null, queueName: issue.queueName || mq?.name || null,
                createdAt: issue.createdAt || '', breachedMs: now.getTime() - due.getTime(),
                policyName: policy.name || 'SLA', productType: pt,
              });
              break;
            }
          }
        }
        return breached;
      }));

      const all = results.filter(r => r.status === 'fulfilled').flatMap(r => (r as any).value);
      const seen = new Set<string>();
      const deduped = all.filter(i => { if (seen.has(i.key)) return false; seen.add(i.key); return true; });
      deduped.sort((a, b) => b.breachedMs - a.breachedMs);
      setAllIssues(deduped);
      setLastRefresh(new Date());
    } catch (e) { console.error('[Breached]', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = React.useMemo(() => allIssues.filter(i => {
    if (selectedBoards.length > 0 && !selectedBoards.includes(i.spaceKey)) return false;
    if (selectedQueues.length > 0 && !selectedQueues.includes(i.queueId || '')) return false;
    if (selectedProducts.length > 0 && !selectedProducts.some(p => (i.productType || '').toLowerCase().includes(p.toLowerCase()))) return false;
    return true;
  }), [allIssues, selectedBoards, selectedQueues, selectedProducts]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, { spaceName: string; issues: BreachedIssue[] }>();
    for (const i of filtered) {
      if (!map.has(i.spaceKey)) map.set(i.spaceKey, { spaceName: i.spaceName, issues: [] });
      map.get(i.spaceKey)!.issues.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].issues.length - a[1].issues.length);
  }, [filtered]);

  // Stat computations
  const critical = filtered.filter(i => i.breachedMs > 48 * 3600000).length;
  const unassigned = filtered.filter(i => !i.assignee).length;
  const worst = filtered[0];
  const hasFilters = selectedBoards.length > 0 || selectedQueues.length > 0 || selectedProducts.length > 0;

  return (
    <div className="flex-1 overflow-y-auto bg-[#f8f9fb] min-h-screen">
      {/* Top banner */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center shadow-sm">
              <AlertTriangle size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-[18px] font-bold text-gray-900">Breached SLAs</h1>
              <p className="text-xs text-gray-400 mt-0.5">Tickets past their SLA deadline · auto-refreshes every visit</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && <span className="text-xs text-gray-400">Updated {timeAgo(lastRefresh.toISOString())}</span>}
            <button onClick={load} disabled={loading}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-3 py-2 bg-white hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-40">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-8 py-6 space-y-6">

        {/* Stat cards */}
        {!loading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<AlertCircle size={18} className="text-red-600" />}
              label="Total Breached" value={filtered.length}
              sub={filtered.length === allIssues.length ? 'all queues' : `of ${allIssues.length} total`}
              color="bg-red-50 border-red-200 text-red-900"
            />
            <StatCard
              icon={<Zap size={18} className="text-orange-600" />}
              label="Critical (>48h)" value={critical}
              sub={critical > 0 ? 'needs immediate action' : 'none critical'}
              color="bg-orange-50 border-orange-200 text-orange-900"
            />
            <StatCard
              icon={<Users size={18} className="text-blue-600" />}
              label="Unassigned" value={unassigned}
              sub={unassigned > 0 ? 'no owner assigned' : 'all assigned'}
              color="bg-blue-50 border-blue-200 text-blue-900"
            />
            <StatCard
              icon={<TrendingUp size={18} className="text-violet-600" />}
              label="Boards Affected" value={grouped.length}
              sub={worst ? `worst: ${msToShort(worst.breachedMs)}` : 'none'}
              color="bg-violet-50 border-violet-200 text-violet-900"
            />
          </div>
        )}

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
          <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mr-1">Filter by</span>
          <MultiSelect label="All Boards" options={spaces.map(s => ({ value: s.key, label: s.name }))}
            selected={selectedBoards} onChange={v => { setSelectedBoards(v); setSelectedQueues([]); }}
            colorClass="bg-indigo-50 text-indigo-700 border-indigo-200" />
          {selectedBoards.length > 0 && (
            <>
              <ChevronRight size={14} className="text-gray-300" />
              <MultiSelect label="All Queues" options={allQueues.map(q => ({ value: q.id, label: q.name }))}
                selected={selectedQueues} onChange={setSelectedQueues}
                colorClass="bg-blue-50 text-blue-700 border-blue-200" />
            </>
          )}
          <span className="w-px h-5 bg-gray-200 mx-1" />
          <MultiSelect label="Product Type" options={PRODUCT_TYPES.map(p => ({ value: p, label: p }))}
            selected={selectedProducts} onChange={setSelectedProducts}
            colorClass="bg-violet-50 text-violet-700 border-violet-200" />
          {hasFilters && (
            <button onClick={() => { setSelectedBoards([]); setSelectedQueues([]); setSelectedProducts([]); }}
              className="ml-1 text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors">
              <X size={11} /> Clear all
            </button>
          )}
          {!loading && filtered.length > 0 && (
            <span className="ml-auto text-[11px] text-gray-400">
              Showing <span className="font-semibold text-gray-600">{filtered.length}</span> ticket{filtered.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <DotLoader />
            <p className="text-sm text-gray-400">Checking SLA status across all queues…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm">
            <div className="flex flex-col items-center justify-center py-20 text-center px-8">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center mb-4 shadow">
                <Shield size={28} className="text-white" />
              </div>
              <h2 className="text-lg font-semibold text-gray-800">
                {hasFilters ? 'No matches for current filters' : 'All SLAs on track!'}
              </h2>
              <p className="text-sm text-gray-400 mt-1 max-w-xs">
                {hasFilters
                  ? 'Try adjusting or clearing the board, queue, or product type filter.'
                  : 'Every queue ticket is within its SLA deadline. Great work!'}
              </p>
              {hasFilters && (
                <button onClick={() => { setSelectedBoards([]); setSelectedQueues([]); setSelectedProducts([]); }}
                  className="mt-4 text-xs font-medium text-blue-600 hover:underline">
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([spaceKey, { spaceName, issues: si }]) => (
              <div key={spaceKey} className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
                {/* Board header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
                  <Link href={`/spaces/${spaceKey}`} className="flex items-center gap-2.5 group">
                    <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-red-500 to-rose-600 text-white text-[11px] font-bold flex items-center justify-center shadow-sm">
                      {spaceName.charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <span className="text-sm font-semibold text-gray-800 group-hover:text-blue-600 transition-colors">{spaceName}</span>
                      <span className="text-xs text-gray-400 ml-1.5">{spaceKey}</span>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-2.5 py-0.5">
                      {si.length} breached
                    </span>
                    {si.filter(i => i.breachedMs > 48 * 3600000).length > 0 && (
                      <span className="text-xs font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-2.5 py-0.5">
                        {si.filter(i => i.breachedMs > 48 * 3600000).length} critical
                      </span>
                    )}
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50/50">
                        {['Key', 'Summary', 'Priority', 'Status', 'Queue', 'Product', 'Assignee', 'Overdue'].map(h => (
                          <th key={h} className="text-left text-[10.5px] font-semibold text-gray-400 uppercase tracking-wider px-4 py-2.5 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {si.map(issue => {
                        const sev = severityColor(issue.breachedMs);
                        return (
                          <tr key={issue.key} className="border-b border-gray-50 hover:bg-red-50/20 transition-colors group">
                            <td className="px-4 py-3">
                              <Link href={`/issues/${(issue as any).cfKey ?? issue.key}`} className="text-blue-600 hover:underline font-semibold text-xs">
                                {issue.key}
                              </Link>
                            </td>
                            <td className="px-4 py-3 max-w-[220px]">
                              <div className="flex items-center gap-2">
                                <IssueTypeIcon type={issue.issueType} size={14} />
                                <Link href={`/issues/${(issue as any).cfKey ?? issue.key}`} className="text-gray-800 hover:text-blue-600 hover:underline line-clamp-1 text-[13px] font-medium">
                                  {issue.summary}
                                </Link>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5">
                                <PriorityIcon priority={issue.priority} size={13} />
                                <span className="text-xs text-gray-600 capitalize">{issue.priority}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className={cn(
                                'inline-block text-[11px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap',
                                issue.status.category === 'in_progress' || issue.status.category === 'inprogress'
                                  ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                              )}>
                                {issue.status.name}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {issue.queueName
                                ? <span className="text-xs text-gray-600 bg-gray-100 rounded-md px-2 py-0.5">{issue.queueName}</span>
                                : <span className="text-xs text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {issue.productType
                                ? <span className="inline-block text-[11px] font-medium rounded-full px-2 py-0.5 bg-violet-100 text-violet-700">{issue.productType}</span>
                                : <span className="text-xs text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {issue.assignee
                                ? <span className="text-xs text-gray-700 truncate block max-w-[100px]">{issue.assignee.displayName}</span>
                                : <span className="text-[11px] font-medium text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">Unassigned</span>}
                            </td>
                            <td className="px-4 py-3">
                              <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2.5 py-1', sev.bg, sev.text, 'border', sev.border)}>
                                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', sev.dot)} />
                                {msToShort(issue.breachedMs)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
