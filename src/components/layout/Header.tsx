'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { getInitials, timeAgo } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import CreateIssueModal from '@/components/issues/CreateIssueModal';
import {
  Search,
  Bell,
  Plus,
  LogOut,
  User,
  Settings,
  LayoutGrid,
  Zap,
  ShieldCheck,
  ChevronDown,
  X,
} from 'lucide-react';

const PRIVILEGED_ROLES = ['admin'];

export default function Header() {
  const { user, logout, notifications, unreadCount, loadNotifications, markAllNotificationsRead, spaces, bumpIssuesVersion } = useStore(
    useShallow((s) => ({
      user: s.user,
      logout: s.logout,
      notifications: s.notifications,
      unreadCount: s.unreadCount,
      loadNotifications: s.loadNotifications,
      markAllNotificationsRead: s.markAllNotificationsRead,
      spaces: s.spaces,
      bumpIssuesVersion: s.bumpIssuesVersion,
    })),
  );
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [activeIdx, setActiveIdx]       = useState(-1);
  const searchRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // If the user is currently viewing a space/queue, the global Create button
  // should default to that space + department instead of always the first
  // space in the list — otherwise a ticket created while looking at e.g. the
  // "Migration" queue silently lands with no department and never shows up
  // there (it isn't visible from any department-filtered queue).
  const spaceMatch = pathname?.match(/^\/spaces\/([^/]+)/);
  const pathSpaceKey = spaceMatch ? decodeURIComponent(spaceMatch[1]).toUpperCase() : '';
  const pathSpace = pathSpaceKey ? spaces.find((s: any) => s.key === pathSpaceKey) : undefined;
  const defaultSpace = pathSpace || spaces[0];
  const defaultSpaceKey = defaultSpace?.key || '';

  const queueParam = searchParams?.get('queue') || '';
  const deptParam = searchParams?.get('dept') || '';
  let headerInitialDept: string | undefined = deptParam || undefined;
  if (!headerInitialDept && pathSpaceKey && queueParam.startsWith('cq_')) {
    try {
      const stored = localStorage.getItem(`custom_queues_${pathSpaceKey}`);
      const queues = stored ? JSON.parse(stored) : [];
      headerInitialDept = queues.find((q: any) => q.id === queueParam)?.name || undefined;
    } catch { /* localStorage may be unavailable or stale — fall back to no default */ }
  }

  useEffect(() => {
    loadNotifications();
    // Poll for new notifications every 30 seconds (real-time feel without WebSocket)
    const interval = setInterval(() => { loadNotifications(); }, 30000);
    // Monitor agent (SLA breach warnings + duplicate detection) used to be triggered
    // from here too — every open tab ran its own copy every 5 minutes, so N staff with
    // the app open meant N concurrent full scans hammering the shared DB pool. It now
    // runs server-side once per process instead (see runMonitorAgentScan in
    // jira-pg-api.ts), independent of how many tabs are open.
    return () => { clearInterval(interval); };
  }, [loadNotifications]);

  const closeAll = () => {
    setShowNotifications(false);
    setShowUserMenu(false);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setActiveIdx(-1);
    inputRef.current?.blur();
  };

  // Clicking outside used to only close the dropdown (setSearchOpen(false)),
  // leaving the typed query sitting in the box with no results visible and no
  // way to tell the search was still "active" — every OTHER way of dismissing
  // the search (the X button, Escape, picking a result) fully resets it via
  // closeSearch(). Use the same reset here so dismissing it is consistent
  // regardless of how it happens.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        closeSearch();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Live search with debounce
  const extractIssueKey = (input: string): string | null => {
    const urlMatch = input.match(/\/issues\/([A-Za-z0-9_-]+(?:-[A-Za-z0-9]+)*)(?:\?|#|$)/);
    if (urlMatch) return urlMatch[1];
    const keyMatch = input.trim().match(/^(CF-\d+|[A-Z][A-Z0-9]+-\d+)$/i);
    if (keyMatch) return keyMatch[1].toUpperCase();
    return null;
  };

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    setActiveIdx(-1);
    setSearchResults([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const issueKey = extractIssueKey(q.trim());
    const searchTerm = issueKey || q.trim();
    if (!searchTerm) { setSearchLoading(false); setSearchOpen(false); return; }
    setSearchLoading(true);
    setSearchOpen(true);
    const seq = ++searchSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.search(searchTerm);
        if (seq !== searchSeqRef.current) return; // stale response — newer query in flight
        setSearchResults((res.issues || []).slice(0, 8));
      } catch {
        if (seq === searchSeqRef.current) setSearchResults([]);
      }
      if (seq === searchSeqRef.current) setSearchLoading(false);
    }, 200);
  }, [spaces]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!searchOpen) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, searchResults.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && searchResults[activeIdx]) {
        router.push(`/issues/${(searchResults[activeIdx] as any).cfKey ?? searchResults[activeIdx].key}`);
        closeSearch();
      } else {
        const issueKey = extractIssueKey(searchQuery.trim());
        if (issueKey) {
          router.push(`/issues/${issueKey}`);
          closeSearch();
        } else if (searchQuery.trim()) {
          router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
          closeSearch();
        }
      }
    }
    if (e.key === 'Escape') closeSearch();
  };

  return (
    <>

      {/*
        z-40, not z-30 -- z-index on a child (the notification/user-menu
        dropdowns below, at z-50) only ranks it within ITS OWN ancestor's
        stacking context, it doesn't escape it. The Filters page has its own
        `sticky top-0 z-30` toolbar; tied with this header's old z-30, the
        later one in DOM order (the page's toolbar) won the tie-break and
        painted over the whole header layer, dropdowns included, no matter
        their own z-index. z-40 sits safely above any same-page z-30 sticky
        bar while staying below real modals (Create Task's z-50 backdrop,
        the z-[9999] dropdowns elsewhere), so ordering there is unaffected.
      */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-blue-900/30 bg-[#0129AC] px-5 shadow-md">
        {/* Live search bar */}
        <div ref={searchRef} className="relative flex-1 max-w-xs">
          <div className={`flex items-center gap-2 rounded border px-3 py-2 transition-all ${searchFocused ? 'border-white/40 bg-white/15' : 'border-white/10 bg-white/5'}`}>
            <Search size={14} className="flex-shrink-0 text-blue-300" />
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              onFocus={() => { setSearchFocused(true); if (searchQuery.trim()) setSearchOpen(true); }}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search anything…"
              className="flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-blue-200/60 min-w-0"
            />
            {searchQuery && (
              <button type="button" onClick={closeSearch} className="text-blue-300 hover:text-white flex-shrink-0">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Live results dropdown */}
          {searchOpen && (
            <div className="absolute left-0 top-full mt-1 w-[420px] bg-white rounded-lg border border-gray-200 shadow-2xl z-[9999] overflow-hidden">
              {/* Header */}
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Issues</span>
                {searchLoading && <div className="w-3.5 h-3.5 border-2 border-blue-200 border-t-blue-500 rounded-full animate-spin" />}
              </div>

              {/* Results */}
              {!searchLoading && searchResults.length === 0 && (
                <div className="px-4 py-6 text-center">
                  <p className="text-[13px] text-gray-400">No results for "<span className="font-medium text-gray-600">{searchQuery}</span>"</p>
                  <p className="text-[11px] text-gray-400 mt-1">Try searching by issue key (e.g. INFRA-1) or summary</p>
                </div>
              )}

              {searchResults.map((issue, idx) => (
                <Link
                  key={issue.id}
                  href={`/issues/${issue.cfKey ?? issue.key}`}
                  onClick={closeSearch}
                  className={`flex items-start gap-3 px-4 py-3 border-b border-gray-50 transition-colors cursor-pointer ${activeIdx === idx ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  {/* Type icon */}
                  <div className="mt-0.5 flex-shrink-0">
                    <IssueTypeIcon type={issue.type || 'task'} size={15} />
                  </div>
                  {/* Key + Summary */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-blue-600 font-mono flex-shrink-0">{(issue as any).cfKey ?? issue.key}</span>
                      <span className="text-[13px] text-gray-800 truncate">{issue.summary}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-gray-400">{issue.spaceKey || issue.spaceId}</span>
                      {issue.status?.name && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                          style={{ color: issue.status.color, backgroundColor: `${issue.status.color}18`, border: `1px solid ${issue.status.color}40` }}>
                          {issue.status.name}
                        </span>
                      )}
                      {issue.priority && (
                        <span className="text-[11px] text-gray-400 capitalize">{issue.priority}</span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}

              {/* Footer: press Enter to see all */}
              {searchQuery.trim() && (
                <div
                  className="px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => { router.push(`/search?q=${encodeURIComponent(searchQuery)}`); closeSearch(); }}
                >
                  <span className="text-[12px] text-blue-600 font-medium">View all results for "{searchQuery}"</span>
                  <kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50">↵</kbd>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Create button — opens modal directly, no dropdown */}
        <button
          onClick={() => { closeAll(); setShowCreateModal(true); }}
          className="flex items-center gap-1.5 rounded border border-white/40 bg-white/15 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-white/25 flex-shrink-0"
        >
          <Plus size={15} strokeWidth={2.5} />
          <span>Create</span>
        </button>

        <div className="relative flex-shrink-0">
          <button
            onClick={() => {
              closeAll();
              setShowNotifications((v) => !v);
            }}
            className="relative flex h-9 w-9 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Bell size={17} />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border border-white/30 bg-red-500 text-[9px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {showNotifications && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
              <div className="absolute right-0 top-full z-50 mt-2 max-h-96 w-80 snap-y snap-proximity overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                <div className="sticky top-0 flex items-center justify-between rounded-t-lg border-b border-gray-200 bg-white px-4 py-3">
                  <span className="text-[15px] font-semibold text-jira-dark">Notifications</span>
                  <button
                    onClick={() => markAllNotificationsRead()}
                    className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
                  >
                    Mark all read
                  </button>
                </div>
                {notifications.length === 0 ? (
                  <div className="p-8 text-center">
                    <Bell size={24} className="mx-auto mb-2 text-gray-300" />
                    <p className="text-[13px] text-gray-500">All caught up!</p>
                  </div>
                ) : (
                  notifications.slice(0, 50).map((n) => (
                    <div
                      key={n.id}
                      // snap-start + scroll-mt so scrolling settles on a full item
                      // instead of stopping mid-item with its title tucked behind
                      // the sticky "Notifications" header above — scroll-mt offsets
                      // the snap point by the header's own height so the item's
                      // title lands just below it, not underneath it.
                      className={`group relative snap-start scroll-mt-12 border-b border-gray-100 px-4 py-3 transition-colors hover:bg-gray-50 ${!n.isRead ? 'bg-blue-50/50' : ''}`}
                    >
                      <div className="flex items-start gap-2">
                        {/* Blue dot for unread */}
                        <div className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${!n.isRead ? 'bg-blue-500' : 'bg-transparent'}`} />
                        <div
                          className="flex-1 cursor-pointer min-w-0"
                          onClick={() => {
                            if (n.issueKey) router.push(`/issues/${n.issueKey}`);
                            if (!n.isRead) { api.markRead(n.id); loadNotifications(); }
                            closeAll();
                          }}
                        >
                          <p className="text-[13px] font-semibold text-gray-900 leading-snug">{n.title}</p>
                          {n.message && (
                            <p className="mt-0.5 truncate text-[11px] text-gray-500">{n.message}</p>
                          )}
                          <p className="mt-1 text-[11px] text-gray-400">{timeAgo(n.createdAt)}</p>
                        </div>
                        {/* Mark single as read button */}
                        {!n.isRead && (
                          <button
                            onClick={(e) => { e.stopPropagation(); api.markRead(n.id); loadNotifications(); }}
                            className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap mt-0.5"
                            title="Mark as read"
                          >
                            ✓ Read
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {isPrivileged && (
          <Link
            href="/settings"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Settings size={17} />
          </Link>
        )}

        <div className="relative flex-shrink-0">
          <button
            onClick={() => {
              closeAll();
              setShowUserMenu((v) => !v);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/40 bg-white/20 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-white/30"
          >
            {getInitials(user?.firstName, user?.lastName)}
          </button>
          {showUserMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
                <div className="border-b border-gray-200 bg-gray-50 px-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-blue-600 text-[13px] font-bold text-white">
                      {getInitials(user?.firstName, user?.lastName)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-jira-dark">
                        {user?.firstName} {user?.lastName}
                      </p>
                      <p className="truncate text-[12px] text-gray-500">{user?.email}</p>
                    </div>
                  </div>
                </div>
                <div className="py-1">
                  <Link
                    href="/account"
                    onClick={() => setShowUserMenu(false)}
                    className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-gray-800 transition-colors hover:bg-gray-50"
                  >
                    <User size={15} className="text-blue-600" /> Profile
                  </Link>
                </div>
                <div className="border-t border-gray-200 py-1">
                  <button
                    onClick={async () => {
                      // Revoke session on server before clearing local state
                      try {
                        const token = localStorage.getItem('jira_token');
                        if (token) {
                          await fetch('/api/auth/logout', {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` },
                          });
                        }
                      } catch {}
                      logout();
                      router.push('/auth/login');
                    }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-[13px] text-gray-800 transition-colors hover:bg-gray-50"
                  >
                    <LogOut size={15} className="text-blue-600" /> Log out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Global Create Issue Modal */}
      {showCreateModal && defaultSpaceKey && (
        <CreateIssueModal
          spaceKey={defaultSpaceKey}
          statuses={(defaultSpace as any)?.statuses || []}
          members={(defaultSpace as any)?.members || []}
          initialDept={headerInitialDept}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            // Don't call loadIssues here — this component doesn't know the exact
            // params (dept/queue/filters/page) of whatever list view is on screen,
            // and a mismatched query wipes the display to empty before overwriting
            // it with unfiltered data. Bump the shared version instead so the
            // mounted list view refetches with its own correct params.
            bumpIssuesVersion();
          }}
        />
      )}
    </>
  );
}
