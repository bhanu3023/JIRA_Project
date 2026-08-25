'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { BarChart3, TrendingUp, Users, Target, Calendar, X } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LineChart, Line } from 'recharts';

export default function ReportsPage() {
  const { spaces, user } = useStore((s) => ({ spaces: s.spaces, user: s.user }));
  const canViewPerformance = user?.role === 'admin' || user?.role === 'manager';
  const [tab, setTab] = useState('velocity');
  const [selectedSpace, setSelectedSpace] = useState('');
  const [velocity, setVelocity] = useState<any[]>([]);
  const [burndown, setBurndown] = useState<any>(null);
  const [performance, setPerformance] = useState<any[]>([]);
  const [perfLoading, setPerfLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    if (!canViewPerformance) return;
    setPerfLoading(true);
    api.getUserPerformance(selectedSpace || undefined, dateFrom || undefined, dateTo || undefined)
      .then((d: any) => setPerformance(Array.isArray(d) ? d : []))
      .catch(() => setPerformance([]))
      .finally(() => setPerfLoading(false));
  }, [canViewPerformance, selectedSpace, dateFrom, dateTo]);

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
                                <p data-hj-suppress className="text-[11px] text-gray-400">{p.email}</p>
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
      </div>
    </div>
  );
}
