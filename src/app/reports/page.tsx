'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { BarChart3, TrendingUp, Users, Target, Calendar, X, CheckCircle2, ShieldCheck, AlertTriangle, LayoutGrid, Clock, Timer, Search } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LineChart, Line } from 'recharts';

const WEEKLY_PRODUCT_TYPES = ['Content Migration', 'Message Migration', 'Email Migration'];
const WEEK_COLORS = ['#1E40AF', '#93C5FD', '#2563EB', '#60A5FA', '#1D4ED8', '#BFDBFE'];
const fmtWeekDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function buildWeeklyChartData(weekly: any, metricKey: 'breachPct' | 'resolutionPct') {
  if (!weekly) return [];
  return WEEKLY_PRODUCT_TYPES.map(pt => {
    const row: Record<string, any> = { name: pt.replace(' Migration', '').toUpperCase() };
    const buckets = weekly.byProductType?.[pt] || [];
    (weekly.weekLabels || []).forEach((label: string, i: number) => { row[label] = buckets[i]?.[metricKey] ?? 0; });
    return row;
  });
}

export default function ReportsPage() {
  const { spaces, user } = useStore((s) => ({ spaces: s.spaces, user: s.user }));
  const canViewPerformance = user?.role === 'admin' || user?.role === 'manager';
  // Lets a link like /reports?tab=resolution-sla&dept=Migration jump straight
  // into the right view — e.g. from the Dashboard's "Migration Report" /
  // "Dev Report" shortcuts, instead of everyone having to know to click
  // Reports, then find the right tab, then set the filter themselves.
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(() => searchParams.get('tab') || 'velocity');
  const [selectedSpace, setSelectedSpace] = useState('');
  const [velocity, setVelocity] = useState<any[]>([]);
  const [burndown, setBurndown] = useState<any>(null);
  const [performance, setPerformance] = useState<any[]>([]);
  const [perfLoading, setPerfLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Resolution % / SLA % / SLA Breach % report — Migration/Dev x Content/Message/Email
  const [rsDept, setRsDept] = useState(() => searchParams.get('dept') || '');        // '' = All (Migration + Dev combined)
  const [rsProductType, setRsProductType] = useState(() => searchParams.get('productType') || ''); // '' = All (Content + Message + Email combined)
  const [rsData, setRsData] = useState<any>(null);
  const [rsLoading, setRsLoading] = useState(false);

  // Team Analytics — ported from the standalone Reports- app; ties into this
  // app's own issues/issue_history, grouped by current_department.
  const [taSubTab, setTaSubTab] = useState<'overview' | 'aging' | 'time-spent'>('overview');
  const [taDepts, setTaDepts] = useState<string[]>([]); // [] = All
  const [taDateType, setTaDateType] = useState<'created' | 'updated' | 'none'>('created');
  const [taFilterOptions, setTaFilterOptions] = useState<{ depts: string[] }>({ depts: [] });
  const [taOverview, setTaOverview] = useState<any>(null);
  const [taAging, setTaAging] = useState<any>(null);
  const [taTimeSpent, setTaTimeSpent] = useState<any>(null);
  const [taTimeSpentSearch, setTaTimeSpentSearch] = useState('');
  const [taTimeSpentSearchDebounced, setTaTimeSpentSearchDebounced] = useState('');
  const [taLoading, setTaLoading] = useState(false);

  // Debounced separately from the other Team Analytics filters so a search
  // term doesn't fire one request per keystroke — the dept/date filters
  // above stay immediate since those only change on a discrete click/select.
  useEffect(() => {
    const t = setTimeout(() => setTaTimeSpentSearchDebounced(taTimeSpentSearch), 400);
    return () => clearTimeout(t);
  }, [taTimeSpentSearch]);

  useEffect(() => {
    if (!canViewPerformance || tab !== 'team-analytics') return;
    // Fetched once, unfiltered, purely to populate the dept checkbox list —
    // using the filtered response's own `depts` would shrink the available
    // options as soon as the user picked one, with no way back.
    api.getTeamAnalytics('overview').then((d: any) => setTaFilterOptions({ depts: d.depts || [] })).catch(() => {});
  }, [canViewPerformance, tab]);

  useEffect(() => {
    if (!canViewPerformance || tab !== 'team-analytics') return;
    setTaLoading(true);
    const params = {
      dept: taDepts.join(',') || undefined, dateType: taDateType, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
      q: taSubTab === 'time-spent' ? (taTimeSpentSearchDebounced || undefined) : undefined,
    };
    api.getTeamAnalytics(taSubTab, params)
      .then((d: any) => {
        if (taSubTab === 'overview') setTaOverview(d);
        else if (taSubTab === 'aging') setTaAging(d);
        else setTaTimeSpent(d);
      })
      .catch(() => {
        if (taSubTab === 'overview') setTaOverview(null);
        else if (taSubTab === 'aging') setTaAging(null);
        else setTaTimeSpent(null);
      })
      .finally(() => setTaLoading(false));
  }, [canViewPerformance, tab, taSubTab, taDepts, taDateType, dateFrom, dateTo, taTimeSpentSearchDebounced]);

  useEffect(() => {
    if (!canViewPerformance) return;
    setPerfLoading(true);
    api.getUserPerformance(selectedSpace || undefined, dateFrom || undefined, dateTo || undefined)
      .then((d: any) => setPerformance(Array.isArray(d) ? d : []))
      .catch(() => setPerformance([]))
      .finally(() => setPerfLoading(false));
  }, [canViewPerformance, selectedSpace, dateFrom, dateTo]);

  useEffect(() => {
    if (!canViewPerformance || tab !== 'resolution-sla') return;
    setRsLoading(true);
    api.getResolutionSla({
      dept: rsDept || undefined,
      productType: rsProductType || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    })
      .then((d: any) => setRsData(d))
      .catch(() => setRsData(null))
      .finally(() => setRsLoading(false));
  }, [canViewPerformance, tab, rsDept, rsProductType, dateFrom, dateTo]);

  useEffect(() => {
    if (selectedSpace) {
      api.getVelocity(selectedSpace, dateFrom || undefined, dateTo || undefined).then(setVelocity).catch(() => setVelocity([]));
      api.getBurndown(selectedSpace, dateFrom || undefined, dateTo || undefined).then(setBurndown).catch(() => setBurndown(null));
    } else {
      setVelocity([]);
      setBurndown(null);
    }
  }, [selectedSpace, dateFrom, dateTo]);

  const tabs = [
    { id: 'velocity',    label: 'Sprint Velocity',  icon: TrendingUp },
    { id: 'burndown',    label: 'Burndown Chart',    icon: Target },
    { id: 'performance', label: 'User Performance',  icon: Users },
    { id: 'resolution-sla', label: 'Resolution & SLA', icon: ShieldCheck },
    { id: 'team-analytics', label: 'Team Analytics', icon: LayoutGrid },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-bold flex items-center gap-2 text-gray-800"><BarChart3 size={20} /> Reports</h1>
        <select
          value={selectedSpace}
          onChange={e => setSelectedSpace(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"
        >
          <option value="">All Spaces</option>
          {spaces.map(s => <option key={s.id} value={s.key}>{s.name}</option>)}
        </select>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-8 flex-shrink-0">
        <div className="flex gap-1">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-[13px] border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 py-6">

        {/* Shared date range bar — shown on all tabs */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-gray-600">
            <Calendar size={15} className="text-gray-400" />
            Filter by Date Range
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              <X size={11} /> Clear
            </button>
          )}
          {(dateFrom || dateTo) && (
            <span className="text-[11.5px] text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full font-medium">
              {dateFrom && dateTo ? `${dateFrom} → ${dateTo}` : dateFrom ? `From ${dateFrom}` : `Until ${dateTo}`}
            </span>
          )}
        </div>

        {/* Velocity */}
        {tab === 'velocity' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-[15px] font-semibold text-gray-800 mb-0.5">Issue Trend{dateFrom || dateTo ? ' — Custom Range' : ' — Last 6 Months'}</h2>
            <p className="text-[12.5px] text-gray-400 mb-5">Issues created vs resolved per month</p>
            {!selectedSpace ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <TrendingUp size={36} className="text-gray-200 mb-3" />
                <p className="text-[14px] font-medium text-gray-400">Select a space to view issue trends</p>
              </div>
            ) : velocity.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <TrendingUp size={36} className="text-gray-200 mb-3" />
                <p className="text-[14px] font-medium text-gray-400">No issue data found for this selection</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={velocity} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="sprintName" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                  <Bar dataKey="committedPoints" name="Created" fill="#93C5FD" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="completedPoints" name="Resolved" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        )}

        {/* Burndown */}
        {tab === 'burndown' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-[15px] font-semibold text-gray-800 mb-0.5">Open Issues Trend{dateFrom || dateTo ? ' — Custom Range' : ' — Last 8 Weeks'}</h2>
            <p className="text-[12.5px] text-gray-400 mb-5">Open issues over time</p>
            {!selectedSpace ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Target size={36} className="text-gray-200 mb-3" />
                <p className="text-[14px] font-medium text-gray-400">Select a space to view open issue trend</p>
              </div>
            ) : burndown && burndown.dailyProgress?.length > 0 ? (
              <ResponsiveContainer width="100%" height={380}>
                <LineChart data={burndown.dailyProgress} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="week" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                  <Line type="monotone" dataKey="open" name="Open Issues" stroke="#3B82F6" strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Target size={36} className="text-gray-200 mb-3" />
                <p className="text-[14px] font-medium text-gray-400">No data found for this space</p>
              </div>
            )}
          </div>
        )}

        {/* User Performance */}
        {tab === 'performance' && (
          !canViewPerformance ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
              <Users size={40} className="mb-3 text-gray-300" />
              <p className="text-[15px] font-semibold text-gray-500">Access restricted</p>
              <p className="text-[13px] text-gray-400 mt-1">Only admins and managers can view user performance reports.</p>
            </div>
          ) : perfLoading ? (
            <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            </div>
          ) : performance.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
              <Users size={40} className="mb-3 text-gray-300" />
              <p className="text-[15px] font-semibold text-gray-500">No data yet</p>
              <p className="text-[13px] text-gray-400 mt-1">No users have assigned tickets{selectedSpace ? ' in this space' : ''}.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Bar Chart — Tickets per user */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-[14px] font-semibold text-gray-700">Tickets per User — Completed vs In Progress</h3>
                  <span className="text-[12px] text-gray-400">{performance.length} users</span>
                </div>
                <div className="overflow-x-auto">
                  <div style={{ minWidth: Math.max(600, performance.length * 64) }}>
                    <BarChart data={performance} width={Math.max(600, performance.length * 64)} height={340} margin={{ left: 40, right: 20, top: 5, bottom: 80 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                      <XAxis dataKey="name" angle={-40} textAnchor="end" tick={{ fontSize: 10 }} interval={0} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                      <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} />
                      <Bar dataKey="completed"     name="Completed"       fill="#10B981" radius={[4,4,0,0]} />
                      <Bar dataKey="inProgress"    name="In Progress"     fill="#3B82F6" radius={[4,4,0,0]} />
                      <Bar dataKey="totalAssigned" name="Total Assigned"  fill="#E5E7EB" radius={[4,4,0,0]} />
                    </BarChart>
                  </div>
                </div>
              </div>

              {/* Completion Rate */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-[14px] font-semibold text-gray-700 mb-5">Completion Rate % per User</h3>
                <div className="overflow-x-auto">
                  <div style={{ minWidth: Math.max(600, performance.length * 64) }}>
                    <BarChart data={performance} width={Math.max(600, performance.length * 64)} height={280} margin={{ left: 40, right: 20, top: 5, bottom: 80 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                      <XAxis dataKey="name" angle={-40} textAnchor="end" tick={{ fontSize: 10 }} interval={0} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                      <Bar dataKey="completionRate" name="Completion Rate" fill="#8B5CF6" radius={[4,4,0,0]} />
                    </BarChart>
                  </div>
                </div>
              </div>

              {/* Table */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h3 className="text-[14px] font-semibold text-gray-700">User Summary</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">User</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Total Assigned</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Completed</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">In Progress</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Avg Resolution</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Completion Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {performance.map(p => (
                        <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold flex-shrink-0">
                                {(p.name || '?').charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <p className="text-[13px] font-medium text-gray-800">{p.name}</p>
                                <p className="text-[11px] text-gray-400">{p.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-[13px] text-gray-700 font-medium">{p.totalAssigned}</td>
                          <td className="px-5 py-3.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11.5px] font-semibold bg-green-50 text-green-700">{p.completed}</span>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11.5px] font-semibold bg-blue-50 text-blue-700">{p.inProgress}</span>
                          </td>
                          <td className="px-5 py-3.5 text-[13px] text-gray-500">{p.avgResolutionHours > 0 ? `${p.avgResolutionHours}h` : '—'}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="flex-1 max-w-[100px] h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all"
                                  style={{ width: `${p.completionRate}%`, background: p.completionRate >= 70 ? '#10B981' : p.completionRate >= 40 ? '#F59E0B' : '#EF4444' }} />
                              </div>
                              <span className="text-[12px] font-medium text-gray-600 w-9 text-right">{p.completionRate}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        )}

        {/* Resolution % / SLA % / SLA Breach % */}
        {tab === 'resolution-sla' && (
          !canViewPerformance ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
              <ShieldCheck size={40} className="mb-3 text-gray-300" />
              <p className="text-[15px] font-semibold text-gray-500">Access restricted</p>
              <p className="text-[13px] text-gray-400 mt-1">Only admins and managers can view this report.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Filters */}
              <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] font-medium text-gray-500">Department</label>
                  <select value={rsDept} onChange={e => setRsDept(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">All (Migration + Dev)</option>
                    <option value="Migration">Migration</option>
                    <option value="Dev">Dev</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[12px] font-medium text-gray-500">Product Type</label>
                  <select value={rsProductType} onChange={e => setRsProductType(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">All (Content + Message + Email)</option>
                    <option value="Content Migration">Content</option>
                    <option value="Message Migration">Message</option>
                    <option value="Email Migration">Email</option>
                  </select>
                </div>
              </div>

              {rsLoading ? (
                <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-20">
                  <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                </div>
              ) : !rsData ? (
                <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
                  <ShieldCheck size={40} className="mb-3 text-gray-300" />
                  <p className="text-[15px] font-semibold text-gray-500">No data</p>
                </div>
              ) : (
                <>
                  {/* Overall — respects the filters above */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-white rounded-xl border border-gray-200 p-5">
                      <div className="flex items-center gap-2 mb-2 text-gray-500">
                        <CheckCircle2 size={16} className="text-blue-500" />
                        <span className="text-[12.5px] font-medium">Resolution %</span>
                      </div>
                      <p className="text-[26px] font-bold text-gray-900">{rsData.overall.resolutionPct}%</p>
                      <p className="text-[11.5px] text-gray-400 mt-1">{rsData.overall.totalResolved} resolved of {rsData.overall.totalAssigned} assigned</p>
                    </div>
                    <div className="bg-white rounded-xl border border-gray-200 p-5">
                      <div className="flex items-center gap-2 mb-2 text-gray-500">
                        <ShieldCheck size={16} className="text-emerald-500" />
                        <span className="text-[12.5px] font-medium">SLA %</span>
                      </div>
                      <p className="text-[26px] font-bold text-emerald-600">{rsData.overall.slaPct}%</p>
                      <p className="text-[11.5px] text-gray-400 mt-1">{rsData.overall.withinSla} within SLA of {rsData.overall.slaTracked} tracked</p>
                    </div>
                    <div className="bg-white rounded-xl border border-gray-200 p-5">
                      <div className="flex items-center gap-2 mb-2 text-gray-500">
                        <AlertTriangle size={16} className="text-red-500" />
                        <span className="text-[12.5px] font-medium">SLA Breach %</span>
                      </div>
                      <p className="text-[26px] font-bold text-red-600">{rsData.overall.breachPct}%</p>
                      <p className="text-[11.5px] text-gray-400 mt-1">{rsData.overall.breached} breached of {rsData.overall.slaTracked} tracked</p>
                    </div>
                  </div>

                  {rsData.overall.slaTracked < rsData.overall.totalResolved && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 flex items-start gap-3">
                      <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-[12.5px] text-amber-800 leading-relaxed">
                        <span className="font-semibold">SLA % / Breach % only cover {rsData.overall.slaTracked} of {rsData.overall.totalResolved} resolved tickets.</span>{' '}
                        The rest were resolved before this app started tracking exact resolution timestamps (mostly tickets migrated from the original Jira import) and have no reliable data to check against an SLA target, so they're left out rather than guessed at. Resolution % above is unaffected — it only needs assigned vs. resolved, not timing. This tracked count will grow as more tickets are resolved going forward.
                      </p>
                    </div>
                  )}

                  {/* Weekly trend — Content/Message/Email × week-within-range, matching
                      the reference "L2 Board" style grouped bar charts. Weeks are anchored
                      to the date-range filter above (or the last 3 weeks if none is set). */}
                  {rsData.weekly && rsData.weekly.weekLabels?.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      <div className="bg-white rounded-xl border border-gray-200 p-6">
                        <h3 className="text-[14px] font-semibold text-gray-700 text-center mb-0.5">SLA Breach %</h3>
                        <p className="text-[11px] text-gray-400 text-center mb-4">
                          {rsData.weekly.weekRanges.map((r: any, i: number) => `${rsData.weekly.weekLabels[i]}: ${fmtWeekDate(r.from)}–${fmtWeekDate(r.to)}`).join('   ·   ')}
                        </p>
                        <ResponsiveContainer width="100%" height={320}>
                          <BarChart data={buildWeeklyChartData(rsData.weekly, 'breachPct')} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                            <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                            <YAxis unit="%" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                            <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                            {rsData.weekly.weekLabels.map((label: string, i: number) => (
                              <Bar key={label} dataKey={label} name={label} fill={WEEK_COLORS[i % WEEK_COLORS.length]} radius={[3, 3, 0, 0]}>
                              </Bar>
                            ))}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-6">
                        <h3 className="text-[14px] font-semibold text-gray-700 text-center mb-0.5">Resolution %</h3>
                        <p className="text-[11px] text-gray-400 text-center mb-4">
                          {rsData.weekly.weekRanges.map((r: any, i: number) => `${rsData.weekly.weekLabels[i]}: ${fmtWeekDate(r.from)}–${fmtWeekDate(r.to)}`).join('   ·   ')}
                        </p>
                        <ResponsiveContainer width="100%" height={320}>
                          <BarChart data={buildWeeklyChartData(rsData.weekly, 'resolutionPct')} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                            <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                            <YAxis unit="%" domain={[0, 110]} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                            <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12 }} />
                            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                            {rsData.weekly.weekLabels.map((label: string, i: number) => (
                              <Bar key={label} dataKey={label} name={label} fill={WEEK_COLORS[i % WEEK_COLORS.length]} radius={[3, 3, 0, 0]}>
                              </Bar>
                            ))}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* By Department — Migration vs Dev overall, regardless of Product Type
                      (Dev tickets essentially never have a Content/Message/Email
                      categorization, so this is the only place its real totals show up). */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-100">
                      <h3 className="text-[14px] font-semibold text-gray-700">By Department</h3>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">Migration vs. Dev, overall — includes every ticket regardless of Product Type.</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12.5px]">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Department</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assigned</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolved</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolution %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">SLA %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Breach %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {['Migration', 'Dev'].map(dept => {
                            const d = rsData.byDept?.[dept];
                            return (
                              <tr key={dept} className="hover:bg-gray-50">
                                <td className="px-4 py-2.5 font-medium text-gray-700">{dept}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{d?.totalAssigned ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{d?.totalResolved ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{d?.resolutionPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 font-medium">{d?.slaPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-red-600 font-medium">{d?.breachPct ?? 0}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* By Product Type — Content/Message/Email combined across both depts
                      (in practice, almost entirely Migration, since Dev doesn't use this field) */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-100">
                      <h3 className="text-[14px] font-semibold text-gray-700">By Product Type</h3>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">Content vs. Message vs. Email, combined across departments.</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12.5px]">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Product Type</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assigned</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolved</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolution %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">SLA %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Breach %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {['Content Migration', 'Message Migration', 'Email Migration'].map(pt => {
                            const p = rsData.byProductType?.[pt];
                            return (
                              <tr key={pt} className="hover:bg-gray-50">
                                <td className="px-4 py-2.5 font-medium text-gray-700">{pt.replace(' Migration', '')}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{p?.totalAssigned ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{p?.totalResolved ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{p?.resolutionPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 font-medium">{p?.slaPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-red-600 font-medium">{p?.breachPct ?? 0}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Breakdown matrix — always every Dept × Product Type combo, regardless of filters */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-100">
                      <h3 className="text-[14px] font-semibold text-gray-700">Breakdown — Department × Product Type</h3>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">Always shows every combination, regardless of the filters above. Dev rows will show 0 here — that field isn't used for Dev tickets; see "By Department" above for its real totals.</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12.5px]">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Department</th>
                            <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Product Type</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assigned</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolved</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolution %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">SLA %</th>
                            <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Breach %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {['Migration', 'Dev'].flatMap(dept => ['Content Migration', 'Message Migration', 'Email Migration'].map(pt => {
                            const combo = rsData.byDeptProductType?.[`${dept}::${pt}`];
                            return (
                              <tr key={`${dept}::${pt}`} className="hover:bg-gray-50">
                                <td className="px-4 py-2.5 font-medium text-gray-700">{dept}</td>
                                <td className="px-4 py-2.5 text-gray-600">{pt.replace(' Migration', '')}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{combo?.totalAssigned ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{combo?.totalResolved ?? 0}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{combo?.resolutionPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 font-medium">{combo?.slaPct ?? 0}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-red-600 font-medium">{combo?.breachPct ?? 0}%</td>
                              </tr>
                            );
                          }))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Per-user — respects the Department / Product Type filters above */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-100">
                      <h3 className="text-[14px] font-semibold text-gray-700">Per User</h3>
                      <p className="text-[11.5px] text-gray-400 mt-0.5">Scoped to the Department / Product Type filters above.</p>
                    </div>
                    {(!rsData.perUser || rsData.perUser.length === 0) ? (
                      <p className="text-[12.5px] text-gray-400 py-8 text-center">No assigned tickets in this scope.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12.5px]">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">User</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assigned</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolved</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolution %</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">SLA %</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Breach %</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {rsData.perUser.map((u: any) => (
                              <tr key={u.id} className="hover:bg-gray-50">
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center gap-2.5">
                                    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold flex-shrink-0">
                                      {(u.name || '?').charAt(0).toUpperCase()}
                                    </div>
                                    <div>
                                      <p className="text-[13px] font-medium text-gray-800">{u.name}</p>
                                      <p className="text-[11px] text-gray-400">{u.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{u.totalAssigned}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{u.totalResolved}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{u.resolutionPct}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 font-medium">{u.slaPct}%</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-red-600 font-medium">{u.breachPct}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        )}

        {/* Team Analytics */}
        {tab === 'team-analytics' && (
          !canViewPerformance ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
              <LayoutGrid size={40} className="mb-3 text-gray-300" />
              <p className="text-[15px] font-semibold text-gray-500">Access restricted</p>
              <p className="text-[13px] text-gray-400 mt-1">Only admins and managers can view team analytics.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Sub-tabs */}
              <div className="flex gap-2">
                {[
                  { id: 'overview', label: 'Overview', icon: LayoutGrid },
                  { id: 'aging', label: 'Aging Tickets', icon: Clock },
                  { id: 'time-spent', label: 'Time Spent', icon: Timer },
                ].map(st => (
                  <button key={st.id} onClick={() => setTaSubTab(st.id as any)}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${taSubTab === st.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    <st.icon size={13} /> {st.label}
                  </button>
                ))}
              </div>

              {/* Filters */}
              <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-wrap items-start gap-5">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] font-medium text-gray-500">Date field</label>
                  <select value={taDateType} onChange={e => setTaDateType(e.target.value as any)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="created">Created date</option>
                    <option value="updated">Updated date</option>
                    <option value="none">None (open tickets only)</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[240px]">
                  <label className="text-[12px] font-medium text-gray-500 block mb-1.5">Department (all selected = all departments)</label>
                  <div className="flex flex-wrap gap-1.5">
                    {taFilterOptions.depts.map(d => {
                      const active = taDepts.includes(d);
                      return (
                        <button key={d} onClick={() => setTaDepts(active ? taDepts.filter(x => x !== d) : [...taDepts, d])}
                          className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-colors ${active ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                          {d}
                        </button>
                      );
                    })}
                    {taDepts.length > 0 && (
                      <button onClick={() => setTaDepts([])} className="px-2.5 py-1 rounded-full text-[11.5px] font-medium text-red-500 border border-red-200 hover:bg-red-50">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {taLoading ? (
                <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-20">
                  <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                </div>
              ) : taSubTab === 'overview' ? (
                !taOverview ? (
                  <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
                    <LayoutGrid size={40} className="mb-3 text-gray-300" />
                    <p className="text-[15px] font-semibold text-gray-500">No data</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="bg-white rounded-xl border border-gray-200 p-5">
                        <p className="text-[12.5px] font-medium text-gray-500 mb-2">Total Tickets</p>
                        <p className="text-[26px] font-bold text-gray-900">{taOverview.totalTickets}</p>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-5">
                        <p className="text-[12.5px] font-medium text-gray-500 mb-2">Resolved</p>
                        <p className="text-[26px] font-bold text-emerald-600">{taOverview.resolvedCount}</p>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-5">
                        <p className="text-[12.5px] font-medium text-gray-500 mb-2">Open</p>
                        <p className="text-[26px] font-bold text-blue-600">{taOverview.openCount}</p>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-5">
                        <p className="text-[12.5px] font-medium text-gray-500 mb-2">SLA Breach %</p>
                        <p className="text-[26px] font-bold text-red-600">{taOverview.slaBreachPct ?? '—'}{taOverview.slaBreachPct !== null ? '%' : ''}</p>
                        <p className="text-[11px] text-gray-400 mt-1">of {taOverview.slaTrackedCount} tracked</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                      <div className="bg-white rounded-xl border border-gray-200 p-6">
                        <h3 className="text-[14px] font-semibold text-gray-700 mb-4">By Status</h3>
                        <div className="space-y-2">
                          {taOverview.byStatus.slice(0, 8).map((s: any) => (
                            <div key={s.name} className="flex items-center justify-between text-[12.5px]">
                              <span className="text-gray-600 truncate pr-2">{s.name}</span>
                              <span className="font-semibold text-gray-800 tabular-nums">{s.count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-6">
                        <h3 className="text-[14px] font-semibold text-gray-700 mb-4">By Priority</h3>
                        <div className="space-y-2">
                          {taOverview.byPriority.map((s: any) => (
                            <div key={s.name} className="flex items-center justify-between text-[12.5px]">
                              <span className="text-gray-600 capitalize truncate pr-2">{s.name}</span>
                              <span className="font-semibold text-gray-800 tabular-nums">{s.count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="bg-white rounded-xl border border-gray-200 p-6">
                        <h3 className="text-[14px] font-semibold text-gray-700 mb-4">By Department</h3>
                        <div className="space-y-2">
                          {taOverview.byDept.map((s: any) => (
                            <div key={s.name} className="flex items-center justify-between text-[12.5px]">
                              <span className="text-gray-600 truncate pr-2">{s.name}</span>
                              <span className="font-semibold text-gray-800 tabular-nums">{s.count}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-100">
                        <h3 className="text-[14px] font-semibold text-gray-700">Member Performance</h3>
                        <p className="text-[11.5px] text-gray-400 mt-0.5">Scoped to the filters above.</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12.5px]">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-5 py-3 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Member</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Tickets</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Resolved</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Avg Resolution</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">SLA Breach %</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {taOverview.memberPerformance.map((m: any) => (
                              <tr key={m.id} className="hover:bg-gray-50">
                                <td className="px-5 py-3">
                                  <div className="flex items-center gap-2.5">
                                    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold flex-shrink-0">
                                      {(m.name || '?').charAt(0).toUpperCase()}
                                    </div>
                                    <div>
                                      <p className="text-[13px] font-medium text-gray-800">{m.name}</p>
                                      <p className="text-[11px] text-gray-400">{m.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-5 py-3 text-right tabular-nums">{m.ticketCount}</td>
                                <td className="px-5 py-3 text-right tabular-nums">{m.resolvedCount}</td>
                                <td className="px-5 py-3 text-right tabular-nums text-gray-500">{m.avgResolutionHrs !== null ? `${m.avgResolutionHrs}h` : '—'}</td>
                                <td className="px-5 py-3 text-right tabular-nums font-medium text-red-600">{m.slaBreachPct !== null ? `${m.slaBreachPct}%` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )
              ) : taSubTab === 'aging' ? (
                !taAging ? (
                  <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
                    <Clock size={40} className="mb-3 text-gray-300" />
                    <p className="text-[15px] font-semibold text-gray-500">No data</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {taAging.buckets.map((b: any) => (
                        <div key={b.key} className="bg-white rounded-xl border border-gray-200 p-5">
                          <p className="text-[12.5px] font-medium text-gray-500 mb-2">{b.label}</p>
                          <p className="text-[26px] font-bold text-gray-900">{b.count}</p>
                        </div>
                      ))}
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-100">
                        <h3 className="text-[14px] font-semibold text-gray-700">By Member</h3>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12.5px]">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-5 py-3 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Member</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">&le; 1 day</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">2-5 days</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">&gt; 5 days</th>
                              <th className="px-5 py-3 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Total Open</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {taAging.byMember.map((m: any) => (
                              <tr key={m.id} className="hover:bg-gray-50">
                                <td className="px-5 py-3 font-medium text-gray-700">{m.name}</td>
                                <td className="px-5 py-3 text-right tabular-nums">{m.le1}</td>
                                <td className="px-5 py-3 text-right tabular-nums">{m.d2to5}</td>
                                <td className="px-5 py-3 text-right tabular-nums text-red-600 font-medium">{m.gt5}</td>
                                <td className="px-5 py-3 text-right tabular-nums font-semibold">{m.total}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-100">
                        <h3 className="text-[14px] font-semibold text-gray-700">Open Tickets — Oldest First</h3>
                      </div>
                      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                        <table className="w-full text-[12.5px]">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Key</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Summary</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Status</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assignee</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Department</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Age (days)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {taAging.tickets.slice(0, 200).map((t: any) => (
                              <tr key={t.id} className="hover:bg-gray-50">
                                <td className="px-4 py-2 font-medium text-blue-600">{t.cfKey || t.key}</td>
                                <td className="px-4 py-2 text-gray-700 max-w-[320px] truncate">{t.summary}</td>
                                <td className="px-4 py-2 text-gray-500">{t.status || '—'}</td>
                                <td className="px-4 py-2 text-gray-500">{t.assignee || '—'}</td>
                                <td className="px-4 py-2 text-gray-500">{t.department}</td>
                                <td className="px-4 py-2 text-right tabular-nums font-medium">{t.ageDays}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {taAging.tickets.length > 200 && (
                        <p className="px-6 py-3 text-[11.5px] text-gray-400 border-t border-gray-100">Showing oldest 200 of {taAging.tickets.length} open tickets.</p>
                      )}
                    </div>
                  </div>
                )
              ) : (
                !taTimeSpent ? (
                  <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-20 text-center">
                    <Timer size={40} className="mb-3 text-gray-300" />
                    <p className="text-[15px] font-semibold text-gray-500">No data</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 flex items-start gap-3">
                      <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-[12.5px] text-amber-800 leading-relaxed">
                        <span className="font-semibold">Hours spent = time actually in an "In Progress" status only</span> — time the ticket sat in To Do, Waiting for X, Pending with X, etc. is excluded, since that's time waiting on someone else, not work being done. Assignee / Department / Product Type reflect the ticket's current values, not a per-segment breakdown — a ticket that changed hands or departments shows its full In-Progress total attributed to where it stands now.{' '}
                        Rows marked <span className="font-semibold">No history</span> have zero logged status changes (mostly older Jira-migrated tickets) — their full age since creation is counted, since there's no record of exactly when they entered their current status.
                      </p>
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 px-5 py-3.5 flex items-center gap-2">
                      <Search size={15} className="text-gray-400 flex-shrink-0" />
                      <input type="text" value={taTimeSpentSearch} onChange={e => setTaTimeSpentSearch(e.target.value)}
                        placeholder="Filter by key, summary, or assignee…"
                        className="flex-1 text-[12.5px] text-gray-700 focus:outline-none" />
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                        <div>
                          <h3 className="text-[14px] font-semibold text-gray-700">Time Spent — Highest First</h3>
                          <p className="text-[11.5px] text-gray-400 mt-0.5">Scoped to the filters above.</p>
                        </div>
                        <span className="text-[12px] text-gray-400">{taTimeSpent.totalMatched} of {taTimeSpent.totalTickets} tickets in scope</span>
                      </div>
                      <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                        <table className="w-full text-[12.5px]">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Key</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Summary</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Assignee</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Department</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Product Type</th>
                              <th className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Status</th>
                              <th className="px-4 py-2.5 text-right font-semibold text-gray-500 uppercase text-[11px] tracking-wide">Hours Spent</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {taTimeSpent.tickets
                              .slice(0, 300)
                              .map((t: any) => (
                                <tr key={t.id} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 font-medium text-blue-600">{t.cfKey || t.key}</td>
                                  <td className="px-4 py-2 text-gray-700 max-w-[280px] truncate">{t.summary}</td>
                                  <td className="px-4 py-2 text-gray-500">{t.assignee}</td>
                                  <td className="px-4 py-2 text-gray-500">{t.department}</td>
                                  <td className="px-4 py-2 text-gray-500">{t.productType || '—'}</td>
                                  <td className="px-4 py-2 text-gray-500">{t.status || '—'}</td>
                                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-800">
                                    {t.inProgressHrs}h
                                    {t.noHistory && <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 align-middle">No history</span>}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="px-6 py-3 text-[11.5px] text-gray-400 border-t border-gray-100">
                        Showing top {Math.min(300, taTimeSpent.tickets.length)} of {taTimeSpent.totalMatched}{taTimeSpentSearch ? ' matching the search' : ' in scope'}, sorted by hours spent{taTimeSpent.truncated ? ` (server-capped at ${taTimeSpent.cap})` : ''}.
                      </p>
                    </div>
                  </div>
                )
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
