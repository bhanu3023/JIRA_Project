'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import SpaceIcon from '@/components/ui/SpaceIcon';
import {
  ChevronLeft,
  ChevronRight as ChevronR,
  Plus,
  MoreHorizontal,
  Star,
  Clock,
  Search,
  Check,
  LayoutDashboard,
  Settings,
  Calendar,
  PanelLeftClose,
  PanelLeft,
  Trash2,
  Archive,
  UserPlus,
  Smile,
  List,
  LayoutGrid,
  GitBranch,
  ChevronDown,
  ClipboardList,
  X,
  TrendingUp,
  Home,
  ShieldCheck,
  UserCheck,
  Server,
  Layers,
  Cpu,
  Building2,
  Globe,
  Users,
  BookOpen,
  Monitor,
  Mail,
  Activity,
  Share2,
  BarChart2,
  Route,
  ArrowUpRight,
  UserX,
  User,
  Inbox as InboxIcon,
  AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getRecentItems, groupRecentItems, type RecentItem } from '@/lib/recent-items';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { can, isManager } from '@/lib/permissions';

const EMOJI_LIST = [
  '🖥️',
  '💻',
  '☁️',
  '🗄️',
  '🔌',
  '💾',
  '📡',
  '🛰️',
  '⚙️',
  '🔧',
  '🔩',
  '🔬',
  '🔐',
  '🔑',
  '🌐',
  '🤖',
  '📟',
  '🖨️',
  '💿',
  '📀',
  '🚀',
  '⚡',
  '🔥',
  '🎯',
  '💡',
  '📊',
  '📈',
  '📋',
  '📁',
  '🗂️',
  '📌',
  '📎',
  '✏️',
  '🏗️',
  '🏢',
  '🏆',
  '💎',
  '🎨',
  '🎖',
  '✅',
  '🎧',
  '👥',
  '🤝',
  '💬',
  '📞',
  '📧',
  '🔔',
  '🛎️',
  '🛡️',
  '🌱',
  '🌍',
  '❤️',
  '⭐',
  '🧩',
  '🌊',
  '🌟',
  '📣',
  '🎪',
  '🎭',
  '🎬',
];

const SM_QUEUES = [
  { id: 'all-open', label: 'All Work Items' },
  { id: 'assigned', label: 'My Assigned Tickets' },
  { id: 'unassigned', label: 'Unassigned' },
];

function RecentFlyout() {
  const { user } = useStore(useShallow((s) => ({ user: s.user })));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<RecentItem[]>([]);
  const [panelTop, setPanelTop] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setItems(getRecentItems(user?.id));
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setPanelTop(rect.top);
      }
    } else {
      // Clear search when panel closes
      setQuery('');
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = query.trim()
    ? items.filter((i) => i.title.toLowerCase().includes(query.toLowerCase()) || i.id.toLowerCase().includes(query.toLowerCase()))
    : items;

  const groups = groupRecentItems(filtered);

  const typeIcon = (item: RecentItem) => {
    if (item.type === 'issue') return <IssueTypeIcon type={item.issueType || 'task'} size={16} />;
    if (item.type === 'board') return <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-violet-100 text-violet-700"><LayoutGrid size={10} /></span>;
    return <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-blue-100 text-blue-700"><LayoutDashboard size={10} /></span>;
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-all',
          open ? 'bg-blue-50 text-jira-dark' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
        )}
      >
        <Clock size={15} className={open ? 'text-blue-600' : 'text-gray-400'} />
        <span className="flex-1 text-left">Recent</span>
        <ChevronR size={13} className={cn('text-gray-400 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Flyout panel — fixed, positioned right of sidebar (w-72 = 288px) */}
          <div
            ref={panelRef}
            className="fixed z-50 w-80 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl"
            style={{ left: 296, top: panelTop, maxHeight: 'calc(100vh - 40px)' }}
          >
            {/* Header */}
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-[14px] font-semibold text-jira-dark">Recent</p>
            </div>

            {/* Search */}
            <div className="border-b border-gray-100 px-3 py-2">
              <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5">
                <Search size={13} className="flex-shrink-0 text-gray-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search recent items"
                  className="flex-1 bg-transparent text-[12.5px] text-gray-800 outline-none placeholder:text-gray-400"
                />
                {query && <button onClick={() => setQuery('')}><X size={12} className="text-gray-400 hover:text-gray-600" /></button>}
              </div>
            </div>

            {/* Groups */}
            <div className="overflow-y-auto" style={{ maxHeight: 360 }}>
              {groups.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <Clock size={20} className="mx-auto mb-2 text-gray-300" />
                  <p className="text-[12px] text-gray-500">{query ? 'No matching items' : 'No recent items yet'}</p>
                  <p className="mt-1 text-[11px] text-gray-400">Visit issues or spaces to see them here</p>
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.label}>
                    <p className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">{group.label}</p>
                    {group.items.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        onClick={() => { setOpen(false); setQuery(''); }}
                        className="flex items-center gap-2.5 px-4 py-2 text-[12.5px] transition-colors hover:bg-gray-50"
                      >
                        {typeIcon(item)}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-gray-900">{item.title}</p>
                          {item.spaceKey && (
                            <p className="text-[10.5px] text-gray-400">{item.spaceKey}</p>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            {items.length > 0 && (
              <div className="border-t border-gray-100 px-4 py-2.5">
                <button
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-1.5 text-[12px] font-medium text-blue-600 hover:text-blue-800"
                >
                  <List size={13} /> View all recent items
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function SideNavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-[13px] font-medium transition-all',
        active
          ? 'border-l-blue-600 bg-blue-50 font-semibold text-jira-dark'
          : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900',
      )}
    >
      <span className={active ? 'text-blue-600' : 'text-gray-400'}>{icon}</span>
      {label}
    </Link>
  );
}

function ContextMenuItem({
  icon,
  label,
  onClick,
  hasArrow,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: (e?: React.MouseEvent) => void;
  hasArrow?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-[12.5px] transition-colors',
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      )}
    >
      <span className={danger ? 'text-red-600' : 'text-gray-400'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {hasArrow && <ChevronR size={11} className="text-slate-600" />}
    </button>
  );
}

// Pick a sensible default icon based on the space name
function SpaceDefaultIcon({ spaceKey, spaceName }: { spaceKey: string; spaceName: string }) {
  const name = spaceName.toLowerCase();
  if (name.includes('infra') || name.includes('server') || name.includes('devops') || name.includes('platform'))
    return <Server size={16} className="text-white" />;
  if (name.includes('software') || name.includes('dev') || name.includes('eng'))
    return <Cpu size={16} className="text-white" />;
  if (name.includes('support') || name.includes('help') || name.includes('service'))
    return <Layers size={16} className="text-white" />;
  if (name.includes('hr') || name.includes('people') || name.includes('finance') || name.includes('ops'))
    return <Building2 size={16} className="text-white" />;
  // Generic fallback: bold 2-letter initials
  return <span className="text-[11px] font-bold text-white">{spaceKey.slice(0, 2)}</span>;
}

function SMSidebar({
  spaceKey,
  spaceName,
  spaceIcon,
  pathname,
  userRole,
}: {
  spaceKey: string;
  spaceName: string;
  spaceIcon?: string;
  pathname: string;
  userRole?: string;
}) {
  const [queuesOpen, setQueuesOpen] = useState(true);
  const searchParams = useSearchParams();
  const isActive = (path: string) => pathname === path || pathname.startsWith(path + '/');
  const canManageSpace = isManager(userRole);

  // Parse saved icon from settings (emoji + bg)
  let parsedIcon: { emoji: string; bg: string } | null = null;
  try { if (spaceIcon) { const p = JSON.parse(spaceIcon); if (p.emoji) parsedIcon = p; } } catch {}

  return (
    <div className="flex h-full flex-col">
      <Link
        href="/spaces"
        className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-blue-600 transition-colors hover:text-blue-800"
      >
        <ChevronLeft size={13} /> All Spaces
      </Link>
      <div className="flex items-center gap-2.5 border-b border-gray-200 px-4 py-3">
        {parsedIcon ? (
          // User-set emoji icon from Settings
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-lg"
            style={{ background: parsedIcon.bg }}>
            {parsedIcon.emoji}
          </div>
        ) : (
          // Smart default: relevant lucide icon based on space name
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600">
            <SpaceDefaultIcon spaceKey={spaceKey} spaceName={spaceName} />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-gray-900">{spaceName}</p>
          <p className="mt-0.5 text-[10px] text-blue-600">Service Management</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        <SideNavItem
          href={`/spaces/${spaceKey}`}
          icon={<LayoutDashboard size={15} />}
          label="Overview"
          active={
            isActive(`/spaces/${spaceKey}`) &&
            !pathname.includes('/board') &&
            !pathname.includes('/settings')
          }
        />
        <div>
          <div className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-3">
            {SM_QUEUES.map((q) => (
              <Link
                key={q.id}
                href={`/spaces/${spaceKey}?queue=${q.id}`}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                  ((searchParams?.get('queue') || 'all-open') === q.id)
                    ? 'bg-indigo-50 font-semibold text-indigo-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )}
              >
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" />
                {q.label}
              </Link>
            ))}
          </div>
        </div>
        <SideNavItem
          href={`/spaces/${spaceKey}?queue=summary`}
          icon={<BarChart2 size={15} />}
          label="Summary"
          active={(searchParams?.get('queue') || '') === 'summary'}
        />
        <SideNavItem
          href={`/spaces/${spaceKey}/board`}
          icon={<LayoutGrid size={15} />}
          label="Board"
          active={pathname.includes('/board')}
        />
        {canManageSpace && (
          <SideNavItem
            href={`/spaces/${spaceKey}/settings?tab=sla`}
            icon={<Clock size={15} />}
            label="SLAs"
            active={pathname.includes('tab=sla')}
          />
        )}
        {canManageSpace && (
          <>
            <div className="my-2 h-px bg-gray-100" />
            <SideNavItem
              href={`/spaces/${spaceKey}/settings`}
              icon={<Settings size={15} />}
              label="Settings"
              active={pathname.includes('/settings')}
            />
          </>
        )}
      </nav>
    </div>
  );
}

function SoftwareSidebar({
  spaceKey,
  spaceName,
  spaceType,
  pathname,
  userRole,
}: {
  spaceKey: string;
  spaceName: string;
  spaceType: string;
  pathname: string;
  userRole?: string;
}) {
  const gradient = spaceType === 'scrum' ? 'from-blue-500 to-indigo-600' : 'from-violet-500 to-purple-600';
  const isActive = (path: string) => pathname === path || pathname.startsWith(path + '/');
  const canManageSpace = isManager(userRole);

  return (
    <div className="flex h-full flex-col">
      <Link
        href="/spaces"
        className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-blue-600 transition-colors hover:text-blue-800"
      >
        <ChevronLeft size={13} /> All Spaces
      </Link>
      <div className="flex items-center gap-2.5 border-b border-gray-200 px-4 py-3">
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${gradient} text-[11px] font-bold text-white`}
        >
          {spaceKey.slice(0, 2)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-gray-900">{spaceName}</p>
          <p className="mt-0.5 text-[10px] text-blue-600">
            {spaceType === 'scrum' ? 'Scrum Project' : 'Kanban Project'}
          </p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        <SideNavItem
          href={`/spaces/${spaceKey}`}
          icon={<List size={15} />}
          label="Issues"
          active={
            isActive(`/spaces/${spaceKey}`) &&
            !pathname.includes('/board') &&
            !pathname.includes('/backlog') &&
            !pathname.includes('/settings') &&
            !pathname.includes('/workflow')
          }
        />
        <SideNavItem
          href={`/spaces/${spaceKey}/board`}
          icon={<LayoutGrid size={15} />}
          label="Board"
          active={pathname.includes('/board')}
        />
        {spaceType === 'scrum' && (
          <SideNavItem
            href={`/spaces/${spaceKey}/backlog`}
            icon={<ClipboardList size={15} />}
            label="Backlog"
            active={pathname.includes('/backlog')}
          />
        )}
        <SideNavItem
          href={`/spaces/${spaceKey}/workflow`}
          icon={<GitBranch size={15} />}
          label="Workflows"
          active={pathname.includes('/workflow')}
        />
        {canManageSpace && (
          <>
            <div className="my-2 h-px bg-gray-100" />
            <SideNavItem
              href={`/spaces/${spaceKey}/settings`}
              icon={<Settings size={15} />}
              label="Settings"
              active={pathname.includes('/settings')}
            />
          </>
        )}
      </nav>
    </div>
  );
}

const PRIVILEGED_ROLES = ['admin'];

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar, spaces, loadSpaces, user, currentIssue } = useStore(
    useShallow((s) => ({
      sidebarOpen: s.sidebarOpen,
      toggleSidebar: s.toggleSidebar,
      spaces: s.spaces,
      loadSpaces: s.loadSpaces,
      user: s.user,
      currentIssue: s.currentIssue,
    })),
  );
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [spaceMenuId, setSpaceMenuId] = useState<string | null>(null);
  const [starredSpaces, setStarredSpaces] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`starred_spaces_${user?.id || 'default'}`) || '[]'); } catch { return []; }
  });
  const [emojiPickerId, setEmojiPickerId] = useState<string | null>(null);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sidebar_collapsed_spaces');
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });

  const toggleSpaceExpand = (spaceKey: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) next.delete(spaceKey);
      else next.add(spaceKey);
      try { localStorage.setItem('sidebar_collapsed_spaces', JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const handleSetIcon = async (spaceKey: string, emoji: string | null) => {
    const icon = emoji ? JSON.stringify({ emoji, bg: '#7C3AED' }) : null;
    try {
      await api.updateSpace(spaceKey, { icon });
      loadSpaces();
    } catch (e) {
      console.error(e);
    }
    setEmojiPickerId(null);
    setSpaceMenuId(null);
  };

  const activeSpaceMatch = pathname.match(/^\/spaces\/([^/]+)/);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _ci: any = currentIssue;
  const issueSpaceKey: string | null = (pathname.startsWith('/issues/') && _ci?.spaceKey)
    ? String(_ci.spaceKey).toUpperCase()
    : null;
  const activeSpaceKey: string | null = activeSpaceMatch ? activeSpaceMatch[1].toUpperCase() : issueSpaceKey;
  const activeSpace = activeSpaceKey ? spaces.find((s) => s.key === activeSpaceKey) : null;
  const isInsideSpace = !!activeSpace;

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  if (!sidebarOpen) {
    return (
      <aside className="fixed left-0 top-0 z-40 flex h-full w-[60px] flex-col items-center gap-1 border-r border-blue-900/20 bg-[#0129AC] py-3">
        <Link href="/dashboard" className="mb-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-white/15 ring-1 ring-white/20">
            <img src="/neutara-logo.png" alt="Neutara" className="h-7 w-7 object-contain" style={{ filter: 'brightness(0) invert(1)' }} />
          </div>
        </Link>
        <button
          onClick={toggleSidebar}
          className="mb-1 flex h-9 w-9 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <PanelLeft size={17} />
        </button>
        {[
          { href: '/dashboard', icon: <Home size={16} />, match: pathname === '/dashboard' },
          { href: '/search', icon: <Search size={16} />, match: pathname === '/search' },
          { href: '/my-dashboard', icon: <LayoutDashboard size={16} />, match: pathname === '/my-dashboard' },
          { href: '/reports', icon: <TrendingUp size={16} />, match: pathname.startsWith('/reports') },
        ].map((item, i) => (
          <Link
            key={i}
            href={item.href}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-md transition-all',
              item.match
                ? 'bg-blue-600/30 text-blue-300 ring-1 ring-blue-400/50'
                : 'text-gray-400 hover:bg-white/10 hover:text-white',
            )}
          >
            {item.icon}
          </Link>
        ))}
      </aside>
    );
  }

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-full w-72 select-none flex-col border-r border-gray-200 bg-white shadow-sm">
      <div className="flex h-14 flex-shrink-0 items-center bg-[#0129AC] px-4">
        <Link href="/dashboard" className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-white/15">
            <img
              src="/neutara-logo.png"
              alt="Neutara"
              className="h-6 w-6 object-contain"
              style={{ filter: 'brightness(0) invert(1)' }}
            />
          </div>
          <span className="truncate text-[14px] font-semibold tracking-tight text-white">
            Neutara Ticketing
          </span>
        </Link>
        <button
          onClick={toggleSidebar}
          className="ml-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
          <div className="space-y-0.5 px-3">
            <GlobalNavItem
              href="/dashboard"
              icon={<Home size={15} />}
              label="Home"
              active={pathname === '/dashboard'}
            />
            <GlobalNavItem href="/filters" icon={<List size={15} />} label="Filters" active={pathname === '/filters'} />
            <GlobalNavItem href="/my-dashboard" icon={<LayoutDashboard size={15} />} label="Dashboard" active={pathname === '/my-dashboard'} />
            {isPrivileged && (
              <GlobalNavItem href="/reports" icon={<TrendingUp size={15} />} label="Reports" active={pathname.startsWith('/reports')} />
            )}
          </div>

          <div className="mx-4 my-4 h-px bg-gray-200" />

          <div className="mb-2.5 flex items-center justify-between px-4">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Spaces</span>
            {isPrivileged && (
              <Link
                href="/spaces?create=true"
                className="flex h-5 w-5 items-center justify-center rounded-md border border-transparent text-gray-500 transition-colors hover:border-gray-200 hover:bg-gray-50 hover:text-blue-600"
              >
                <Plus size={13} />
              </Link>
            )}
          </div>

          <div className="space-y-0.5 px-3">
            {spaces.map((space) => {
              const isThisSpaceActive =
                pathname.includes(`/spaces/${space.key}`) ||
                activeSpaceKey === space.key.toUpperCase();
              return (
              <div key={space.id} className="group/space relative">
                <Link
                  href={`/spaces/${space.key}`}
                  onClick={(e) => {
                    if (isThisSpaceActive) {
                      e.preventDefault();
                      toggleSpaceExpand(space.key);
                    } else {
                      setCollapsedSpaces((prev) => { const n = new Set(prev); n.delete(space.key); try { localStorage.setItem('sidebar_collapsed_spaces', JSON.stringify([...n])); } catch {} return n; });
                    }
                  }}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md border border-transparent px-3 py-2 text-[13px] transition-all',
                    isThisSpaceActive
                      ? 'border-gray-200 bg-blue-50 font-semibold text-jira-dark shadow-sm'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                  )}
                >
                  <SpaceIcon icon={space.icon} spaceKey={space.key} spaceName={space.name} spaceType={space.type} size="sm" />
                  <span className="flex-1 truncate text-[12.5px]">{space.name}</span>
                  {isThisSpaceActive && (
                    <ChevronDown size={12} className={cn('text-gray-400 transition-transform flex-shrink-0', collapsedSpaces.has(space.key) ? '-rotate-90' : '')} />
                  )}
                </Link>

                {/* Inline sub-nav when this space is active and not collapsed */}
                {isThisSpaceActive && !collapsedSpaces.has(space.key) && (
                  <div className="ml-3 mt-0.5 border-l-2 border-blue-200 pl-3 pb-1">
                    <SMSpaceSubNav spaceKey={space.key} pathname={pathname} spaceType={space.type} />
                  </div>
                )}

                {isPrivileged && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setSpaceMenuId(spaceMenuId === space.id ? null : space.id);
                    }}
                    className="absolute right-2 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900 group-hover/space:flex"
                  >
                    <MoreHorizontal size={13} />
                  </button>
                )}

                {spaceMenuId === space.id && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => {
                        setSpaceMenuId(null);
                        setEmojiPickerId(null);
                      }}
                    />
                    <div
                      className="absolute left-2 top-full z-50 mt-1 rounded-xl border border-gray-200 bg-white py-1.5 shadow-2xl"
                      style={{ width: emojiPickerId === space.id ? '240px' : '200px' }}
                    >
                      <ContextMenuItem
                        icon={<Star size={13} />}
                        label={starredSpaces.includes(space.id) ? 'Unstar' : 'Star'}
                        onClick={() => {
                          setStarredSpaces((prev) => {
                            const next = prev.includes(space.id) ? prev.filter((id) => id !== space.id) : [...prev, space.id];
                            try { localStorage.setItem(`starred_spaces_${user?.id || 'default'}`, JSON.stringify(next)); } catch {}
                            return next;
                          });
                          setSpaceMenuId(null);
                        }}
                      />
                      <ContextMenuItem
                        icon={<UserPlus size={13} />}
                        label="Add members"
                        onClick={() => {
                          setSpaceMenuId(null);
                          router.push(`/spaces/${space.key}/settings?tab=people`);
                        }}
                      />
                      <div className="my-1 h-px bg-gray-100" />
                      <ContextMenuItem
                        icon={<Settings size={13} />}
                        label="Settings"
                        onClick={() => {
                          setSpaceMenuId(null);
                          router.push(`/spaces/${space.key}/settings`);
                        }}
                      />
                      <ContextMenuItem icon={<Archive size={13} />} label="Archive" onClick={() => setSpaceMenuId(null)} />
                      <ContextMenuItem
                        icon={<Trash2 size={13} />}
                        label="Delete"
                        onClick={async () => {
                          setSpaceMenuId(null);
                          if (!window.confirm(`Delete space "${space.name}"? This cannot be undone.`)) return;
                          try {
                            await api.deleteSpace(space.key);
                            await loadSpaces();
                            router.push('/');
                          } catch (e) {
                            alert('Failed to delete space. Please try again.');
                          }
                        }}
                        danger
                      />
                    </div>
                  </>
                )}
              </div>
            );
            })}
          </div>

        </nav>
    </aside>
  );
}

type CustomQueue = { id: string; name: string; memberIds: string[]; suspendedIds?: string[]; sla?: { timeValue: string; timeUnit: 'minutes' | 'hours' | 'days' } };

function SMSpaceSubNav({ spaceKey, pathname, spaceType }: { spaceKey: string; pathname: string; spaceType?: string }) {
  // treat as dept_queue if explicitly typed OR if it has custom queues (backward compat for pre-existing spaces)
  // Read localStorage immediately so the correct layout renders on first paint (no flash)
  const [isDeptQueue, setIsDeptQueue] = useState(() => {
    if (spaceType === 'dept_queue') return true;
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem(`custom_queues_${spaceKey}`) : null;
      if (stored) { const q = JSON.parse(stored); return Array.isArray(q) && q.length > 0; }
    } catch {}
    return false;
  });
  const [queuesOpen, setQueuesOpen] = useState(true);
  const [defaultOpen, setDefaultOpen] = useState(true);
  const [counts, setCounts] = useState({ allOpen: 0, assigned: 0, total: 0, unassigned: 0 });
  const [customQueues, setCustomQueues] = useState<CustomQueue[]>([]);
  const [showCreateQueue, setShowCreateQueue] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [newQueueMembers, setNewQueueMembers] = useState<string[]>([]);
  const [spaceMembers, setSpaceMembers] = useState<any[]>([]);
  const [queueMenuOpen, setQueueMenuOpen] = useState<string | null>(null);
  const [queuePanelOpen, setQueuePanelOpen] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<'people' | 'sla'>('people');
  const [showAddMember, setShowAddMember] = useState(false);
  const [addMemberSearch, setAddMemberSearch] = useState('');
  const [slaTimeValue, setSlaTimeValue] = useState('');
  const [slaTimeUnit, setSlaTimeUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [rrConfig, setRrConfig] = useState<any>(null);
  const { user, currentIssue } = useStore(useShallow((s) => ({ user: s.user, currentIssue: s.currentIssue })));
  const searchParams = useSearchParams();
  const router = useRouter();
  const canManageSpace = isManager(user?.role);
  const [spaceMemberRole, setSpaceMemberRole] = useState<string>('');

  // Fetch RR config to determine shift lead status + space member role.
  // Routed through api.request so this coalesces with the page's own identical
  // rr-config/space fetches for the same spaceKey instead of duplicating them.
  useEffect(() => {
    api.request<any>(`spaces/${spaceKey}/rr-config`)
      .then((cfg: any) => { if (cfg?.config) setRrConfig(cfg.config); })
      .catch(() => {});
    // Load current user's SpaceMember role for this space
    if (user?.id) {
      api.request<any>(`spaces/${spaceKey}`)
        .then((sp: any) => {
          const me = (sp?.members || []).find((m: any) => (m.userId || m.user?.id) === user.id);
          if (me?.role) setSpaceMemberRole(me.role);
        })
        .catch(() => {});
    }
  }, [spaceKey, user?.id]);

  const isSpaceLead = spaceMemberRole === 'lead' || spaceMemberRole === 'shift_lead';

  const isShiftLead = (userId: string) =>
    rrConfig?.departments?.some((d: any) =>
      d.agents?.some((a: any) => a.userId === userId && a.isShiftLead)
    );

  // Load custom queues from DB (migrate from localStorage if DB is empty)
  useEffect(() => {
    if (!spaceKey) return;
    api.request<any[]>(`custom-queues/${spaceKey}`).then((q) => {
      if (Array.isArray(q) && q.length > 0) {
        setCustomQueues(q);
        setIsDeptQueue(true);
      } else {
        // DB is empty — check localStorage and migrate
        try {
          const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
          if (stored) {
            const local = JSON.parse(stored);
            if (Array.isArray(local) && local.length > 0) {
              setCustomQueues(local);
              setIsDeptQueue(true);
              // Push to DB so server has them too
              api.request(`custom-queues/${spaceKey}`, { method: 'PUT', body: JSON.stringify(local) }).catch(() => {});
            }
          }
        } catch {}
      }
    }).catch(() => {
      try {
        const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
        if (stored) setCustomQueues(JSON.parse(stored));
      } catch {}
    });
  }, [spaceKey]);

  // Load space members for the create-queue form
  useEffect(() => {
    if (!showCreateQueue) return;
    api.getSpace(spaceKey).then((sp: any) => {
      setSpaceMembers(sp?.members || []);
    }).catch(() => {});
  }, [showCreateQueue, spaceKey]);

  const saveQueues = (queues: CustomQueue[]) => {
    setCustomQueues(queues);
    api.request(`custom-queues/${spaceKey}`, { method: 'PUT', body: JSON.stringify(queues) }).catch(() => {});
    try { localStorage.setItem(`custom_queues_${spaceKey}`, JSON.stringify(queues)); } catch {}
  };

  const createQueue = () => {
    if (!newQueueName.trim()) return;
    const q: CustomQueue = { id: `cq_${Date.now()}`, name: newQueueName.trim(), memberIds: newQueueMembers };
    saveQueues([...customQueues, q]);
    setNewQueueName(''); setNewQueueMembers([]); setShowCreateQueue(false);
  };

  const deleteQueue = (id: string) => saveQueues(customQueues.filter(q => q.id !== id));

  useEffect(() => {
    // Fetch exact open count from DB (excludeDone filters at DB level → total is accurate)
    Promise.all([
      api.getIssues({ spaceKey, limit: '1', page: '1' }),
      api.getIssues({ spaceKey, limit: '1', page: '1', excludeDone: 'true' }),
      user?.id
        ? api.getIssues({ spaceKey, limit: '1', page: '1', excludeDone: 'true', assignee: user.id })
        : Promise.resolve({ total: 0 }),
      api.getIssues({ spaceKey, limit: '1', page: '1', excludeDone: 'true', unassigned: 'true' }),
    ]).then(([allData, openData, assignedData, unassignedData]: any[]) => {
      setCounts({
        total:      allData.total       ?? 0,
        allOpen:    openData.total      ?? 0,
        assigned:   assignedData.total  ?? 0,
        unassigned: unassignedData.total ?? 0,
      });
    }).catch(() => {});
  }, [spaceKey, user?.id]);

  const queueActive = (queueId: string) => {
    if ((searchParams?.get('queue') || 'all-open') === queueId) return true;
    // When on an issue page, highlight the queue matching the ticket's current_department
    if (pathname?.startsWith('/issues/')) {
      const dept = (currentIssue as any)?.current_department;
      if (dept) {
        const matchedQueue = customQueues.find(q => q.id === queueId);
        if (matchedQueue && matchedQueue.name.toLowerCase() === dept.toLowerCase()) return true;
      }
    }
    return false;
  };

  // Queues this user is a member of
  const userQueues = customQueues.filter(q => q.memberIds.includes(user?.id || ''));
  // Dept-scoped: any user who is assigned to specific queues sees ONLY those queues
  // If not assigned to any queue (e.g. fresh admin) → sees all queues
  const isDeptScoped = userQueues.length > 0;
  // For dept-scoped users, the unassigned link includes their dept so the page can filter
  const unassignedHref = (deptName: string) => `/spaces/${spaceKey}?queue=unassigned&dept=${encodeURIComponent(deptName)}`;

  const subCls = (active: boolean) => cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors',
    active ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
  );

  // True admins always see every queue. A "manager"-role user is often scoped
  // to just their own department's queue (e.g. a queue lead who can manage
  // their queue's members but isn't a global admin) — canManageSpace alone
  // (isManager: admin OR manager) was rendering every queue's sidebar link for
  // any manager regardless of which queue(s) they actually belong to, and each
  // rendered <Link> gets background-prefetched by Next.js, which is what fired
  // every queue's API on board load for these users. Only fall back to "see
  // everything" for a manager with no queue membership at all (e.g. freshly
  // created, not yet assigned to any queue) — same fallback isDeptScoped
  // already documents above.
  const visibleQueues = (user?.role === 'admin' || (canManageSpace && !isDeptScoped)) ? customQueues : userQueues;

  return (
    <>
    <div className="space-y-0.5">
      {/* Queues — service_desk: direct links; dept_queue: expandable with custom queues */}
      {!isDeptQueue ? (
        <>
          <Link href={`/spaces/${spaceKey}?queue=all-open`} className={subCls(queueActive('all-open'))}>
            <InboxIcon size={13} className={queueActive('all-open') ? 'text-blue-600' : 'text-gray-400'} />
            <span className="flex-1">All Tickets</span>
            {counts.total > 0 && <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">{counts.total}</span>}
          </Link>
          <Link href={`/spaces/${spaceKey}?queue=unassigned`} className={subCls(queueActive('unassigned'))}>
            <UserX size={13} className={queueActive('unassigned') ? 'text-blue-600' : 'text-gray-400'} />
            <span className="flex-1">Unassigned</span>
            {counts.unassigned > 0 && <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{counts.unassigned}</span>}
          </Link>
          <Link href={`/spaces/${spaceKey}?queue=assigned`} className={subCls(queueActive('assigned'))}>
            <UserCheck size={13} className={queueActive('assigned') ? 'text-blue-600' : 'text-gray-400'} />
            <span className="flex-1">Assigned to me</span>
            {counts.assigned > 0 && <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{counts.assigned}</span>}
          </Link>
          <Link href={`/spaces/${spaceKey}?queue=closed`} className={subCls(queueActive('closed'))}>
            <Archive size={13} className={queueActive('closed') ? 'text-blue-600' : 'text-gray-400'} />
            <span className="flex-1">Closed tickets</span>
          </Link>
        </>
      ) : (
      <div>
        {true && (
          <div className="ml-2 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2">
            <div className="ml-2 space-y-0.5">
                {/* Custom queues — dept_queue only */}
                {isDeptQueue && visibleQueues.map(q => {
                  const isMenuOpen = queueMenuOpen === q.id;
                  // Sub-items (All Open, Unassigned, Assigned to me, Closed, Sent/Watching) are
                  // always shown now — no arrow toggle, so they stay reachable from the sidebar.
                  const isSubExpanded = true;
                  const queueParam = searchParams?.get('queue');
                  const deptParam = searchParams?.get('dept');
                  const subActive = (subQueue: string) =>
                    queueParam === subQueue && deptParam === q.name;
                  return (
                    <div key={q.id}>
                      {(() => {
                        // Clicking the queue name itself opens the same "All Tickets"
                        // view as the sub-item below it, instead of a separate
                        // cq_ view — one destination for "show me Migration's
                        // tickets," not two different counts depending on which
                        // link you happened to click.
                        const isActive = queueActive(q.id) || (queueParam === 'dept_all' && deptParam === q.name);
                        return (
                      <div className="group relative flex items-center rounded-md transition-colors hover:bg-gray-100">
                        <Link href={`/spaces/${spaceKey}?queue=dept_all&dept=${encodeURIComponent(q.name)}`}
                          className={cn('flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-[12px] transition-colors',
                            isActive ? 'text-blue-700' : 'text-gray-600')}>
                          <ClipboardList size={12} className={cn('flex-shrink-0', isActive ? 'text-blue-500' : 'text-gray-400')} />
                          <span className="flex-1 truncate">{q.name}</span>
                        </Link>
                        {/* Three-dot menu — admin/manager only */}
                        <div className="relative flex-shrink-0">
                          {canManageSpace && <button
                            onClick={e => { e.stopPropagation(); setQueueMenuOpen(isMenuOpen ? null : q.id); setQueuePanelOpen(null); }}
                            className="hidden group-hover:flex w-6 h-6 items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200">
                            <MoreHorizontal size={13} />
                          </button>}
                          {isMenuOpen && (
                            <div className="absolute right-0 top-7 z-50 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1"
                              onMouseLeave={() => setQueueMenuOpen(null)}>
                              <button
                                onClick={() => {
                                  setQueueMenuOpen(null);
                                  router.push(`/spaces/${spaceKey}/queue/${q.id}`);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-gray-700 hover:bg-gray-50">
                                <Settings size={12} className="text-gray-400" />
                                Settings
                              </button>
                              <div className="my-0.5 h-px bg-gray-100" />
                              <button
                                onClick={() => { setQueueMenuOpen(null); deleteQueue(q.id); }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-red-600 hover:bg-red-50">
                                <X size={12} />
                                Delete queue
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                        );
                      })()}

                      {/* Sub-items */}
                      {isSubExpanded && (
                        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2">
                          {/* All Open — visible to everyone, shows all tickets in this dept */}
                          <Link
                            href={`/spaces/${spaceKey}?queue=dept_all&dept=${encodeURIComponent(q.name)}`}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors',
                              (queueParam === 'dept_all' && deptParam === q.name)
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                            )}
                          >
                            <InboxIcon size={11} className={(queueParam === 'dept_all' && deptParam === q.name) ? 'text-blue-500' : 'text-gray-400'} />
                            <span className="flex-1 truncate">All Tickets</span>
                          </Link>
                          {/* Unassigned — for shift leads, leads, and managers/admins */}
                          {(canManageSpace || isShiftLead(user?.id || '') || isSpaceLead) && (
                            <Link
                              href={`/spaces/${spaceKey}?queue=dept_unassigned&dept=${encodeURIComponent(q.name)}`}
                              className={cn(
                                'flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors',
                                subActive('dept_unassigned')
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                              )}
                            >
                              <UserX size={11} className={subActive('dept_unassigned') ? 'text-blue-500' : 'text-gray-400'} />
                              <span className="flex-1 truncate">Unassigned</span>
                            </Link>
                          )}
                          {/* Assigned to me — always visible */}
                          <Link
                            href={`/spaces/${spaceKey}?queue=dept_assigned&dept=${encodeURIComponent(q.name)}`}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors',
                              subActive('dept_assigned')
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                            )}
                          >
                            <User size={11} className={subActive('dept_assigned') ? 'text-blue-500' : 'text-gray-400'} />
                            <span className="flex-1 truncate">Assigned to me</span>
                          </Link>
                          {/* Closed tickets — always visible */}
                          <Link
                            href={`/spaces/${spaceKey}?queue=dept_closed&dept=${encodeURIComponent(q.name)}`}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors',
                              subActive('dept_closed')
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                            )}
                          >
                            <Archive size={11} className={subActive('dept_closed') ? 'text-blue-500' : 'text-gray-400'} />
                            <span className="flex-1 truncate">Worked on</span>
                          </Link>
                          {/* Sent / Watching — dept_queue only */}
                          {isDeptQueue && <Link
                            href={`/spaces/${spaceKey}?queue=sent-watching&dept=${encodeURIComponent(q.name)}`}
                            className={cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors',
                              (queueParam === 'sent-watching' && deptParam === q.name)
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                            )}
                          >
                            <ClipboardList size={11} className={(queueParam === 'sent-watching' && deptParam === q.name) ? 'text-blue-500' : 'text-gray-400'} />
                            <span className="flex-1 truncate">Sent / Watching</span>
                          </Link>}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* New Queue button — managers/admins only, dept_queue only */}
                {isDeptQueue && canManageSpace && (!showCreateQueue ? (
                  <button onClick={() => setShowCreateQueue(true)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-blue-600 hover:bg-blue-50 transition-colors w-full">
                    <Plus size={12} />
                    <span>New Queue</span>
                  </button>
                ) : (
                  <div className="mt-1 rounded-md border border-gray-200 bg-white shadow-sm p-2 space-y-2">
                    <input
                      autoFocus
                      value={newQueueName}
                      onChange={e => setNewQueueName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') createQueue(); if (e.key === 'Escape') { setShowCreateQueue(false); setNewQueueName(''); setNewQueueMembers([]); } }}
                      placeholder="Queue name…"
                      className="w-full text-[12px] border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-blue-400"
                    />
                    {spaceMembers.length > 0 && (
                      <div>
                        <p className="text-[10.5px] text-gray-400 mb-1 font-medium uppercase tracking-wide">Add people</p>
                        <div className="max-h-32 overflow-y-auto space-y-0.5">
                          {spaceMembers.map((m: any) => {
                            const member = m.user || m;
                            const isSel = newQueueMembers.includes(member.id);
                            return (
                              <button key={member.id}
                                onClick={() => setNewQueueMembers(prev => isSel ? prev.filter(id => id !== member.id) : [...prev, member.id])}
                                className={cn('flex w-full items-center gap-2 rounded px-1.5 py-1 text-[11.5px] transition-colors',
                                  isSel ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50')}>
                                <div className={cn('w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0',
                                  isSel ? 'bg-blue-600 border-blue-600' : 'border-gray-300')}>
                                  {isSel && <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                </div>
                                <span className="truncate">{member.firstName} {member.lastName}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-1.5 pt-0.5">
                      <button onClick={createQueue}
                        className="flex-1 py-1 text-[11.5px] font-medium bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">
                        Create
                      </button>
                      <button onClick={() => { setShowCreateQueue(false); setNewQueueName(''); setNewQueueMembers([]); }}
                        className="flex-1 py-1 text-[11.5px] text-gray-600 border border-gray-200 rounded hover:bg-gray-50 transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
          </div>
        )}
      </div>
      )}

      {/* Summary */}
      <Link href={`/spaces/${spaceKey}?queue=summary`} className={subCls(queueActive('summary'))}>
        <BarChart2 size={13} className={queueActive('summary') ? 'text-blue-600' : 'text-gray-400'} />
        <span className="flex-1">Summary</span>
      </Link>

      <div className="my-1 h-px bg-gray-100" />

      {/* SLAs — managers+ only */}
      {canManageSpace && (
        <Link href={`/spaces/${spaceKey}/settings?tab=sla`} className={subCls(pathname.includes('tab=sla'))}>
          <Clock size={13} className={pathname.includes('tab=sla') ? 'text-blue-600' : 'text-gray-400'} />
          <span className="flex-1">SLAs</span>
        </Link>
      )}

      {/* Settings — managers+ only */}
      {canManageSpace && (
        <Link href={`/spaces/${spaceKey}/settings`} className={subCls(pathname.includes('/settings') && !pathname.includes('tab=sla'))}>
          <Settings size={13} className={pathname.includes('/settings') && !pathname.includes('tab=sla') ? 'text-blue-600' : 'text-gray-400'} />
          <span className="flex-1">Settings</span>
        </Link>
      )}
    </div>

    {/* ── People & Access Modal ── */}
    {queuePanelOpen && (() => {
      const q = customQueues.find(cq => cq.id === queuePanelOpen);
      if (!q) return null;
      const suspended = q.suspendedIds || [];
      const COLORS = ['bg-blue-500','bg-purple-500','bg-green-500','bg-orange-500','bg-rose-500','bg-teal-500','bg-indigo-500','bg-amber-500'];
      const avatarColor = (name: string) => COLORS[(name||'').charCodeAt(0) % COLORS.length];
      const mkInitials = (first: string, last: string) => `${(first||'')[0]||''}${(last||'')[0]||''}`.toUpperCase();
      const members = spaceMembers.filter(m => { const mb = m.user || m; return q.memberIds.includes(mb.id); });
      const nonMembers = spaceMembers.filter(m => { const mb = m.user || m; return !q.memberIds.includes(mb.id); });

      const removeMember  = (id: string) => saveQueues(customQueues.map(cq => cq.id === q.id ? { ...cq, memberIds: cq.memberIds.filter(x => x !== id), suspendedIds: (cq.suspendedIds||[]).filter(x => x !== id) } : cq));
      const suspendMember = (id: string) => saveQueues(customQueues.map(cq => cq.id === q.id ? { ...cq, suspendedIds: [...(cq.suspendedIds||[]), id] } : cq));
      const reactivate    = (id: string) => saveQueues(customQueues.map(cq => cq.id === q.id ? { ...cq, suspendedIds: (cq.suspendedIds||[]).filter(x => x !== id) } : cq));
      const addMember     = (id: string) => saveQueues(customQueues.map(cq => cq.id === q.id ? { ...cq, memberIds: [...cq.memberIds, id] } : cq));

      return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={() => { setQueuePanelOpen(null); setShowAddMember(false); setAddMemberSearch(''); }}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative z-10 w-[540px] max-h-[88vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="border-b border-gray-100">
              <div className="flex items-center justify-between px-6 pt-5 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
                    <Settings size={17} className="text-blue-600" />
                  </div>
                  <div>
                    <h2 className="text-[15px] font-semibold text-gray-900">Queue Settings</h2>
                    <p className="text-[11.5px] text-gray-400 mt-0.5">Queue: <span className="font-medium text-gray-600">{q.name}</span></p>
                  </div>
                </div>
                <button onClick={() => { setQueuePanelOpen(null); setShowAddMember(false); setAddMemberSearch(''); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                  <X size={16} />
                </button>
              </div>
              {/* Tabs */}
              <div className="flex px-6 gap-1">
                {(['people', 'sla'] as const).map(tab => (
                  <button key={tab} onClick={() => setSettingsTab(tab)}
                    className={`px-4 py-2 text-[12.5px] font-medium border-b-2 transition-colors ${settingsTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                    {tab === 'people' ? 'People & Access' : 'SLA'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* ── SLA Tab ── */}
              {settingsTab === 'sla' && (() => {
                const saveSla = () => {
                  const updated = customQueues.map(cq => cq.id === q.id
                    ? { ...cq, sla: slaTimeValue.trim() ? { timeValue: slaTimeValue.trim(), timeUnit: slaTimeUnit } : undefined }
                    : cq);
                  saveQueues(updated);
                };
                const currentSla = q.sla;
                const fmtTarget = currentSla ? `${currentSla.timeValue} ${currentSla.timeUnit}` : 'Not set';
                return (
                  <div className="px-6 py-6 space-y-6">
                    {/* Current SLA */}
                    <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-4">
                      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1">Current SLA Target</p>
                      <p className={`text-[20px] font-bold ${currentSla ? 'text-blue-700' : 'text-gray-300'}`}>{fmtTarget}</p>
                      <p className="text-[11.5px] text-gray-400 mt-1">Time allowed from when a ticket arrives in <span className="font-medium text-gray-600">{q.name}</span> until resolution</p>
                    </div>

                    {/* Set SLA target */}
                    <div>
                      <p className="text-[13px] font-semibold text-gray-800 mb-3">Set SLA Target</p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <label className="block text-[11px] font-medium text-gray-500 mb-1.5 uppercase tracking-wide">Time</label>
                          <input
                            type="number" min="1" max="9999"
                            value={slaTimeValue}
                            onChange={e => setSlaTimeValue(e.target.value)}
                            placeholder="e.g. 8"
                            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                          />
                        </div>
                        <div className="w-36">
                          <label className="block text-[11px] font-medium text-gray-500 mb-1.5 uppercase tracking-wide">Unit</label>
                          <select
                            value={slaTimeUnit}
                            onChange={e => setSlaTimeUnit(e.target.value as 'minutes' | 'hours' | 'days')}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 bg-white">
                            <option value="minutes">Minutes</option>
                            <option value="hours">Hours</option>
                            <option value="days">Days</option>
                          </select>
                        </div>
                      </div>
                      <p className="text-[11.5px] text-gray-400 mt-2">SLA timer starts fresh when a ticket enters this queue. Pauses when transferred to another queue.</p>
                    </div>

                    {/* Priority overrides info */}
                    <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">
                      <p className="text-[12.5px] font-semibold text-blue-800 mb-1">How it works</p>
                      <ul className="space-y-1 text-[11.5px] text-blue-700">
                        <li>• Ticket arrives in <strong>{q.name}</strong> → timer starts</li>
                        <li>• Ticket moves to another dept → timer pauses, elapsed time saved</li>
                        <li>• Ticket recalled → new timer cycle starts</li>
                        <li>• Breach shown in ticket sidebar when target exceeded</li>
                      </ul>
                    </div>

                    <div className="flex gap-3 pt-2">
                      <button onClick={() => { saveSla(); }}
                        className="flex-1 py-2.5 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                        Save SLA
                      </button>
                      {currentSla && (
                        <button onClick={() => { setSlaTimeValue(''); saveQueues(customQueues.map(cq => cq.id === q.id ? { ...cq, sla: undefined } : cq)); }}
                          className="px-4 py-2.5 text-[13px] font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ── People & Access Tab ── */}
              {settingsTab === 'people' && <>
              {/* Members section */}
              <div className="px-6 pt-5 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-gray-800">Members</h3>
                    <span className="text-[11px] font-medium text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">{members.length}</span>
                  </div>
                </div>

                {members.length === 0 ? (
                  <div className="flex flex-col items-center py-8 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
                    <Users size={22} className="text-gray-300 mb-2" />
                    <p className="text-[13px] font-medium text-gray-400">No members yet</p>
                    <p className="text-[11.5px] text-gray-300 mt-0.5">Add people below to give them access</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {members.map(m => {
                      const mb = m.user || m;
                      const isSuspended = suspended.includes(mb.id);
                      return (
                        <div key={mb.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${isSuspended ? 'border-amber-100 bg-amber-50' : 'border-gray-100 bg-gray-50 hover:bg-white'}`}>
                          {/* Avatar */}
                          <div className="relative flex-shrink-0">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-bold text-white ${isSuspended ? 'bg-gray-300' : avatarColor(mb.firstName||'')}`}>
                              {mkInitials(mb.firstName||'', mb.lastName||'')}
                            </div>
                            {isSuspended && (
                              <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-amber-400 rounded-full border-2 border-white flex items-center justify-center">
                                <span className="text-white text-[8px] font-bold">!</span>
                              </div>
                            )}
                          </div>
                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className={`text-[13px] font-medium truncate ${isSuspended ? 'text-gray-400' : 'text-gray-800'}`}>{mb.firstName} {mb.lastName}</p>
                              {isSuspended && <span className="text-[10px] font-semibold text-amber-600 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5 flex-shrink-0">Suspended</span>}
                            </div>
                            <p className="text-[11.5px] text-gray-400 truncate">{mb.email || ''}</p>
                          </div>
                          {/* Role badge */}
                          <span className="text-[11px] text-gray-500 bg-white border border-gray-200 rounded-md px-2 py-1 flex-shrink-0">Member</span>
                          {/* Actions */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {isSuspended ? (
                              <button onClick={() => reactivate(mb.id)}
                                title="Reactivate"
                                className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                                Reactivate
                              </button>
                            ) : (
                              <button onClick={() => suspendMember(mb.id)}
                                title="Suspend"
                                className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
                                Suspend
                              </button>
                            )}
                            <button onClick={() => removeMember(mb.id)}
                              title="Remove"
                              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="mx-6 border-t border-gray-100" />

              {/* Add Member section — always visible */}
              <div className="px-6 pt-4 pb-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[13px] font-semibold text-gray-800">Add Member</h3>
                  {!showAddMember && (
                    <button
                      onClick={() => { setShowAddMember(true); setAddMemberSearch(''); if (spaceMembers.length === 0) { api.getSpace(spaceKey).then((sp: any) => setSpaceMembers(sp?.members || [])).catch(() => {}); } }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors">
                      <Plus size={13} /> Add Member
                    </button>
                  )}
                </div>

                {showAddMember && (
                  <>
                    {/* Search input */}
                    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 mb-3 focus-within:border-blue-400 focus-within:bg-white transition-colors">
                      <Search size={13} className="text-gray-400 flex-shrink-0" />
                      <input
                        autoFocus
                        value={addMemberSearch}
                        onChange={e => { setAddMemberSearch(e.target.value); if (spaceMembers.length === 0) { api.getSpace(spaceKey).then((sp: any) => setSpaceMembers(sp?.members || [])).catch(() => {}); } }}
                        placeholder="Search by name or email…"
                        className="flex-1 bg-transparent text-[12.5px] text-gray-700 outline-none placeholder:text-gray-400"
                      />
                      <button onClick={() => { setShowAddMember(false); setAddMemberSearch(''); }} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={12} /></button>
                    </div>

                    {/* Filtered non-members */}
                    {(() => {
                      const filtered = nonMembers.filter(m => {
                        const mb = m.user || m;
                        const name = `${mb.firstName||''} ${mb.lastName||''}`.toLowerCase();
                        const email = (mb.email||'').toLowerCase();
                        const q2 = addMemberSearch.toLowerCase();
                        return !q2 || name.includes(q2) || email.includes(q2);
                      });
                      if (spaceMembers.length === 0) return (
                        <div className="py-6 text-center text-[12.5px] text-gray-400">Loading members…</div>
                      );
                      if (nonMembers.length === 0) return (
                        <div className="py-6 text-center">
                          <Check size={18} className="text-emerald-400 mx-auto mb-1.5" />
                          <p className="text-[12.5px] text-gray-500 font-medium">All space members added</p>
                          <p className="text-[11.5px] text-gray-400 mt-0.5">Everyone in this space is already a member</p>
                        </div>
                      );
                      if (filtered.length === 0) return (
                        <div className="py-6 text-center text-[12.5px] text-gray-400">No users match "{addMemberSearch}"</div>
                      );
                      return (
                        <div className="space-y-2 max-h-52 overflow-y-auto">
                          {filtered.map(m => {
                            const mb = m.user || m;
                            return (
                              <div key={mb.id}
                                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors group cursor-pointer"
                                onClick={() => { addMember(mb.id); setAddMemberSearch(''); }}>
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-bold text-white flex-shrink-0 ${avatarColor(mb.firstName||'')}`}>
                                  {mkInitials(mb.firstName||'', mb.lastName||'')}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] font-medium text-gray-800 truncate">{mb.firstName} {mb.lastName}</p>
                                  <p className="text-[11.5px] text-gray-400 truncate">{mb.email||''}</p>
                                </div>
                                <div className="flex items-center gap-1.5 text-[12px] font-medium text-gray-400 group-hover:text-blue-600 transition-colors flex-shrink-0">
                                  <Plus size={14} />
                                  <span>Add</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            </> }
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
              {settingsTab === 'people'
                ? <p className="text-[12px] text-gray-400">{members.length} member{members.length !== 1 ? 's' : ''} · {suspended.length} suspended</p>
                : <p className="text-[12px] text-gray-400">{q.sla ? `Target: ${q.sla.timeValue} ${q.sla.timeUnit}` : 'No SLA configured'}</p>
              }
              <button onClick={() => { setQueuePanelOpen(null); setShowAddMember(false); setAddMemberSearch(''); }}
                className="px-5 py-2 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                Done
              </button>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
}

function SpaceSubItem({ href, icon, label, active }: { href: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors',
        active ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      )}
    >
      <span className={active ? 'text-blue-600' : 'text-gray-400'}>{icon}</span>
      {label}
    </Link>
  );
}

function GlobalNavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-[13px] font-medium transition-all',
        active
          ? 'border-l-blue-600 bg-blue-50 font-semibold text-jira-dark shadow-sm'
          : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900',
      )}
    >
      <span className={active ? 'text-blue-600' : 'text-gray-400'}>{icon}</span>
      {label}
    </Link>
  );
}
