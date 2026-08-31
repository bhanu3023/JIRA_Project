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

function Card({ label, value, tone, icon, sub }: { label: string; value: React.ReactNode; tone?: 'warn' | 'bad'; icon: React.ReactNode; sub?: string }) {
  const valueColor = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-800';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start justify-between">
      <div>
        <p className={`text-[24px] font-bold ${valueColor}`}>{value}</p>
        <p className="text-[12px] text-gray-500 mt-0.5">{label}</p>
        {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
      <div className="text-gray-300">{icon}</div>
    </div>
  );
}

const TOP_TABS = [
  { id: 'department', label: 'By Department' },
  { id: 'eng', label: 'Customer Engineering' },
  { id: 'qa', label: 'QA' },
  { id: 'infra', label: 'Infra' },
] as const;
type TopTab = (typeof TOP_TABS)[number]['id'];

function pct(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : '—';
}

// Customer Engineering / QA / Infra — backed by a static export (mbr-static-tickets.json,
// 2,257 rows from "All Tickets.xlsx", 2026-06-01 to 2026-07-30 only), not a live fetch.
// No hygiene score / RCA / screenshot checks here — that data isn't in this export.
function StaticTeamTab({ team, dateFrom, dateTo }: { team: 'eng' | 'qa' | 'infra'; dateFrom: string; dateTo: string }) {
  const [person, setPerson] = useState('');
  const [people, setPeople] = useState<any[]>([]);
  const [monthly, setMonthly] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({ total: 0, resolved: 0, rbBreached: 0, rbTracked: 0, frbBreached: 0, frbTracked: 0 });
  const [tickets, setTickets] = useState<any[]>([]);
  const [totalMatched, setTotalMatched] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getMbrStaticData(team, dateFrom || undefined, dateTo || undefined, person || undefined)
      .then((d) => { setPeople(d.people); setMonthly(d.monthly); setSummary(d.summary); setTickets(d.tickets); setTotalMatched(d.totalMatched); })
      .catch(() => { setPeople([]); setMonthly([]); setTickets([]); })
      .finally(() => setLoading(false));
  }, [team, dateFrom, dateTo, person]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-[12px] text-gray-400 -mt-2">
        From All Tickets.xlsx (covers 2026-06-01 to 2026-07-30 only) — no hygiene score, RCA, closing-comment, or screenshot checks (this export doesn't carry that data).
      </p>

      <div className="flex items-center gap-3">
        <label className="text-[12px] text-gray-500 font-medium">Person</label>
        <select value={person} onChange={(e) => setPerson(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[220px]">
          <option value="">All ({people.reduce((s, p) => s + p.total, 0)} tickets)</option>
          {people.map((p) => <option key={p.email} value={p.email}>{p.name} ({p.total})</option>)}
        </select>
      </div>

      {/* Summary — Section 4.12 "Summary" (4 cards, for selected person or whole team) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Total tickets" value={summary.total} icon={<Users size={22} />} />
        <Card label="Resolved tickets" value={summary.resolved} sub={pct(summary.resolved, summary.total)} icon={<Users size={22} />}
          tone={summary.total > 0 && summary.resolved / summary.total < 0.7 ? 'warn' : undefined} />
        <Card label="Resolution SLA breached" value={`${summary.rbBreached} / ${summary.rbTracked}`} icon={<AlertTriangle size={22} />} tone={summary.rbBreached > 0 ? 'bad' : undefined} />
        <Card label="First response SLA breached" value={`${summary.frbBreached} / ${summary.frbTracked}`} icon={<AlertTriangle size={22} />} tone={summary.frbBreached > 0 ? 'bad' : undefined} />
      </div>

      {/* Monthly summary — Section 4.12, team-wide regardless of person filter */}
      {monthly.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-[14px] font-semibold text-gray-700">Monthly summary</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Month</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Total tickets</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Resolved tickets</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Resolution SLA breached</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Breach rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {monthly.map((m) => (
                  <tr key={m.label} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3 text-[13px] font-medium text-gray-800">{m.label}</td>
                    <td className="px-5 py-3 text-[13px] text-gray-700">{m.total}</td>
                    <td className="px-5 py-3 text-[13px] text-gray-700">{m.resolved} <span className="text-gray-400">({pct(m.resolved, m.total)})</span></td>
                    <td className={`px-5 py-3 text-[13px] ${m.rbBreached > 0 ? 'text-red-600' : 'text-gray-700'}`}>{m.rbBreached} / {m.rbTracked}</td>
                    <td className="px-5 py-3 text-[13px] text-gray-700">{pct(m.rbBreached, m.rbTracked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Per-person SLA summary — Section 4.12 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-[14px] font-semibold text-gray-700">Per-person SLA summary</h3>
        </div>
        {people.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Users size={36} className="text-gray-200 mb-3" />
            <p className="text-[14px] font-medium text-gray-400">No tracked tickets for this selection</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Total tickets</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Resolved tickets</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Resolution SLA breached</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Avg. resolution (hrs)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {people.map((p) => (
                  <tr key={p.email} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setPerson(p.email)}>
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
                    <td className="px-4 py-3 text-[13px] text-gray-700">{p.total}</td>
                    <td className="px-4 py-3 text-[13px] text-gray-700">{p.resolved} <span className="text-gray-400">({pct(p.resolved, p.total)})</span></td>
                    <td className={`px-4 py-3 text-[13px] ${p.rbBreached > 0 ? 'text-red-600' : 'text-gray-700'}`}>{p.rbBreached} / {p.rbTracked}</td>
                    <td className="px-4 py-3 text-[13px] text-gray-700">{p.avgResolutionHours === null ? '—' : p.avgResolutionHours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ticket table — Section 4.12 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-gray-700">Tickets</h3>
          <span className="text-[12px] text-gray-400">Showing {tickets.length} of {totalMatched}{totalMatched > tickets.length ? ' (capped)' : ''}</span>
        </div>
        {tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Users size={36} className="text-gray-200 mb-3" />
            <p className="text-[14px] font-medium text-gray-400">No tickets in this range</p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-[13px] whitespace-nowrap">
              <thead>
                <tr>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Ticket</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Board</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Assignee</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Reporter</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Status</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Summary</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Created</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Updated</th>
                  <th className="sticky top-0 z-[2] text-left px-3 py-2 bg-gray-50 font-semibold text-gray-500 uppercase text-[11px] tracking-wide border-b border-gray-200">Resolution SLA breached</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.key} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 border-b border-gray-100 font-semibold text-blue-600">{t.key}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-500">{t.project}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-600">{t.assignee}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-600">{t.reporter}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-600">{t.status}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-800 max-w-[360px] truncate">{t.summary}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-500">{new Date(t.created).toLocaleDateString()}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100 text-gray-500">{new Date(t.updated).toLocaleDateString()}</td>
                    <td className="px-3 py-1.5 border-b border-gray-100">
                      {t.rb === true && <span className="font-semibold text-red-600">Yes</span>}
                      {t.rb === false && <span className="font-medium text-green-600">No</span>}
                      {t.rb === null && <span className="text-gray-400">N/A</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MbrPage() {
  const user = useStore((s) => s.user);
  const router = useRouter();
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');

  const [topTab, setTopTab] = useState<TopTab>('department');
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
    if (!isPrivileged || topTab !== 'department') return;
    setLoading(true);
    api.getMbrData(department || undefined, dateFrom || undefined, dateTo || undefined, staleDays)
      .then((d) => { setDepartments(d.departments); setPeople(d.people); })
      .catch(() => { setDepartments([]); setPeople([]); })
      .finally(() => setLoading(false));
  }, [isPrivileged, topTab, department, dateFrom, dateTo, staleDays]);

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
        {topTab === 'department' && (
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
          >
            <option value="">All Departments</option>
            {allDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>

      {/* Top-level tabs */}
      <div className="bg-white border-b border-gray-200 px-8 flex-shrink-0">
        <div className="flex gap-1">
          {TOP_TABS.map((t) => (
            <button key={t.id} onClick={() => setTopTab(t.id)}
              className={`px-4 py-3 text-[13px] border-b-2 transition-colors ${topTab === t.id ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {/* Shared date range bar */}
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
          {topTab === 'department' && (
            <div className="flex items-center gap-2">
              <label className="text-[12px] text-gray-400 font-medium">Stale threshold</label>
              <select value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
              </select>
            </div>
          )}
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {topTab !== 'department' ? (
          <StaticTeamTab team={topTab} dateFrom={dateFrom} dateTo={dateTo} />
        ) : loading ? (
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
