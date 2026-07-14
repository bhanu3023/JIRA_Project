'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { timeAgo, cn } from '@/lib/utils';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import DotLoader from '@/components/ui/DotLoader';
import { AlertTriangle, RefreshCw, Clock, ChevronDown, X, Check, ChevronRight } from 'lucide-react';

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
  if (d >= 1) return `${d}d ${h % 24}h overdue`;
  return `${h}h overdue`;
}

/* ── Generic multi-select dropdown ── */
function MultiSelect({
  label, options, selected, onChange, colorClass = 'bg-blue-50 text-blue-700 border-blue-200', disabled = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  colorClass?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  };

  const displayLabel = selected.length === 0 ? label
    : selected.length === 1 ? (options.find(o => o.value === selected[0])?.label || selected[0])
    : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-2 text-xs font-medium border rounded-lg px-3 py-2 transition-colors min-w-[140px] bg-white',
          disabled ? 'opacity-40 cursor-not-allowed border-gray-200 text-gray-400'
            : selected.length > 0 ? colorClass : 'border-gray-200 text-gray-600 hover:bg-gray-50'
        )}
      >
        <span className="flex-1 text-left truncate">{displayLabel}</span>
        {selected.length > 0 && !disabled && (
          <span role="button" onClick={e => { e.stopPropagation(); onChange([]); }} className="text-gray-400 hover:text-gray-700">
            <X size={11} />
          </span>
        )}
        <ChevronDown size={12} className={cn('text-gray-400 transition-transform flex-shrink-0', open && 'rotate-180')} />
      </button>

      {open && !disabled && options.length > 0 && (
        <div className="absolute top-full left-0 z-50 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[180px] max-h-56 overflow-y-auto">
          {options.map(o => (
            <button
              key={o.value}
              onClick={() => toggle(o.value)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <span className={cn(
                'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center',
                selected.includes(o.value) ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
              )}>
                {selected.includes(o.value) && <Check size={10} className="text-white" />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {open && !disabled && options.length === 0 && (
        <div className="absolute top-full left-0 z-50 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg py-3 px-4 min-w-[180px]">
          <span className="text-xs text-gray-400">No queues found</span>
        </div>
      )}
    </div>
  );
}

export default function BreachedPage() {
  const { user } = useStore(useShallow(s => ({ user: s.user })));
  const [allIssues, setAllIssues] = useState<BreachedIssue[]>([]);
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [allQueues, setAllQueues] = useState<QueueOption[]>([]); // all queues across selected boards
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Filters — boards first, then queues within those boards, then product type
  const [selectedBoards, setSelectedBoards] = useState<string[]>([]);
  const [selectedQueues, setSelectedQueues] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);

  const getToken = () => typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';

  // When boards change, fetch their queues and reset queue selection
  useEffect(() => {
    if (selectedBoards.length === 0) { setAllQueues([]); setSelectedQueues([]); return; }
    const headers = { Authorization: `Bearer ${getToken()}` };
    Promise.all(
      selectedBoards.map(sk =>
        fetch(`/api/custom-queues/${sk}`, { headers })
          .then(r => r.ok ? r.json() : [])
          .then((qs: any[]) => qs.map((q: any) => ({ id: q.id, name: q.name, spaceKey: sk })))
      )
    ).then(results => {
      setAllQueues(results.flat());
      setSelectedQueues([]);
    });
  }, [selectedBoards.join(',')]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${getToken()}` };

      const spacesRes = await fetch('/api/spaces', { headers });
      const spacesData = await spacesRes.json();
      const allSpaces: any[] = spacesData?.spaces || spacesData || [];
      const deskSpaces = allSpaces.filter((s: any) =>
        s.type === 'service_desk' || s.type === 'dept_queue'
      );

      setSpaces(deskSpaces.map((s: any) => ({ key: s.key, name: s.name })));

      if (deskSpaces.length === 0) { setAllIssues([]); setLoading(false); return; }

      const now = new Date();
      const perSpace = await Promise.allSettled(
        deskSpaces.map(async (space: any) => {
          const [issuesData, policies, queueData] = await Promise.all([
            fetch(`/api/issues?spaceKey=${space.key}&limit=500`, { headers }).then(r => r.ok ? r.json() : { issues: [] }),
            fetch(`/api/sla/${space.key}`, { headers }).then(r => r.ok ? r.json() : []),
            fetch(`/api/custom-queues/${space.key}`, { headers }).then(r => r.ok ? r.json() : []),
          ]);
          const slaPolicies: any[] = Array.isArray(policies) ? policies : (policies?.policies || []);
          const queues: any[] = Array.isArray(queueData) ? queueData : [];
          const openIssues: any[] = (issuesData?.issues || []).filter(
            (i: any) => i.status?.category !== 'done' && i.status?.category !== 'Done'
          );

          const breached: BreachedIssue[] = [];
          for (const issue of openIssues) {
            const priority = (issue.priority || 'medium').toLowerCase();
            for (const policy of slaPolicies) {
              const goals: any[] = policy.goals || [];
              const goal = goals.find((g: any) => (g.priority || '').toLowerCase() === priority)
                || goals.find((g: any) => !g.priority || g.priority === 'all');
              if (!goal) continue;

              const unit = (goal.unit || 'hours').toLowerCase();
              const val = Number(goal.duration || goal.value || 0);
              const durationMs = unit.startsWith('min') ? val * 60000
                : unit.startsWith('day') ? val * 86400000
                : val * 3600000;
              if (!durationMs) continue;

              const startedAt = new Date(issue.createdAt || issue.created_at || now);
              const dueTime = new Date(startedAt.getTime() + durationMs);
              if (dueTime < now) {
                const breachedMs = now.getTime() - dueTime.getTime();
                const pt: string | null =
                  issue.productType || issue.product_type ||
                  issue.customFieldValues?.productType ||
                  issue.customFieldValues?.product_type || null;

                // Find which queue this issue belongs to (by queueId field or filter match)
                const matchedQueue = queues.find((q: any) =>
                  issue.queueId === q.id || (q.issueKeys && q.issueKeys.includes(issue.key))
                );

                breached.push({
                  key: issue.key,
                  summary: issue.summary || issue.title || '',
                  priority: issue.priority || 'medium',
                  issueType: issue.issueType || issue.type || 'task',
                  status: issue.status || { name: 'Open', category: 'todo' },
                  assignee: issue.assignee || null,
                  spaceKey: space.key,
                  spaceName: space.name,
                  queueId: issue.queueId || matchedQueue?.id || null,
                  queueName: issue.queueName || matchedQueue?.name || null,
                  createdAt: issue.createdAt || issue.created_at || '',
                  breachedMs,
                  policyName: policy.name || 'SLA',
                  productType: pt,
                });
                break;
              }
            }
          }
          return breached;
        })
      );

      const all: BreachedIssue[] = perSpace
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => (r as any).value);

      const seen = new Set<string>();
      const deduped = all.filter(i => { if (seen.has(i.key)) return false; seen.add(i.key); return true; });
      deduped.sort((a, b) => b.breachedMs - a.breachedMs);

      setAllIssues(deduped);
      setLastRefresh(new Date());
    } catch (e) {
      console.error('[Breached] load error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Apply filters
  const filtered = React.useMemo(() => {
    return allIssues.filter(i => {
      if (selectedBoards.length > 0 && !selectedBoards.includes(i.spaceKey)) return false;
      if (selectedQueues.length > 0 && !selectedQueues.includes(i.queueId || '')) return false;
      if (selectedProducts.length > 0) {
        const pt = (i.productType || '').toLowerCase();
        if (!selectedProducts.some(p => pt.includes(p.toLowerCase()))) return false;
      }
      return true;
    });
  }, [allIssues, selectedBoards, selectedQueues, selectedProducts]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, { spaceName: string; issues: BreachedIssue[] }>();
    for (const i of filtered) {
      if (!map.has(i.spaceKey)) map.set(i.spaceKey, { spaceName: i.spaceName, issues: [] });
      map.get(i.spaceKey)!.issues.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].issues.length - a[1].issues.length);
  }, [filtered]);

  const boardOptions = spaces.map(s => ({ value: s.key, label: s.name }));
  const queueOptions = allQueues.map(q => ({ value: q.id, label: q.name }));
  const productOptions = PRODUCT_TYPES.map(p => ({ value: p, label: p }));
  const hasFilters = selectedBoards.length > 0 || selectedQueues.length > 0 || selectedProducts.length > 0;

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
              <AlertTriangle size={16} className="text-red-600" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Breached SLAs</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Tickets past their SLA deadline across all service desk queues
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-gray-400">Updated {timeAgo(lastRefresh.toISOString())}</span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-md px-3 py-1.5 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Filter bar — Board → Queue → Product Type */}
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          {/* Step 1: Board */}
          <MultiSelect
            label="All Boards"
            options={boardOptions}
            selected={selectedBoards}
            onChange={v => { setSelectedBoards(v); setSelectedQueues([]); }}
            colorClass="bg-indigo-50 text-indigo-700 border-indigo-200"
          />

          {/* Arrow separator */}
          {selectedBoards.length > 0 && (
            <ChevronRight size={14} className="text-gray-300 flex-shrink-0" />
          )}

          {/* Step 2: Queue — only shown after a board is selected */}
          {selectedBoards.length > 0 && (
            <MultiSelect
              label="All Queues"
              options={queueOptions}
              selected={selectedQueues}
              onChange={setSelectedQueues}
              colorClass="bg-blue-50 text-blue-700 border-blue-200"
            />
          )}

          {/* Divider */}
          {selectedBoards.length > 0 && (
            <span className="w-px h-5 bg-gray-200 mx-1" />
          )}

          {/* Step 3: Product Type — always visible */}
          <MultiSelect
            label="Product Type"
            options={productOptions}
            selected={selectedProducts}
            onChange={setSelectedProducts}
            colorClass="bg-violet-50 text-violet-700 border-violet-200"
          />

          {hasFilters && (
            <button
              onClick={() => { setSelectedBoards([]); setSelectedQueues([]); setSelectedProducts([]); }}
              className="text-xs text-gray-400 hover:text-gray-700 flex items-center gap-1 px-2 py-1.5"
            >
              <X size={11} /> Clear all
            </button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <DotLoader />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
              <Clock size={20} className="text-green-600" />
            </div>
            <p className="text-base font-medium text-gray-700">
              {hasFilters ? 'No breached tickets match the filters' : 'No breached SLAs'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {hasFilters ? 'Try clearing the board, queue, or product type filter' : 'All queue tickets are within their SLA targets'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 text-red-700 rounded-full px-3 py-1 font-medium text-xs">
                <AlertTriangle size={11} />
                {filtered.length} breached ticket{filtered.length !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-400 text-xs">across {grouped.length} board{grouped.length !== 1 ? 's' : ''}</span>
            </div>

            {grouped.map(([spaceKey, { spaceName, issues: spaceIssues }]) => (
              <div key={spaceKey} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
                  <Link href={`/spaces/${spaceKey}`} className="flex items-center gap-2 hover:text-blue-600 transition-colors">
                    <span className="w-5 h-5 rounded bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {spaceName.charAt(0).toUpperCase()}
                    </span>
                    <span className="text-sm font-semibold text-gray-800">{spaceName}</span>
                    <span className="text-xs text-gray-400">({spaceKey})</span>
                  </Link>
                  <span className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                    {spaceIssues.length} breached
                  </span>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-4 py-2 w-24">Key</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2">Summary</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-24">Priority</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-24">Status</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-28">Queue</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-24">Product Type</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-24">Assignee</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-28">Overdue by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spaceIssues.map(issue => (
                      <tr key={issue.key} className="border-b border-gray-50 hover:bg-red-50/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <Link href={`/issues/${issue.key}`} className="text-blue-600 hover:underline font-medium text-xs">
                            {issue.key}
                          </Link>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-2">
                            <IssueTypeIcon type={issue.issueType} size={14} />
                            <Link href={`/issues/${issue.key}`} className="text-gray-800 hover:text-blue-600 hover:underline line-clamp-1 text-[13px]">
                              {issue.summary}
                            </Link>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <PriorityIcon priority={issue.priority} size={13} />
                            <span className="text-xs text-gray-600 capitalize">{issue.priority}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <span className={cn(
                            'inline-block text-[11px] font-medium rounded-full px-2 py-0.5',
                            issue.status.category === 'in_progress' || issue.status.category === 'inprogress'
                              ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                          )}>
                            {issue.status.name}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          {issue.queueName ? (
                            <span className="text-xs text-gray-600">{issue.queueName}</span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {issue.productType ? (
                            <span className="inline-block text-[11px] font-medium rounded-full px-2 py-0.5 bg-violet-100 text-violet-700">
                              {issue.productType}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {issue.assignee ? (
                            <span className="text-xs text-gray-600 truncate block max-w-[100px]">{issue.assignee.displayName}</span>
                          ) : (
                            <span className="text-xs text-gray-400">Unassigned</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="text-xs font-medium text-red-600 flex items-center gap-1">
                            <AlertTriangle size={11} />
                            {msToHuman(issue.breachedMs)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
