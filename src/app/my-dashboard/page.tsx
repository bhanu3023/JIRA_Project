'use client';

import React, { useEffect, useState } from 'react';
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
  Layers, Loader2, CheckCircle2, Send, Hourglass, AlertTriangle,
  MessageSquare, ArrowRightLeft, ArrowLeftRight, PlusCircle,
} from 'lucide-react';

/* ─── palette ─── */
const DEPT_PALETTE = ['#3B82F6', '#8B5CF6', '#F59E0B', '#14B8A6', '#EC4899', '#64748B', '#22C55E', '#EF4444'];
const AGE_COLORS: Record<string, string> = { '0-2': '#22C55E', '3-5': '#F59E0B', '5-10': '#F97316', '10+': '#EF4444' };
const RISK_COLORS: Record<string, string> = { low: '#22C55E', medium: '#F59E0B', high: '#EF4444' };
const SLA_STATUS_COLORS: Record<string, string> = {
  withinSla: '#22C55E', nearBreach: '#F59E0B', breachingSoon: '#F97316', breached: '#EF4444',
};
const SLA_STATUS_LABELS: Record<string, string> = {
  withinSla: 'Within SLA', nearBreach: 'Near Breach', breachingSoon: 'Breaching Soon', breached: 'Breached',
};
const AGE_LABELS: Record<string, string> = { '0-2': '0 - 2 Days', '3-5': '3 - 5 Days', '5-10': '5 - 10 Days', '10+': '10+ Days' };
const RISK_LABELS: Record<string, string> = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk' };

/* ─── stat card ─── */
function StatTile({ label, value, icon, iconClass }: { label: string; value: number; icon: React.ReactNode; iconClass: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none text-gray-900 tabular-nums">{value.toLocaleString()}</p>
        <p className="mt-1 truncate text-[11.5px] text-gray-500">{label}</p>
      </div>
    </div>
  );
}

/* ─── donut chart with centered total ─── */
function Donut({
  data, centerLabel, centerSub,
}: {
  data: { name: string; value: number; color: string }[];
  centerLabel?: string;
  centerSub?: string;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const shown = total > 0 ? data.filter((d) => d.value > 0) : [{ name: 'None', value: 1, color: '#E5E7EB' }];
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[120px] w-[120px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={shown} dataKey="value" innerRadius={38} outerRadius={58} paddingAngle={total > 0 ? 2 : 0} startAngle={90} endAngle={-270} stroke="none">
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
        {data.map((d) => (
          <div key={d.name} className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-gray-600">
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="flex-shrink-0 font-medium text-gray-700">
              {d.value} {total > 0 && <span className="text-gray-400">({Math.round((d.value / total) * 100)}%)</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── card shell ─── */
function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-gray-800">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/* ─── bar chart ─── */
function DeptBarChart({ data, color }: { data: { dept: string; count: number }[]; color: string }) {
  if (!data.length) {
    return <div className="flex h-[180px] items-center justify-center text-[12px] text-gray-400">No data yet</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#F3F4F6" />
        <XAxis dataKey="dept" tick={{ fontSize: 10.5, fill: '#6B7280' }} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" height={38} />
        <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: '#F9FAFB' }} />
        <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function MyDashboardPage() {
  const { user } = useStore(useShallow((s) => ({ user: s.user })));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getMyDashboard().then((d: any) => { if (!cancelled) setData(d); }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading || !data) {
    return <DotLoader className="py-24" />;
  }

  const cards = data.cards || {};
  const byStatus = (data.byStatus || []) as { name: string; count: number; color: string }[];
  const byPriority = (data.byPriority || []) as { name: string; count: number }[];
  const slaStatus = data.slaStatus || { withinSla: 0, nearBreach: 0, breachingSoon: 0, breached: 0 };
  const riskBuckets = data.riskBuckets || { low: 0, medium: 0, high: 0 };
  const ageing = data.ageing || { '0-2': 0, '3-5': 0, '5-10': 0, '10+': 0 };
  const bySourceDept = (data.bySourceDept || []) as { dept: string; count: number }[];
  const journey = (data.journey || []) as { dept: string; total: number; created: number; inProgress: number; waiting: number; completed: number }[];
  const movedByMe = (data.movedByMe || []) as { dept: string; cnt: number }[];
  const receivedByMe = (data.receivedByMe || []) as { dept: string; cnt: number }[];
  const quick = data.quickStats || {};

  const statusDonutData = byStatus.map((s) => ({ name: s.name, value: s.count, color: s.color }));
  const priorityDonutData = byPriority.map((p) => ({
    name: p.name.charAt(0).toUpperCase() + p.name.slice(1),
    value: p.count,
    color: priorityColors[p.name] || '#94A3B8',
  }));
  const slaStatusDonutData = Object.entries(slaStatus).map(([k, v]) => ({ name: SLA_STATUS_LABELS[k], value: v as number, color: SLA_STATUS_COLORS[k] }));
  const ageingDonutData = Object.entries(ageing).map(([k, v]) => ({ name: AGE_LABELS[k], value: v as number, color: AGE_COLORS[k] }));
  const riskDonutData = Object.entries(riskBuckets).map(([k, v]) => ({ name: RISK_LABELS[k], value: v as number, color: RISK_COLORS[k] }));
  const slaComplianceDonutData = [
    { name: 'Within SLA', value: (data.slaTrackedCount || 0) - (slaStatus.breached || 0), color: '#22C55E' },
    { name: 'Breached', value: slaStatus.breached || 0, color: '#EF4444' },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold text-gray-900">
          User Level Dashboard <span>👋</span>
        </h1>
        <p className="mt-0.5 text-[13px] text-gray-500">Welcome back, {user?.firstName}</p>
      </div>

      {/* Top stat row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatTile label="My Open Tickets" value={cards.myOpenTickets || 0} icon={<Layers size={17} className="text-blue-600" />} iconClass="bg-blue-50" />
        <StatTile label="In Progress (With Me)" value={cards.inProgress || 0} icon={<Loader2 size={17} className="text-purple-600" />} iconClass="bg-purple-50" />
        <StatTile label="Waiting / On Hold" value={cards.waitingOrOnHold || 0} icon={<Hourglass size={17} className="text-orange-600" />} iconClass="bg-orange-50" />
        <StatTile label="Resolved by Me" value={cards.resolvedByMe || 0} icon={<CheckCircle2 size={17} className="text-green-600" />} iconClass="bg-green-50" />
        <StatTile label="Reported by Me" value={cards.reportedByMe || 0} icon={<Send size={17} className="text-teal-600" />} iconClass="bg-teal-50" />
        <StatTile label="SLA Running (With Me)" value={cards.slaRunning || 0} icon={<Hourglass size={17} className="text-indigo-600" />} iconClass="bg-indigo-50" />
        <StatTile label="SLA Breaching Soon" value={cards.slaBreachingSoon || 0} icon={<AlertTriangle size={17} className="text-red-600" />} iconClass="bg-red-50" />
      </div>

      {/* Donut row 1 */}
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
          <DeptBarChart data={movedByMe.map((r) => ({ dept: r.dept, count: r.cnt }))} color="#3B82F6" />
        </Card>
        <Card title="Tickets Received from Other Departments">
          <DeptBarChart data={receivedByMe.map((r) => ({ dept: r.dept, count: r.cnt }))} color="#8B5CF6" />
        </Card>
        <Card title="My Current Tickets by Source Department (From)">
          <DeptBarChart data={bySourceDept} color="#14B8A6" />
        </Card>
      </div>

      {/* Journey + ageing + risk + quick stats */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <Card title="My Ticket Journey (Current Tickets)">
          {journey.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-gray-400">No open tickets right now</p>
          ) : (
            <div className="space-y-4">
              {journey.map((j, i) => {
                const stageIdx = j.completed >= j.total * 0.5 ? 3 : j.waiting >= j.total * 0.5 ? 2 : j.inProgress >= j.total * 0.5 ? 1 : 0;
                return (
                  <div key={j.dept} className="flex items-center gap-3">
                    <span
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: DEPT_PALETTE[i % DEPT_PALETTE.length] }}
                    >
                      {j.dept.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-gray-700">{j.dept}</p>
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
                  </div>
                );
              })}
              <div className="flex justify-between border-t border-gray-100 pt-2 text-[10px] text-gray-400">
                <span>Created</span><span>In Progress</span><span>Waiting</span><span>Completed</span>
              </div>
            </div>
          )}
        </Card>
        <Card title="Tickets by Ageing (My Open Tickets)"><Donut data={ageingDonutData} /></Card>
        <Card title="SLA Breach Risk (My Tickets)"><Donut data={riskDonutData} /></Card>
        <Card title="Quick Stats (Today)">
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { label: 'Created by Me', value: quick.createdToday || 0, icon: <PlusCircle size={14} className="text-blue-600" />, bg: 'bg-blue-50' },
              { label: 'Moved by Me', value: quick.movedToday || 0, icon: <ArrowRightLeft size={14} className="text-purple-600" />, bg: 'bg-purple-50' },
              { label: 'Received by Me', value: quick.receivedToday || 0, icon: <ArrowLeftRight size={14} className="text-teal-600" />, bg: 'bg-teal-50' },
              { label: 'Comments by Me', value: quick.commentsToday || 0, icon: <MessageSquare size={14} className="text-orange-600" />, bg: 'bg-orange-50' },
              { label: 'Resolved by Me', value: quick.resolvedToday || 0, icon: <CheckCircle2 size={14} className="text-green-600" />, bg: 'bg-green-50' },
            ].map((q) => (
              <div key={q.label} className="rounded-lg border border-gray-100 p-2.5">
                <div className={cn('mb-1.5 flex h-6 w-6 items-center justify-center rounded-md', q.bg)}>{q.icon}</div>
                <p className="text-[15px] font-bold text-gray-900">{q.value}</p>
                <p className="truncate text-[10.5px] text-gray-500">{q.label}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
