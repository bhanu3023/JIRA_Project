'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { getInitials, timeAgo } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { PriorityIcon, getPriorityMeta } from '@/components/ui/PriorityIcon';
import {
  CheckCircle2, Clock, TrendingUp, AlertTriangle,
  Users, BarChart2, Activity, RefreshCw,
  ArrowUp, ArrowDown, Minus, ArrowRight, Zap,
  Shield, Target,
} from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(n: number, total: number) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

const STATUS_CATEGORY_COLORS: Record<string, string> = {
  todo:        '#64748B',
  in_progress: '#3B82F6',
  done:        '#10B981',
};

const STATUS_CATEGORY_LABELS: Record<string, string> = {
  todo:        'To Do',
  in_progress: 'In Progress',
  done:        'Done',
};

const PRIORITY_ORDER = ['highest', 'high', 'medium', 'low', 'lowest'];
const PRIORITY_COLORS: Record<string, string> = {
  highest: '#E11D48',
  high:    '#D97706',
  medium:  '#7C3AED',
  low:     '#0891B2',
  lowest:  '#64748B',
};

// ─── Donut Chart (pure SVG) ──────────────────────────────────────────────────

function DonutChart({
  segments,
  size = 140,
}: {
  segments: { value: number; color: string; label: string }[];
  size?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 140 140">
          <circle cx="70" cy="70" r="52" fill="none" stroke="#E2E8F0" strokeWidth="20" />
        </svg>
      </div>
    );
  }

  const cx = 70, cy = 70, r = 52, stroke = 20;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  const arcs = segments.map((seg) => {
    const dashArray = (seg.value / total) * circ;
    const dashOffset = circ - offset;
    offset += dashArray;
    return { ...seg, dashArray, dashOffset };
  });

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 140 140"
        style={{ transform: 'rotate(-90deg)' }}
      >
        {arcs.map((arc, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth={stroke}
            strokeDasharray={`${arc.dashArray} ${circ - arc.dashArray}`}
            strokeDashoffset={arc.dashOffset}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{ transform: 'none' }}
      >
        <span className="text-[22px] font-bold text-gray-800">{total}</span>
        <span className="text-[10px] text-gray-500 mt-0.5">issues</span>
      </div>
    </div>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  sub,
  color,
  trend,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
  color: string;
  trend?: 'up' | 'down' | 'flat';
}) {
  const trendIcon =
    trend === 'up' ? <ArrowUp size={12} className="text-emerald-500" /> :
    trend === 'down' ? <ArrowDown size={12} className="text-rose-500" /> :
    trend === 'flat' ? <Minus size={12} className="text-gray-400" /> : null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11.5px] text-gray-500 font-medium mb-1">{label}</p>
        <div className="flex items-end gap-2">
          <span className="text-[26px] font-bold text-gray-900 leading-none">{value}</span>
          {trendIcon && <span className="flex items-center gap-0.5 mb-0.5">{trendIcon}</span>}
        </div>
        {sub && <p className="text-[11px] text-gray-400 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Progress Bar Row ────────────────────────────────────────────────────────

function BarRow({
  label,
  value,
  total,
  color,
  icon,
  href,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  icon?: React.ReactNode;
  href?: string;
}) {
  const p = pct(value, total);
  return (
    <div className="flex items-center gap-3 py-2">
      {icon && <span className="flex-shrink-0 w-4 flex items-center justify-center">{icon}</span>}
      <span className="text-[12px] text-gray-700 w-28 flex-shrink-0 truncate">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${p}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[12px] font-semibold text-gray-600 w-8 text-right">{value}</span>
    </div>
  );
}

// ─── Section Card wrapper ────────────────────────────────────────────────────

function SectionCard({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-800">
          <span className="text-blue-500">{icon}</span>
          {title}
        </div>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

// ─── SLA Status Badge ────────────────────────────────────────────────────────

function SLABadge({ label, met, total }: { label: string; met: number; total: number }) {
  const rate = total ? Math.round((met / total) * 100) : 0;
  const color = rate >= 90 ? '#10B981' : rate >= 70 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex-1">
        <p className="text-[12px] font-medium text-gray-700">{label}</p>
        <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${rate}%`, backgroundColor: color }}
          />
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span className="text-[15px] font-bold" style={{ color }}>{rate}%</span>
        <p className="text-[10px] text-gray-400">{met}/{total} met</p>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SummaryPage() {
  const params = useParams();
  const rawKey = params?.spaceKey;
  const spaceKey =
    typeof rawKey === 'string'
      ? rawKey.toUpperCase()
      : Array.isArray(rawKey)
        ? (rawKey[0] || '').toUpperCase()
        : '';

  const { currentSpace, loadSpace } = useStore(
    useShallow((s) => ({ currentSpace: s.currentSpace, loadSpace: s.loadSpace })),
  );

  const [issues, setIssues] = useState<any[]>([]);
  const [slaPolicies, setSlaPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const loadData = async () => {
    setLoading(true);
    try {
      await loadSpace(spaceKey, true);
      const [{ issues: allIssues }, policies] = await Promise.all([
        api.getIssues({ spaceKey, limit: '200' }),
        api.getSLAs(spaceKey).catch(() => [] as any[]),
      ]);
      setIssues(allIssues);
      setSlaPolicies(Array.isArray(policies) ? policies : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  };

  useEffect(() => {
    if (!spaceKey) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceKey]);

  // ── Computed metrics ──────────────────────────────────────────────────────

  const now = Date.now();
  const sevenDays = 7 * 24 * 3600 * 1000;
  const oneDayMs  = 24 * 3600 * 1000;

  const metrics = useMemo(() => {
    // Helper: compute SLA breach for an issue from policies
    function computeSLABreached(issue: any, policyName: string) {
      const priority = (issue.priority || 'medium').toLowerCase();
      const isResolved = issue.status?.category === 'done';
      for (const policy of slaPolicies) {
        if (!(policy.name || '').toLowerCase().includes(policyName.toLowerCase())) continue;
        if (policy.status !== 'active') continue;
        let durationMs = 8 * 3_600_000;
        for (const goal of (policy.goals || [])) {
          if (goal.isPriorityGroup && goal.priorityRows) {
            const row = goal.priorityRows.find((r: any) => r.priority?.toLowerCase() === priority);
            if (row?.timeValue) {
              const val = parseFloat(row.timeValue);
              const unit = (row.timeUnit || 'hours').toLowerCase();
              durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
              break;
            }
          } else if (goal.timeValue) {
            const val = parseFloat(goal.timeValue);
            const unit = (goal.timeUnit || 'hours').toLowerCase();
            durationMs = unit === 'minutes' ? val * 60_000 : unit === 'days' ? val * 86_400_000 : val * 3_600_000;
            break;
          }
        }
        const startedAt = issue.createdAt ? new Date(issue.createdAt).getTime() : Date.now();
        const dueMs = startedAt + durationMs;
        const isBreached = !isResolved && dueMs < Date.now();
        return { matched: true, isBreached };
      }
      return { matched: false, isBreached: false };
    }
    const total      = issues.length;
    const resolved   = issues.filter(i => i.status?.category === 'done');
    const open       = issues.filter(i => i.status?.category !== 'done');
    const inProgress = issues.filter(i => i.status?.category === 'in_progress');

    const createdThisWeek = issues.filter(i => i.createdAt && now - new Date(i.createdAt).getTime() < sevenDays);
    const updatedThisWeek = issues.filter(i => i.updatedAt && now - new Date(i.updatedAt).getTime() < sevenDays);
    const resolvedThisWeek= resolved.filter(i => i.updatedAt && now - new Date(i.updatedAt).getTime() < sevenDays);
    const dueSoon         = issues.filter(i => i.dueDate && !i.status?.category?.includes('done') &&
      new Date(i.dueDate).getTime() - now > 0 &&
      new Date(i.dueDate).getTime() - now < sevenDays);

    // Status breakdown
    const byCategory: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
    for (const iss of issues) {
      const cat = iss.status?.category || 'todo';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    // Priority breakdown
    const byPriority: Record<string, number> = {};
    for (const iss of issues) {
      const p = (iss.priority || 'medium').toLowerCase();
      byPriority[p] = (byPriority[p] || 0) + 1;
    }

    // Type breakdown
    const byType: Record<string, number> = {};
    for (const iss of issues) {
      const t = (iss.type || 'task').toLowerCase();
      byType[t] = (byType[t] || 0) + 1;
    }

    // Team workload
    const byAssignee: Record<string, { name: string; count: number; initials: string }> = {};
    for (const iss of issues) {
      if (iss.status?.category === 'done') continue; // only open issues
      if (iss.assignee) {
        const id = iss.assignee.id;
        if (!byAssignee[id]) byAssignee[id] = {
          name: `${iss.assignee.firstName} ${iss.assignee.lastName}`,
          count: 0,
          initials: getInitials(iss.assignee.firstName, iss.assignee.lastName),
        };
        byAssignee[id].count++;
      }
    }
    const unassignedOpen = open.filter(i => !i.assignee).length;
    if (unassignedOpen > 0) {
      byAssignee['__unassigned'] = { name: 'Unassigned', count: unassignedOpen, initials: '—' };
    }

    // SLA metrics — compute from policies client-side for all issues
    let slaFirstResponse = { met: 0, total: 0 };
    let slaResolution    = { met: 0, total: 0 };
    if (slaPolicies.length > 0) {
      for (const iss of issues) {
        const fr = computeSLABreached(iss, 'first response');
        if (fr.matched) {
          slaFirstResponse.total++;
          if (!fr.isBreached) slaFirstResponse.met++;
        }
        const res = computeSLABreached(iss, 'resolution');
        if (res.matched) {
          slaResolution.total++;
          if (!res.isBreached) slaResolution.met++;
        }
      }
    }

    // Recent activity — last 10 issues updated
    const recentActivity = [...issues]
      .filter(i => i.updatedAt)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);

    // Avg resolution time (for resolved this week, rough)
    let totalResMs = 0, resCount = 0;
    for (const iss of resolvedThisWeek) {
      if (iss.createdAt && iss.updatedAt) {
        totalResMs += new Date(iss.updatedAt).getTime() - new Date(iss.createdAt).getTime();
        resCount++;
      }
    }
    const avgResHours = resCount ? Math.round(totalResMs / resCount / 3_600_000) : null;

    return {
      total, open: open.length, inProgress: inProgress.length,
      resolved: resolved.length, createdThisWeek: createdThisWeek.length,
      updatedThisWeek: updatedThisWeek.length, resolvedThisWeek: resolvedThisWeek.length,
      dueSoon: dueSoon.length, byCategory, byPriority, byType, byAssignee,
      slaFirstResponse, slaResolution, recentActivity, avgResHours,
    };
  }, [issues, slaPolicies]);

  // ── Status donut segments ─────────────────────────────────────────────────

  const donutSegments = Object.entries(metrics.byCategory)
    .filter(([, v]) => v > 0)
    .map(([cat, v]) => ({
      value: v,
      color: STATUS_CATEGORY_COLORS[cat] || '#64748B',
      label: STATUS_CATEGORY_LABELS[cat] || cat,
    }));

  // ── Render ────────────────────────────────────────────────────────────────

  if (!spaceKey) return null;

  return (
    <div className="flex flex-col h-full bg-gray-50 overflow-auto">

      {/* ── Header ── */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-gray-400 mb-1">
            <Link href="/spaces" className="hover:text-blue-600">Spaces</Link>
            <span>/</span>
            <Link href={`/spaces/${spaceKey}`} className="hover:text-blue-600">{currentSpace?.name || spaceKey}</Link>
            <span>/</span>
            <span className="text-gray-700 font-medium">Summary</span>
          </div>
          <h1 className="text-[18px] font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 size={18} className="text-blue-500" />
            Summary
            <span className="text-[12px] font-normal text-gray-400 ml-1">Last 7 days</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-gray-400">
            Updated {lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-[12.5px] font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-[13px] text-gray-500">Loading summary…</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 px-6 py-5 space-y-5">

          {/* ── Stat Cards ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={<CheckCircle2 size={18} />}
              label="Resolved (7d)"
              value={metrics.resolvedThisWeek}
              sub={`${metrics.resolved} total resolved`}
              color="#10B981"
              trend="up"
            />
            <StatCard
              icon={<TrendingUp size={18} />}
              label="Updated (7d)"
              value={metrics.updatedThisWeek}
              sub={`${metrics.total} total issues`}
              color="#3B82F6"
              trend="flat"
            />
            <StatCard
              icon={<Activity size={18} />}
              label="Created (7d)"
              value={metrics.createdThisWeek}
              sub={`${metrics.open} currently open`}
              color="#8B5CF6"
              trend="up"
            />
            <StatCard
              icon={<AlertTriangle size={18} />}
              label="Due Soon (7d)"
              value={metrics.dueSoon}
              sub={metrics.avgResHours != null ? `Avg resolve: ${metrics.avgResHours}h` : 'No resolved this week'}
              color={metrics.dueSoon > 0 ? '#F59E0B' : '#10B981'}
              trend={metrics.dueSoon > 0 ? 'down' : 'flat'}
            />
          </div>

          {/* ── Row 2: Status Overview + SLA ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Status Overview Donut */}
            <SectionCard title="Status Overview" icon={<Target size={14} />}>
              <div className="flex items-center gap-6">
                <DonutChart segments={donutSegments} size={130} />
                <div className="flex-1 space-y-2">
                  {Object.entries(metrics.byCategory).map(([cat, count]) => (
                    <div key={cat} className="flex items-center gap-3">
                      <span
                        className="w-3 h-3 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: STATUS_CATEGORY_COLORS[cat] }}
                      />
                      <span className="flex-1 text-[12px] text-gray-700">{STATUS_CATEGORY_LABELS[cat]}</span>
                      <span className="text-[12px] font-semibold text-gray-800">{count}</span>
                      <span className="text-[11px] text-gray-400 w-8 text-right">{pct(count, metrics.total)}%</span>
                    </div>
                  ))}
                  <div className="pt-2 mt-2 border-t border-gray-100 flex items-center justify-between">
                    <span className="text-[11.5px] text-gray-500">Total issues</span>
                    <span className="text-[14px] font-bold text-gray-800">{metrics.total}</span>
                  </div>
                </div>
              </div>
            </SectionCard>

            {/* SLA Performance */}
            <SectionCard title="SLA Performance" icon={<Shield size={14} />}>
              {metrics.slaFirstResponse.total === 0 && metrics.slaResolution.total === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <Clock size={24} className="text-gray-200 mb-2" />
                  <p className="text-[12.5px] text-gray-500 font-medium">No SLA data yet</p>
                  <p className="text-[11.5px] text-gray-400 mt-1">SLA tracking begins once issues have SLA policies</p>
                  <Link href={`/spaces/${spaceKey}/settings?tab=sla`}
                    className="mt-3 flex items-center gap-1 text-[12px] text-blue-600 hover:text-blue-800 font-medium">
                    Configure SLAs <ArrowRight size={11} />
                  </Link>
                </div>
              ) : (
                <div className="space-y-1 divide-y divide-gray-50">
                  <SLABadge
                    label="Time to First Response"
                    met={metrics.slaFirstResponse.met}
                    total={metrics.slaFirstResponse.total}
                  />
                  <SLABadge
                    label="Time to Resolution"
                    met={metrics.slaResolution.met}
                    total={metrics.slaResolution.total}
                  />
                  <div className="pt-3">
                    <div className="flex items-center justify-between text-[11.5px]">
                      <span className="text-gray-500">Overall compliance</span>
                      <span className="font-semibold text-gray-700">
                        {(() => {
                          const totalSla = metrics.slaFirstResponse.total + metrics.slaResolution.total;
                          const metSla   = metrics.slaFirstResponse.met   + metrics.slaResolution.met;
                          return totalSla ? `${Math.round((metSla / totalSla) * 100)}%` : '—';
                        })()}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Row 3: Priority + Type + Workload ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Priority Breakdown */}
            <SectionCard title="Priority Breakdown" icon={<Zap size={14} />}>
              {PRIORITY_ORDER.filter(p => metrics.byPriority[p] > 0).length === 0 ? (
                <p className="text-[12px] text-gray-400 py-4 text-center">No priority data</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {PRIORITY_ORDER.map(p => {
                    const count = metrics.byPriority[p] || 0;
                    if (!count) return null;
                    const meta = getPriorityMeta(p);
                    return (
                      <BarRow
                        key={p}
                        label={meta.label}
                        value={count}
                        total={metrics.total}
                        color={PRIORITY_COLORS[p] || '#64748B'}
                        icon={<PriorityIcon priority={p} size={13} />}
                      />
                    );
                  })}
                </div>
              )}
            </SectionCard>

            {/* Request Type Breakdown */}
            <SectionCard title="Request Type" icon={<BarChart2 size={14} />}>
              {Object.keys(metrics.byType).length === 0 ? (
                <p className="text-[12px] text-gray-400 py-4 text-center">No type data</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {Object.entries(metrics.byType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <BarRow
                        key={type}
                        label={type.charAt(0).toUpperCase() + type.slice(1)}
                        value={count}
                        total={metrics.total}
                        color="#3B82F6"
                        icon={<IssueTypeIcon type={type} size={13} />}
                      />
                    ))}
                </div>
              )}
            </SectionCard>

            {/* Team Workload */}
            <SectionCard title="Team Workload" icon={<Users size={14} />}>
              {Object.keys(metrics.byAssignee).length === 0 ? (
                <div className="flex flex-col items-center py-6 text-center">
                  <Users size={22} className="text-gray-200 mb-2" />
                  <p className="text-[12.5px] text-gray-500">No open issues assigned</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {Object.entries(metrics.byAssignee)
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([id, info]) => {
                      const maxCount = Math.max(...Object.values(metrics.byAssignee).map(x => x.count));
                      return (
                        <div key={id} className="flex items-center gap-3 py-2">
                          <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ${id === '__unassigned' ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-700'}`}>
                            {info.initials === '—' ? '?' : info.initials}
                          </div>
                          <span className="text-[12px] text-gray-700 flex-1 truncate">{info.name}</span>
                          <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden flex-shrink-0">
                            <div
                              className="h-full rounded-full bg-blue-400 transition-all duration-500"
                              style={{ width: `${pct(info.count, maxCount)}%` }}
                            />
                          </div>
                          <span className="text-[12px] font-semibold text-gray-600 w-5 text-right flex-shrink-0">{info.count}</span>
                        </div>
                      );
                    })}
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Row 4: Recent Activity ── */}
          <SectionCard
            title="Recent Activity"
            icon={<Activity size={14} />}
            action={
              <Link href={`/spaces/${spaceKey}?queue=all-open`}
                className="flex items-center gap-1 text-[12px] text-blue-600 hover:text-blue-800 font-medium">
                View all <ArrowRight size={11} />
              </Link>
            }
          >
            {metrics.recentActivity.length === 0 ? (
              <p className="text-[12px] text-gray-400 py-4 text-center">No recent activity</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {metrics.recentActivity.map(issue => {
                  const st = issue.status;
                  const catColor = st?.color || STATUS_CATEGORY_COLORS[st?.category || 'todo'] || '#64748B';
                  return (
                    <Link
                      key={issue.id}
                      href={`/issues/${issue.cfKey ?? issue.key}`}
                      className="flex items-center gap-3 py-2.5 hover:bg-gray-50 -mx-5 px-5 transition-colors rounded"
                    >
                      <IssueTypeIcon type={issue.type || 'task'} size={14} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] text-gray-800 font-medium truncate">{issue.summary}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10.5px] font-mono text-blue-500">{issue.key}</span>
                          {issue.assignee && (
                            <span className="text-[10.5px] text-gray-400">
                              {issue.assignee.firstName} {issue.assignee.lastName}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className="px-2 py-0.5 rounded text-[10.5px] font-medium"
                          style={{ backgroundColor: `${catColor}18`, color: catColor }}
                        >
                          {st?.name || '—'}
                        </span>
                        <PriorityIcon priority={issue.priority} size={12} />
                        <span className="text-[11px] text-gray-400 w-16 text-right">{timeAgo(issue.updatedAt)}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* ── Footer ── */}
          <div className="text-center py-3">
            <p className="text-[11px] text-gray-400">
              Summary data is computed from all issues in <span className="font-medium text-gray-600">{currentSpace?.name || spaceKey}</span>.
              Refresh to see the latest metrics.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}
