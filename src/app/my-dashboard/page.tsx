'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { cn, priorityColors } from '@/lib/utils';
import { isManager } from '@/lib/permissions';
import DotLoader from '@/components/ui/DotLoader';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import {
  Layers, Loader2, CheckCircle2, Send, Hourglass, AlertTriangle, ChevronDown, ChevronRight, Calendar, BarChart3,
  LayoutDashboard, Users, X, GitCompare,
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

/* ─── grouped bar chart — 2 series per category (e.g. Last Week vs This
 * Week), used by the queue dashboard's week-over-week comparisons below.
 * Same recharts + Tailwind conventions as DeptBarChart above (grid, axis
 * font sizes, tooltip), plus a Legend to distinguish the two series. */
function GroupedBarChart({
  data, series, fallbackHref, height = 200,
}: {
  data: (Record<string, any> & { label: string; href?: string })[];
  series: { key: string; name: string; color: string }[];
  fallbackHref: string;
  height?: number;
}) {
  const router = useRouter();
  if (!data.length) {
    return (
      <Link href={fallbackHref} className="flex h-[110px] w-full flex-col items-center justify-center gap-1 rounded-lg text-center transition-colors hover:bg-gray-50">
        <span className="text-[12px] text-gray-400">No data yet — click to view</span>
      </Link>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#F3F4F6" />
        <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: '#6B7280' }} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" height={38} />
        <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: '#F9FAFB' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
        {series.map((s) => (
          <Bar
            key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={32} cursor="pointer"
            onClick={(d: any) => { const href = d?.payload?.href; if (href) router.push(href); }}
          />
        ))}
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

/* ─── small "Synced" indicator for the queue dashboard's 10s live poll below
 * — ticks its own "Xs ago" label every second (so it visibly counts up
 * between polls instead of sitting static) and flashes green for a moment
 * each time a poll actually completes (lastSyncedAt changing is the signal —
 * this component owns no fetching itself, it only reflects timestamps handed
 * down from the page-level polling effect). */
function SyncIndicator({ lastSyncedAt }: { lastSyncedAt: number | null }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (lastSyncedAt == null) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(id);
  }, [lastSyncedAt]);

  let label = 'Syncing…';
  if (lastSyncedAt != null) {
    const secs = Math.max(0, Math.round((Date.now() - lastSyncedAt) / 1000));
    label = secs < 3 ? 'Synced just now' : `Synced ${secs}s ago`;
  }
  return (
    <span
      className={cn(
        'flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-300',
        flash ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-200 bg-gray-50 text-gray-500',
      )}
      title="This queue dashboard refreshes itself every 10 seconds"
    >
      <CheckCircle2 size={12} className={flash ? 'text-green-600' : 'text-gray-400'} />
      {label}
    </span>
  );
}

type QueueMemberRow = {
  userId: string; name: string; ticketsWorked: number; slaBreached: number; inProgress: number; resolved: number;
  waitingForDev: number; waitingForPreSales: number; waitingForQA: number; waitingForInfra: number;
  statusBreakdown: { name: string; count: number; color: string }[];
};

/* ─── admin/manager (+ the role that owns this specific queue) per-queue
 * dashboard — the whole department's numbers, shown INSTEAD OF the personal
 * dashboard while active (never alongside it). Reuses
 * StatTile/Card/Donut/DeptBarChart/GroupedBarChart exactly like the personal
 * dashboard below; every stat/bar/table row deep-links to /filters via
 * filtersHref, same as everywhere else on this page.
 *
 * Two sub-tabs live here: "Summary" (stat tiles + full status breakdown +
 * the existing week-over-week graphs, all untouched from before) and
 * "User-wise Tickets" (a genuine table, replacing nothing -- the original
 * per-member bar chart stays in Summary exactly as it always has). */
function QueueDashboardView({ data, dateRangeLabel, lastSyncedAt }: { data: any; dateRangeLabel?: string; lastSyncedAt: number | null }) {
  const dept: string = data.dept;
  const spaceKey: string | null = data.spaceKey || null;
  const memberIds: string[] = data.memberIds || [];
  const summary = data.summary || {};
  const statusBreakdown = (data.statusBreakdown || []) as { name: string; count: number; color: string }[];
  const userWiseTickets = (data.userWiseTickets || []) as { userId: string; name: string; count: number }[];
  const userWiseTable = (data.userWiseTable || []) as QueueMemberRow[];
  const wow = data.weekOverWeek || {};
  const slaBreachRate = wow.slaBreachRate || { lastWeek: { total: 0, breached: 0, pct: 0 }, thisWeek: { total: 0, breached: 0, pct: 0 } };
  const createdVsResolved = wow.createdVsResolved || { lastWeek: { created: 0, resolved: 0 }, thisWeek: { created: 0, resolved: 0 } };
  const memberWorkload = (wow.memberWorkload || []) as {
    userId: string; name: string; thisWeek: number; lastWeek: number;
    breachedThisWeek: number; breachedLastWeek: number; inProgressThisWeek: number; inProgressLastWeek: number;
    openThisWeek: number; openLastWeek: number;
  }[];
  const workloadByUserId = new Map(memberWorkload.map((m) => [m.userId, m]));

  const [subTab, setSubTab] = useState<'summary' | 'userWise'>('summary');
  const [compareMode, setCompareMode] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  // Exact-space deep link when this queue name maps to exactly one board
  // (space+queue, same params bySourceDept/journey use below); otherwise an
  // assignee-list link across every current member — same "fall back to the
  // closest supported filter" precedent the personal dashboard's own SLA
  // running/breaching-soon tiles already rely on further down this file.
  const queueFallbackHref = spaceKey
    ? filtersHref({ space: spaceKey, queue: dept })
    : filtersHref({ assignee: memberIds.join(',') });
  const queueBreachedHref = spaceKey
    ? filtersHref({ space: spaceKey, queue: dept, slaBreached: 'yes' })
    : filtersHref({ assignee: memberIds.join(','), slaBreached: 'yes' });
  const membersHref = filtersHref({ assignee: memberIds.join(',') });

  const statusDonutData = statusBreakdown.map((s) => ({
    name: s.name, value: s.count, color: s.color,
    href: spaceKey ? filtersHref({ space: spaceKey, queue: dept, status: s.name }) : filtersHref({ assignee: memberIds.join(','), status: s.name }),
  }));
  const userWiseBarData = userWiseTickets.map((m) => ({
    dept: m.userId, label: m.name, count: m.count, href: filtersHref({ assignee: m.userId }),
  }));
  const slaBreachRateBarData = [
    { dept: 'lastWeek', label: `Last Week (${slaBreachRate.lastWeek.breached}/${slaBreachRate.lastWeek.total})`, count: slaBreachRate.lastWeek.pct, href: queueBreachedHref },
    { dept: 'thisWeek', label: `This Week (${slaBreachRate.thisWeek.breached}/${slaBreachRate.thisWeek.total})`, count: slaBreachRate.thisWeek.pct, href: queueBreachedHref },
  ];
  const createdVsResolvedData = [
    { label: 'Last Week', created: createdVsResolved.lastWeek.created, resolved: createdVsResolved.lastWeek.resolved, href: queueFallbackHref },
    { label: 'This Week', created: createdVsResolved.thisWeek.created, resolved: createdVsResolved.thisWeek.resolved, href: queueFallbackHref },
  ];
  const memberWorkloadData = memberWorkload.map((m) => ({
    label: m.name, lastWeek: m.lastWeek, thisWeek: m.thisWeek, href: filtersHref({ assignee: m.userId }),
  }));

  const expandedRow = expandedUserId ? userWiseTable.find((r) => r.userId === expandedUserId) || null : null;

  const thStyle = 'px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide';
  const tdStyle = 'px-4 py-2.5 text-right tabular-nums';

  return (
    <>
      {/* Sub-tabs (Summary / User-wise Tickets) + the live-sync indicator —
          the indicator sits here (not per sub-tab) since the whole
          queueDashboard payload — table included — is what the 10s poll
          below actually refreshes. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {([['summary', 'Summary'], ['userWise', 'User-wise Tickets']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSubTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                subTab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <SyncIndicator lastSyncedAt={lastSyncedAt} />
      </div>

      {subTab === 'summary' && (
        <>
          {/* Summary stat row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <StatTile
              label={`Total ${dept} Tickets`} value={summary.totalQueueTickets || 0}
              icon={<Layers size={17} className="text-blue-600" />} iconClass="bg-blue-50" href={queueFallbackHref}
            />
            <StatTile
              label="Queue Members" value={summary.membersCount || 0}
              icon={<Users size={17} className="text-purple-600" />} iconClass="bg-purple-50" href={membersHref}
            />
            <StatTile
              label={`Tickets Worked (${dateRangeLabel || 'range'})`} value={summary.ticketsWorked || 0}
              icon={<Send size={17} className="text-teal-600" />} iconClass="bg-teal-50" href={queueFallbackHref}
            />
            <StatTile
              label="Open Tickets" value={summary.openTickets || 0}
              icon={<Hourglass size={17} className="text-orange-600" />} iconClass="bg-orange-50" href={queueFallbackHref}
            />
            <StatTile
              label="SLA Breached" value={summary.slaBreached || 0}
              icon={<AlertTriangle size={17} className="text-red-600" />} iconClass="bg-red-50" href={queueBreachedHref}
            />
            <StatTile
              label="Due Tickets" value={summary.dueTickets || 0}
              icon={<Hourglass size={17} className="text-indigo-600" />} iconClass="bg-indigo-50" href={queueFallbackHref}
            />
          </div>

          {/* Full status breakdown -- every distinct status this queue's
              tickets currently sit in, each its own slice (resolved included,
              never lumped into one "open" bucket). Same Donut component, same
              usage, as the personal dashboard's "My Tickets by Status" below,
              just scoped to the whole department instead of one user. */}
          <Card title={`${dept} Tickets by Status`} subtitle={`All ${summary.totalQueueTickets || 0} current tickets in this queue`}>
            <Donut data={statusDonutData} fallbackHref={queueFallbackHref} />
          </Card>

          {/* User-wise tickets (current holdings bar chart -- unchanged; the
              richer per-metric breakdown lives in the User-wise Tickets
              sub-tab's table instead of replacing this). */}
          <Card title={`${dept} Tickets by Member`} subtitle="Current tickets held by each queue member">
            <DeptBarChart data={userWiseBarData} color="#3B82F6" fallbackHref={queueFallbackHref} />
          </Card>

          {/* Week-over-week graphs */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card title="SLA Breach Rate — Week over Week" subtitle="Last 7 days vs the 7 days before">
              <DeptBarChart data={slaBreachRateBarData} color="#EF4444" fallbackHref={queueBreachedHref} />
            </Card>
            <Card title="Tickets Created vs Resolved — Week over Week" subtitle="Last 7 days vs the 7 days before">
              <GroupedBarChart
                data={createdVsResolvedData}
                series={[{ key: 'created', name: 'Created', color: '#3B82F6' }, { key: 'resolved', name: 'Resolved', color: '#22C55E' }]}
                fallbackHref={queueFallbackHref}
              />
            </Card>
          </div>
          <Card title="Per-Member Workload — Week over Week" subtitle="Tickets worked, last 7 days vs the 7 days before">
            <GroupedBarChart
              data={memberWorkloadData}
              series={[{ key: 'lastWeek', name: 'Last Week', color: '#94A3B8' }, { key: 'thisWeek', name: 'This Week', color: '#8B5CF6' }]}
              fallbackHref={queueFallbackHref}
              height={Math.max(200, memberWorkloadData.length * 12)}
            />
          </Card>
        </>
      )}

      {subTab === 'userWise' && (
        <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[13px] font-semibold leading-snug text-gray-800">{`${dept} — User-wise Tickets`}</h3>
              <p className="mt-0.5 text-[10.5px] text-gray-400">
                {compareMode
                  ? 'Last 7 days vs the 7 days before, per member'
                  : `One row per queue member${dateRangeLabel ? ` — "Tickets Worked" scoped to ${dateRangeLabel}` : ''}`}
              </p>
            </div>
            {/* Compare toggle -- flips the table below between the normal
                single-period columns and Last Wk/This Wk paired columns for
                4 metrics. Toggling off returns to the normal columns; no
                separate modal, this IS the table. */}
            <button
              onClick={() => setCompareMode((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                compareMode ? 'border-violet-400 bg-violet-100 text-violet-700' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
              )}
            >
              <GitCompare size={13} /> {compareMode ? 'Comparing: Last Wk vs This Wk' : 'Compare'}
            </button>
          </div>

          {userWiseTable.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-gray-400">No queue members resolved yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Member</th>
                    {compareMode ? (
                      <>
                        <th className={thStyle}>Tickets Worked (Last Wk)</th>
                        <th className={thStyle}>Tickets Worked (This Wk)</th>
                        <th className={thStyle}>SLA Breached (Last Wk)</th>
                        <th className={thStyle}>SLA Breached (This Wk)</th>
                        <th className={thStyle}>In Progress (Last Wk)</th>
                        <th className={thStyle}>In Progress (This Wk)</th>
                        <th className={thStyle}>Open (Last Wk)</th>
                        <th className={thStyle}>Open (This Wk)</th>
                      </>
                    ) : (
                      <>
                        <th className={thStyle}>Tickets Worked</th>
                        <th className={thStyle}>SLA Breached</th>
                        <th className={thStyle}>In Progress</th>
                        <th className={thStyle}>Resolved</th>
                        <th className={thStyle}>Waiting for Dev</th>
                        <th className={thStyle}>Waiting for Pre-Sales</th>
                        <th className={thStyle}>Waiting for QA</th>
                        <th className={thStyle}>Waiting for Infra</th>
                      </>
                    )}
                    <th className="px-3 py-2.5" aria-label="Expand" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userWiseTable.map((row) => {
                    const wk = workloadByUserId.get(row.userId);
                    return (
                      <tr key={row.userId} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <Link href={filtersHref({ assignee: row.userId })} className="text-[13px] font-medium text-gray-800 hover:text-blue-600 hover:underline">
                            {row.name}
                          </Link>
                        </td>
                        {compareMode ? (
                          <>
                            <td className={tdStyle}>{wk?.lastWeek ?? 0}</td>
                            <td className={cn(tdStyle, 'font-medium')}>{wk?.thisWeek ?? 0}</td>
                            <td className={cn(tdStyle, 'text-red-600')}>{wk?.breachedLastWeek ?? 0}</td>
                            <td className={cn(tdStyle, 'text-red-600 font-medium')}>{wk?.breachedThisWeek ?? 0}</td>
                            <td className={tdStyle}>{wk?.inProgressLastWeek ?? 0}</td>
                            <td className={cn(tdStyle, 'font-medium')}>{wk?.inProgressThisWeek ?? 0}</td>
                            <td className={tdStyle}>{wk?.openLastWeek ?? 0}</td>
                            <td className={cn(tdStyle, 'font-medium')}>{wk?.openThisWeek ?? 0}</td>
                          </>
                        ) : (
                          <>
                            <td className={tdStyle}>{row.ticketsWorked}</td>
                            <td className={cn(tdStyle, 'text-red-600 font-medium')}>{row.slaBreached}</td>
                            <td className={tdStyle}>{row.inProgress}</td>
                            <td className={cn(tdStyle, 'text-green-600')}>{row.resolved}</td>
                            <td className={tdStyle}>{row.waitingForDev}</td>
                            <td className={tdStyle}>{row.waitingForPreSales}</td>
                            <td className={tdStyle}>{row.waitingForQA}</td>
                            <td className={tdStyle}>{row.waitingForInfra}</td>
                          </>
                        )}
                        <td className="px-3 py-2.5 text-right">
                          <button
                            onClick={() => setExpandedUserId(row.userId)}
                            title={`View ${row.name}'s breakdown`}
                            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          >
                            <ChevronRight size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Per-user expand -- a real side panel (not inline row expansion),
          triggered by the chevron button in the table above. Lives at this
          level (outside subTab's conditional) so it stays mountable
          regardless of which sub-tab is active. */}
      {expandedRow && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setExpandedUserId(null)} />
          <div className="fixed right-0 top-0 z-50 h-full w-[380px] max-w-[90vw] overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-2xl">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-gray-900">{expandedRow.name}</h3>
              <button onClick={() => setExpandedUserId(null)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                <X size={16} />
              </button>
            </div>
            <p className="mb-4 text-[11.5px] text-gray-400">{dept} tickets by status</p>
            <Donut
              data={(expandedRow.statusBreakdown || []).map((s) => ({
                name: s.name, value: s.count, color: s.color,
                href: filtersHref({ assignee: expandedRow.userId, status: s.name }),
              }))}
              fallbackHref={filtersHref({ assignee: expandedRow.userId })}
              height={130}
            />
            <div className="mt-5 grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded-lg border border-gray-200 p-2.5">
                <p className="text-gray-400">Tickets Worked</p>
                <p className="text-[15px] font-semibold text-gray-800">{expandedRow.ticketsWorked}</p>
              </div>
              <div className="rounded-lg border border-gray-200 p-2.5">
                <p className="text-gray-400">SLA Breached</p>
                <p className="text-[15px] font-semibold text-red-600">{expandedRow.slaBreached}</p>
              </div>
              <div className="rounded-lg border border-gray-200 p-2.5">
                <p className="text-gray-400">In Progress</p>
                <p className="text-[15px] font-semibold text-gray-800">{expandedRow.inProgress}</p>
              </div>
              <div className="rounded-lg border border-gray-200 p-2.5">
                <p className="text-gray-400">Resolved</p>
                <p className="text-[15px] font-semibold text-green-600">{expandedRow.resolved}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function MyDashboardPage() {
  const { user } = useStore(useShallow((s) => ({ user: s.user })));
  const isAdmin = user?.role === 'admin';
  // Who sees which queue's TAB (distinct from isAdmin above, which still
  // gates the admin-only "view as" pickers/report links further down —
  // those are unchanged). isManager already covers admin, so it alone
  // decides the generic case; migration_manager is layered on top for the
  // one dept-specific role that exists today. No dev-specific role exists,
  // so the Dev tab is exactly isManager -- same as the generic case.
  const canViewMigrationQueue = isManager(user?.role) || user?.role === 'migration_manager';
  const canViewDevQueue = isManager(user?.role);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [queueUsers, setQueueUsers] = useState<{ migration: any[]; dev: any[] }>({ migration: [], dev: [] });
  const [viewedUserId, setViewedUserId] = useState<string>('');
  // Viewing a whole queue's dashboard instead of any one person's — mutually
  // exclusive with viewedUserId (picking one always clears the other, see the
  // handlers below). Holds the department name, e.g. "Migration" / "Dev",
  // sent to the backend as ?viewedQueue=. Also doubles as the active
  // top-level tab key ('' = "My Dashboard").
  const [viewedQueueDept, setViewedQueueDept] = useState<string>('');
  const [dateRangeKey, setDateRangeKey] = useState<DateRangeKey>('7d');
  // Bumped to the completion time of every successful fetch while a queue
  // dashboard is active (including each 10s poll tick below) — purely so
  // QueueDashboardView's SyncIndicator can show it's really still syncing,
  // not a static label.
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

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
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // isPoll=true is a silent background refresh (no loading spinner, and it
    // stamps lastSyncedAt so the queue dashboard's SyncIndicator can reflect
    // it) — isPoll=false is the normal "view/range/user changed" load.
    const load = (isPoll: boolean) => {
      if (!isPoll) setLoading(true);
      const to = new Date();
      const from = dateRangeKey === 'today'
        ? new Date(to.getFullYear(), to.getMonth(), to.getDate())
        : new Date(to.getTime() - (dateRangeKey === '30d' ? 30 : 7) * 86_400_000);
      return api.getMyDashboard({
        // Mutually exclusive: a queue-dashboard view takes over the whole
        // request when set, exactly like userId does for one person — never
        // both at once (viewedUserId is always cleared whenever
        // viewedQueueDept is set, and vice versa, see the handlers below).
        ...(viewedQueueDept ? { viewedQueue: viewedQueueDept } : viewedUserId ? { userId: viewedUserId } : {}),
        from: from.toISOString(),
        to: to.toISOString(),
      })
        .then((d: any) => { if (!cancelled) { setData(d); setLastSyncedAt(Date.now()); } })
        .catch(() => {})
        .finally(() => { if (!cancelled && !isPoll) setLoading(false); });
    };

    load(false);
    // Live sync: only while an actual queue dashboard is being viewed (the
    // personal dashboard never polls). One interval per effect run, always
    // cleared in the cleanup below before the effect can re-run or this
    // component can unmount — so switching queues/date-range/user, or
    // navigating away entirely, can never leave a second interval stacked
    // on top, nor keep polling after the view is no longer active.
    if (viewedQueueDept) {
      intervalId = setInterval(() => load(true), 10_000);
    } else {
      setLastSyncedAt(null);
    }
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  }, [viewedUserId, viewedQueueDept, dateRangeKey]);

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

  // Present only when ?viewedQueue= was sent (admin queue-dashboard mode) —
  // takes over the WHOLE page body below instead of the personal dashboard;
  // the personal fields computed after this are simply unused in that case
  // (the response shape for the personal-dashboard case, i.e. when this is
  // absent, is completely unchanged from before this feature existed).
  const queueDashboard = data.queueDashboard || null;

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
      {/* Top-level view tabs: "My Dashboard" (everyone) + one tab per queue
          the current user is allowed to see. A plain developer/viewer/etc.
          only ever gets the one "My Dashboard" tab -- rather than render a
          single-tab bar that's really just a relabeled heading, the whole
          bar is skipped for them, so their page is pixel-identical to
          before this feature existed. Reuses the exact same
          viewedQueueDept trigger the queue-dashboard buttons always used;
          this is just that mechanism restyled as real underlined tabs and
          gated by role instead of isAdmin alone. */}
      {(canViewMigrationQueue || canViewDevQueue) && (
        <div className="flex items-center gap-5 border-b border-gray-200">
          {[
            { key: '', label: 'My Dashboard' },
            ...(canViewMigrationQueue ? [{ key: 'Migration', label: 'Migration Queue Dashboard' }] : []),
            ...(canViewDevQueue ? [{ key: 'Dev', label: 'Dev Queue Dashboard' }] : []),
          ].map((tab) => (
            <button
              key={tab.key || 'my-dashboard'}
              onClick={() => { setViewedQueueDept(tab.key); setViewedUserId(''); }}
              className={cn(
                'relative -mb-px flex items-center gap-1.5 pb-2.5 text-[13.5px] font-medium transition-colors',
                viewedQueueDept === tab.key ? 'text-blue-700' : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {tab.key ? <LayoutDashboard size={14} /> : null}
              {tab.label}
              {viewedQueueDept === tab.key && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-blue-600" />}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold text-gray-900">
            {queueDashboard ? `${queueDashboard.dept} Queue Dashboard` : 'User Level Dashboard'} <span>👋</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {queueDashboard
              ? `Queue-wide view across all ${queueDashboard.summary?.membersCount ?? 0} members`
              : <>{viewedUserId && viewedUserId !== user?.id ? 'Viewing' : 'Welcome back,'} {viewedName}</>}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <DateRangeSelect value={dateRangeKey} onChange={setDateRangeKey} />
          {/* Admin-only "view as another person" pickers and the standalone
              Reports deep-links — unrelated to the queue-dashboard TABS
              above, so these stay exactly as admin-gated as they always
              were (not part of what this role change touches). */}
          {isAdmin && (
            <>
              <QueueSelect
                label="Migration Queue" options={queueUsers.migration} value={viewedUserId}
                onChange={(v) => { setViewedUserId(v); setViewedQueueDept(''); }}
              />
              <QueueSelect
                label="Dev Queue" options={queueUsers.dev} value={viewedUserId}
                onChange={(v) => { setViewedUserId(v); setViewedQueueDept(''); }}
              />
              {/* These link straight to the actual Migration/Dev Resolution %,
                  SLA %, and SLA Breach % report instead of leaving that
                  undiscoverable behind Reports → a specific tab → a specific
                  filter. */}
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

      {queueDashboard && <QueueDashboardView key={queueDashboard.dept} data={queueDashboard} dateRangeLabel={dateRangeLabel} lastSyncedAt={lastSyncedAt} />}

      {/* Everything below is the PERSONAL dashboard — untouched, and only
          rendered when queue-dashboard mode isn't active (the two views
          never show at once, see QueueDashboardView above for that one). */}
      {!queueDashboard && (
      <>
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
      </>
      )}
    </div>
    </div>
    </div>
  );
}
