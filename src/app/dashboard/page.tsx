'use client';

import React, { useEffect, useState, useRef } from 'react';
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
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return display;
}
import Link from 'next/link';
import { typeIcons, timeAgo, cn } from '@/lib/utils';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import SpaceIcon from '@/components/ui/SpaceIcon';
import DotLoader from '@/components/ui/DotLoader';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import {
  ChevronRight, CheckCircle2, LayoutGrid, AlertCircle,
  Zap, ArrowUpRight, Users, Plus
} from 'lucide-react';

type TabType = 'assigned' | 'worked_on' | 'viewed' | 'starred' | 'boards';

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

function StatCards({ totalSpaces, openIssues, resolvedToday, teamMembers, highlightedBox, toggleHighlight }: {
  totalSpaces: number; openIssues: number; resolvedToday: number; teamMembers: number;
  highlightedBox: DashboardHighlight | null; toggleHighlight: (id: DashboardHighlight) => void;
}) {
  const stats = [
    { label: 'Total Spaces',   value: totalSpaces,   icon: <Zap size={16} />,         iconClass: 'text-blue-500 bg-blue-50' },
    { label: 'Open Issues',    value: openIssues,    icon: <AlertCircle size={16} />,  iconClass: 'text-orange-500 bg-orange-50' },
    { label: 'Resolved',       value: resolvedToday, icon: <CheckCircle2 size={16} />, iconClass: 'text-green-500 bg-green-50' },
    { label: 'Team Members',   value: teamMembers,   icon: <Users size={16} />,        iconClass: 'text-purple-500 bg-purple-50' },
  ];
  return (
    <div className="grid grid-cols-4 gap-4">
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
  const [starredSpaceIds, setStarredSpaceIds] = useState<string[]>([]);

  // Helper to read starred spaces from localStorage
  const readStarred = () => {
    try {
      const key = `starred_spaces_${user?.id || 'default'}`;
      return JSON.parse(localStorage.getItem(key) || '[]') as string[];
    } catch { return []; }
  };

  // Load on mount + when user changes
  useEffect(() => { setStarredSpaceIds(readStarred()); }, [user?.id]);

  // Re-read whenever the Starred tab becomes active
  useEffect(() => {
    if (activeTab === 'starred') setStarredSpaceIds(readStarred());
  }, [activeTab]);
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
  /** Click a box to show a black border on that box only; click again to clear. */
  const [highlightedBox, setHighlightedBox] = useState<DashboardHighlight | null>(null);

  const toggleHighlight = (id: DashboardHighlight) => {
    setHighlightedBox((prev) => (prev === id ? null : id));
  };

  const panelShellClick = (e: React.MouseEvent, id: 'spaces' | 'issues') => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    toggleHighlight(id);
  };

  // Cache loaded tabs — avoid re-fetching on every tab switch
  const tabCache = useRef<Partial<Record<TabType, any[]>>>({});

  useEffect(() => { loadSpaces(); }, [loadSpaces]);

  // Only re-fetch when tab or user changes — NOT when spaces changes
  useEffect(() => {
    if (user?.id) loadTabData(activeTab);
  }, [activeTab, user?.id]);

  const loadTabData = async (tab: TabType, forceRefresh = false) => {
    // Return cached data instantly if available and not forcing refresh
    if (!forceRefresh && tabCache.current[tab]) {
      if (tab === 'assigned') setAssignedIssues(tabCache.current[tab]!);
      else setRecentIssues(tabCache.current[tab]!);
      return;
    }

    setLoading(true);
    try {
      if (tab === 'assigned' && user) {
        // Limit to 50 for speed — enough for dashboard
        const data = await api.getIssues({ assignee: user.id, limit: '50' });
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
      } else {
        setRecentIssues([]);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const currentIssues = activeTab === 'assigned' ? assignedIssues : recentIssues;

  const tabs: { key: TabType; label: string; count?: number }[] = [
    { key: 'assigned', label: 'My Assigned Tickets', count: assignedIssues.length },
    { key: 'worked_on', label: 'Worked On' },
    { key: 'viewed', label: 'Viewed' },
    { key: 'starred', label: 'Starred' },
    { key: 'boards', label: 'Boards' },
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
          <div className="flex items-center overflow-x-auto border-b border-gray-200 bg-gray-50 px-4">
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

          {/* Tab content */}
          <div className="min-h-[320px]">
            {loading ? (
              <DotLoader className="py-20" />
            ) : activeTab === 'boards' ? (
              <div className="divide-y divide-gray-100">
                {spaces.map(space => (
                  <Link key={space.id} href={`/spaces/${space.key}/board`}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50">
                    <SpaceIcon icon={space.icon} spaceKey={space.key} spaceName={space.name} spaceType={space.type} size="md" />
                    <div className="flex-1">
                      <p className="text-[13px] font-medium text-gray-900 transition-colors group-hover:text-blue-600">{space.name} Board</p>
                      <p className="text-[11px] text-gray-500">{space.type === 'scrum' ? 'Scrum' : space.type === 'kanban' ? 'Kanban' : 'Service desk'}</p>
                    </div>
                    <LayoutGrid size={14} className="text-gray-300" />
                  </Link>
                ))}
              </div>
            ) : activeTab === 'starred' ? (
              (() => {
                const starredList = spaces.filter(s => starredSpaceIds.includes(s.id));
                return starredList.length > 0 ? (
                  <div className="divide-y divide-gray-100">
                    {starredList.map(space => (
                      <Link key={space.id} href={`/spaces/${space.key}/board`}
                        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50">
                        <SpaceIcon icon={space.icon} spaceKey={space.key} spaceName={space.name} spaceType={space.type} size="md" />
                        <div className="flex-1">
                          <p className="text-[13px] font-medium text-gray-900 transition-colors group-hover:text-blue-600">{space.name}</p>
                          <p className="text-[11px] text-gray-500 capitalize">{space.type?.replace('_', ' ')}</p>
                        </div>
                        <LayoutGrid size={14} className="text-gray-300" />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <CheckCircle2 size={32} className="mb-3 text-gray-300" />
                    <p className="text-[13px] font-medium text-gray-500">No starred items</p>
                    <p className="mt-1 text-[12px] text-gray-400">Star a space from the sidebar to see it here</p>
                  </div>
                );
              })()
            ) : currentIssues.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                    <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Key</th>
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">Summary</th>
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Status</th>
                    <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-10">P</th>
                    <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-20">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {currentIssues.slice(0, 12).map(issue => {
                    return (
                      <tr key={issue.id} className="group transition-colors hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <IssueTypeIcon type={issue.type} size={16} />
                            <Link href={`/issues/${issue.cfKey ?? issue.key}`} className="whitespace-nowrap font-mono text-[11.5px] font-semibold text-blue-600 hover:text-blue-800">
                              {issue.cfKey ?? issue.key}
                            </Link>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 max-w-0">
                          <Link href={`/issues/${issue.cfKey ?? issue.key}`} className="block truncate text-[13px] text-gray-900 transition-colors group-hover:text-jira-dark">
                            {issue.summary}
                          </Link>
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="text-[11px] font-medium text-white px-2 py-0.5 rounded whitespace-nowrap"
                            style={{ backgroundColor: issue.status?.color || '#6B7280' }}>
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
                  {activeTab === 'assigned' ? 'No open issues assigned to you' : 'Nothing here yet'}
                </p>
                {activeTab === 'assigned' && <p className="mt-1 text-[12px] text-gray-400">{"You're all caught up!"}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
