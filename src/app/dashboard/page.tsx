'use client';

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { getRecentItems } from '@/lib/recent-items';

/** Animated count-up — runs every time the component mounts (every Home visit).
 *  Counts from 0 → target with ease-out over `duration` ms. */
function useCountUp(target: number, duration = 1200) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setDisplay(0);
    if (target === 0) return;
    const startTime = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress); // ease-out quad
      setDisplay(Math.round(target * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    // requestAnimationFrame is throttled — and can be paused indefinitely —
    // for a tab that isn't actively visible/focused. A stat card landing here
    // right as the page loads in a background tab (a very ordinary thing to
    // happen: switching away right after clicking a link, an occluded window,
    // etc.) meant rAF might never fire even once, permanently stuck at 0 with
    // no way to recover since the effect never re-fires once mounted.
    // setTimeout still fires (throttled to at most ~1/sec in background tabs,
    // but never fully suspended) so this guarantees the real value eventually
    // lands regardless of whether the animation itself ever got to run.
    const fallback = setTimeout(() => setDisplay(target), duration + 100);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearTimeout(fallback);
    };
  }, [target, duration]);

  return display;
}
import Link from 'next/link';
import { typeIcons, timeAgo, cn, resolveStatusColor } from '@/lib/utils';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import DotLoader from '@/components/ui/DotLoader';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import {
  ChevronRight, CheckCircle2, AlertCircle,
  Zap, ArrowUpRight, Users, Plus
} from 'lucide-react';

type TabType = 'assigned' | 'worked_on' | 'viewed' | 'migration_reporters';

type DashboardHighlight = 'stat-0' | 'stat-1' | 'stat-2' | 'stat-3' | 'spaces' | 'issues';

function StatCard({ label, value, icon, iconClass, id, selected, onToggle }: {
  label: string; value: number; icon: React.ReactNode; iconClass: string;
  id: DashboardHighlight; selected: boolean; onToggle: () => void;
}) {
  const animated = useCountUp(value);
  return (
    <div
      role="button" tabIndex={0} aria-pressed={selected}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border-2 bg-white p-4 shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        selected ? 'border-gray-900 shadow-md' : 'border-gray-200 hover:border-blue-300',
      )}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconClass}`}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-semibold leading-none text-jira-dark tabular-nums">{animated.toLocaleString()}</p>
        <p className="mt-0.5 text-[11.5px] text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function StatCards({ totalSpaces, openIssues, resolvedToday, teamMembers, isAdmin, highlightedBox, toggleHighlight }: {
  totalSpaces: number; openIssues: number; resolvedToday: number; teamMembers: number; isAdmin: boolean;
  highlightedBox: DashboardHighlight | null; toggleHighlight: (id: DashboardHighlight) => void;
}) {
  const stats = [
    { label: 'Total Spaces',   value: totalSpaces,   icon: <Zap size={16} />,         iconClass: 'text-blue-500 bg-blue-50' },
    { label: 'Open Issues',    value: openIssues,    icon: <AlertCircle size={16} />,  iconClass: 'text-orange-500 bg-orange-50' },
    { label: 'Resolved',       value: resolvedToday, icon: <CheckCircle2 size={16} />, iconClass: 'text-green-500 bg-green-50' },
    // Org-wide member count is admin-only info
    ...(isAdmin ? [{ label: 'Team Members', value: teamMembers, icon: <Users size={16} />, iconClass: 'text-purple-500 bg-purple-50' }] : []),
  ];
  return (
    <div className={cn('grid gap-4', isAdmin ? 'grid-cols-4' : 'grid-cols-3')}>
      {stats.map((stat, i) => {
        const id = `stat-${i}` as DashboardHighlight;
        return (
          <StatCard key={i} {...stat} id={id} selected={highlightedBox === id} onToggle={() => toggleHighlight(id)} />
        );
      })}
    </div>
  );
}

export default function DashboardPage() {
  const { spaces, loadSpaces, user } = useStore(
    useShallow((s) => ({
      spaces: s.spaces,
      loadSpaces: s.loadSpaces,
      user: s.user,
    })),
  );
  const [activeTab, setActiveTab] = useState<TabType>('assigned');
  const [assignedIssues, setAssignedIssues] = useState<any[]>([]);
  const [openIssuesCount, setOpenIssuesCount] = useState(0);
  const [resolvedTodayCount, setResolvedTodayCount] = useState(0);

  // Fetch per-user stats — assigned tickets split by open vs done
  useEffect(() => {
    if (!user?.id) return;
    // Open: my assigned tickets NOT in done status
    api.getIssues({ assignee: user.id, excludeDone: 'true', limit: '1' })
      .then((d: any) => setOpenIssuesCount(d.total ?? 0))
      .catch(() => {});
    // Resolved: my assigned tickets IN done status
    api.getIssues({ assignee: user.id, statusCategory: 'done', limit: '1' })
      .then((d: any) => setResolvedTodayCount(d.total ?? 0))
      .catch(() => {});
  }, [user?.id]);
  const [showWelcome, setShowWelcome] = useState(false);
  // Increments every time this page mounts → forces StatCards to remount and re-animate
  const [animKey, setAnimKey] = useState(0);
  useEffect(() => { setAnimKey(k => k + 1); }, []);

  // Show welcome banner once per session
  useEffect(() => {
    if (!sessionStorage.getItem('welcomed')) {
      sessionStorage.setItem('welcomed', '1');
      setShowWelcome(true);
      const t = setTimeout(() => setShowWelcome(false), 4000);
      return () => clearTimeout(t);
    }
  }, []);
  const [recentIssues, setRecentIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  /** Click a box to show a black border on that box only; click again to clear.
      For the Open Issues / Resolved stat cards specifically, this now ALSO
      actually filters "My Assigned Tickets" to match -- clicking used to
      only draw a highlight border with no effect on what's shown, which
      looked like the click did nothing (worse, "Resolved" had literally no
      way to see those tickets at all: the assigned-tab fetch always sent
      excludeDone=true, matching only the Open Issues count). Switches to
      that tab too, so the filtered result is immediately visible instead of
      silently updating a tab you might not currently be looking at. */
  const [highlightedBox, setHighlightedBox] = useState<DashboardHighlight | null>(null);

  const toggleHighlight = (id: DashboardHighlight) => {
    setHighlightedBox((prev) => {
      const next = prev === id ? null : id;
      if (id === 'stat-1' || id === 'stat-2') setActiveTab('assigned');
      return next;
    });
  };

  const panelShellClick = (e: React.MouseEvent, id: 'spaces' | 'issues') => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    toggleHighlight(id);
  };

  // Cache loaded tabs — avoid re-fetching on every tab switch
  const tabCache = useRef<Partial<Record<TabType, any[]>>>({});

  useEffect(() => { loadSpaces(); }, [loadSpaces]);

  // Only re-fetch when tab or user changes — NOT when spaces changes.
  // Also re-fetch on highlightedBox so toggling the Open Issues/Resolved
  // stat card while already on (or switching to) "My Assigned Tickets"
  // actually re-queries with the matching filter instead of leaving
  // whatever was already loaded on screen.
  useEffect(() => {
    if (user?.id) loadTabData(activeTab);
  }, [activeTab, user?.id, highlightedBox]);

  // Distinct reporters with at least one ticket currently in the Migration
  // department — Migration Manager / admin only, see the tab below.
  const [migrationReporters, setMigrationReporters] = useState<any[]>([]);
  const canSeeMigrationReporters = user?.role === 'admin' || user?.role === 'migration_manager';

  // Separate cache for the "Resolved" stat-card view of My Assigned Tickets --
  // a genuinely different query (statusCategory=done instead of excludeDone),
  // not just a client-side filter of the same result set, so it needs its own
  // cache slot rather than sharing tabCache['assigned'] with the open-tickets
  // view and clobbering whichever one was fetched more recently.
  const assignedResolvedCache = useRef<any[] | null>(null);

  const loadTabData = async (tab: TabType, forceRefresh = false) => {
    if (tab === 'assigned' && highlightedBox === 'stat-2') {
      if (!forceRefresh && assignedResolvedCache.current) {
        setAssignedIssues(assignedResolvedCache.current);
        return;
      }
      setLoading(true);
      try {
        if (user) {
          const data = await api.getIssues({ assignee: user.id, statusCategory: 'done', limit: '50' });
          const issues = data.issues || [];
          setAssignedIssues(issues);
          assignedResolvedCache.current = issues;
        }
      } catch { /* ignore */ }
      setLoading(false);
      return;
    }

    // Return cached data instantly if available and not forcing refresh
    if (!forceRefresh && tabCache.current[tab]) {
      if (tab === 'assigned') setAssignedIssues(tabCache.current[tab]!);
      else if (tab === 'migration_reporters') setMigrationReporters(tabCache.current[tab]!);
      else setRecentIssues(tabCache.current[tab]!);
      return;
    }

    setLoading(true);
    try {
      if (tab === 'assigned' && user) {
        // Limit to 50 for speed — enough for dashboard. excludeDone so a
        // resolved ticket doesn't linger in "My Assigned Tickets" alongside
        // the actually-open ones it's meant to surface.
        const data = await api.getIssues({ assignee: user.id, excludeDone: 'true', limit: '50' });
        const issues = data.issues || [];
        setAssignedIssues(issues);
        tabCache.current[tab] = issues;
      } else if (tab === 'worked_on' && user) {
        const data = await api.request<{ issues: any[] }>(`/worked-on?userId=${user.id}`).catch(() => ({ issues: [] }));
        setRecentIssues(data.issues || []);
        tabCache.current[tab] = data.issues || [];
      } else if (tab === 'viewed') {
        // Use localStorage recent items — no API call needed, instant
        const recentIssueItems = getRecentItems(user?.id).filter(i => i.type === 'issue').slice(0, 15);
        if (recentIssueItems.length === 0) { setRecentIssues([]); setLoading(false); return; }
        // Single bulk fetch using keys filter instead of N individual calls
        const keys = recentIssueItems.map(i => i.id);
        const data = await api.getIssues({ keys: keys.join(','), limit: '15' }).catch(() => ({ issues: [] }));
        // Sort by visit order from localStorage
        const issueMap = new Map((data.issues || []).map((i: any) => [i.key, i]));
        const ordered = keys.map(k => issueMap.get(k)).filter(Boolean) as any[];
        setRecentIssues(ordered);
        tabCache.current[tab] = ordered;
      } else if (tab === 'migration_reporters' && canSeeMigrationReporters) {
        const data = await api.request<{ reporters: any[] }>('/migration-reporters').catch(() => ({ reporters: [] }));
        setMigrationReporters(data.reporters || []);
        tabCache.current[tab] = data.reporters || [];
      } else {
        setRecentIssues([]);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const currentIssues = activeTab === 'assigned' ? assignedIssues : recentIssues;

  // Worked On mixes hand-offs across every department a ticket passed
  // through — filter down to just one queue's entries (e.g. only Migration
  // or only Dev) instead of always showing everything at once.
  const [workedOnDeptFilter, setWorkedOnDeptFilter] = useState('');
  const workedOnDepts = useMemo(
    () => Array.from(new Set(recentIssues.map((i: any) => i.dept).filter(Boolean))).sort(),
    [recentIssues],
  );
  const displayedIssues = (activeTab === 'worked_on' && workedOnDeptFilter)
    ? currentIssues.filter((i: any) => (i.dept || '').toLowerCase() === workedOnDeptFilter.toLowerCase())
    : currentIssues;

  const tabs: { key: TabType; label: string; count?: number }[] = [
    { key: 'assigned', label: highlightedBox === 'stat-2' ? 'My Assigned Tickets — Resolved' : 'My Assigned Tickets', count: assignedIssues.length },
    { key: 'worked_on', label: 'Worked On' },
    { key: 'viewed', label: 'Viewed' },
    ...(canSeeMigrationReporters ? [{ key: 'migration_reporters' as const, label: 'Migration Reporters' }] : []),
  ];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="max-w-[1120px] mx-auto px-6 py-6 space-y-5">

      {/* Welcome banner — shows once per session */}
      <div
        className="overflow-hidden transition-all duration-700 ease-in-out"
        style={{ maxHeight: showWelcome ? '80px' : '0px', opacity: showWelcome ? 1 : 0 }}
      >
        <div className="flex items-center gap-3 rounded-xl px-5 py-3.5 mb-1"
          style={{ background: 'linear-gradient(135deg, #0129AC, #1a52e8)' }}>
          <span className="text-2xl">👋</span>
          <div>
            <p className="text-white font-semibold text-[14px] leading-tight">
              Welcome to <span className="text-blue-200">Neutara Technologies Ticketing</span>
            </p>
            <p className="text-blue-200/70 text-[12px] mt-0.5">
              Hi {user?.firstName}, glad to have you back!
            </p>
          </div>
          <button onClick={() => setShowWelcome(false)}
            className="ml-auto text-white/50 hover:text-white text-lg leading-none transition-colors">×</button>
        </div>
      </div>

      {/* Page header */}
      <div className="flex items-center justify-between pb-1">
        <div>
          <h1 className="text-[22px] font-semibold text-jira-dark">
            <span className="text-blue-600">{greeting},</span>{' '}
            {user?.firstName} {user?.lastName}
          </h1>
          <p className="mt-0.5 text-[13px] text-gray-500">Have a productive day!</p>
        </div>
        {user?.role === 'admin' && (
          <div className="flex items-center gap-2">
            <Link href="/spaces?create=true"
              className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-gray-800 transition-colors hover:bg-gray-50">
              <Plus size={13} /> New Space
            </Link>
          </div>
        )}
      </div>

      {/* Stats row */}
      <StatCards
        key={animKey}
        totalSpaces={spaces.length}
        openIssues={openIssuesCount}
        resolvedToday={resolvedTodayCount}
        teamMembers={spaces.reduce((a, s) => a + (s.memberCount || 0), 0)}
        isAdmin={user?.role === 'admin'}
        highlightedBox={highlightedBox}
        toggleHighlight={toggleHighlight}
      />

      <div className="grid grid-cols-1 gap-5">
        {/* Issues panel — full width */}
        <div
          role="presentation"
          onClick={(e) => panelShellClick(e, 'issues')}
          className={cn(
            'col-span-1 cursor-default overflow-hidden rounded-lg border-2 bg-white shadow-sm transition-colors',
            highlightedBox === 'issues' ? 'border-gray-900 shadow-md' : 'border-gray-200 hover:border-blue-300',
          )}
        >
          {/* Tabs */}
          <div className="flex items-center justify-between overflow-x-auto border-b border-gray-200 bg-gray-50 px-4">
            <div className="flex items-center">
              {tabs.map(tab => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                  className={`whitespace-nowrap border-b-2 px-3 py-3 text-[12.5px] font-medium transition-colors ${
                    activeTab === tab.key
                      ? 'border-blue-600 text-jira-dark'
                      : 'border-transparent text-gray-500 hover:text-gray-900'
                  }`}>
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className={`ml-1.5 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${
                      activeTab === tab.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'
                    }`}>{tab.count}</span>
                  )}
                </button>
              ))}
            </div>
            {/* Worked On mixes every department a ticket passed through into one
                list — let it be scoped down to just one queue (e.g. Migration
                or Dev) instead of always showing the mix. */}
            {activeTab === 'worked_on' && workedOnDepts.length > 0 && (
              <select
                value={workedOnDeptFilter}
                onChange={(e) => setWorkedOnDeptFilter(e.target.value)}
                className="flex-shrink-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[12px] font-medium text-gray-700 outline-none focus:border-blue-500"
              >
                <option value="">All queues</option>
                {workedOnDepts.map((d: string) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
          </div>

          {/* Tab content — capped height + its own scroll, so a long list
              (e.g. ~200 Migration reporters) scrolls in place instead of
              growing the whole page and pushing the header/stats/tabs
              off-screen as you scroll down. */}
          <div className="min-h-[320px] max-h-[560px] overflow-y-auto">
            {loading ? (
              <DotLoader className="py-20" />
            ) : activeTab === 'migration_reporters' ? (
              migrationReporters.length > 0 ? (
                <table className="w-full">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                      <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">Reporter</th>
                      <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">Email</th>
                      <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-32">Migration Tickets</th>
                      <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Last Activity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {migrationReporters.map((r, idx) => (
                      <tr key={r.id || `${r.name}-${idx}`} className="transition-colors hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <Link
                            href={r.id ? `/filters?reporter=${r.id}&department=Migration` : '#'}
                            className={cn('text-[13px] font-medium', r.id ? 'text-blue-600 hover:text-blue-800' : 'text-gray-700')}
                          >
                            {r.name}
                          </Link>
                        </td>
                        <td data-hj-suppress className="px-2 py-2.5 text-[12.5px] text-gray-600">{r.email || '—'}</td>
                        <td className="px-2 py-2.5 text-[12.5px] text-gray-900 font-medium">{r.ticketCount}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-[11px] text-gray-500">
                          {r.lastActivity ? timeAgo(r.lastActivity) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Users size={32} className="mb-3 text-gray-300" />
                  <p className="text-[13px] font-medium text-gray-500">No reporters in the Migration queue right now</p>
                </div>
              )
            ) : displayedIssues.length > 0 ? (
              <table className="w-full">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                    <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Key</th>
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">Summary</th>
                    {activeTab === 'worked_on' && (
                      <>
                        <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Queue</th>
                        <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-32">Reporter</th>
                      </>
                    )}
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Status</th>
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-10">P</th>
                    <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-20">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {displayedIssues.slice(0, 12).map(issue => {
                    // "Worked On" shows this queue's own FROZEN snapshot for a
                    // ticket that's since moved to a different department (see
                    // the same ?viewDept= pattern on the spaces page's own
                    // Worked-on list) -- without this, opening a ticket the
                    // Dev queue shows here landed on the issue detail page
                    // showing whatever department the ticket is CURRENTLY in
                    // (e.g. Migration), directly contradicting the Dev queue
                    // this same row was just opened from.
                    const issueHref = activeTab === 'worked_on' && (issue as any).dept
                      ? `/issues/${issue.cfKey ?? issue.key}?viewDept=${encodeURIComponent((issue as any).dept)}`
                      : `/issues/${issue.cfKey ?? issue.key}`;
                    return (
                      <tr key={issue.id} className="group transition-colors hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <IssueTypeIcon type={issue.type} size={16} />
                            <Link href={issueHref} className="whitespace-nowrap font-mono text-[11.5px] font-semibold text-blue-600 hover:text-blue-800">
                              {issue.cfKey ?? issue.key}
                            </Link>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 max-w-0">
                          <Link href={issueHref} className="block truncate text-[13px] text-gray-900 transition-colors group-hover:text-jira-dark">
                            {issue.summary}
                          </Link>
                        </td>
                        {activeTab === 'worked_on' && (
                          <>
                            <td className="px-2 py-2.5 text-[11.5px] text-gray-600">{(issue as any).dept || '—'}</td>
                            <td className="px-2 py-2.5 text-[11.5px] text-gray-600 truncate max-w-[130px]" title={(issue as any).reporterEmail || undefined}>
                              {(issue as any).reporterName || <span className="text-gray-300">—</span>}
                            </td>
                          </>
                        )}
                        <td className="px-2 py-2.5">
                          <span className="text-[11px] font-medium text-white px-2 py-0.5 rounded whitespace-nowrap"
                            style={{ backgroundColor: issue.status ? resolveStatusColor(issue.status) : '#6B7280' }}>
                            {issue.status?.name || 'Open'}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <PriorityIcon priority={issue.priority} size={14} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-[11px] text-gray-500">{timeAgo(issue.updatedAt || issue.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 size={32} className="mb-3 text-gray-300" />
                <p className="text-[13px] font-medium text-gray-500">
                  {activeTab === 'assigned'
                    ? (highlightedBox === 'stat-2' ? 'No resolved tickets assigned to you yet' : 'No open issues assigned to you')
                    : 'Nothing here yet'}
                </p>
                {activeTab === 'assigned' && highlightedBox !== 'stat-2' && <p className="mt-1 text-[12px] text-gray-400">{"You're all caught up!"}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
