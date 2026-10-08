'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { Clock, Calendar, X, Search, ChevronDown } from 'lucide-react';

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

// Plain <select> for "Logged by" had no way to search a 300+ person list --
// finding one specific name meant scrolling through the whole alphabet.
// Same search-box-over-a-list pattern as the Filters page's own people
// pickers, just single-select (clicking an option selects it and closes).
function UserSearchSelect({
  value, onChange, options, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const selectedLabel = options.find((o) => o.value === value)?.label || placeholder;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 hover:border-gray-400 transition-colors min-w-[140px]"
      >
        <span className="flex-1 text-left truncate">{selectedLabel}</span>
        <ChevronDown size={12} className={`text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-xl overflow-hidden">
          <div className="border-b border-gray-100 px-2.5 py-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
              <Search size={12} className="text-gray-400 flex-shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search people…"
                className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-gray-400 text-center">No results</p>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { onChange(opt.value); setOpen(false); setQ(''); }}
                  className={`block w-full text-left px-3 py-1.5 text-[12.5px] transition-colors ${opt.value === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  {opt.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
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
  const [deptFilter, setDeptFilter] = useState('');
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
      dept: deptFilter || undefined,
    })
      .then((data: any) => setRows(Array.isArray(data) ? data : []))
      .catch((e: any) => setError(e?.message || 'Failed to load worklog entries.'))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, spaceKeyFilter, userFilter, deptFilter]);

  // Queue filter means "logged by one of THIS queue's own configured
  // members, wherever they logged it" -- by explicit request (two rounds):
  // first, Dev-team people's cross-team entries showing under Migration
  // read as wrong even though the entry's own Department tag was accurate
  // (fixed by also requiring roster membership); then the SAME Dev people
  // disappeared from "Queue: Dev" entirely because most of their own
  // entries are tagged Migration (the department they were helping on, not
  // their own team) -- "Queue: Dev" needs to mean "this person is a Dev
  // person", not "AND this specific entry happens to be tagged Dev" on top
  // of that. The actual roster matching now happens server-side (GET
  // /worklogs?dept=), not here -- moved there after this exact client-side
  // version repeatedly tested as "still not working" live despite the
  // underlying roster data itself checking out correct every time via a
  // script, so it can be verified directly against real data instead of
  // depending on this component's own state/effect timing. This only
  // fetches the dropdown's own option list now: every CONFIGURED queue for
  // the spaces actually present in the current (unfiltered-by-dept) rows,
  // not just whichever department tags happen to appear in this date
  // range, so a queue stays selectable even when none of its own entries
  // happened to be tagged that way.
  const [deptOptionsBySpace, setDeptOptionsBySpace] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const spaceKeys = Array.from(new Set(rows.map((r) => r.spaceKey).filter(Boolean)));
    const missing = spaceKeys.filter((sk) => !(sk in deptOptionsBySpace));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(missing.map(async (sk) => {
        try {
          const queues = await api.request<any[]>(`custom-queues/${sk}`);
          return [sk, (queues || []).map((q: any) => q.name).filter(Boolean)] as const;
        } catch {
          return [sk, []] as const;
        }
      }));
      if (cancelled) return;
      setDeptOptionsBySpace((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    return () => { cancelled = true; };
  }, [rows, deptOptionsBySpace]);

  const deptOptions = useMemo(
    () => Array.from(new Set(Object.values(deptOptionsBySpace).flat())).sort(),
    [deptOptionsBySpace],
  );

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

  // Label for the summary tile -- "how it should show in Jira": a plain
  // total when no one's singled out, "<Name>'s total" once a specific
  // person is selected, matching Jira's own per-assignee time-logged
  // reading rather than a generic "Total logged" that doesn't say whose.
  const selectedUserLabel = useMemo(() => {
    if (!userFilter) return null;
    if (userFilter === user?.id) return 'You';
    const u = users.find((uu) => uu.id === userFilter);
    return u ? (`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email) : null;
  }, [userFilter, users, user?.id]);

  // Grouped by ticket rather than one long flat chronological list, so two
  // entries against the SAME ticket (e.g. one person logs time, the ticket
  // moves to another queue, a different person logs more) sit together
  // with a per-ticket subtotal -- exactly how Jira's own per-issue Work Log
  // tab reads, just rolled up across every ticket here.
  const groupedByTicket = useMemo(() => {
    const map = new Map<string, { issueKey: string; issueSummary: string; spaceKey: string; spaceName: string; entries: WorklogRow[]; totalMinutes: number }>();
    for (const r of filteredRows) {
      let g = map.get(r.issueKey);
      if (!g) {
        g = { issueKey: r.issueKey, issueSummary: r.issueSummary, spaceKey: r.spaceKey, spaceName: r.spaceName, entries: [], totalMinutes: 0 };
        map.set(r.issueKey, g);
      }
      g.entries.push(r);
      g.totalMinutes += r.timeSpentMinutes || 0;
    }
    const groups = Array.from(map.values());
    for (const g of groups) g.entries.sort((a, b) => new Date(b.workDate).getTime() - new Date(a.workDate).getTime());
    groups.sort((a, b) => new Date(b.entries[0].workDate).getTime() - new Date(a.entries[0].workDate).getTime());
    return groups;
  }, [filteredRows]);

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
            <label className="text-[12px] text-gray-400 font-medium">Queue</label>
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All queues</option>
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[12px] text-gray-400 font-medium">Logged by</label>
            <UserSearchSelect
              value={userFilter}
              onChange={setUserFilter}
              placeholder="Everyone"
              options={[
                { value: '', label: 'Everyone' },
                { value: user?.id || '', label: 'Just me' },
                ...users.map((u) => ({ value: u.id, label: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id })),
              ]}
            />
          </div>

          <div className="relative flex-1 min-w-[180px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="Search ticket, person, or description…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {(spaceKeyFilter || userFilter || deptFilter || search) && (
            <button onClick={() => { setSpaceKeyFilter(''); setUserFilter(''); setDeptFilter(''); setSearch(''); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex items-center gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">
              {selectedUserLabel ? `${selectedUserLabel}'s total` : 'Total logged'}{deptFilter ? ` · ${deptFilter}` : ''}
            </p>
            <p className="text-[22px] font-bold text-gray-800">{totalMinutes > 0 ? formatMinutes(totalMinutes) : '0m'}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Entries</p>
            <p className="text-[22px] font-bold text-gray-800">{filteredRows.length}</p>
          </div>
        </div>

        {/* One table, real column headers, grouped by ticket via a merged
            first cell instead of a separate boxed header bar per ticket --
            the old "card per ticket" layout repeated the same ticket-key
            header weight whether a ticket had 1 entry or 10, and had no
            column labels at all, reported back as confusing to scan. */}
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-[13px] text-gray-400">Loading…</div>
        ) : error ? (
          <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-[13px] text-red-500">{error}</div>
        ) : groupedByTicket.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-[13px] text-gray-400">No work logged in this range.</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 w-[260px]">Ticket</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Logged by</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Department</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Time</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedByTicket.map((g, gi) => (
                    <Fragment key={g.issueKey}>
                      {g.entries.map((r, idx) => (
                        <tr
                          key={r.id}
                          className={`hover:bg-gray-50 ${idx === 0 && gi > 0 ? 'border-t-4 border-t-gray-100' : 'border-t border-gray-100'}`}
                        >
                          {idx === 0 && (
                            <td rowSpan={g.entries.length} className="align-top px-4 py-2.5 border-r border-gray-100 bg-gray-50/60">
                              <Link href={`/issues/${g.issueKey}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-600 hover:underline text-[13px]">{g.issueKey}</Link>
                              <p className="text-[12px] text-gray-500 mt-0.5 line-clamp-2">{g.issueSummary}</p>
                              <p className="text-[11px] text-gray-400 mt-1">{g.spaceName || g.spaceKey} · <span className="font-semibold text-gray-600">{formatMinutes(g.totalMinutes)} total</span></p>
                            </td>
                          )}
                          <td className="px-4 py-2.5 text-[12.5px] text-gray-600 whitespace-nowrap">{r.authorName || 'Unknown'}</td>
                          <td className="px-4 py-2.5 text-[12.5px] text-gray-500 whitespace-nowrap">{r.department}</td>
                          <td className="px-4 py-2.5 text-[12.5px] text-gray-400 whitespace-nowrap">
                            {new Date(r.workDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-4 py-2.5 text-[12.5px] font-semibold text-gray-800 whitespace-nowrap">{formatMinutes(r.timeSpentMinutes || 0)}</td>
                          <td className="px-4 py-2.5 text-[12.5px] text-gray-500 max-w-[280px] truncate">{r.description || '—'}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
