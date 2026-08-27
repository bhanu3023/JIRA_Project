'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { BarChart2, Calendar, X, Users, AlertTriangle, Clock, UserX, ChevronUp, ChevronDown } from 'lucide-react';

const PRIVILEGED_ROLES = ['admin'];

type DeptRow = { dept: string; open: number; unassigned: number; old30: number; overdue: number; slaBreached: number };
type PersonRow = {
  dept: string; assigneeId: string; name: string; email: string;
  openCount: number; stale: number; missing: number; overdue: number;
  closed: number; noClosure: number; screenshots: number; screenshotPct: number | null;
  hygieneScore: number; grade: 'great' | 'ok' | 'poor';
};

const GRADE_STYLE: Record<string, string> = {
  great: 'bg-green-50 text-green-700',
  ok:    'bg-amber-50 text-amber-700',
  poor:  'bg-red-50 text-red-700',
};
const GRADE_LABEL: Record<string, string> = { great: 'Great', ok: 'Needs attention', poor: 'Poor' };

function Card({ label, value, tone, icon }: { label: string; value: number; tone?: 'warn' | 'bad'; icon: React.ReactNode }) {
  const valueColor = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-800';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start justify-between">
      <div>
        <p className={`text-[24px] font-bold ${valueColor}`}>{value}</p>
        <p className="text-[12px] text-gray-500 mt-0.5">{label}</p>
      </div>
      <div className="text-gray-300">{icon}</div>
    </div>
  );
}

export default function MbrPage() {
  const user = useStore((s) => s.user);
  const router = useRouter();
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');

  const [allDepartments, setAllDepartments] = useState<string[]>([]);
  const [department, setDepartment] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [staleDays, setStaleDays] = useState(7);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<keyof PersonRow>('hygieneScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Redirect non-admins away
  useEffect(() => {
    if (user && !isPrivileged) router.replace('/dashboard');
  }, [user, isPrivileged, router]);

  // Fetch the full department list once, unfiltered, to populate the selector
  useEffect(() => {
    if (!isPrivileged) return;
    api.getMbrData().then((d) => setAllDepartments(d.departments.map((r) => r.dept))).catch(() => {});
  }, [isPrivileged]);

  useEffect(() => {
    if (!isPrivileged) return;
    setLoading(true);
    api.getMbrData(department || undefined, dateFrom || undefined, dateTo || undefined, staleDays)
      .then((d) => { setDepartments(d.departments); setPeople(d.people); })
      .catch(() => { setDepartments([]); setPeople([]); })
      .finally(() => setLoading(false));
  }, [isPrivileged, department, dateFrom, dateTo, staleDays]);

  const toggleSort = useCallback((key: keyof PersonRow) => {
    setSortKey((prevKey) => {
      if (prevKey === key) { setSortDir((d) => (d === 'desc' ? 'asc' : 'desc')); return prevKey; }
      setSortDir('desc');
      return key;
    });
  }, []);

  if (!user || !isPrivileged) return null;

  const totals = departments.reduce(
    (acc, d) => ({
      open: acc.open + d.open,
      unassigned: acc.unassigned + d.unassigned,
      old30: acc.old30 + d.old30,
      overdue: acc.overdue + d.overdue,
      slaBreached: acc.slaBreached + d.slaBreached,
    }),
    { open: 0, unassigned: 0, old30: 0, overdue: 0, slaBreached: 0 },
  );

  const sortedPeople = [...people].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const SortTh = ({ label, k }: { label: string; k: keyof PersonRow }) => (
    <th
      onClick={() => toggleSort(k)}
      className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700"
    >
      <span className="flex items-center gap-1">
        {label}
        {sortKey === k && (sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  );

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-bold flex items-center gap-2 text-gray-800"><BarChart2 size={20} /> MBR</h1>
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
        >
          <option value="">All Departments</option>
          {allDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {/* Shared date range + stale threshold bar */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-gray-600">
            <Calendar size={15} className="text-gray-400" />
            Filter by Date Range
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">Stale threshold</label>
            <select value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
            </select>
          </div>
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* KPI cards — Section 1 (backlog) + Section 2 (SLA) */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card label="Total open" value={totals.open} icon={<Users size={22} />} />
              <Card label="Unassigned" value={totals.unassigned} icon={<UserX size={22} />} tone={totals.open > 0 && totals.unassigned / totals.open > 0.3 ? 'warn' : undefined} />
              <Card label="Old (> 30 days)" value={totals.old30} icon={<Clock size={22} />} tone="warn" />
              <Card label="Overdue" value={totals.overdue} icon={<AlertTriangle size={22} />} tone="bad" />
              <Card label="SLA breached" value={totals.slaBreached} icon={<AlertTriangle size={22} />} tone="bad" />
            </div>

            {/* By-department breakdown — only meaningful in the "All Departments" view */}
            {!department && departments.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h3 className="text-[14px] font-semibold text-gray-700">By department</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Department</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Open</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Unassigned</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Old (&gt;30d)</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Overdue</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">SLA breached</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {departments.map((d) => (
                        <tr key={d.dept} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setDepartment(d.dept)}>
                          <td className="px-5 py-3 text-[13px] font-medium text-gray-800">{d.dept}</td>
                          <td className="px-5 py-3 text-[13px] text-gray-700">{d.open}</td>
                          <td className="px-5 py-3 text-[13px] text-gray-700">{d.unassigned}</td>
                          <td className="px-5 py-3 text-[13px] text-amber-600">{d.old30}</td>
                          <td className="px-5 py-3 text-[13px] text-red-600">{d.overdue}</td>
                          <td className="px-5 py-3 text-[13px] text-red-600">{d.slaBreached}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Per-person hygiene — Section 5 */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="text-[14px] font-semibold text-gray-700">Per-person hygiene</h3>
                <p className="text-[12px] text-gray-400 mt-0.5">
                  Score starts at 100 and is docked for stale open tickets, missing priority/labels/due date, overdue tickets,
                  tickets resolved without a proper closed status, and closed tickets with no image attachment.
                </p>
              </div>
              {sortedPeople.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Users size={36} className="text-gray-200 mb-3" />
                  <p className="text-[14px] font-medium text-gray-400">No tracked tickets for this selection</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <SortTh label="Assignee" k="name" />
                        {!department && <SortTh label="Department" k="dept" />}
                        <SortTh label="Open" k="openCount" />
                        <SortTh label="Stale" k="stale" />
                        <SortTh label="Missing details" k="missing" />
                        <SortTh label="Overdue" k="overdue" />
                        <SortTh label="Closed" k="closed" />
                        <SortTh label="Resolved w/o closure" k="noClosure" />
                        <SortTh label="Screenshot %" k="screenshotPct" />
                        <SortTh label="Hygiene score" k="hygieneScore" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedPeople.map((p) => (
                        <tr key={`${p.dept}-${p.assigneeId}`} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3">
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
                          {!department && <td className="px-4 py-3 text-[12.5px] text-gray-500">{p.dept}</td>}
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.openCount}</td>
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.stale}</td>
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.missing}</td>
                          <td className="px-4 py-3 text-[13px] text-red-600">{p.overdue}</td>
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.closed}</td>
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.noClosure}</td>
                          <td className="px-4 py-3 text-[13px] text-gray-700">{p.screenshotPct === null ? '—' : `${p.screenshotPct}%`}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-semibold ${GRADE_STYLE[p.grade]}`}>
                              {p.hygieneScore} · {GRADE_LABEL[p.grade]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
