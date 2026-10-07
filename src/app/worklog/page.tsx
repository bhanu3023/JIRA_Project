'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { Clock, Calendar, X, Search } from 'lucide-react';

type WorklogRow = {
  id: string;
  department: string;
  timeSpentMinutes: number;
  description: string | null;
  workDate: string;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
  issueKey: string;
  issueSummary: string;
  spaceKey: string;
  spaceName: string;
};

function formatMinutes(m: number) {
  const h = Math.floor(m / 60), rem = m % 60;
  return h && rem ? `${h}h ${rem}m` : h ? `${h}h` : `${rem}m`;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function WorklogPage() {
  const { spaces, user } = useStore((s) => ({ spaces: s.spaces, user: s.user }));

  // Default to the last 30 days -- the full unfiltered history across every
  // ticket is rarely what anyone wants on first load, same reasoning as the
  // Reports page's own date filters.
  const [dateFrom, setDateFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [dateTo, setDateTo] = useState(() => isoDate(new Date()));
  const [spaceKeyFilter, setSpaceKeyFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [search, setSearch] = useState('');

  const [users, setUsers] = useState<{ id: string; firstName?: string; lastName?: string; email?: string }[]>([]);
  useEffect(() => { api.getUsers().then(setUsers).catch(() => {}); }, []);

  const [rows, setRows] = useState<WorklogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getAllWorklogs({
      from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
      to: dateTo ? `${dateTo}T23:59:59` : undefined,
      spaceKey: spaceKeyFilter || undefined,
      userId: userFilter || undefined,
    })
      .then((data: any) => setRows(Array.isArray(data) ? data : []))
      .catch((e: any) => setError(e?.message || 'Failed to load worklog entries.'))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, spaceKeyFilter, userFilter]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.issueKey.toLowerCase().includes(q) ||
      (r.issueSummary || '').toLowerCase().includes(q) ||
      (r.authorName || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totalMinutes = useMemo(() => filteredRows.reduce((sum, r) => sum + (r.timeSpentMinutes || 0), 0), [filteredRows]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-4 flex-shrink-0">
        <h1 className="text-xl font-bold flex items-center gap-2 text-gray-800"><Clock size={20} /> Worklog</h1>
        <p className="text-[12.5px] text-gray-500 mt-0.5">Time logged against tickets, same as Jira's own Logged Work view.</p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {/* Filters */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-gray-600">
            <Calendar size={15} className="text-gray-400" />
            Date Range
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
            <label className="text-[12px] text-gray-400 font-medium">Space</label>
            <select value={spaceKeyFilter} onChange={(e) => setSpaceKeyFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All spaces</option>
              {spaces.map((sp: any) => <option key={sp.key} value={sp.key}>{sp.name || sp.key}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">Logged by</label>
            <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Everyone</option>
              <option value={user?.id || ''}>Just me</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}</option>
              ))}
            </select>
          </div>

          <div className="relative flex-1 min-w-[180px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="Search ticket, person, or description…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {(spaceKeyFilter || userFilter || search) && (
            <button onClick={() => { setSpaceKeyFilter(''); setUserFilter(''); setSearch(''); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex items-center gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Total logged</p>
            <p className="text-[22px] font-bold text-gray-800">{totalMinutes > 0 ? formatMinutes(totalMinutes) : '0m'}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Entries</p>
            <p className="text-[22px] font-bold text-gray-800">{filteredRows.length}</p>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {loading ? (
            <p className="px-5 py-8 text-center text-[13px] text-gray-400">Loading…</p>
          ) : error ? (
            <p className="px-5 py-8 text-center text-[13px] text-red-500">{error}</p>
          ) : filteredRows.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-gray-400">No work logged in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Ticket</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Space</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Department</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Logged by</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Time spent</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredRows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 text-[12.5px] text-gray-500 whitespace-nowrap">
                        {new Date(r.workDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                      </td>
                      <td className="px-4 py-2.5 text-[12.5px] whitespace-nowrap">
                        <Link href={`/issues/${r.issueKey}`} className="font-semibold text-blue-600 hover:underline">{r.issueKey}</Link>
                        <p className="text-[11.5px] text-gray-400 truncate max-w-[220px]">{r.issueSummary}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[12.5px] text-gray-600 whitespace-nowrap">{r.spaceKey}</td>
                      <td className="px-4 py-2.5 text-[12.5px] text-gray-600 whitespace-nowrap">{r.department}</td>
                      <td className="px-4 py-2.5 text-[12.5px] text-gray-600 whitespace-nowrap">{r.authorName || 'Unknown'}</td>
                      <td className="px-4 py-2.5 text-[12.5px] font-semibold text-gray-800 whitespace-nowrap">{formatMinutes(r.timeSpentMinutes || 0)}</td>
                      <td className="px-4 py-2.5 text-[12.5px] text-gray-500 max-w-[320px] truncate">{r.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
