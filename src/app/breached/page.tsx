'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { timeAgo, cn } from '@/lib/utils';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import DotLoader from '@/components/ui/DotLoader';
import { AlertTriangle, RefreshCw, Clock } from 'lucide-react';

interface BreachedIssue {
  key: string;
  summary: string;
  priority: string;
  issueType: string;
  status: { name: string; category: string };
  assignee: { displayName: string; avatarUrl?: string } | null;
  spaceKey: string;
  spaceName: string;
  createdAt: string;
  breachedMs: number;
  policyName: string;
}

function msToHuman(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h overdue`;
  return `${h}h overdue`;
}

const PRIORITY_ORDER: Record<string, number> = {
  highest: 0, high: 1, medium: 2, low: 3, lowest: 4,
};

export default function BreachedPage() {
  const { user } = useStore(useShallow(s => ({ user: s.user })));
  const [issues, setIssues] = useState<BreachedIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('jira_token') || '' : '';
      const headers = { Authorization: `Bearer ${token}` };

      // 1. Fetch all spaces
      const spacesRes = await fetch('/api/spaces', { headers });
      const spacesData = await spacesRes.json();
      const allSpaces: any[] = spacesData?.spaces || spacesData || [];

      // 2. Keep service desk / dept queue spaces
      const deskSpaces = allSpaces.filter((s: any) =>
        s.type === 'service_desk' || s.type === 'dept_queue'
      );
      if (deskSpaces.length === 0) { setIssues([]); setLoading(false); return; }

      // 3. For each space fetch issues + SLA policies in parallel
      const now = new Date();
      const perSpace = await Promise.allSettled(
        deskSpaces.map(async (space: any) => {
          const [issuesData, policies] = await Promise.all([
            fetch(`/api/issues?spaceKey=${space.key}&limit=500`, { headers }).then(r => r.ok ? r.json() : { issues: [] }),
            fetch(`/api/sla/${space.key}`, { headers }).then(r => r.ok ? r.json() : []),
          ]);
          const slaPolicies: any[] = Array.isArray(policies) ? policies : (policies?.policies || []);
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
                breached.push({
                  key: issue.key,
                  summary: issue.summary || issue.title || '',
                  priority: issue.priority || 'medium',
                  issueType: issue.issueType || issue.type || 'task',
                  status: issue.status || { name: 'Open', category: 'todo' },
                  assignee: issue.assignee || null,
                  spaceKey: space.key,
                  spaceName: space.name,
                  createdAt: issue.createdAt || issue.created_at || '',
                  breachedMs,
                  policyName: policy.name || 'SLA',
                });
                break; // one breach entry per issue
              }
            }
          }
          return breached;
        })
      );

      const all: BreachedIssue[] = perSpace
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => (r as any).value);

      // Dedupe by key, sort by most overdue first
      const seen = new Set<string>();
      const deduped = all.filter(i => { if (seen.has(i.key)) return false; seen.add(i.key); return true; });
      deduped.sort((a, b) => b.breachedMs - a.breachedMs);

      setIssues(deduped);
      setLastRefresh(new Date());
    } catch (e) {
      console.error('[Breached] load error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, { spaceName: string; issues: BreachedIssue[] }>();
    for (const i of issues) {
      if (!map.has(i.spaceKey)) map.set(i.spaceKey, { spaceName: i.spaceName, issues: [] });
      map.get(i.spaceKey)!.issues.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].issues.length - a[1].issues.length);
  }, [issues]);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
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
              <span className="text-xs text-gray-400">
                Updated {timeAgo(lastRefresh.toISOString())}
              </span>
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

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <DotLoader />
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
              <Clock size={20} className="text-green-600" />
            </div>
            <p className="text-base font-medium text-gray-700">No breached SLAs</p>
            <p className="text-sm text-gray-400 mt-1">All queue tickets are within their SLA targets</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 text-red-700 rounded-full px-3 py-1 font-medium text-xs">
                <AlertTriangle size={11} />
                {issues.length} breached ticket{issues.length !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-400 text-xs">across {grouped.length} space{grouped.length !== 1 ? 's' : ''}</span>
            </div>

            {grouped.map(([spaceKey, { spaceName, issues: spaceIssues }]) => (
              <div key={spaceKey} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                {/* Space header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
                  <Link
                    href={`/spaces/${spaceKey}`}
                    className="flex items-center gap-2 hover:text-blue-600 transition-colors"
                  >
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

                {/* Issues table */}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-4 py-2 w-28">Key</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2">Summary</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-24">Priority</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-28">Status</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-32">Assignee</th>
                      <th className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-2 w-36">Overdue by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spaceIssues.map(issue => (
                      <tr key={issue.key} className="border-b border-gray-50 hover:bg-red-50/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/issues/${issue.key}`}
                            className="text-blue-600 hover:underline font-medium text-xs"
                          >
                            {issue.key}
                          </Link>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-2">
                            <IssueTypeIcon type={issue.issueType} size={14} />
                            <Link
                              href={`/issues/${issue.key}`}
                              className="text-gray-800 hover:text-blue-600 hover:underline line-clamp-1 text-[13px]"
                            >
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
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                          )}>
                            {issue.status.name}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          {issue.assignee ? (
                            <span className="text-xs text-gray-600 truncate block max-w-[120px]">
                              {issue.assignee.displayName}
                            </span>
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
