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
  Layers, Loader2, CheckCircle2, Send, Hourglass, AlertTriangle, ChevronDown,
} from 'lucide-react';

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

/* ─── stat card (clickable) ─── */
function StatTile({ label, value, icon, iconClass, href }: { label: string; value: number; icon: React.ReactNode; iconClass: string; href: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 hover:shadow-md">
      <div className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none text-gray-900 tabular-nums">{value.toLocaleString()}</p>
        <p className="mt-1 truncate text-[11.5px] text-gray-500">{label}</p>
      </div>
    </Link>
  );
}

/* ─── donut chart with centered total — each legend row is clickable ─── */
function Donut({
  data, centerLabel, centerSub,
}: {
  data: { name: string; value: number; color: string; href?: string }[];
  centerLabel?: string;
  centerSub?: string;
}) {
  const router = useRouter();
  const total = data.reduce((a, d) => a + d.value, 0);
  const shown = total > 0 ? data.filter((d) => d.value > 0) : [{ name: 'None', value: 1, color: '#E5E7EB' }];
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[120px] w-[120px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={shown} dataKey="value" innerRadius={38} outerRadius={58} paddingAngle={total > 0 ? 2 : 0}
              startAngle={90} endAngle={-270} stroke="none"
              onClick={(d: any) => { if (d?.href) router.push(d.href); }}
              cursor={total > 0 ? 'pointer' : 'default'}
            >
              {shown.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            {total > 0 && <Tooltip formatter={(v: any, n: any) => [v, n]} />}
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
          return (
            <div key={d.name} className="flex items-center justify-between gap-2 text-[11.5px]">
              {d.href && d.value > 0 ? <Link href={d.href} className="min-w-0 hover:text-blue-600 hover:underline">{row}</Link> : row}
              <span className="flex-shrink-0 font-medium text-gray-700">
                {d.value} {total > 0 && <span className="text-gray-400">({Math.round((d.value / total) * 100)}%)</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── card shell ─── */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-[13px] font-semibold text-gray-800">{title}</h3>
      {children}
    </div>
  );
}

/* ─── bar chart — bars are clickable ─── */
function DeptBarChart({ data, color }: { data: { dept: string; label: string; count: number; href: string }[]; color: string }) {
  const router = useRouter();
  if (!data.length) {
    return <div className="flex h-[180px] items-center justify-center text-[12px] text-gray-400">No data yet</div>;
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

export default function MyDashboardPage() {
  const { user } = useStore(useShallow((s) => ({ user: s.user })));
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<any[]>([]);
  const [viewedUserId, setViewedUserId] = useState<string>('');

  // Admin-only: load the user list to populate the "view as" dropdown
  useEffect(() => {
    if (!isAdmin) return;
    api.getUsers().then((rows: any) => setUsers(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getMyDashboard(viewedUserId ? { userId: viewedUserId } : undefined)
      .then((d: any) => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewedUserId]);

  if (loading || !data) {
    return <DotLoader className="py-24" />;
  }

  const cards = data.cards || {};
  const cardStatuses = data.cardStatuses || {};
  const targetUserId: string = data.viewedUserId || user?.id || '';
  const byStatus = (data.byStatus || []) as { name: string; count: number; color: string }[];
  const byPriority = (data.byPriority || []) as { name: string; count: number }[];
  const slaStatus = data.slaStatus || { withinSla: 0, nearBreach: 0, breachingSoon: 0, breached: 0 };
  const bySourceDept = withDisambiguatedLabels((data.bySourceDept || []) as { dept: string; spaceKey: string | null; count: number }[]);
  const journey = withDisambiguatedLabels((data.journey || []) as { dept: string; spaceKey: string | null; total: number; created: number; inProgress: number; waiting: number; completed: number }[]);
  const movedByMe = withDisambiguatedLabels((data.movedByMe || []) as { dept: string; spaceKey: string | null; cnt: number }[]);
  const receivedByMe = withDisambiguatedLabels((data.receivedByMe || []) as { dept: string; spaceKey: string | null; cnt: number }[]);

  const statusDonutData = byStatus.map((s) => ({
    name: s.name, value: s.count, color: s.color,
    href: s.name === 'Unknown' ? filtersHref({ assignee: targetUserId }) : filtersHref({ assignee: targetUserId, status: s.name }),
  }));
  const priorityDonutData = byPriority.map((p) => ({
    name: p.name.charAt(0).toUpperCase() + p.name.slice(1),
    value: p.count,
    color: priorityColors[p.name] || '#94A3B8',
    href: filtersHref({ assignee: targetUserId, priority: p.name }),
  }));
  const slaStatusDonutData = Object.entries(slaStatus).map(([k, v]) => ({
    name: SLA_STATUS_LABELS[k], value: v as number, color: SLA_STATUS_COLORS[k],
    href: filtersHref({ assignee: targetUserId }),
  }));
  const slaComplianceDonutData = [
    { name: 'Within SLA', value: (data.slaTrackedCount || 0) - (slaStatus.breached || 0), color: '#22C55E', href: filtersHref({ assignee: targetUserId }) },
    { name: 'Breached', value: slaStatus.breached || 0, color: '#EF4444', href: filtersHref({ assignee: targetUserId }) },
  ];

  const barDataFor = (rows: { dept: string; label: string; spaceKey: string | null; count: number }[]) =>
    rows.map((r) => ({ ...r, href: filtersHref({ assignee: targetUserId, space: r.spaceKey || undefined, queue: r.spaceKey ? r.dept : undefined }) }));

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold text-gray-900">
            User Level Dashboard <span>👋</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {viewedUserId && viewedUserId !== user?.id ? 'Viewing' : 'Welcome back,'}{' '}
            {viewedUserId && viewedUserId !== user?.id
              ? users.find((u) => u.id === viewedUserId)?.firstName || 'another user'
              : user?.firstName}
          </p>
        </div>

        {isAdmin && (
          <div className="relative flex-shrink-0">
            <select
              value={viewedUserId}
              onChange={(e) => setViewedUserId(e.target.value)}
              className="appearance-none rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-[13px] font-medium text-gray-700 outline-none focus:border-blue-500"
            >
              <option value="">My Dashboard</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
                </option>
              ))}
            </select>
            <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
        )}
      </div>

      {/* Top stat row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
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
          href={filtersHref({ assignee: targetUserId })}
        />
        <StatTile
          label="SLA Breaching Soon" value={cards.slaBreachingSoon || 0}
          icon={<AlertTriangle size={17} className="text-red-600" />} iconClass="bg-red-50"
          href={filtersHref({ assignee: targetUserId })}
        />
      </div>

      {/* Donut row */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <Card title="My Tickets by Status"><Donut data={statusDonutData} /></Card>
        <Card title="My Tickets by Priority"><Donut data={priorityDonutData} /></Card>
        <Card title="SLA Status (My Tickets)"><Donut data={slaStatusDonutData} /></Card>
        <Card title="SLA Compliance (My Tickets)">
          <Donut data={slaComplianceDonutData} centerLabel={`${data.slaCompliancePct ?? 100}%`} centerSub="Compliance" />
        </Card>
      </div>

      {/* Bar charts row */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="Tickets Moved to Other Departments (By Me)">
          <DeptBarChart data={barDataFor(movedByMe.map((r) => ({ ...r, count: r.cnt })))} color="#3B82F6" />
        </Card>
        <Card title="Tickets Received from Other Departments">
          <DeptBarChart data={barDataFor(receivedByMe.map((r) => ({ ...r, count: r.cnt })))} color="#8B5CF6" />
        </Card>
        <Card title="My Current Tickets by Source Department (From)">
          <DeptBarChart data={barDataFor(bySourceDept)} color="#14B8A6" />
        </Card>
      </div>

      {/* Ticket journey */}
      <Card title="My Ticket Journey (Current Tickets)">
        {journey.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-gray-400">No open tickets right now</p>
        ) : (
          <div className="space-y-4">
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
        )}
      </Card>
    </div>
  );
}
