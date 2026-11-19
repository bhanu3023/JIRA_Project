'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { Clock, Calendar, X, Search, ChevronDown, Plus, Trash2, Download } from 'lucide-react';

// The fixed activity list for the "Ticket Worklog" tab's Create form --
// non-ticket work that still deserves a logged, reportable time entry.
// "Others" is the one type that also needs a free-text reason, handled
// specially wherever this list is used.
const ACTIVITY_TYPES = [
  'Monitor migrations and retry failed items from the UI',
  'Analyse reports and send them to the customer',
  'Work on automation',
  'Attend the weekly communication training',
  'Complete courses',
  'Validate mappings and start migrations',
  'Attend the daily meeting on updates',
  'Hand off to the next shift',
  'Create tickets',
  'Write KB articles',
  'Investigate issues',
  'Join client calls',
  'Join internal calls',
  'PMO tracker update',
  'Others',
] as const;

// What the Dev queue logs instead -- shown in the Create form when the
// entry is being logged for the Dev queue.
const DEV_ACTIVITY_TYPES = [
  'Worked on automation',
  'Attend the daily meeting on updates',
  'Helping Team Members on tickets (Add Ticket Number Which Ticket You helped)',
  'QA Discussion And Migration Team discussion',
  'RCA Doc preparation',
  'Working with infra on deployment',
  'Worked on Mantec project',
  'Wrote KB articles',
  'Investigate issues',
  'Join client calls',
  'Join internal calls',
  'Others',
] as const;

const HELPING_ON_TICKETS = 'Helping Team Members on tickets (Add Ticket Number Which Ticket You helped)';

// People whose role is on the Migration team. They always get the Migration
// activity list and never count under the Dev queue, even if they're also
// listed as a Dev queue member. ("developer" can't be used the other way
// round -- it's the default role every team member gets.)
const MIGRATION_ROLES = new Set(['migration_engineer', 'migration_manager']);
const isMigrationRole = (role?: string | null) => MIGRATION_ROLES.has(String(role || '').toLowerCase());
const isDevQueue = (queue?: string | null) => String(queue || '').trim().toLowerCase() === 'dev';

const activityTypesFor = (queue: string, role?: string | null): readonly string[] =>
  !isMigrationRole(role) && isDevQueue(queue) ? DEV_ACTIVITY_TYPES : ACTIVITY_TYPES;

// Every activity from both lists, for the Activity filter.
const ALL_ACTIVITY_TYPES = Array.from(new Set<string>([...ACTIVITY_TYPES, ...DEV_ACTIVITY_TYPES]));

type ActivityWorklogRow = {
  id: string;
  userId: string;
  spaceKey?: string | null;
  queue?: string | null;
  authorName: string | null;
  authorEmail: string | null;
  activityType: string;
  customReason: string | null;
  timeSpentMinutes: number;
  description: string | null;
  workDate: string;
  createdAt: string;
};

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

// yyyy-mm-dd in the viewer's local time -- the same day the table shows.
function localDay(d: string) {
  const t = new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const toHours = (m: number) => Math.round(((m || 0) / 60) * 100) / 100;

// Writes the given sheets to an .xlsx and downloads it. xlsx is loaded only
// when someone actually exports, so it stays out of the page bundle.
async function downloadWorkbook(filename: string, sheets: { name: string; rows: Record<string, any>[] }[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows);
    const headers = Object.keys(s.rows[0] || {});
    ws['!cols'] = headers.map((h) => ({
      wch: Math.min(60, Math.max(h.length, ...s.rows.map((r) => String(r[h] ?? '').length)) + 2),
    }));
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  XLSX.writeFile(wb, filename);
}

// Per-person totals sheet shared by both exports.
function perPersonRows(items: { authorName: string | null; authorEmail: string | null; timeSpentMinutes: number }[]) {
  const map = new Map<string, { Name: string; Email: string; minutes: number; Entries: number }>();
  for (const r of items) {
    const key = r.authorEmail || r.authorName || 'unknown';
    const g = map.get(key) || { Name: r.authorName || 'Unknown', Email: r.authorEmail || '', minutes: 0, Entries: 0 };
    g.minutes += r.timeSpentMinutes || 0;
    g.Entries += 1;
    map.set(key, g);
  }
  return Array.from(map.values())
    .sort((a, b) => b.minutes - a.minutes)
    .map((g) => ({ Name: g.Name, Email: g.Email, 'Total (hours)': toHours(g.minutes), Total: formatMinutes(g.minutes), Entries: g.Entries }));
}

function ExportButton({ onClick, disabled }: { onClick: () => Promise<void>; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || busy}
      title={disabled ? 'Nothing to download for these filters' : 'Download the entries shown as an Excel file'}
      onClick={async () => { setBusy(true); try { await onClick(); } catch (e) { console.error(e); alert('Could not create the Excel file.'); } finally { setBusy(false); } }}
      className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 bg-white text-gray-700 text-[12.5px] font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Download size={14} /> {busy ? 'Preparing…' : 'Download Excel'}
    </button>
  );
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

// ── Ticket Worklog tab ──────────────────────────────────────────────────
// A personal, non-ticket activity log (training, meetings, reports, etc.)
// -- separate from the ticket-scoped Worklog tab above. Self-contained
// (own state/fetching/modal) so it doesn't need to touch WorklogPage's
// already-large existing state.

type DraftEntry = { activityType: string; hours: string; minutes: string; customReason: string; description: string };

function emptyDraft(activityType: string): DraftEntry {
  return { activityType, hours: '', minutes: '', customReason: '', description: '' };
}

function CreateActivityWorklogModal({ onClose, onSaved, userId, userRole, spaces }: {
  onClose: () => void;
  onSaved: () => void;
  userId: string | undefined;
  userRole: string | undefined;
  spaces: { key: string; name?: string }[];
}) {
  const [workDate, setWorkDate] = useState(() => isoDate(new Date()));
  const [selected, setSelected] = useState<Record<string, DraftEntry>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The queues this person belongs to, across every space -- the entry is
  // filed under the one picked here (auto-picked when there's only one).
  const [myQueues, setMyQueues] = useState<{ spaceKey: string; spaceName: string; name: string }[] | null>(null);
  const [queueChoice, setQueueChoice] = useState(''); // "SPACEKEY|Queue name"
  const spaceKeysStr = spaces.map((s) => s.key).join(',');
  useEffect(() => {
    if (!userId) { setMyQueues([]); return; }
    let cancelled = false;
    Promise.all(spaces.map((sp) =>
      api.request<any[]>(`custom-queues/${sp.key}`).then(
        (qs) => (qs || [])
          .filter((q: any) => q?.name && Array.isArray(q.memberIds) && q.memberIds.includes(userId))
          .filter((q: any) => !(isMigrationRole(userRole) && isDevQueue(q.name)))
          .map((q: any) => ({ spaceKey: sp.key, spaceName: sp.name || sp.key, name: String(q.name) })),
        () => [] as { spaceKey: string; spaceName: string; name: string }[],
      ),
    )).then((lists) => {
      if (cancelled) return;
      const all = lists.flat();
      setMyQueues(all);
      if (all.length === 1) setQueueChoice(`${all[0].spaceKey}|${all[0].name}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userRole, spaceKeysStr]);
  const [choiceSpaceKey, ...choiceNameParts] = queueChoice.split('|');
  const choiceQueue = choiceNameParts.join('|');
  const activityTypes = activityTypesFor(choiceQueue, userRole);
  const needsQueue = !!myQueues && myQueues.length > 0;

  // Switching queue can swap the activity list -- drop picks that aren't on it.
  useEffect(() => {
    setSelected((prev) => {
      const kept = Object.fromEntries(Object.entries(prev).filter(([k]) => activityTypes.includes(k)));
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }, [activityTypes]);

  const toggle = (activityType: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[activityType]) delete next[activityType];
      else next[activityType] = emptyDraft(activityType);
      return next;
    });
  };

  const updateDraft = (activityType: string, patch: Partial<DraftEntry>) => {
    setSelected((prev) => ({ ...prev, [activityType]: { ...prev[activityType], ...patch } }));
  };

  const handleSave = async () => {
    if (needsQueue && !choiceQueue) { setError('Select the queue you are logging this work for.'); return; }
    const drafts = Object.values(selected);
    if (!drafts.length) { setError('Select at least one activity.'); return; }
    const entries: Array<{ activityType: string; customReason?: string; timeSpentMinutes: number; description?: string }> = [];
    for (const d of drafts) {
      const h = Math.max(0, parseInt(d.hours, 10) || 0);
      const m = Math.max(0, parseInt(d.minutes, 10) || 0);
      const total = h * 60 + m;
      if (total <= 0) { setError(`Enter time spent for "${d.activityType}".`); return; }
      if (d.activityType === 'Others' && !d.customReason.trim()) { setError('Enter a reason for "Others".'); return; }
      if (d.activityType === HELPING_ON_TICKETS && !d.description.trim()) { setError('Enter the ticket number(s) you helped on in Notes.'); return; }
      entries.push({
        activityType: d.activityType,
        customReason: d.activityType === 'Others' ? d.customReason.trim() : undefined,
        timeSpentMinutes: total,
        description: d.description.trim() || undefined,
      });
    }
    setSaving(true);
    setError('');
    try {
      await api.createActivityWorklog({
        workDate: `${workDate}T12:00:00`,
        ...(choiceQueue ? { spaceKey: choiceSpaceKey, queue: choiceQueue } : {}),
        entries,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <h2 className="text-[15px] font-bold text-gray-800">Log work</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          <div className="mb-4">
            <label className="text-[12px] text-gray-500 font-medium block mb-1">Date</label>
            <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {needsQueue && (
            <div className="mb-4">
              <label className="text-[12px] text-gray-500 font-medium block mb-1">Queue <span className="text-red-500">*</span></label>
              <select value={queueChoice} onChange={(e) => setQueueChoice(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select queue</option>
                {myQueues!.map((q) => (
                  <option key={`${q.spaceKey}|${q.name}`} value={`${q.spaceKey}|${q.name}`}>
                    {q.name} — {q.spaceName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <p className="text-[12px] text-gray-500 font-medium mb-2">Select what you worked on — check each one that applies, then log time for it.</p>
          <div className="space-y-2">
            {activityTypes.map((activityType) => {
              const checked = !!selected[activityType];
              const draft = selected[activityType];
              return (
                <div key={activityType} className={`rounded-lg border ${checked ? 'border-blue-300 bg-blue-50/40' : 'border-gray-200'}`}>
                  <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={checked} onChange={() => toggle(activityType)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0" />
                    <span className="text-[13px] text-gray-800">{activityType}</span>
                  </label>
                  {checked && draft && (
                    <div className="px-3 pb-3 pt-1 space-y-2 border-t border-blue-100">
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] text-gray-500 font-medium w-20">Time spent</label>
                        <input type="number" min={0} placeholder="h" value={draft.hours}
                          onChange={(e) => updateDraft(activityType, { hours: e.target.value })}
                          className="w-16 border border-gray-300 rounded px-2 py-1 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <span className="text-[11px] text-gray-400">h</span>
                        <input type="number" min={0} max={59} placeholder="m" value={draft.minutes}
                          onChange={(e) => updateDraft(activityType, { minutes: e.target.value })}
                          className="w-16 border border-gray-300 rounded px-2 py-1 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <span className="text-[11px] text-gray-400">m</span>
                      </div>
                      {activityType === 'Others' && (
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-gray-500 font-medium w-20 flex-shrink-0">Reason</label>
                          <input type="text" placeholder="What did you work on?" value={draft.customReason}
                            onChange={(e) => updateDraft(activityType, { customReason: e.target.value })}
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] text-gray-500 font-medium w-20 flex-shrink-0">Notes</label>
                        <input type="text"
                          placeholder={activityType === HELPING_ON_TICKETS ? 'Ticket number(s) you helped on — required' : 'Optional'}
                          value={draft.description}
                          onChange={(e) => updateDraft(activityType, { description: e.target.value })}
                          className="flex-1 border border-gray-300 rounded px-2 py-1 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between flex-shrink-0">
          {error ? <p className="text-[12px] text-red-500">{error}</p> : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-[12.5px] font-medium text-gray-500 hover:text-gray-800">Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-1.5 bg-blue-600 text-white text-[12.5px] font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Space / Queue filters on both tabs: the queue names to offer (from the
// chosen space, or every space) and who belongs to the selection -- members
// of that queue, or of any queue in the chosen space. `memberIds` is null
// when neither is chosen (everyone). Same rule the server applies to the
// entries themselves, so the Logged by / Reporter list only offers people
// who can actually have entries under the current Space / Queue.
function useQueueRoster(spaces: { key: string }[], spaceKey: string, dept: string) {
  const [queuesBySpace, setQueuesBySpace] = useState<Record<string, any[]>>({});
  const keysStr = spaceKey || spaces.map((s) => s.key).join(',');
  useEffect(() => {
    const missing = keysStr.split(',').filter((k) => k && !(k in queuesBySpace));
    if (!missing.length) return;
    let cancelled = false;
    Promise.all(missing.map((sk) => api.request<any[]>(`custom-queues/${sk}`).then((q) => [sk, q || []] as const, () => [sk, []] as const)))
      .then((entries) => { if (!cancelled) setQueuesBySpace((prev) => ({ ...prev, ...Object.fromEntries(entries) })); });
    return () => { cancelled = true; };
  }, [keysStr, queuesBySpace]);

  return useMemo(() => {
    const keys = keysStr.split(',').filter(Boolean);
    // Every needed space's queues have arrived -- until then an empty
    // option list / roster means "not loaded", not "nobody".
    const ready = keys.every((k) => k in queuesBySpace);
    const queues = keys.flatMap((k) => queuesBySpace[k] || []);
    const deptOptions = Array.from(new Set(queues.map((q: any) => q?.name).filter(Boolean))).sort() as string[];
    if (!spaceKey && !dept) return { ready, deptOptions, memberIds: null as Set<string> | null };
    const memberIds = new Set<string>();
    for (const q of queues) {
      if (dept && String(q?.name || '').toLowerCase() !== dept.toLowerCase()) continue;
      if (Array.isArray(q?.memberIds)) q.memberIds.forEach((id: string) => memberIds.add(id));
    }
    return { ready, deptOptions, memberIds };
  }, [keysStr, queuesBySpace, spaceKey, dept]);
}

// Drops a Queue / person choice the new Space / Queue no longer contains.
function useResetStaleFilters(
  roster: ReturnType<typeof useQueueRoster>,
  deptFilter: string, setDeptFilter: (v: string) => void,
  userFilter: string, setUserFilter: (v: string) => void,
) {
  useEffect(() => {
    if (!roster.ready) return;
    if (deptFilter && !roster.deptOptions.includes(deptFilter)) setDeptFilter('');
    else if (userFilter && roster.memberIds && !roster.memberIds.has(userFilter)) setUserFilter('');
  }, [roster, deptFilter, userFilter, setDeptFilter, setUserFilter]);
}

function TicketWorklogTab({ userId, userRole, allUsers, spaces }: {
  userId: string | undefined;
  userRole: string | undefined;
  allUsers: { id: string; firstName?: string; lastName?: string; email?: string; role?: string }[];
  spaces: { key: string; name?: string }[];
}) {
  const [entries, setEntries] = useState<ActivityWorklogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  // Default to the last 30 days, same reasoning as the Worklog tab's own
  // date filter -- the full unfiltered history isn't what anyone wants on
  // first load.
  const [dateFrom, setDateFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [dateTo, setDateTo] = useState(() => isoDate(new Date()));
  const [userFilter, setUserFilter] = useState(''); // open to everyone -- any user can filter to anyone else here
  const [activityFilter, setActivityFilter] = useState('');
  // Space / Queue, same as the Worklog tab's: these entries aren't on a
  // ticket, so the server places them by who logged them -- a member of
  // that queue (or of any queue in that space).
  const [spaceKeyFilter, setSpaceKeyFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  const roster = useQueueRoster(spaces, spaceKeyFilter, deptFilter);
  const deptOptions = roster.deptOptions;
  useResetStaleFilters(roster, deptFilter, setDeptFilter, userFilter, setUserFilter);
  const reporterUsers = (roster.memberIds ? allUsers.filter((u) => roster.memberIds!.has(u.id)) : allUsers)
    .filter((u) => !(isDevQueue(deptFilter) && isMigrationRole(u.role)));

  const load = () => {
    setLoading(true);
    api.getActivityWorklogs({
      from: dateFrom ? `${dateFrom}T00:00:00` : undefined,
      to: dateTo ? `${dateTo}T23:59:59` : undefined,
      userId: userFilter || undefined,
      spaceKey: spaceKeyFilter || undefined,
      dept: deptFilter || undefined,
    }).then(setEntries).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, [dateFrom, dateTo, userFilter, spaceKeyFilter, deptFilter]);

  const visibleEntries = activityFilter ? entries.filter((e) => e.activityType === activityFilter) : entries;
  // Same summary as the Worklog tab, over the entries currently shown.
  const visibleMinutes = visibleEntries.reduce((sum, e) => sum + (e.timeSpentMinutes || 0), 0);
  const reporter = userFilter ? allUsers.find((u) => u.id === userFilter) : undefined;
  const reporterLabel = reporter ? `${reporter.firstName || ''} ${reporter.lastName || ''}`.trim() || reporter.email || '' : '';

  const exportExcel = () => {
    const rows = visibleEntries.map((e) => ({
      Date: localDay(e.workDate),
      Reporter: e.authorName || 'Unknown',
      Email: e.authorEmail || '',
      Space: e.spaceKey || '',
      Queue: e.queue || '',
      Activity: e.activityType,
      Reason: e.activityType === 'Others' ? e.customReason || '' : '',
      'Time (hours)': toHours(e.timeSpentMinutes),
      Time: formatMinutes(e.timeSpentMinutes),
      Notes: e.description || '',
    }));
    return downloadWorkbook(`ticket-worklog_${dateFrom || 'start'}_to_${dateTo || 'today'}.xlsx`, [
      { name: 'Ticket Worklog', rows },
      { name: 'Per person', rows: perPersonRows(visibleEntries) },
    ]);
  };

  const handleDelete = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try { await api.deleteActivityWorklog(id); } catch { load(); }
  };

  return (
    <div className="flex-1 overflow-auto px-8 py-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-[13px] text-gray-500">Non-ticket work — training, meetings, reports, and other activities worth logging.</p>
        <div className="flex items-center gap-2">
          <ExportButton onClick={exportExcel} disabled={loading || visibleEntries.length === 0} />
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-[12.5px] font-semibold rounded-lg hover:bg-blue-700">
            <Plus size={14} /> Create
          </button>
        </div>
      </div>

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
            {spaces.map((sp) => <option key={sp.key} value={sp.key}>{sp.name || sp.key}</option>)}
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
          <label className="text-[12px] text-gray-400 font-medium">Reporter</label>
          <UserSearchSelect
            value={userFilter}
            onChange={setUserFilter}
            placeholder="Everyone"
            options={[
              { value: '', label: 'Everyone' },
              ...reporterUsers.map((u) => ({ value: u.id, label: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id })),
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-gray-400 font-medium">Activity</label>
          <select value={activityFilter} onChange={(e) => setActivityFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white max-w-[260px]">
            <option value="">All activities</option>
            {ALL_ACTIVITY_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        {(userFilter || activityFilter || spaceKeyFilter || deptFilter || dateFrom || dateTo) && (
          <button onClick={() => { setUserFilter(''); setActivityFilter(''); setSpaceKeyFilter(''); setDeptFilter(''); setDateFrom(isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000))); setDateTo(isoDate(new Date())); }}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            <X size={11} /> Clear
          </button>
        )}
      </div>

      {!loading && (
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex items-center gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">
              {reporterLabel ? `${reporterLabel}'s total` : 'Total logged'}{deptFilter ? ` · ${deptFilter}` : ''}{activityFilter ? ` · ${activityFilter}` : ''}
            </p>
            <p className="text-[22px] font-bold text-gray-800">{visibleMinutes > 0 ? formatMinutes(visibleMinutes) : '0m'}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Entries</p>
            <p className="text-[22px] font-bold text-gray-800">{visibleEntries.length}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Avg per entry</p>
            <p className="text-[22px] font-bold text-gray-800">
              {visibleEntries.length > 0 ? formatMinutes(Math.round(visibleMinutes / visibleEntries.length)) : '0m'}
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-[13px] text-gray-400">Loading…</div>
      ) : visibleEntries.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-[13px] text-gray-400">
          {entries.length === 0 ? 'No activity logged yet. Click Create to log your first entry.' : 'No entries match these filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Reporter</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Queue</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Activity</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Time</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Notes</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 last:border-0 group">
                    <td className="px-4 py-2.5 text-[12.5px] text-gray-500 whitespace-nowrap">
                      {new Date(e.workDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-4 py-2.5 text-[12.5px] text-gray-600 whitespace-nowrap">{e.authorName || 'Unknown'}</td>
                    <td className="px-4 py-2.5 text-[12.5px] text-gray-500 whitespace-nowrap">{e.queue || '—'}</td>
                    <td className="px-4 py-2.5 text-[13px] text-gray-800">
                      {e.activityType === 'Others' && e.customReason ? e.customReason : e.activityType}
                    </td>
                    <td className="px-4 py-2.5 text-[12.5px] font-semibold text-gray-800 whitespace-nowrap">{formatMinutes(e.timeSpentMinutes)}</td>
                    <td className="px-4 py-2.5 text-[12.5px] text-gray-500 max-w-[280px] truncate">{e.description || '—'}</td>
                    <td className="px-4 py-2.5">
                      {e.userId === userId && (
                        <button onClick={() => handleDelete(e.id)} title="Delete"
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && <CreateActivityWorklogModal onClose={() => setShowCreate(false)} onSaved={load} userId={userId} userRole={userRole} spaces={spaces} />}
    </div>
  );
}

export default function WorklogPage() {
  const { spaces, user } = useStore((s) => ({ spaces: s.spaces, user: s.user }));
  const isAdminUser = user?.role === 'admin';
  // "Worklog" (cross-ticket, every user's logged hours) is admin-only by
  // default -- reversed back after briefly opening it to everyone; "Ticket
  // Worklog" (the non-ticket activity log) is the one meant for all users.
  // canViewWorklog is a narrow, per-person additive grant (same pattern as
  // MBR's canViewMbr) for unlocking just this tab for one named person.
  const canSeeWorklogTab = isAdminUser || !!(user as any)?.canViewWorklog;
  const [mainTab, setMainTab] = useState<'worklog' | 'ticket'>(canSeeWorklogTab ? 'worklog' : 'ticket');

  // Default to the last 30 days -- the full unfiltered history across every
  // ticket is rarely what anyone wants on first load, same reasoning as the
  // Reports page's own date filters.
  const [dateFrom, setDateFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [dateTo, setDateTo] = useState(() => isoDate(new Date()));
  const [spaceKeyFilter, setSpaceKeyFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [search, setSearch] = useState('');

  const [users, setUsers] = useState<{ id: string; firstName?: string; lastName?: string; email?: string; role?: string }[]>([]);
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
  // supplies the dropdowns: every CONFIGURED queue in the chosen space (or
  // every space), so a queue stays selectable even when none of its own
  // entries happened to be tagged that way, and -- once a Space / Queue is
  // chosen -- only that queue's people under "Logged by".
  const roster = useQueueRoster(spaces || [], spaceKeyFilter, deptFilter);
  const deptOptions = roster.deptOptions;
  useResetStaleFilters(roster, deptFilter, setDeptFilter, userFilter, setUserFilter);
  const loggedByUsers = roster.memberIds ? users.filter((u) => roster.memberIds!.has(u.id)) : users;

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

  // Per-person breakdown -- the summary bar above only ever shows ONE
  // combined Total/Entries/Avg, which mixes everyone together into a single
  // number the moment "Logged by" is left on All. Only meaningful (and only
  // shown) when no specific person is already selected there -- picking a
  // person already gives their own numbers via selectedUserLabel above, so
  // this would just show a single-row repeat of the same stats.
  const groupedByUser = useMemo(() => {
    if (userFilter) return [];
    const map = new Map<string, { authorId: string | null; name: string; totalMinutes: number; entries: number }>();
    for (const r of filteredRows) {
      const key = r.authorId || r.authorName || 'unknown';
      let g = map.get(key);
      if (!g) {
        g = { authorId: r.authorId, name: r.authorName || 'Unknown', totalMinutes: 0, entries: 0 };
        map.set(key, g);
      }
      g.totalMinutes += r.timeSpentMinutes || 0;
      g.entries += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
  }, [filteredRows, userFilter]);

  // Same rows as the table (filters + search applied), ticket by ticket.
  const exportExcel = () => {
    const rows = groupedByTicket.flatMap((g) => g.entries.map((r) => ({
      Ticket: r.issueKey,
      Summary: r.issueSummary || '',
      Space: r.spaceName || r.spaceKey || '',
      'Logged by': r.authorName || 'Unknown',
      Email: r.authorEmail || '',
      Department: r.department || '',
      Date: localDay(r.workDate),
      'Time (hours)': toHours(r.timeSpentMinutes),
      Time: formatMinutes(r.timeSpentMinutes || 0),
      Description: r.description || '',
    })));
    const byTicket = groupedByTicket.map((g) => ({
      Ticket: g.issueKey,
      Summary: g.issueSummary || '',
      Space: g.spaceName || g.spaceKey || '',
      'Total (hours)': toHours(g.totalMinutes),
      Total: formatMinutes(g.totalMinutes),
      Entries: g.entries.length,
    }));
    return downloadWorkbook(`worklog_${dateFrom || 'start'}_to_${dateTo || 'today'}.xlsx`, [
      { name: 'Worklog', rows },
      { name: 'Per ticket', rows: byTicket },
      { name: 'Per person', rows: perPersonRows(filteredRows) },
    ]);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-4 flex-shrink-0">
        <h1 className="text-xl font-bold flex items-center gap-2 text-gray-800"><Clock size={20} /> Worklog</h1>
        <p className="text-[12.5px] text-gray-500 mt-0.5">Time logged against tickets, same as Jira's own Logged Work view.</p>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-8 flex-shrink-0">
        <div className="flex gap-6">
          {canSeeWorklogTab && (
            <button onClick={() => setMainTab('worklog')}
              className={`py-3 text-[13px] font-semibold border-b-2 transition-colors ${mainTab === 'worklog' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
              Worklog
            </button>
          )}
          <button onClick={() => setMainTab('ticket')}
            className={`py-3 text-[13px] font-semibold border-b-2 transition-colors ${mainTab === 'ticket' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            Ticket Worklog
          </button>
        </div>
      </div>

      {mainTab === 'ticket' && <TicketWorklogTab userId={user?.id} userRole={user?.role} allUsers={users} spaces={spaces || []} />}

      {mainTab === 'worklog' && canSeeWorklogTab && (
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
                ...(!roster.memberIds || (user?.id && roster.memberIds.has(user.id)) ? [{ value: user?.id || '', label: 'Just me' }] : []),
                ...loggedByUsers.map((u) => ({ value: u.id, label: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id })),
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

          <div className="ml-auto">
            <ExportButton onClick={exportExcel} disabled={loading || !!error || filteredRows.length === 0} />
          </div>
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
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Avg per entry</p>
            <p className="text-[22px] font-bold text-gray-800">
              {filteredRows.length > 0 ? formatMinutes(Math.round(totalMinutes / filteredRows.length)) : '0m'}
            </p>
          </div>
        </div>

        {/* Per-person breakdown -- only when no one's singled out via
            "Logged by" (see groupedByUser's own comment for why). Same
            three stats as the combined summary bar above, one row per
            person instead of everyone folded into one number. */}
        {!userFilter && groupedByUser.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-5">
            <div className="px-5 py-3 border-b border-gray-200">
              <p className="text-[12.5px] font-semibold text-gray-700">Per-person breakdown</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Name</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Total</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Entries</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Avg per entry</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedByUser.map((g) => (
                    <tr
                      key={g.authorId || g.name}
                      className={`border-b border-gray-100 last:border-0 ${g.authorId ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                      onClick={() => { if (g.authorId) setUserFilter(g.authorId); }}
                    >
                      <td className="px-4 py-2.5 text-[13px] font-medium text-gray-800">{g.name}</td>
                      <td className="px-4 py-2.5 text-[13px] text-gray-700">{formatMinutes(g.totalMinutes)}</td>
                      <td className="px-4 py-2.5 text-[13px] text-gray-700">{g.entries}</td>
                      <td className="px-4 py-2.5 text-[13px] text-gray-700">{formatMinutes(Math.round(g.totalMinutes / g.entries))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

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
      )}
    </div>
  );
}
