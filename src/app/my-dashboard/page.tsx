'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { cn, priorityColors } from '@/lib/utils';
import DotLoader from '@/components/ui/DotLoader';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  Layers, Loader2, CheckCircle2, Send, Hourglass, AlertTriangle, ChevronDown, Calendar, BarChart3,
} from 'lucide-react';

const DATE_RANGE_OPTIONS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: 'Last 7 Days', days: 7 },
  { key: '30d', label: 'Last 30 Days', days: 30 },
] as const;
type DateRangeKey = (typeof DATE_RANGE_OPTIONS)[number]['key'];

/* ─── palette ─── */
const DEPT_PALETTE = ['#3B82F6', '#8B5CF6', '#F59E0B', '#14B8A6', '#EC4899', '#64748B', '#22C55E', '#EF4444'];
const SLA_STATUS_COLORS: Record<string, string> = {
  withinSla: '#22C55E', nearBreach: '#F59E0B', breachingSoon: '#F97316', breached: '#EF4444',
};
const SLA_STATUS_LABELS: Record<string, string> = {
  withinSla: 'Within SLA', nearBreach: 'Near Breach', breachingSoon: 'Breaching Soon', breached: 'Breached',
};

/** Build a /filters URL scoped to whatever's provided — the deep-link target for every clickable element here. */
function filtersHref(params: Record<string, string | undefined | null>) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const s = qs.toString();
  return `/filters${s ? `?${s}` : ''}`;
}

/** Disambiguate same-named departments that live in different boards ("Migration (CB)" vs "Migration (CU)"). */
function withDisambiguatedLabels<T extends { dept: string; spaceKey?: string | null }>(items: T[]): (T & { label: string })[] {
  const counts: Record<string, number> = {};
  items.forEach((i) => { counts[i.dept] = (counts[i.dept] || 0) + 1; });
  return items.map((i) => ({ ...i, label: counts[i.dept] > 1 && i.spaceKey ? `${i.dept} (${i.spaceKey})` : i.dept }));
}

/* ─── stat card (always clickable, even at 0 — it's a real, if empty, ticket list) ─── */
function StatTile({ label, value, icon, iconClass, href }: { label: string; value: number; icon: React.ReactNode; iconClass: string; href: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 hover:shadow-md">
      <div className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none text-gray-900 tabular-nums">{value.toLocaleString()}</p>
        <p className="mt-1 line-clamp-2 text-[11.5px] leading-tight text-gray-500">{label}</p>
      </div>
    </Link>
  );
}

/* ─── donut chart with centered total — every row (and the empty state) is clickable ─── */
function Donut({
  data, centerLabel, centerSub, fallbackHref, height = 100,
}: {
  data: { name: string; value: number; color: string; href?: string }[];
  centerLabel?: string;
  centerSub?: string;
  fallbackHref: string;
  height?: number;
}) {
  const router = useRouter();
  const total = data.reduce((a, d) => a + d.value, 0);

  // No categories to show at all (e.g. by-status/by-priority for a user with zero
  // tickets ever) — nothing meaningful to preview, so keep this compact.
  if (data.length === 0) {
    return (
      <Link
        href={fallbackHref}
        className="flex flex-col items-center justify-center gap-1 rounded-lg text-center transition-colors hover:bg-gray-50"
        style={{ height }}
      >
        <span className="text-2xl font-bold text-gray-300">0</span>
        <span className="text-[11.5px] text-gray-400">No tickets yet — click to view</span>
      </Link>
    );
  }

  // Fixed category sets (SLA Status, SLA Compliance) always have their real colors —
  // show the full colored legend at 0 rather than collapsing to a bare "no data" line.
  const shown = total > 0 ? data.filter((d) => d.value > 0) : [{ name: 'None', value: 1, color: '#E5E7EB', href: fallbackHref }];
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[120px] w-[120px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={shown} dataKey="value" innerRadius={38} outerRadius={58} paddingAngle={2}
              startAngle={90} endAngle={-270} stroke="none"
              onClick={(d: any) => { if (d?.href) router.push(d.href); }}
              cursor="pointer"
            >
              {shown.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip formatter={(v: any, n: any) => [v, n]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-gray-900">{centerLabel ?? total}</span>
          <span className="text-[10px] text-gray-400">{centerSub ?? 'Total'}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {data.map((d) => {
          const row = (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-gray-600">
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
              <span className="truncate">{d.name}</span>
            </span>
          );
          const linkHref = d.value > 0 ? d.href : fallbackHref;
          return (
            <div key={d.name} className="flex items-center justify-between gap-2 text-[11.5px]">
              {linkHref ? <Link href={linkHref} className="min-w-0 hover:text-blue-600 hover:underline">{row}</Link> : row}
              <span className="flex-shrink-0 font-medium text-gray-700">
                {d.value}{total > 0 && <span className="text-gray-400"> ({Math.round((d.value / total) * 100)}%)</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── card shell ─── */
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <h3 title={title} className="line-clamp-2 break-normal text-[13px] font-semibold leading-snug text-gray-800">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[10.5px] text-gray-400">{subtitle}</p>}
      </div>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

/* ─── bar chart — bars, and the empty state, are clickable ─── */
function DeptBarChart({ data, color, fallbackHref }: { data: { dept: string; label: string; count: number; href: string }[]; color: string; fallbackHref: string }) {
  const router = useRouter();
  if (!data.length) {
    return (
      <Link href={fallbackHref} className="flex h-[110px] w-full flex-col items-center justify-center gap-1 rounded-lg text-center transition-colors hover:bg-gray-50">
        <span className="text-[12px] text-gray-400">No data yet — click to view my tickets</span>
      </Link>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#F3F4F6" />
        <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: '#6B7280' }} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" height={38} />
        <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: '#F9FAFB' }} />
        <Bar
          dataKey="count" fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} cursor="pointer"
          onClick={(d: any) => { if (d?.href) router.push(d.href); }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ─── admin queue-scoped "view as" dropdown ─── */
function QueueSelect({ label, options, value, onChange }: { label: string; options: any[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex-shrink-0">
      <select
        value={options.some((u) => u.id === value) ? value : ''}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        className="appearance-none rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-[13px] font-medium text-gray-700 outline-none focus:border-blue-500 disabled:opacity-50"
        disabled={options.length === 0}
      >
        <option value="">{options.length ? label : `${label} (none found)`}</option>
        {options.map((u) => (
          <option key={u.id} value={u.id}>{`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}</option>
        ))}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
    </div>
  );
}

/** Applies to the "moved/received" department-activity charts below — the rest of the
 * dashboard is always a live snapshot of current ticket state, not a historical range. */
function DateRangeSelect({ value, onChange }: { value: DateRangeKey; onChange: (v: DateRangeKey) => void }) {
  return (
    <div className="relative flex-shrink-0">
      <Calendar size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DateRangeKey)}
        className="appearance-none rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-8 text-[13px] font-medium text-gray-700 outline-none focus:border-blue-500"
      >
        {DATE_RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
    </div>
  );
}

export default function MyDashboardPage() {
  const { user } = useStore(useShallow((s) => ({ user: s.user })));
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [queueUsers, setQueueUsers] = useState<{ migration: any[]; dev: any[] }>({ migration: [], dev: [] });
  const [viewedUserId, setViewedUserId] = useState<string>('');
  const [dateRangeKey, setDateRangeKey] = useState<DateRangeKey>('7d');

  // Admin-only: group users by their custom-queue membership (Migration / Dev) across
  // every space, instead of one unmanageable flat list of the entire organization.
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const [usersRes, spacesRes] = await Promise.all([api.getUsers(), api.getSpaces()]);
        const usersList: any[] = Array.isArray(usersRes) ? usersRes : [];
        setAllUsers(usersList);
        const usersById = new Map(usersList.map((u: any) => [u.id, u]));
        const migrationIds = new Set<string>();
        const devIds = new Set<string>();
        await Promise.all((Array.isArray(spacesRes) ? spacesRes : []).map(async (sp: any) => {
          try {
            const queues = await api.request<any[]>(`custom-queues/${sp.key}`);
            for (const q of Array.isArray(queues) ? queues : []) {
              const name = (q.name || '').toLowerCase();
              const memberIds: string[] = q.memberIds || [];
              if (name.includes('migration')) memberIds.forEach((id) => migrationIds.add(id));
              if (name.includes('dev')) memberIds.forEach((id) => devIds.add(id));
            }
          } catch { /* space may have no custom queues */ }
        }));
        const resolve = (ids: Set<string>) => Array.from(ids).map((id) => usersById.get(id)).filter(Boolean);
        setQueueUsers({ migration: resolve(migrationIds), dev: resolve(devIds) });
      } catch { /* non-fatal — dropdowns just stay empty */ }
    })();
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = new Date();
    const from = dateRangeKey === 'today'
      ? new Date(to.getFullYear(), to.getMonth(), to.getDate())
      : new Date(to.getTime() - (dateRangeKey === '30d' ? 30 : 7) * 86_400_000);
    api.getMyDashboard({
      ...(viewedUserId ? { userId: viewedUserId } : {}),
      from: from.toISOString(),
      to: to.toISOString(),
    })
      .then((d: any) => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewedUserId, dateRangeKey]);

  if (loading || !data) {
    // py-24 was just top/bottom padding on a small inline element — it sat
    // near the top of the page instead of centered in the actual available
    // height, leaving a large, obviously-empty area below it. min-h-full +
    // flex centers it in the full height of the content area instead.
    return (
      <div className="flex min-h-full items-center justify-center">
        <DotLoader />
      </div>
    );
  }

  const cards = data.cards || {};
  const cardStatuses = data.cardStatuses || {};
  const targetUserId: string = data.viewedUserId || user?.id || '';
  const myAssignedFallback = filtersHref({ assignee: targetUserId });
  const byStatus = (data.byStatus || []) as { name: string; count: number; color: string }[];
  const byPriority = (data.byPriority || []) as { name: string; count: number }[];
  const slaStatus = data.slaStatus || { withinSla: 0, nearBreach: 0, breachingSoon: 0, breached: 0 };
  const bySourceDept = withDisambiguatedLabels((data.bySourceDept || []) as { dept: string; spaceKey: string | null; count: number }[]);
  const journey = withDisambiguatedLabels((data.journey || []) as { dept: string; spaceKey: string | null; total: number; created: number; inProgress: number; waiting: number; completed: number }[]);
  const movedByMe = withDisambiguatedLabels((data.movedByMe || []) as { dept: string; spaceKey: string | null; cnt: number }[]);
  const receivedByMe = withDisambiguatedLabels((data.receivedByMe || []) as { dept: string; spaceKey: string | null; cnt: number }[]);

  const statusDonutData = byStatus.map((s) => ({
    name: s.name, value: s.count, color: s.color,
    href: s.name === 'Unknown' ? myAssignedFallback : filtersHref({ assignee: targetUserId, status: s.name }),
  }));
  const priorityDonutData = byPriority.map((p) => ({
    name: p.name.charAt(0).toUpperCase() + p.name.slice(1),
    value: p.count,
    color: priorityColors[p.name] || '#94A3B8',
    href: filtersHref({ assignee: targetUserId, priority: p.name }),
  }));
  // The Filters page already supports a live slaBreached=yes/no filter (same
  // SLA check computed here) -- these donuts just never used it, so every
  // segment (including "Breached") linked to the same generic "all my
  // tickets" view no matter which slice you clicked. Only breached/not-yet-
  // breached is filterable server-side (no separate near-breach/breaching-
  // soon distinction exists there), so those two still fall back to the
  // "not breached" filter -- still more accurate than "everything."
  const slaBreachedHref = filtersHref({ assignee: targetUserId, slaBreached: 'yes' });
  const slaNotBreachedHref = filtersHref({ assignee: targetUserId, slaBreached: 'no' });
  const slaStatusDonutData = Object.entries(slaStatus).map(([k, v]) => ({
    name: SLA_STATUS_LABELS[k], value: v as number, color: SLA_STATUS_COLORS[k],
    href: k === 'breached' ? slaBreachedHref : slaNotBreachedHref,
  }));
  const slaComplianceDonutData = [
    { name: 'Within SLA', value: (data.slaTrackedCount || 0) - (slaStatus.breached || 0), color: '#22C55E', href: slaNotBreachedHref },
    { name: 'Breached', value: slaStatus.breached || 0, color: '#EF4444', href: slaBreachedHref },
  ];

  const barDataFor = (rows: { dept: string; label: string; spaceKey: string | null; count: number }[]) =>
    rows.map((r) => ({ ...r, href: filtersHref({ assignee: targetUserId, space: r.spaceKey || undefined, queue: r.spaceKey ? r.dept : undefined }) }));

  const viewedName = viewedUserId && viewedUserId !== user?.id
    ? (allUsers.find((u) => u.id === viewedUserId)?.firstName || 'another user')
    : user?.firstName;
  const dateRangeLabel = DATE_RANGE_OPTIONS.find((o) => o.key === dateRangeKey)?.label;

  return (
    // min-h-full so the gray page background fills the whole scrollable area
    // even when there's little data (a sparse dashboard's actual content is
    // much shorter than a tall screen) — otherwise the empty area below the
    // last row stayed plain white, reading as a cut-off/broken layout rather
    // than page background. gray-100 (not gray-50) so the contrast against
    // the white content card is actually visible, not just a few points of
    // RGB apart. The content itself sits inside one bordered, rounded white
    // card (rather than floating loose on the page) so the whole dashboard
    // reads as a single contained panel with a visible edge, matching how
    // the individual stat/report tiles inside it are already framed.
    <div className="min-h-full bg-gray-100 p-6">
    <div className="mx-auto max-w-[1400px]">
    <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold text-gray-900">
            User Level Dashboard <span>👋</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {viewedUserId && viewedUserId !== user?.id ? 'Viewing' : 'Welcome back,'} {viewedName}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <DateRangeSelect value={dateRangeKey} onChange={setDateRangeKey} />
          {isAdmin && (
            <>
              {viewedUserId && (
                <button
                  onClick={() => setViewedUserId('')}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] font-medium text-gray-600 hover:bg-gray-50"
                >
                  My Dashboard
                </button>
              )}
              <QueueSelect label="Migration Queue" options={queueUsers.migration} value={viewedUserId} onChange={setViewedUserId} />
              <QueueSelect label="Dev Queue" options={queueUsers.dev} value={viewedUserId} onChange={setViewedUserId} />
              {/* The two dropdowns above pick ONE person to view their personal
                  dashboard as — they were never meant to show the department's
                  own numbers, which is a completely different question people
                  kept asking this page. These link straight to the actual
                  Migration/Dev Resolution %, SLA %, and SLA Breach % report
                  instead of leaving that undiscoverable behind Reports → a
                  specific tab → a specific filter. */}
              <Link
                href="/reports?tab=resolution-sla&dept=Migration"
                className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] font-medium text-blue-700 hover:bg-blue-100"
              >
                <BarChart3 size={14} /> Migration Report
              </Link>
              <Link
                href="/reports?tab=resolution-sla&dept=Dev"
                className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] font-medium text-blue-700 hover:bg-blue-100"
              >
                <BarChart3 size={14} /> Dev Report
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Top stat row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <StatTile
          label="My Open Tickets" value={cards.myOpenTickets || 0}
          icon={<Layers size={17} className="text-blue-600" />} iconClass="bg-blue-50"
          href={filtersHref({ assignee: targetUserId, status: (cardStatuses.myOpenTickets || []).join(',') })}
        />
        <StatTile
          label="In Progress (With Me)" value={cards.inProgress || 0}
          icon={<Loader2 size={17} className="text-purple-600" />} iconClass="bg-purple-50"
          href={filtersHref({ assignee: targetUserId, status: (cardStatuses.inProgress || []).join(',') })}
        />
        <StatTile
          label="Waiting / On Hold" value={cards.waitingOrOnHold || 0}
          icon={<Hourglass size={17} className="text-orange-600" />} iconClass="bg-orange-50"
          href={filtersHref({ assignee: targetUserId, status: (cardStatuses.waitingOrOnHold || []).join(',') })}
        />
        <StatTile
          label="Resolved by Me" value={cards.resolvedByMe || 0}
          icon={<CheckCircle2 size={17} className="text-green-600" />} iconClass="bg-green-50"
          href={filtersHref({ assignee: targetUserId, status: (cardStatuses.resolvedByMe || []).join(',') })}
        />
        <StatTile
          label="Reported by Me" value={cards.reportedByMe || 0}
          icon={<Send size={17} className="text-teal-600" />} iconClass="bg-teal-50"
          href={filtersHref({ reporter: targetUserId })}
        />
        <StatTile
          label="SLA Running (With Me)" value={cards.slaRunning || 0}
          icon={<Hourglass size={17} className="text-indigo-600" />} iconClass="bg-indigo-50"
          href={slaNotBreachedHref}
        />
        <StatTile
          label="SLA Breaching Soon" value={cards.slaBreachingSoon || 0}
          icon={<AlertTriangle size={17} className="text-red-600" />} iconClass="bg-red-50"
          href={slaNotBreachedHref}
        />
      </div>

      {/* Donut row */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4 lg:items-stretch">
        <Card title="My Tickets by Status"><Donut data={statusDonutData} fallbackHref={myAssignedFallback} /></Card>
        <Card title="My Tickets by Priority"><Donut data={priorityDonutData} fallbackHref={myAssignedFallback} /></Card>
        <Card title="SLA Status (My Tickets)"><Donut data={slaStatusDonutData} fallbackHref={myAssignedFallback} /></Card>
        <Card title="SLA Compliance (My Tickets)">
          <Donut data={slaComplianceDonutData} centerLabel={`${data.slaCompliancePct ?? 100}%`} centerSub="Compliance" fallbackHref={myAssignedFallback} />
        </Card>
      </div>

      {/* Bar charts row — when the journey has nothing to show, its compact empty
          state joins this row as a 4th tile instead of sitting alone as a giant
          full-width strip with a one-line message and huge blank space either side.
          Once there's real journey data (which needs the extra width to lay out
          department rows), it gets its own full-width section below instead. */}
      <div className={cn('grid grid-cols-1 gap-3', journey.length === 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
        <Card title="Tickets Moved to Other Departments (By Me)" subtitle={dateRangeLabel}>
          <DeptBarChart data={barDataFor(movedByMe.map((r) => ({ ...r, count: r.cnt })))} color="#3B82F6" fallbackHref={myAssignedFallback} />
        </Card>
        <Card title="Tickets Received from Other Departments" subtitle={dateRangeLabel}>
          <DeptBarChart data={barDataFor(receivedByMe.map((r) => ({ ...r, count: r.cnt })))} color="#8B5CF6" fallbackHref={myAssignedFallback} />
        </Card>
        <Card title="My Current Tickets by Source Department (From)">
          <DeptBarChart data={barDataFor(bySourceDept)} color="#14B8A6" fallbackHref={myAssignedFallback} />
        </Card>
        {journey.length === 0 && (
          <Card title="My Ticket Journey (Current Tickets)">
            <DeptBarChart data={[]} color="#F59E0B" fallbackHref={myAssignedFallback} />
          </Card>
        )}
      </div>

      {/* Ticket journey — full width, only rendered once there's real data */}
      {journey.length > 0 && (
        <Card title="My Ticket Journey (Current Tickets)">
          <div className="w-full space-y-4">
            {journey.map((j, i) => {
              const stageIdx = j.completed >= j.total * 0.5 ? 3 : j.waiting >= j.total * 0.5 ? 2 : j.inProgress >= j.total * 0.5 ? 1 : 0;
              const href = filtersHref({ assignee: targetUserId, space: j.spaceKey || undefined, queue: j.spaceKey ? j.dept : undefined });
              return (
                <Link href={href} key={`${j.dept}-${j.spaceKey}`} className="flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-gray-50">
                  <span
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: DEPT_PALETTE[i % DEPT_PALETTE.length] }}
                  >
                    {j.dept.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-gray-700">{j.label}</p>
                    <div className="mt-1 flex items-center gap-1">
                      {['Created', 'In Progress', 'Waiting', 'Completed'].map((_, si) => (
                        <React.Fragment key={si}>
                          {si > 0 && <span className={cn('h-px flex-1', si <= stageIdx ? 'bg-blue-400' : 'bg-gray-200')} />}
                          <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', si <= stageIdx ? 'bg-blue-500' : 'bg-gray-200')} />
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                  <span className="flex-shrink-0 text-right text-[11.5px] text-gray-500">
                    <span className="font-semibold text-gray-800">{j.total}</span> Tickets
                  </span>
                </Link>
              );
            })}
            <div className="flex justify-between border-t border-gray-100 pt-2 text-[10px] text-gray-400">
              <span>Created</span><span>In Progress</span><span>Waiting</span><span>Completed</span>
            </div>
          </div>
        </Card>
      )}
    </div>
    </div>
    </div>
  );
}
