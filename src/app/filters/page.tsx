'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useRouter } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { timeAgo, cn, getEffectiveIssueStatus, resolveStatusColor } from '@/lib/utils';
import Link from 'next/link';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import DotLoader from '@/components/ui/DotLoader';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import {
  Search, Star, Plus, MoreHorizontal, Trash2, Edit2,
  Filter, X, ChevronDown, Check, Bookmark, SlidersHorizontal,
  List, LayoutGrid, Download,
} from 'lucide-react';
import { can } from '@/lib/permissions';
import { INFRA_ISSUE_TYPES } from '@/components/issues/CreateIssueModal';

/* ─── types ─── */
// Everything a saved filter can hold. Every filter on the page has a key
// here -- a field missing from this list is silently dropped on save.
interface FilterCriteria {
  spaces?: string[];
  queue?: string;
  assignees?: string[];
  reporters?: string[];
  types?: string[];
  statuses?: string[];
  priorities?: string[];
  text?: string;
  createdRange?: string;
  updatedRange?: string;
  workedRange?: string;
  dueDateRange?: string;
  resolvedRange?: string;
  department?: string;
  productType?: string[];
  productionTicket?: string[];
  combination?: string;
  customerName?: string[];
  clientName?: string[];
  projectManager?: string[];
  projectPool?: string;
  infraIssueType?: string[];
  slaBreached?: 'yes' | 'no';
  overdue?: 'yes' | 'no';
  extras?: string[];
}

// Multi-select text values (Customer Name, Product Type, ...) go into the URL
// and the API joined with "|||", so a value that contains a comma ("Acme,
// Inc.") stays one value. The URL marks this with rSep=pipe (the API with
// multiSep=pipe); links written before that used commas and still parse.
const MULTI_SEP = '|||';
function splitMultiParam(value: string, pipe: boolean): string[] {
  return value.split(pipe ? MULTI_SEP : ',').map((v) => v.trim()).filter(Boolean);
}
interface SavedFilter {
  id: string; name: string; criteria: FilterCriteria;
  ownerId: string; ownerName: string;
  starred: boolean; starredBy: string[];
  createdAt: string; updatedAt: string;
}

const ISSUE_TYPES = ['bug', 'task', 'subtask'];
const TYPE_LABELS: Record<string, string> = {
  bug: 'Bug', task: 'Task', subtask: 'Subtask',
};
// Highest removed per explicit request -- every ticket that had it was
// bulk-converted to High (3,146 confirmed system-wide), and it's no
// longer offered anywhere a priority can be picked.
const PRIORITIES = ['high', 'medium', 'low', 'lowest'];
// Was a hand-maintained hardcoded name list here (and in CreateIssueModal.tsx /
// issues/[issueKey]/page.tsx) that drifted from reality -- a real
// migration_manager-role user (Kiran U) was missing from it, while others
// listed no longer held that role. Now fetched live via
// api.getProjectManagerOptions() (see PROJECT_MANAGER_OPTIONS state below)
// from whoever currently has the migration_manager role in User Management.
// Same fixed list the ticket's own Product Type field picks from (see
// CreateIssueModal.tsx / issues/[issueKey]/page.tsx) — a free-text box here
// required typing the value out exactly (case and all) to match anything,
// which is why it looked broken; a handful of known values is a dropdown.
const PRODUCT_TYPE_OPTIONS = ['Content Migration', 'Email Migration', 'Message Migration', 'Board Migration', 'CF Connect', 'CF Manage', 'UI', 'others', 'Others'];
// Same fixed list the ticket's own Production Ticket field picks from (see
// the 'productionTicket' custom-field entries in issues/[issueKey]/page.tsx
// and CreateIssueModal.tsx) -- this filter didn't exist on the Filters page
// at all before, per explicit request.
const PRODUCTION_TICKET_OPTIONS = ['Operational Support', 'Code Fixes'];
const PRIORITY_LABELS: Record<string, string> = {
  highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest',
};


/* ─── inline dropdown ─── */
function DropBtn({
  label, options, selected, onChange, align = 'left',
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // dropPos was only ever computed once, at the moment the button was clicked — scrolling
  // the page (or the results table) while the panel stayed open left it hanging wherever it
  // first appeared instead of following the button. Recompute on every scroll/resize while
  // open; capture:true on scroll so this also catches scrolling inside a nested container,
  // not just the window itself (scroll events don't bubble, but they do fire in capture).
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 4, left: align === 'right' ? rect.right - 240 : rect.left });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, align]);

  // Already-selected options were left in whatever order `options` happened
  // to arrive in -- for a long list (e.g. Assignee's full member roster),
  // an active selection could sit well below the fold, invisible without
  // scrolling every time this dropdown is reopened. Stable-sort selected
  // options to the top so what's currently active is always visible first.
  const filtered = options
    .filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    .map((o, idx) => ({ o, idx, sel: selected.includes(o.value) ? 0 : 1 }))
    .sort((a, b) => a.sel - b.sel || a.idx - b.idx)
    .map(({ o }) => o);
  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);

  const active = selected.length > 0;

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 4, left: align === 'right' ? rect.right - 240 : rect.left });
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={ref} className="flex-shrink-0">
      <button
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          active
            ? 'border-blue-500 bg-blue-50 text-blue-700'
            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50',
        )}
      >
        {label}
        {active && (
          <span className="ml-0.5 text-[10px] font-bold text-blue-600">({selected.length})</span>
        )}
        <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && dropPos && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[9999] w-60 rounded-lg border border-gray-200 bg-white shadow-2xl overflow-hidden"
          onMouseDown={e => e.stopPropagation()}
          style={{ top: dropPos.top, left: dropPos.left }}
        >
          <div className="border-b border-gray-100 px-3 py-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
              <Search size={12} className="text-gray-400 flex-shrink-0" />
              <input
                                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-gray-400 text-center">No results</p>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => toggle(opt.value)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <div className={cn(
                    'h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center',
                    selected.includes(opt.value) ? 'border-blue-600 bg-blue-600' : 'border-gray-300',
                  )}>
                    {selected.includes(opt.value) && <Check size={10} className="text-white" strokeWidth={3} />}
                  </div>
                  <span className="flex-1 truncate text-left">{opt.label}</span>
                </button>
              ))
            )}
          </div>
          {selected.length > 0 && (
            <div className="border-t border-gray-100 px-3 py-2">
              <button onClick={() => onChange([])} className="text-[11.5px] text-blue-600 font-medium hover:text-blue-800">
                Clear
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Queue filter — pick one or more spaces, or drill into a single space to filter by one of its custom queues */
function SpaceQueueDropBtn({
  spaces, selSpaces, onSpacesChange, selQueue, onQueueChange,
}: {
  spaces: any[];
  selSpaces: string[];
  onSpacesChange: (v: string[]) => void;
  selQueue: string;
  onQueueChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  // Multiple boards can be expanded at once — a Set, not a single key, so selecting
  // one board doesn't collapse another board's already-open queue list.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [queuesByKey, setQueuesByKey] = useState<Record<string, { id: string; name: string }[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const filtered = spaces.filter((sp: any) => (sp.name || '').toLowerCase().includes(q.toLowerCase()));

  const loadQueues = async (key: string) => {
    if (queuesByKey[key]) return;
    setLoadingKey(key);
    try {
      const rows = await api.request<any[]>(`custom-queues/${key}`);
      setQueuesByKey((prev) => ({ ...prev, [key]: Array.isArray(rows) ? rows : [] }));
    } catch {
      setQueuesByKey((prev) => ({ ...prev, [key]: [] }));
    }
    setLoadingKey(null);
  };

  const toggleSpace = (key: string) => {
    if (selQueue) onQueueChange('');
    const isSelecting = !selSpaces.includes(key);
    onSpacesChange(isSelecting ? [...selSpaces, key] : selSpaces.filter((v) => v !== key));
    // Checking a space auto-expands its queues so there's no extra click to see them —
    // other already-expanded boards stay open.
    if (isSelecting) {
      setExpandedKeys((prev) => new Set(prev).add(key));
      loadQueues(key);
    }
  };

  const expandSpace = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (!expandedKeys.has(key)) loadQueues(key);
  };

  // Picking a specific queue narrows the space selection to just its parent space,
  // since department filtering only makes sense scoped to a single space.
  const selectQueue = (spaceKey: string, queueName: string) => {
    onSpacesChange([spaceKey]);
    onQueueChange(selQueue === queueName ? '' : queueName);
  };

  const active = selSpaces.length > 0;
  const label = selQueue ? `Queue: ${selQueue}` : active ? `Queue (${selSpaces.length})` : 'Queue';

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={ref} className="flex-shrink-0">
      <button
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          active
            ? 'border-blue-500 bg-blue-50 text-blue-700'
            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50',
        )}
      >
        {label}
        <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && dropPos && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-[9999] w-64 rounded-lg border border-gray-200 bg-white shadow-2xl overflow-hidden"
          style={{ top: dropPos.top, left: dropPos.left }}
          onMouseDown={e => e.stopPropagation()}>
          <div className="border-b border-gray-100 px-3 py-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
              <Search size={12} className="text-gray-400 flex-shrink-0" />
              <input
                                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search queue…"
                className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-gray-400 text-center">No results</p>
            ) : (
              filtered.map((sp: any) => {
                const key = sp.key;
                const isExpanded = expandedKeys.has(key);
                const subQueues = queuesByKey[key] || [];
                return (
                  <div key={key}>
                    <div className="flex w-full items-center gap-1.5 px-3 py-2 hover:bg-gray-50 transition-colors">
                      <button
                        onClick={() => toggleSpace(key)}
                        className="flex flex-1 items-center gap-2.5 text-[12.5px] text-gray-700 text-left"
                      >
                        <div className={cn(
                          'h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center',
                          selSpaces.includes(key) ? 'border-blue-600 bg-blue-600' : 'border-gray-300',
                        )}>
                          {selSpaces.includes(key) && <Check size={10} className="text-white" strokeWidth={3} />}
                        </div>
                        <span className="flex-1 truncate">{sp.name}</span>
                      </button>
                      <button
                        onClick={() => expandSpace(key)}
                        className="flex-shrink-0 rounded p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Show queues in this space"
                      >
                        <ChevronDown size={13} className={cn('transition-transform', isExpanded && 'rotate-180')} />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="ml-6 mb-1 border-l border-gray-100 pl-2">
                        {loadingKey === key ? (
                          <p className="px-2 py-1.5 text-[11.5px] text-gray-400">Loading queues…</p>
                        ) : subQueues.length === 0 ? (
                          <p className="px-2 py-1.5 text-[11.5px] text-gray-400">No queues in this space</p>
                        ) : (
                          subQueues.map((qu) => {
                            const isSel = selQueue === qu.name && selSpaces.includes(key);
                            return (
                              <button
                                key={qu.id}
                                onClick={() => selectQueue(key, qu.name)}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-gray-600 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                              >
                                <div className={cn(
                                  'h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 flex items-center justify-center',
                                  isSel ? 'border-blue-600' : 'border-gray-300',
                                )}>
                                  {isSel && <div className="h-1.5 w-1.5 rounded-full bg-blue-600" />}
                                </div>
                                <span className="flex-1 truncate text-left">{qu.name}</span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {(selSpaces.length > 0 || selQueue) && (
            <div className="border-t border-gray-100 px-3 py-2">
              <button
                onClick={() => { onSpacesChange([]); onQueueChange(''); }}
                className="text-[11.5px] text-blue-600 font-medium hover:text-blue-800"
              >
                Clear
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ─── save-name modal ─── */
function SaveModal({
  criteria, editFilter, onClose, onSaved,
}: {
  criteria: FilterCriteria; editFilter?: SavedFilter | null;
  onClose: () => void; onSaved: (f: SavedFilter) => void;
}) {
  const [name, setName] = useState(editFilter?.name || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleSave = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    setSaving(true);
    try {
      let res: SavedFilter;
      if (editFilter) {
        res = await api.updateFilter(editFilter.id, { name: name.trim(), criteria }) as any;
      } else {
        res = await api.createFilter({ name: name.trim(), criteria }) as any;
      }
      onSaved(res);
    } catch (e: any) { setErr(e.message || 'Failed'); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[420px] rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-gray-900">{editFilter ? 'Update filter' : 'Save filter'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={17} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12.5px] text-red-700">{err}</div>}
          <div>
            <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">Filter name <span className="text-red-500">*</span></label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="e.g. My open bugs"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-[12.5px] font-medium text-gray-700 hover:bg-white transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="rounded-md bg-blue-600 px-5 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : editFilter ? 'Update' : 'Save filter'}
          </button>
        </div>
      </div>
    </div>
  );
}

const IN_RANGE_PRESETS = [
  { value: 'today',     label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d',        label: 'Last 7 days' },
  { value: '30d',       label: 'Last 30 days' },
  { value: '90d',       label: 'Last 90 days' },
];

type DateMode = 'withinLast' | 'moreThan' | 'between' | 'inRange';

/** Encode date filter to a string for the API */
function encodeDateFilter(mode: DateMode, n: string, unit: string, from: string, to: string, preset: string): string {
  if (mode === 'withinLast') return `withinLast:${n || 7}:${unit || 'days'}`;
  if (mode === 'moreThan')   return `moreThan:${n || 7}:${unit || 'days'}`;
  if (mode === 'between')    return `between:${from}:${to}`;
  if (mode === 'inRange')    return preset || '7d';
  return '';
}

/** Decode string back to display label for the button */
function decodeDateLabel(val: string): string {
  if (!val) return '';
  if (val.startsWith('withinLast:')) {
    const [, n, unit] = val.split(':');
    return `Within last ${n} ${unit}`;
  }
  if (val.startsWith('moreThan:')) {
    const [, n, unit] = val.split(':');
    // Redefined per explicit request: this used to be open-ended ("N+
    // units ago, no upper bound"), which always returned a huge count on
    // an established dataset -- confirmed the expectation was actually a
    // single bounded window ("exactly N units ago"), matching what "In the
    // range -> Yesterday" already does for N=1 day. Label updated to match
    // -- "More than" would now be actively misleading for what this
    // actually computes.
    return `Exactly ${n} ${unit} ago`;
  }
  if (val.startsWith('between:')) {
    const parts = val.split(':');
    return `${parts[1]} → ${parts[2]}`;
  }
  return IN_RANGE_PRESETS.find((p) => p.value === val)?.label || val;
}

/** Today's date as YYYY-MM-DD for default */
// Local calendar date -- toISOString() is UTC, which gave yesterday's date
// before 05:30 IST.
function localDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() {
  return localDateStr(new Date());
}
function daysAgoStr(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/* ─── Jira-style Date dropdown (Within last / More than / Between / In range) ─── */
function DateDropBtn({
  label, selected, onChange, align = 'left',
}: {
  label: string;
  selected: string;
  onChange: (v: string) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // local draft state
  const [mode, setMode]         = useState<DateMode>('withinLast');
  const [wlN, setWlN]           = useState('7');
  const [wlUnit, setWlUnit]     = useState('days');
  const [mtN, setMtN]           = useState('7');
  const [mtUnit, setMtUnit]     = useState('days');
  const [btFrom, setBtFrom]     = useState(daysAgoStr(7));
  const [btTo, setBtTo]         = useState(todayStr());
  const [preset, setPreset]     = useState('7d');

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);

  // when opening, decode current value into draft
  const handleOpen = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setDropPos(align === 'right'
        ? { top: r.bottom + 4, left: r.right - 288 }
        : { top: r.bottom + 4, left: r.left });
    }
    if (selected) {
      if (selected.startsWith('withinLast:')) {
        const [, n, u] = selected.split(':'); setMode('withinLast'); setWlN(n); setWlUnit(u);
      } else if (selected.startsWith('moreThan:')) {
        const [, n, u] = selected.split(':'); setMode('moreThan'); setMtN(n); setMtUnit(u);
      } else if (selected.startsWith('between:')) {
        const parts = selected.split(':'); setMode('between'); setBtFrom(parts[1]); setBtTo(parts[2]);
      } else {
        setMode('inRange'); setPreset(selected);
      }
    }
    setOpen(true);
  };

  const handleUpdate = () => {
    // Always passed wlN/wlUnit ("Within the last") regardless of which mode
    // was actually selected -- encodeDateFilter's 'moreThan' branch then
    // silently used the untouched "Within the last" value (default 7)
    // instead of whatever was typed into the "More than" field. Confirmed
    // for real: "Created: More than 7 days ago" never changed no matter
    // what was typed, while "Updated" (using "Within the last") worked
    // fine. Pass each mode's own n/unit instead.
    const n = mode === 'moreThan' ? mtN : wlN;
    const unit = mode === 'moreThan' ? mtUnit : wlUnit;
    const val = encodeDateFilter(mode, n, unit, btFrom, btTo, preset);
    onChange(val);
    setOpen(false);
  };

  const active = Boolean(selected);

  const unitSelect = (val: string, set: (v: string) => void) => (
    <select value={val} onChange={(e) => set(e.target.value)}
      className="rounded border border-gray-300 bg-white px-2 py-1 text-[12px] text-gray-700 outline-none focus:border-blue-500 cursor-pointer">
      <option value="days">days</option>
      <option value="weeks">weeks</option>
      <option value="months">months</option>
    </select>
  );

  const RadioRow = ({ m, children }: { m: DateMode; children: React.ReactNode }) => (
    <div
      onClick={() => setMode(m)}
      className={cn(
        'flex cursor-pointer flex-col gap-1.5 rounded-md px-3 py-2.5 transition-colors',
        mode === m ? 'bg-blue-50' : 'hover:bg-gray-50',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className={cn(
          'h-4 w-4 flex-shrink-0 rounded-full border-2 flex items-center justify-center',
          mode === m ? 'border-blue-600' : 'border-gray-300',
        )}>
          {mode === m && <div className="h-2 w-2 rounded-full bg-blue-600" />}
        </div>
        {children}
      </div>
    </div>
  );

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={handleOpen}
        className={cn(
          'flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50',
        )}
      >
        {active ? `${label}: ${decodeDateLabel(selected)}` : label}
        {active ? (
          <span onClick={(e) => { e.stopPropagation(); onChange(''); }} className="ml-0.5 text-blue-400 hover:text-blue-700 cursor-pointer">
            <X size={11} />
          </span>
        ) : (
          <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />
        )}
      </button>

      {open && dropPos && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          className="fixed z-[9999] w-72 rounded-lg border border-gray-200 bg-white shadow-2xl overflow-hidden"
          style={{ top: dropPos.top, left: dropPos.left }}
        >
          <div className="divide-y divide-gray-100 py-1">

            {/* Within the last */}
            <RadioRow m="withinLast">
              <span className="text-[13px] font-medium text-gray-800 flex-1">Within the last</span>
            </RadioRow>
            {mode === 'withinLast' && (
              <div className="flex items-center gap-2 bg-blue-50 px-3 py-2">
                <input type="number" min={1} value={wlN} onChange={(e) => setWlN(e.target.value)}
                  className="w-16 rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 outline-none focus:border-blue-500" />
                {unitSelect(wlUnit, setWlUnit)}
              </div>
            )}

            {/* "Exactly N ago" -- a single bounded window ending N units
                ago, not an open-ended "anytime before N units ago" (see
                decodeDateLabel's own comment for why this was renamed from
                "More than"). */}
            <RadioRow m="moreThan">
              <span className="text-[13px] font-medium text-gray-800 flex-1">Exactly</span>
            </RadioRow>
            {mode === 'moreThan' && (
              <div className="flex items-center gap-2 bg-blue-50 px-3 py-2">
                <input type="number" min={1} value={mtN} onChange={(e) => setMtN(e.target.value)}
                  className="w-16 rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 outline-none focus:border-blue-500" />
                {unitSelect(mtUnit, setMtUnit)}
                <span className="text-[11.5px] text-gray-500">ago</span>
              </div>
            )}

            {/* Between */}
            <RadioRow m="between">
              <span className="text-[13px] font-medium text-gray-800 flex-1">Between</span>
            </RadioRow>
            {mode === 'between' && (
              <div className="flex items-center gap-2 bg-blue-50 px-3 py-2 flex-wrap">
                <input type="date" value={btFrom} onChange={(e) => setBtFrom(e.target.value)}
                  className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 outline-none focus:border-blue-500" />
                <span className="text-[11.5px] text-gray-500">and</span>
                <input type="date" value={btTo} onChange={(e) => setBtTo(e.target.value)}
                  className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 outline-none focus:border-blue-500" />
              </div>
            )}

            {/* In the range */}
            <RadioRow m="inRange">
              <span className="text-[13px] font-medium text-gray-800 flex-1">In the range</span>
            </RadioRow>
            {mode === 'inRange' && (
              <div className="bg-blue-50 px-3 py-2 space-y-0.5">
                {IN_RANGE_PRESETS.map((p) => (
                  <button key={p.value} onClick={() => setPreset(p.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12.5px] transition-colors',
                      preset === p.value ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-700 hover:bg-blue-100',
                    )}>
                    <div className={cn(
                      'h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 flex items-center justify-center',
                      preset === p.value ? 'border-blue-600' : 'border-gray-400',
                    )}>
                      {preset === p.value && <div className="h-1.5 w-1.5 rounded-full bg-blue-600" />}
                    </div>
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-3 py-2.5">
            {selected && (
              <button onClick={() => { onChange(''); setOpen(false); }}
                className="text-[12px] text-gray-500 hover:text-red-500 transition-colors">
                Clear
              </button>
            )}
            <button onClick={handleUpdate}
              className="ml-auto rounded-md bg-blue-600 px-4 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700 transition-colors">
              Update
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// The table's own fixed (non-filter-driven) columns -- Key/Work are always
// shown (they're the ticket's identity), everything else here can be
// hidden via the "Columns" button. Added by explicit request: with
// Key/Work plus up to several "More filters" columns plus all 7 of these,
// nothing fits on one screen without horizontal scrolling no matter how
// narrow each column gets -- letting people hide the ones they don't care
// about (Time Spent, SLA Breached, etc.) means the ones they DO want can
// actually fit without scrolling.
const STATIC_COLUMN_OPTIONS = [
  { value: 'assignee', label: 'Assignee' },
  { value: 'reportedBy', label: 'Reported By' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'slaBreached', label: 'SLA Breached' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'timeSpent', label: 'Time Spent' },
];
const STATIC_COLUMN_IDS = STATIC_COLUMN_OPTIONS.map((c) => c.value);
const VISIBLE_COLUMNS_STORAGE_KEY = 'filters_visible_static_columns_v1';

// All available "extra" filter options that can be added to the bar from More filters
const EXTRA_FILTER_OPTIONS = [
  { id: 'reporter',       label: 'Reporter',        group: 'People' },
  { id: 'projectManager', label: 'Project Manager', group: 'People' },
  { id: 'priority',       label: 'Priority',        group: 'Issue' },
  { id: 'department',     label: 'Department',      group: 'Issue' },
  { id: 'productType',    label: 'Product Type',    group: 'Issue' },
  { id: 'productionTicket', label: 'Production Ticket', group: 'Issue' },
  { id: 'combination',    label: 'Combination',     group: 'Issue' },
  { id: 'customerName',   label: 'Customer Name',   group: 'Issue' },
  { id: 'clientName',     label: 'Client Name',     group: 'Issue' },
  { id: 'projectPool',    label: 'Project Pool',    group: 'Issue' },
  { id: 'infraIssueType', label: 'Infra Issue Type', group: 'Issue' },
  { id: 'created',        label: 'Created date',    group: 'Date' },
  { id: 'updated',        label: 'Updated date',    group: 'Date' },
  { id: 'worked',         label: 'Worked',          group: 'Date' },
  { id: 'dueDate',        label: 'Due Date',        group: 'Date' },
  { id: 'resolved',       label: 'Resolved date',   group: 'Date' },
];

/* ─── Simple text filter button ─── */
function TextFilterBtn({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  // Keep the panel glued to the button while scrolling instead of staying wherever
  // it first appeared (see the identical fix + comment on DropBtn above).
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);
  const active = Boolean(value);
  const handleToggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(v => !v);
  };
  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={handleToggle}
        className={cn('flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50')}>
        {active ? `${label}: ${value}` : label}
        {active
          ? <span onClick={(e) => { e.stopPropagation(); onChange(''); }} className="ml-0.5 text-blue-400 hover:text-blue-700 cursor-pointer"><X size={11} /></span>
          : <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && dropPos && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          className="fixed z-[9999] w-56 rounded-lg border border-gray-200 bg-white shadow-2xl p-3"
          style={{ top: dropPos.top, left: dropPos.left }}
        >
          <input value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { onChange(draft); setOpen(false); } if (e.key === 'Escape') setOpen(false); }}
            placeholder={`Filter by ${label.toLowerCase()}…`}
            className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
          <div className="flex gap-2 mt-2">
            <button onClick={() => { onChange(draft); setOpen(false); }}
              className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700">Apply</button>
            {value && <button onClick={() => { onChange(''); setDraft(''); setOpen(false); }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">Clear</button>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/* ─── More filters dropdown — all filters are "add to bar" style ─── */
function MoreFiltersBtn({
  activeExtras, onToggleExtra,
}: {
  activeExtras: string[];
  onToggleExtra: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
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

  const handleToggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.right - 240 });
    }
    setOpen(v => !v);
  };

  const qLow = q.trim().toLowerCase();
  const filtered = EXTRA_FILTER_OPTIONS.filter((o) =>
    !qLow || o.label.toLowerCase().includes(qLow) || o.group.toLowerCase().includes(qLow),
  );

  const visibleGroups = ['People', 'Issue', 'Date'].filter((g) =>
    filtered.some((o) => o.group === g),
  );

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          activeExtras.length > 0
            ? 'border-blue-500 bg-blue-50 text-blue-700'
            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50',
        )}
      >
        More filters
        {activeExtras.length > 0 && (
          <span className="ml-0.5 text-[10px] font-bold text-blue-600">({activeExtras.length})</span>
        )}
        <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && dropPos && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          className="fixed z-[9999] w-60 rounded-lg border border-gray-200 bg-white shadow-2xl overflow-hidden"
          style={{ top: dropPos.top, left: dropPos.left }}
        >
          {/* search */}
          <div className="border-b border-gray-100 px-3 py-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
              <Search size={12} className="text-gray-400 flex-shrink-0" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search filters…"
                className="flex-1 bg-transparent text-[12px] text-gray-700 outline-none placeholder:text-gray-400"
              />
              {q && <button onClick={() => setQ('')}><X size={11} className="text-gray-400" /></button>}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {visibleGroups.length === 0 ? (
              <p className="px-4 py-4 text-[12px] text-gray-400 text-center">No results for &ldquo;{q}&rdquo;</p>
            ) : (
              visibleGroups.map((group) => (
                <div key={group}>
                  <p className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">{group}</p>
                  {filtered.filter((o) => o.group === group).map((opt) => {
                    const added = activeExtras.includes(opt.id);
                    return (
                      <button
                        key={opt.id}
                        onClick={() => { onToggleExtra(opt.id); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-[12.5px] text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <div className={cn(
                          'h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors',
                          added ? 'border-blue-600 bg-blue-600' : 'border-gray-300',
                        )}>
                          {added && <Check size={10} className="text-white" strokeWidth={3} />}
                        </div>
                        <span className="flex-1 text-left font-medium">{opt.label}</span>
                        {!added && (
                          <span className="text-[10.5px] text-blue-500 font-semibold">+ Add</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/* ─── SLA Breached single-select button ─── */
// Generalized from what used to be SLA-Breached-only (SlaBreachedBtn) so the
// same Yes/No quick-filter chrome can drive a second, independent condition
// (Overdue) without duplicating this whole dropdown.
function YesNoFilterBtn({ value, onChange, label: baseLabel, yesLabel, noLabel }: {
  value: 'yes' | 'no' | ''; onChange: (v: 'yes' | 'no' | '') => void;
  label: string; yesLabel: string; noLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((v) => !v);
  };

  const active = Boolean(value);
  const label = value === 'yes' ? `${baseLabel}: Yes` : value === 'no' ? `${baseLabel}: No` : baseLabel;

  return (
    <div ref={ref} className="flex-shrink-0">
      <button
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1 rounded border px-3 py-1.5 text-[12.5px] font-medium transition-colors whitespace-nowrap',
          active ? 'border-red-400 bg-red-50 text-red-600' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50',
        )}
      >
        {label}
        {active
          ? <span onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false); }} className="ml-0.5 text-red-400 hover:text-red-600 cursor-pointer"><X size={11} /></span>
          : <ChevronDown size={12} className={cn('ml-0.5 text-gray-400 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && dropPos && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-[9999] w-44 rounded-lg border border-gray-200 bg-white shadow-2xl overflow-hidden"
          style={{ top: dropPos.top, left: dropPos.left }}
          onMouseDown={e => e.stopPropagation()}>
          <div className="py-1">
            {([['yes', yesLabel, 'text-red-600', 'bg-red-50'], ['no', noLabel, 'text-gray-700', 'bg-gray-50']] as const).map(([v, lbl, textCls, bgCls]) => (
              <button key={v} onClick={() => { onChange(value === v ? '' : v); setOpen(false); }}
                className={cn('flex w-full items-center gap-2.5 px-3 py-2.5 text-[12.5px] transition-colors hover:bg-gray-50', value === v && bgCls)}>
                <div className={cn('h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center', value === v ? 'border-blue-600 bg-blue-600' : 'border-gray-300')}>
                  {value === v && <Check size={10} className="text-white" strokeWidth={3} />}
                </div>
                <span className={cn('font-medium', value === v ? textCls : 'text-gray-700')}>{lbl}</span>
              </button>
            ))}
          </div>
          {value && (
            <div className="border-t border-gray-100 px-3 py-2">
              <button onClick={() => { onChange(''); setOpen(false); }} className="text-[11.5px] text-blue-600 font-medium hover:text-blue-800">Clear</button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ─── main page ─── */
export default function FiltersPage() {
  const { user, spaces } = useStore(useShallow((s) => ({ user: s.user, spaces: s.spaces })));
  const router = useRouter();

  const [PROJECT_MANAGER_OPTIONS, setProjectManagerOptions] = useState<string[]>(['Others']);
  useEffect(() => { api.getProjectManagerOptions().then(setProjectManagerOptions).catch(() => {}); }, []);

  // Customer Name / Client Name used to be a plain free-text box with no
  // visible options at all, whose typed value then had to EXACTLY match a
  // ticket's stored value server-side (same "comes from a DB dropdown"
  // assumption every field in this family makes) -- so almost anything
  // typed returned zero results with no indication why. Fetching the real,
  // currently-used values (same GET /field-values this app already uses
  // for other pickers) and offering them as a searchable multi-select
  // fixes both: the options are now visible, and a selected value is
  // guaranteed to match exactly.
  const [CUSTOMER_NAME_OPTIONS, setCustomerNameOptions] = useState<string[]>([]);
  const [CLIENT_NAME_OPTIONS, setClientNameOptions] = useState<string[]>([]);
  useEffect(() => { api.getFieldValues('customerName').then(setCustomerNameOptions).catch(() => {}); }, []);
  useEffect(() => { api.getFieldValues('clientName').then(setClientNameOptions).catch(() => {}); }, []);

  /* filter bar state */
  const [text, setText]                   = useState('');
  const [selSpaces, setSelSpaces]         = useState<string[]>([]);
  const [selQueue, setSelQueue]           = useState('');  // custom queue name within a single selected space
  // "Routed to X" (and any other custom queue status) only lives inside that
  // queue's own queueStatuses config, never in the space's real statuses
  // table -- confirmed for real, no ticket in this app ever carries "Routed
  // to X" as its actual global status, since picking one only updates
  // dept_statuses for non-done categories (see the backend's queueStatusId
  // handler). The Status filter dropdown's ALLOWED_STATUSES list below could
  // never offer these as options without fetching them from here.
  const [queueStatusOptions, setQueueStatusOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!selQueue || selSpaces.length !== 1) { setQueueStatusOptions([]); return; }
    let cancelled = false;
    api.request<any[]>(`custom-queues/${selSpaces[0]}`).then((queues) => {
      if (cancelled) return;
      const q = (queues || []).find((qq: any) => (qq.name || '').toLowerCase() === selQueue.toLowerCase());
      const names: { value: string; label: string }[] = (q?.queueStatuses || []).map((s: any) => ({ value: s.name, label: s.name }));
      setQueueStatusOptions(names);
    }).catch(() => { if (!cancelled) setQueueStatusOptions([]); });
    return () => { cancelled = true; };
  }, [selQueue, selSpaces]);
  const [selAssignees, setSelAssignees]   = useState<string[]>([]);  // stores member IDs
  const [selReporters, setSelReporters]   = useState<string[]>([]);  // stores member IDs
  const [selTypes, setSelTypes]           = useState<string[]>([]);
  const [selStatuses, setSelStatuses]     = useState<string[]>([]);
  const [selPriorities, setSelPriorities] = useState<string[]>([]);
  const [selCreated, setSelCreated]       = useState('');
  const [selUpdated, setSelUpdated]       = useState('');
  // "Worked" means something categorically different from Created/Updated:
  // it changes what Assignee itself means (current owner -> who actually did
  // the work here), and what Queue means (currently in this dept -> ever
  // genuinely worked in this dept), not just an additional date bound on top
  // of the same semantics. No backend union support with created/updated
  // exists for it (unlike created+updated, which the backend does union) --
  // kept mutually exclusive with all three date filters below, same as
  // Due Date already is.
  const [selWorked, setSelWorked]         = useState('');
  const [selDueDate, setSelDueDate]       = useState('');
  const [selResolved, setSelResolved]     = useState('');
  const [selDepartment, setSelDepartment] = useState('');
  const [selProductType, setSelProductType] = useState<string[]>([]);
  const [selProductionTicket, setSelProductionTicket] = useState<string[]>([]);
  const [selCombination, setSelCombination] = useState('');
  const [selCustomerName, setSelCustomerName] = useState<string[]>([]);
  const [selClientName, setSelClientName] = useState<string[]>([]);
  const [selProjectManager, setSelProjectManager] = useState<string[]>([]);
  const [selProjectPool, setSelProjectPool] = useState('');
  const [selInfraIssueType, setSelInfraIssueType] = useState<string[]>([]);
  const [selBreached, setSelBreached] = useState<'yes' | 'no' | ''>('');
  const [selOverdue, setSelOverdue] = useState<'yes' | 'no' | ''>('');

  /* issues */
  const [issues, setIssues]   = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
  // 1000, not 100 -- by request, a normal filtered view (hundreds of
  // matches) should show entirely on one screen with no clicking through
  // pages at all. This page used to fetch page=1/limit=100 unconditionally
  // with no way to see anything past the first 100 matches (confirmed for
  // real: filtering "Aug 1 - Aug 31", 696 matching tickets sorted newest
  // first, silently cut off everything before roughly mid-August). The
  // Prev/Next control added alongside this stays as a safety net only for
  // the rare case a filter (or no filter at all) matches more than 1000.
  // Confirmed for real via DevTools Network tab: an unfiltered view's
  // issues fetch was taking 11+ seconds and transferring 2.64MB (1000 full
  // issue objects, each with nested status/assignee/reporter) -- exactly
  // what the comment at this constant's own use-site already described as
  // the problem, but the constant itself had drifted back up to 1000 at
  // some point independent of that comment. The OTHER historical bug this
  // value's size was once entangled with (the render loop silently only
  // ever showing the first 100 of whatever was fetched, regardless of
  // PAGE_SIZE) is a separate, already-fixed issue -- see the comment above
  // the issues.map() render loop -- so lowering this again does not
  // reintroduce it.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* saved filters */
  const [savedFilters, setSavedFilters]         = useState<SavedFilter[]>([]);
  const [activeFilterId, setActiveFilterId]     = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal]        = useState(false);
  const [editingFilter, setEditingFilter]        = useState<SavedFilter | null>(null);
  const [showSavedPanel, setShowSavedPanel]      = useState(false);
  const [menuId, setMenuId]                     = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId]   = useState<string | null>(null);
  // which extra date filters are visible in the bar (added from More filters).
  // "created" starts visible by default -- a date range is a common enough
  // filter that requiring a trip through "More filters" to find it every
  // single time wasn't discoverable; it can still be removed via its own X.
  const [activeExtras, setActiveExtras]         = useState<string[]>(['created']);

  // Created and Updated were mutually exclusive here on the theory that
  // "two date filters silently combine into a number that doesn't mean
  // what either one alone would suggest" -- true in general (still applies
  // to Due Date below), but Created+Updated together now has a real,
  // well-defined meaning: the backend unions them (everything created in
  // that window, plus everything updated in that window), verified against
  // production data. Keeping them force-exclusive in the UI meant that
  // backend support was simply unreachable -- there was no way to ever
  // send both params at once. Due Date has no such union support on the
  // backend, so it stays exclusive with both.
  const DATE_GROUP_KEYS = ['created', 'updated', 'worked', 'dueDate', 'resolved'];
  // Worked/Due Date/Resolved date stand apart from created/updated: none of
  // these may combine with each other (same reasoning as dueDate's existing
  // isolation -- each changes what the date column itself means, rather
  // than narrowing the same created/updated window further).
  const EXCLUSIVE_DATE_KEYS = ['worked', 'dueDate', 'resolved'];
  const clearExtraValue = (key: string) => {
    if (key === 'created')        setSelCreated('');
    if (key === 'updated')        setSelUpdated('');
    if (key === 'worked')         setSelWorked('');
    if (key === 'dueDate')        setSelDueDate('');
    if (key === 'resolved')       setSelResolved('');
    if (key === 'reporter')       setSelReporters([]);
    if (key === 'priority')       setSelPriorities([]);
    if (key === 'department')     setSelDepartment('');
    if (key === 'productType')    setSelProductType([]);
    if (key === 'productionTicket') setSelProductionTicket([]);
    if (key === 'combination')    setSelCombination('');
    if (key === 'customerName')   setSelCustomerName([]);
    if (key === 'clientName')     setSelClientName([]);
    if (key === 'projectManager') setSelProjectManager([]);
    if (key === 'projectPool')    setSelProjectPool('');
    if (key === 'infraIssueType') setSelInfraIssueType([]);
  };
  const toggleExtra = (key: string) => {
    setActiveExtras((prev) => {
      if (prev.includes(key)) {
        clearExtraValue(key);
        return prev.filter((k) => k !== key);
      }
      let next = [...prev, key];
      if (EXCLUSIVE_DATE_KEYS.includes(key)) {
        // Worked/Due Date exclusive with every other date filter -- no
        // backend union support for combining either with anything else.
        const others = DATE_GROUP_KEYS.filter((k) => k !== key && prev.includes(k));
        others.forEach(clearExtraValue);
        next = next.filter((k) => !others.includes(k));
      } else if (DATE_GROUP_KEYS.includes(key)) {
        // Turning on Created/Updated (which DO union with each other) still
        // needs to kick out any exclusive one (Worked or Due Date) already
        // active -- scoped to just these two date keys, not every other
        // unrelated filter (Reporter, Priority, ...) that also reaches here.
        const exclusiveActive = EXCLUSIVE_DATE_KEYS.filter((k) => prev.includes(k));
        exclusiveActive.forEach(clearExtraValue);
        next = next.filter((k) => !exclusiveActive.includes(k));
      }
      return next;
    });
  };

  // Hydrate filters from the URL once on mount. Two sources feed this:
  // (1) other pages (e.g. the personal dashboard) deep-linking straight into
  //     a scoped ticket list here, using assignee/reporter/status/priority/
  //     space/queue/slaBreached (singular names, kept for backward compat);
  // (2) this page's OWN state, round-tripped through the URL by the sync
  //     effect below -- opening a ticket and clicking "Back" returns to this
  //     exact URL, but Next.js doesn't restore this component's in-memory
  //     useState across that navigation, so without the URL round-trip every
  //     filter the user had picked reset back to defaults on return.
  const urlParams = useSearchParams();
  useEffect(() => {
    const qpAssignee = urlParams?.get('assignee');
    const qpReporter = urlParams?.get('reporter');
    const qpStatus = urlParams?.get('status');
    const qpPriority = urlParams?.get('priority');
    const qpSpace = urlParams?.get('space');
    const qpQueue = urlParams?.get('queue');
    // Deep-linked from the Dashboard's SLA tiles/donut (e.g. "Breached 21" ->
    // ?slaBreached=yes) -- buildFilterParams below already sends this same
    // param outbound on every fetch, but nothing ever read it back in on
    // load, so a link built with slaBreached=yes silently showed every one
    // of that person's tickets instead of just the breached ones.
    const qpSlaBreached = urlParams?.get('slaBreached');
    const qpOverdue = urlParams?.get('overdue');

    if (qpAssignee) setSelAssignees(qpAssignee.split(','));
    if (qpReporter) {
      setSelReporters(qpReporter.split(','));
      setActiveExtras((prev) => (prev.includes('reporter') ? prev : [...prev, 'reporter']));
    }
    if (qpStatus) setSelStatuses(qpStatus.split(','));
    if (qpPriority) {
      setSelPriorities(qpPriority.split(','));
      setActiveExtras((prev) => (prev.includes('priority') ? prev : [...prev, 'priority']));
    }
    if (qpSpace) setSelSpaces([qpSpace]);
    if (qpQueue) setSelQueue(qpQueue);
    // SlaBreachedBtn lives directly in the main toolbar (not behind "More
    // filters"), so unlike reporter/priority above there's no activeExtras
    // entry to also flip for it to become visible.
    if (qpSlaBreached === 'yes' || qpSlaBreached === 'no') setSelBreached(qpSlaBreached);
    if (qpOverdue === 'yes' || qpOverdue === 'no') setSelOverdue(qpOverdue);

    // Full self-persistence round-trip (written by the sync effect below,
    // using its own distinct param names so it never collides with the
    // external deep-link names read above).
    const rSpaces          = urlParams?.get('rSpaces');
    const rQueue           = urlParams?.get('rQueue');
    const rAssignees       = urlParams?.get('rAssignees');
    const rReporters       = urlParams?.get('rReporters');
    const rTypes           = urlParams?.get('rTypes');
    const rStatuses        = urlParams?.get('rStatuses');
    const rPriorities      = urlParams?.get('rPriorities');
    const rCreated         = urlParams?.get('rCreated');
    const rUpdated         = urlParams?.get('rUpdated');
    const rWorked          = urlParams?.get('rWorked');
    const rDueDate         = urlParams?.get('rDueDate');
    const rResolved        = urlParams?.get('rResolved');
    const rDepartment      = urlParams?.get('rDepartment');
    const rProductType     = urlParams?.get('rProductType');
    const rProductionTicket = urlParams?.get('rProductionTicket');
    const rCombination     = urlParams?.get('rCombination');
    const rCustomerName    = urlParams?.get('rCustomerName');
    const rClientName      = urlParams?.get('rClientName');
    const rProjectManager  = urlParams?.get('rProjectManager');
    const rProjectPool     = urlParams?.get('rProjectPool');
    const rInfraIssueType  = urlParams?.get('rInfraIssueType');
    const rBreached        = urlParams?.get('rBreached');
    const rOverdue         = urlParams?.get('rOverdue');
    const rQ               = urlParams?.get('rQ');
    const rExtras          = urlParams?.get('rExtras');

    if (rSpaces) setSelSpaces(rSpaces.split(','));
    if (rQueue) setSelQueue(rQueue);
    if (rAssignees) setSelAssignees(rAssignees.split(','));
    if (rReporters) setSelReporters(rReporters.split(','));
    if (rTypes) setSelTypes(rTypes.split(','));
    if (rStatuses) setSelStatuses(rStatuses.split(','));
    if (rPriorities) setSelPriorities(rPriorities.split(','));
    if (rCreated) setSelCreated(rCreated);
    if (rUpdated) setSelUpdated(rUpdated);
    if (rWorked) setSelWorked(rWorked);
    if (rDueDate) setSelDueDate(rDueDate);
    if (rResolved) setSelResolved(rResolved);
    if (rDepartment) setSelDepartment(rDepartment);
    const pipeSep = urlParams?.get('rSep') === 'pipe';
    if (rProductType) setSelProductType(splitMultiParam(rProductType, pipeSep));
    if (rProductionTicket) setSelProductionTicket(splitMultiParam(rProductionTicket, pipeSep));
    if (rCombination) setSelCombination(rCombination);
    if (rCustomerName) setSelCustomerName(splitMultiParam(rCustomerName, pipeSep));
    if (rClientName) setSelClientName(splitMultiParam(rClientName, pipeSep));
    if (rProjectManager) setSelProjectManager(rProjectManager.split('|||'));
    if (rProjectPool) setSelProjectPool(rProjectPool);
    if (rInfraIssueType) setSelInfraIssueType(splitMultiParam(rInfraIssueType, pipeSep));
    if (rBreached === 'yes' || rBreached === 'no') setSelBreached(rBreached);
    if (rOverdue === 'yes' || rOverdue === 'no') setSelOverdue(rOverdue);
    if (rQ) setText(rQ);
    // rExtras and each field's own r* param are two SEPARATE pieces of
    // persisted state -- a URL that sets e.g. rProjectManager without also
    // listing 'projectManager' in rExtras (an older saved link, a deep-link
    // built elsewhere in the app that only set the value param) silently
    // restored the filter value while leaving its chip inactive, which in
    // turn made the Export button drop that field's column with no visible
    // sign anything was wrong. Whichever of these r* params is present
    // always implies its chip should be active too, regardless of what
    // rExtras itself says.
    const impliedExtras = [
      rProductType && 'productType', rProductionTicket && 'productionTicket', rCombination && 'combination', rCustomerName && 'customerName',
      rClientName && 'clientName', rProjectManager && 'projectManager', rProjectPool && 'projectPool',
      rInfraIssueType && 'infraIssueType',
      rWorked && 'worked', rDueDate && 'dueDate', rResolved && 'resolved',
    ].filter(Boolean) as string[];
    if (rExtras || impliedExtras.length) {
      setActiveExtras(Array.from(new Set([...(rExtras ? rExtras.split(',') : []), ...impliedExtras])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the URL in sync with every filter selection (via replace, so it
  // never grows browser history) -- this is what lets "Back" from a ticket
  // actually restore the exact filters that were active, since this
  // component's useState doesn't otherwise survive that navigation.
  // Skips its own first invocation: on mount, this fires with the pre-
  // hydration (default/empty) state before the effect above has applied
  // whatever was in the URL, and writing that out first would blank the URL
  // for an instant before the hydrated values overwrite it again.
  const skippedFirstUrlSyncRef = useRef(false);
  const restoreParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (selSpaces.length) p.rSpaces = selSpaces.join(',');
    if (selQueue) p.rQueue = selQueue;
    if (selAssignees.length) p.rAssignees = selAssignees.join(',');
    if (selReporters.length) p.rReporters = selReporters.join(',');
    if (selTypes.length) p.rTypes = selTypes.join(',');
    if (selStatuses.length) p.rStatuses = selStatuses.join(',');
    if (selPriorities.length) p.rPriorities = selPriorities.join(',');
    if (selCreated) p.rCreated = selCreated;
    if (selUpdated) p.rUpdated = selUpdated;
    if (selWorked) p.rWorked = selWorked;
    if (selDueDate) p.rDueDate = selDueDate;
    if (selResolved) p.rResolved = selResolved;
    if (selDepartment) p.rDepartment = selDepartment;
    if (selProductType.length) p.rProductType = selProductType.join(MULTI_SEP);
    if (selProductionTicket.length) p.rProductionTicket = selProductionTicket.join(MULTI_SEP);
    if (selCombination) p.rCombination = selCombination;
    if (selCustomerName.length) p.rCustomerName = selCustomerName.join(MULTI_SEP);
    if (selClientName.length) p.rClientName = selClientName.join(MULTI_SEP);
    if (selProjectManager.length) p.rProjectManager = selProjectManager.join('|||');
    if (selProjectPool) p.rProjectPool = selProjectPool;
    if (selInfraIssueType.length) p.rInfraIssueType = selInfraIssueType.join(MULTI_SEP);
    if (p.rProductType || p.rProductionTicket || p.rCustomerName || p.rClientName || p.rInfraIssueType) p.rSep = 'pipe';
    if (selBreached) p.rBreached = selBreached;
    if (selOverdue) p.rOverdue = selOverdue;
    if (text.trim()) p.rQ = text.trim();
    if (activeExtras.length) p.rExtras = activeExtras.join(',');
    return p;
  }, [selSpaces, selQueue, selAssignees, selReporters, selTypes, selStatuses, selPriorities, selCreated, selUpdated, selWorked, selDueDate, selResolved, selDepartment, selProductType, selProductionTicket, selCombination, selCustomerName, selClientName, selProjectManager, selProjectPool, selInfraIssueType, selBreached, selOverdue, text, activeExtras]);

  useEffect(() => {
    if (!skippedFirstUrlSyncRef.current) { skippedFirstUrlSyncRef.current = true; return; }
    const qs = new URLSearchParams(restoreParams).toString();
    router.replace(qs ? `/filters?${qs}` : '/filters', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreParams]);


  /* derived */
  // When specific spaces are selected, only show statuses that belong to those spaces.
  // If no space filter is active, show statuses from all spaces.
  const filteredSpacesForStatus = selSpaces.length > 0
    ? spaces.filter((sp: any) => selSpaces.includes(sp.key))
    : spaces;
  // Every status the selected spaces actually have -- a fixed allowlist used
  // to gate this list, which hid any other real status (it could never be
  // picked at all). Keyed case-insensitively so "Open"/"open" across spaces
  // show once; the server matches status names case-insensitively anyway.
  const availableStatuses: { value: string; label: string }[] = Array.from(
    new Map([
      ...filteredSpacesForStatus
        .flatMap((sp: any) => (sp.statuses || []))
        .filter((s: any) => (s.name || '').trim())
        .map((s: any) => [(s.name as string).toLowerCase(), { value: s.name, label: s.name, order: s.order ?? 0 }] as const),
      // Merged in on top -- the selected queue's own "Routed to X" set, only
      // ever meaningful once a specific queue is chosen (see queueStatusOptions above).
      ...queueStatusOptions.map((s) => [s.value.toLowerCase(), { ...s, order: 99 }] as const),
    ]).values()
  )
    .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
    .map((s: any) => ({ value: s.value, label: s.label }));

  // Memoized: this feeds buildFilterParams' dependency array below. Without
  // useMemo, this array got a brand-new reference every render, which broke
  // buildFilterParams' own memoization, which broke fetchIssues' memoization,
  // which re-ran the fetch effect on every render — and each fetch's state
  // update triggered another render, looping forever (visible as the table
  // repeatedly flashing "Loading..." then results, then "Loading..." again).
  const allMembers: any[] = useMemo(() => Array.from(
    new Map(spaces.flatMap((sp: any) => (sp.members || []).map((m: any) => [m.id, m]))).values(),
  ), [spaces]);

  const hasCriteria = Boolean(
    text.trim() || selSpaces.length || selQueue || selAssignees.length || selReporters.length ||
    selTypes.length || selStatuses.length || selPriorities.length ||
    selCreated || selUpdated || selWorked || selDueDate || selResolved || selDepartment ||
    selProductType.length || selProductionTicket.length || selCombination || selCustomerName.length || selClientName.length || selProjectManager.length || selProjectPool || selInfraIssueType.length || selBreached || selOverdue,
  );

  // Builds the filter params both the live table and the CSV export send —
  // shared so the export always matches exactly what's currently on screen,
  // not a second copy of this logic that could drift out of sync with it.
  const buildFilterParams = useCallback((): Record<string, string> => {
        const params: Record<string, string> = {};

        // Space(s) — always restrict to user's accessible spaces
        // If specific spaces are selected, use those; otherwise use ALL accessible spaces
        const accessibleSpaceKeys = spaces.map((sp: any) => sp.key);
        if (selSpaces.length === 1) {
          params.spaceKey = selSpaces[0];
        } else if (selSpaces.length > 1) {
          params.spaceKeys = selSpaces.join(',');
        } else if (accessibleSpaceKeys.length > 0) {
          // No specific filter: restrict to accessible spaces only (not all 25k+ issues)
          params.spaceKeys = accessibleSpaceKeys.join(',');
        }

        // Queue (department) — only meaningful when scoped to exactly one space.
        // queueMembersOnly restricts results to tickets assigned to that
        // queue's actual configured members, not every ticket merely labeled
        // with the department (the department queue board pages that share
        // this same backend branch deliberately don't set this flag, since
        // "All Tickets" there means every ticket in the department).
        if (selQueue && params.spaceKey) { params.dept = selQueue; params.queueMembersOnly = 'true'; }

        // Expand a member into all possible identifiers the mock can match against
        const expandMember = (id: string) => {
          const m = allMembers.find((mm: any) => mm.id === id);
          if (!m) return [id];
          const firstName = (m.firstName || '').trim();
          const lastName  = (m.lastName  || '').trim();
          const fullName  = [firstName, lastName].filter(Boolean).join(' ');
          const display   = (m.displayName || m.name || '').trim();
          // also include accountId / jiraId if present (Jira migration field)
          const jiraId    = (m.accountId || m.jiraId || m.jira_id || '').trim();
          return [id, m.email, fullName, firstName, display, jiraId].filter(Boolean);
        };

        if (selAssignees.length) {
          params.assignees = Array.from(new Set(selAssignees.flatMap(expandMember))).join(',');
          // Assignee = "owner or past worker" in every combination, with or
          // without a Queue (decided explicitly): the current owner, plus
          // tickets the person held or worked and handed on. The server
          // applies this for Filters requests (queueMembersOnly in the Queue
          // branch, the default broadening in the other).
        }

        if (selReporters.length) {
          params.reporters = Array.from(new Set(selReporters.flatMap(expandMember))).join(',');
        }

        // Type(s)
        if (selTypes.length)    params.type     = selTypes.join(',');

        // Status(es)
        if (selStatuses.length) params.status   = selStatuses.join(',');

        // Priority(ies)
        if (selPriorities.length) params.priority = selPriorities.join(',');

        // Date ranges
        if (selCreated) params.createdRange = selCreated;
        if (selUpdated) params.updatedRange = selUpdated;
        // "Worked" only has any effect on the backend's dept-scoped (Queue)
        // query path -- with no Queue selected it falls through to the
        // general query, which never even reads this param, and with no
        // Assignee selected there's no one for "who did the work" to
        // scope by. Sending it in either case would silently do nothing.
        if (selWorked && selQueue && selAssignees.length) params.workedRange = selWorked;
        if (selDueDate) params.dueDateRange = selDueDate;
        if (selResolved) params.resolvedRange = selResolved;

        // Hours actually spent in an "In Progress"-type status per ticket --
        // needs an extra issue_history query on the backend, so opt-in rather
        // than always paid by every issues list fetch.
        params.includeTimeSpent = 'true';

        // Extra text/field filters
        // Multi-value text fields are "|||"-joined (see MULTI_SEP) so a value
        // containing a comma isn't split in two on the server.
        params.multiSep = 'pipe';
        if (selDepartment)     params.department     = selDepartment;
        if (selProductType.length) params.productType = selProductType.join(MULTI_SEP);
        if (selProductionTicket.length) params.productionTicket = selProductionTicket.join(MULTI_SEP);
        if (selCombination)    params.combination    = selCombination;
        if (selCustomerName.length) params.customerName = selCustomerName.join(MULTI_SEP);
        if (selClientName.length)   params.clientName   = selClientName.join(MULTI_SEP);
        // Joined with a delimiter that won't collide with commas already inside a
        // stored value (e.g. "Abhishikth, Abhishek" naming two people as one value).
        if (selProjectManager.length) params.projectManager = selProjectManager.join('|||');
        if (selProjectPool)    params.projectPool    = selProjectPool;
        if (selInfraIssueType.length) params.infraIssueType = selInfraIssueType.join(MULTI_SEP);
        if (selBreached) params.slaBreached = selBreached;
        if (selOverdue) params.overdue = selOverdue;

        // Text search
        if (text.trim()) params.q = text.trim();

        return params;
  }, [spaces, selSpaces, selQueue, allMembers, selAssignees, selReporters, selTypes, selStatuses, selPriorities, selCreated, selUpdated, selWorked, selDueDate, selResolved, selDepartment, selProductType, selProductionTicket, selCombination, selCustomerName, selClientName, selProjectManager, selProjectPool, selInfraIssueType, selBreached, selOverdue, text]);

  /* fetch issues — all filtering done server-side for accuracy.
     Short (150ms) debounce -- NOT the old flat 400ms, which made every
     single filter click feel sluggish (already fixed once this session).
     But removing debouncing entirely turned out to have its own real
     problem: several of these filters (Assignee, Type, Status, Priority)
     are multi-select checkboxes that call onChange on every single click,
     with no "Apply" step -- selecting several values in a row fired one
     full fetch + up to 1000-row re-render PER CLICK, back to back, which
     could pile up faster than the browser could keep up and show a "page
     not responding" prompt. 150ms is short enough that a single deliberate
     click still feels instant, but long enough to collapse a rapid burst
     of clicks (multi-select, or fast typing in the search box) into one
     fetch instead of N. */
  const fetchIssues = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      (async () => {
        setLoadingIssues(true);
        try {
          // limit was 1000 — on an unfiltered view that's a ~2.7MB response (1000 full
          // issue objects with nested status/assignee/reporter), which is what made this
          // page take multiple seconds to load. 100 keeps a generous browsing window
          // while cutting the payload by ~90%.
          const params = { ...buildFilterParams(), page: String(page), limit: String(PAGE_SIZE) };
          const { issues: list, total: tot } = await api.getIssues(params);
          if (cancelled) return;
          setIssues(list as any[]);
          setTotal(tot);
        } catch { if (!cancelled) { setIssues([]); setTotal(0); } }
        if (!cancelled) setLoadingIssues(false);
      })();
    }, 150);
    return () => { cancelled = true; if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [buildFilterParams, page]);

  // fetchIssues returns a cancel function -- without wiring it up as this
  // effect's own cleanup, firing filter clicks in quick succession could
  // let an earlier, slower request's response land AFTER a later one's and
  // overwrite the table with stale results.
  useEffect(() => fetchIssues(), [fetchIssues]);

  // Changing any filter should land back on page 1 -- otherwise narrowing
  // the result set while sitting on, say, page 5 could point at a page
  // that no longer exists for the new filter, showing an empty table that
  // looks like "no matches" instead of what it actually is.
  useEffect(() => { setPage(1); }, [buildFilterParams]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Filters results never refreshed on their own -- someone leaving this
  // page open with a filter applied (e.g. a live Queue view during the
  // day) just kept looking at whatever it showed when they last touched a
  // filter, going stale as tickets got created/updated elsewhere. Every
  // other live list in this app already auto-refreshes on some interval
  // (department queue views every 30s, Sent/Watching every 15s) -- this
  // page never got one. Silent background refresh, same as those: never
  // clears what's currently shown while the new fetch is in flight.
  useEffect(() => {
    const id = setInterval(() => { fetchIssues(); }, 60_000);
    return () => clearInterval(id);
  }, [fetchIssues]);

  /* export current filter results to CSV — same params as the live table,
     but the server's own max page size (2000) instead of the 100-row
     browsing cap, so the export covers everything a saved/shared filter
     would actually match, not just what's currently rendered. */
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Which of STATIC_COLUMN_OPTIONS are currently shown in the results
  // table -- per-browser preference (not shared/synced), read once on
  // mount and persisted on every change. Defaults to everything visible
  // (today's behavior) when nothing's saved yet or the value can't be
  // read/parsed, so a private window or blocked storage never breaks the
  // table, just always shows every column.
  const [visibleStaticCols, setVisibleStaticCols] = useState<string[]>(STATIC_COLUMN_IDS);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setVisibleStaticCols(parsed.filter((v) => STATIC_COLUMN_IDS.includes(v)));
      }
    } catch { /* fall back to all columns visible */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(visibleStaticCols)); } catch { /* per-viewer convenience only */ }
  }, [visibleStaticCols]);
  const csvCell = (value: unknown): string => {
    const s = value == null ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Extra fields added to the filter bar via "More filters" (see
  // EXTRA_FILTER_OPTIONS/activeExtras) that don't already have a fixed export
  // column below -- reporter/priority/department/created/updated are always
  // exported regardless of whether their chip is active, so they're excluded
  // here to avoid a duplicate column. Whatever the user actually toggles on
  // in the bar is what shows up as a column in the export, instead of a
  // fixed list that silently omits whichever extra field they're using.
  const EXPORT_EXTRA_COLUMNS: Record<string, { label: string; getValue: (issue: any) => string }> = {
    productType:    { label: 'Product Type',    getValue: (i) => i.productType ?? '' },
    productionTicket: { label: 'Production Ticket', getValue: (i) => i.productionTicket ?? '' },
    projectManager: { label: 'Project Manager', getValue: (i) => i.projectManager ?? '' },
    combination:    { label: 'Combination',     getValue: (i) => i.combination ?? '' },
    customerName:   { label: 'Customer Name',   getValue: (i) => i.customerName ?? '' },
    clientName:     { label: 'Client Name',     getValue: (i) => i.clientName ?? '' },
    projectPool:    { label: 'Project Pool',    getValue: (i) => i.projectPool ?? '' },
    infraIssueType: { label: 'Infra Issue Type', getValue: (i) => i.infraIssueType ?? '' },
    dueDate:        { label: 'Due Date',        getValue: (i) => i.dueDate ?? '' },
    resolved:       { label: 'Resolved date',   getValue: (i) => i.resolvedAt ?? '' },
  };
  // 'ticket': one row per ticket (its single displayed assignee).
  // 'person': one row per person per ticket -- everyone the Assignee filter
  // would match the ticket for (owner in the queue + anyone who worked or
  // held it there, issue.workedBy). A ticket's Assignee column can only hold
  // one name, so filtering an unfiltered per-ticket export by a person in
  // Excel undercounts anyone who wasn't that one name (Queue: Migration +
  // Updated: Sep -- Lakshma Reddy: 65 in the app, 47 in Excel). Filtering
  // the Person column of this mode gives the app's count.
  const handleExport = async (mode: 'ticket' | 'person' = 'ticket') => {
    setExporting(true);
    try {
      // The server returns at most 2000 rows per request, so page through
      // until everything matching is fetched (it used to stop at the first
      // 2000). EXPORT_MAX is a safety ceiling for a runaway filter.
      const PAGE_LIMIT = 2000;
      const EXPORT_MAX = 50000;
      const baseParams = buildFilterParams();
      const list: any[] = [];
      let matchedTotal = 0;
      for (let p = 1; ; p++) {
        const { issues: rows, total } = await api.getIssues({ ...baseParams, page: String(p), limit: String(PAGE_LIMIT) });
        matchedTotal = total;
        list.push(...(rows as any[]));
        if ((rows as any[]).length < PAGE_LIMIT || list.length >= total || list.length >= EXPORT_MAX) break;
      }
      // Which extra fields actually have a selected value right now -- a
      // field the user is genuinely filtering on must show up as a column
      // even if activeExtras (the "More filters" chip-visibility list,
      // restored wholesale from the rExtras URL param on page load) doesn't
      // happen to list it. That desync is real: a chip's value state
      // (selProjectManager etc.) and activeExtras are two separately
      // persisted/restored pieces of state (rProjectManager vs rExtras) --
      // a URL that sets one without the other (an older saved link, a
      // deep-link built elsewhere in the app) left the filter itself
      // working (the value still gets sent to the server) while silently
      // dropping the column from every export, with no visible sign
      // anything was wrong. Union instead of relying on activeExtras alone.
      const fieldsWithSelectedValue = {
        productType: selProductType.length > 0,
        productionTicket: selProductionTicket.length > 0,
        combination: !!selCombination,
        customerName: selCustomerName.length > 0,
        clientName: selClientName.length > 0,
        projectManager: selProjectManager.length > 0,
        projectPool: !!selProjectPool,
        infraIssueType: selInfraIssueType.length > 0,
        dueDate: !!selDueDate,
        resolved: !!selResolved,
      };
      const extraCols = Object.keys(EXPORT_EXTRA_COLUMNS).filter(
        (id) => activeExtras.includes(id) || fieldsWithSelectedValue[id as keyof typeof fieldsWithSelectedValue],
      );
      const header = [
        'Key', ...(mode === 'person' ? ['Person'] : []), 'Type', 'Summary', 'Assignee', 'Worked By', 'Reporter', 'Status', 'Priority', 'SLA Breached', 'SLA Breached By', 'SLA Breached Dept', 'Overdue', 'Department',
        'Created', 'Updated',
        ...extraCols.map((id) => EXPORT_EXTRA_COLUMNS[id].label),
      ];
      // Excel (and Google Sheets, when the CSV is imported) evaluates a cell
      // starting with "=" as a formula regardless of CSV quoting, so
      // =HYPERLINK(url,label) makes the Key column clickable in the
      // exported file, opening the same ticket detail page the in-app Key
      // link goes to -- same href construction (viewDept when a queue is
      // selected, so the opened ticket shows this queue's own historical
      // assignee/status snapshot, not just whoever holds it live).
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const keyLink = (issue: any) => {
        const key = issue.cfKey ?? issue.key;
        const href = selQueue
          ? `${origin}/issues/${key}?ref=filters&viewDept=${encodeURIComponent(selQueue)}`
          : `${origin}/issues/${key}?ref=filters`;
        return `=HYPERLINK("${href.replace(/"/g, '""')}","${String(key).replace(/"/g, '""')}")`;
      };
      const lines = [header.map(csvCell).join(',')];
      const assigneeName = (issue: any) =>
        issue.assignee ? `${issue.assignee.firstName || ''} ${issue.assignee.lastName || ''}`.trim() : 'Unassigned';
      // Person mode: one line per person in issue.workedBy (only sent for a
      // Queue view); a ticket with no such list falls back to its assignee.
      const peopleFor = (issue: any): string[] =>
        mode === 'person'
          ? (Array.isArray(issue.workedBy) && issue.workedBy.length ? issue.workedBy.map((p: any) => p.name) : [assigneeName(issue)])
          : [''];
      for (const issue of list) for (const person of peopleFor(issue)) {
        lines.push([
          keyLink(issue),
          ...(mode === 'person' ? [person] : []),
          issue.type ?? '',
          issue.summary ?? '',
          assigneeName(issue),
          // Independent of the Assignee column above (which can legitimately
          // show a historical worker's name, or just the current owner's,
          // depending on whether an Assignee filter is active -- see its own
          // comment on current_department below) -- this lists every person
          // the app's Assignee filter would match the row for (current owner
          // in this queue, plus anyone who worked or held it here), so
          // filtering THIS column in Excel afterward gives the same result
          // as filtering Assignee in the app. Only populated on a Queue-
          // scoped export (dept-scoped branch); empty on the general "All
          // Work" tab with no Queue selected, which has no single
          // department's worked-on ledger to draw from.
          issue.workedByNames ?? '',
          issue.reporter ? `${issue.reporter.firstName || ''} ${issue.reporter.lastName || ''}`.trim() : '',
          // Same queue-scoped effective status the on-screen table shows --
          // exporting the raw issue.status?.name here could show a
          // different value than what the table right above it displays
          // for the identical row.
          getEffectiveIssueStatus(issue, selQueue || undefined).name || '',
          issue.priority ?? '',
          issue.sla_breached == null ? 'N/A' : issue.sla_breached ? 'Yes' : 'No',
          issue.sla_breached ? (issue.sla_breached_by ?? '') : '',
          issue.sla_breached ? (issue.sla_breached_dept ?? '') : '',
          issue.overdue ? 'Yes' : 'No',
          // Reverted per explicit follow-up request: Department should always
          // reflect the ticket's real CURRENT department here, even on a row
          // surfaced by a past department's worked-on credit (Assignee can
          // legitimately show that historical person while Department still
          // says where the ticket actually lives now, e.g. CF-29525 --
          // Assignee: a Migration engineer's historical credit, Department:
          // Dev, its real current department). A prior version of this line
          // showed selQueue instead whenever assigneeIsHistorical was set,
          // which was itself a fix for the opposite complaint -- confirmed
          // this is what's wanted now instead.
          issue.current_department ?? '',
          issue.createdAt ? new Date(issue.createdAt).toLocaleString() : '',
          issue.updatedAt ? new Date(issue.updatedAt).toLocaleString() : '',
          ...extraCols.map((id) => EXPORT_EXTRA_COLUMNS[id].getValue(issue)),
        ].map(csvCell).join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `filtered-issues${mode === 'person' ? '-by-person' : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (matchedTotal > list.length) {
        alert(`Exported the first ${list.length.toLocaleString()} of ${matchedTotal.toLocaleString()} matching issues. Narrow your filters to export everything.`);
      }
    } catch {
      alert('Export failed. Please try again.');
    }
    setExporting(false);
  };

  // Filtering by a field and seeing that field's column in the table used to
  // be two disconnected things for most fields (only Product Type,
  // Combination, and Project Manager had it) -- driven per-field by a
  // hardcoded list here, which meant every new addable field needed its own
  // line added by hand or it silently stayed export-only. Generalized to
  // every field in EXTRA_FILTER_OPTIONS at once: a column shows in the table
  // the moment that field is added via "More filters" (activeExtras) OR
  // already has a value selected (the same "chip active OR a value is
  // selected" rule the export uses, for the same reason -- activeExtras and
  // a filter's own value state are two separately persisted pieces of state
  // that can desync, e.g. an older deep link that set one without the
  // other). Reporter, Priority, Department, and Updated are excluded here --
  // they're already always-visible fixed columns, not extras.
  // "Created"/"Updated" are table-only (kept out of EXPORT_EXTRA_COLUMNS
  // since the CSV export already always includes its own fixed Created/
  // Updated columns -- adding them there too would double them up in the
  // export). "Updated" was missing here entirely even though it's a real,
  // selectable filter (EXTRA_FILTER_OPTIONS) and the CSV export already
  // shows it as a fixed column -- selecting the Updated date filter had no
  // way to actually show that value anywhere in the on-screen table.
  const TABLE_ONLY_COLUMNS: Record<string, { label: string; getValue: (issue: any) => string }> = {
    created: { label: 'Created', getValue: (i) => i.createdAt ? new Date(i.createdAt).toLocaleDateString() : '' },
    updated: { label: 'Updated', getValue: (i) => i.updatedAt ? new Date(i.updatedAt).toLocaleDateString() : '' },
  };
  const TABLE_COLUMN_DEFS: Record<string, { label: string; getValue: (issue: any) => string }> = {
    ...TABLE_ONLY_COLUMNS,
    ...EXPORT_EXTRA_COLUMNS,
  };
  const EXTRA_COLUMN_HAS_VALUE: Record<string, boolean> = {
    created: !!selCreated,
    updated: !!selUpdated,
    productType: selProductType.length > 0,
    productionTicket: selProductionTicket.length > 0,
    combination: !!selCombination,
    projectManager: selProjectManager.length > 0,
    customerName: selCustomerName.length > 0,
    clientName: selClientName.length > 0,
    projectPool: !!selProjectPool,
    infraIssueType: selInfraIssueType.length > 0,
    dueDate: !!selDueDate,
    resolved: !!selResolved,
  };
  const tableExtraCols = EXTRA_FILTER_OPTIONS
    .map((f) => f.id)
    .filter((id) => TABLE_COLUMN_DEFS[id] && (activeExtras.includes(id) || EXTRA_COLUMN_HAS_VALUE[id]));

  // "Columns" used to list only the 7 fixed columns (Assignee/Status/etc)
  // -- a field added via "More filters" (Infra Issue Type, Combination,
  // etc.) DID already auto-show as a table column via tableExtraCols
  // above, but had no entry here, so there was no way to see it listed or
  // turn it back off except by removing the filter chip entirely. Merged
  // into one combined checklist: picking any of these fields here either
  // flips the static column's own visibility, or toggles the extra
  // field's "More filters" chip (same effect as adding/removing it there,
  // including clearing its value on removal via toggleExtra).
  const columnsDropdownOptions = [
    ...STATIC_COLUMN_OPTIONS,
    ...EXTRA_FILTER_OPTIONS.filter((f) => TABLE_COLUMN_DEFS[f.id]).map((f) => ({ value: f.id, label: f.label })),
  ];
  const columnsDropdownSelected = [...visibleStaticCols, ...tableExtraCols];
  const handleColumnsDropdownChange = (next: string[]) => {
    const added = next.find((id) => !columnsDropdownSelected.includes(id));
    const removed = columnsDropdownSelected.find((id) => !next.includes(id));
    const toggledId = added ?? removed;
    if (!toggledId) return;
    if (STATIC_COLUMN_IDS.includes(toggledId)) {
      setVisibleStaticCols(next.filter((id) => STATIC_COLUMN_IDS.includes(id)));
    } else {
      toggleExtra(toggledId);
    }
  };

  // When space selection changes, drop any selected statuses that no longer exist in the new scope
  useEffect(() => {
    if (selStatuses.length === 0) return;
    const validNames = new Set(availableStatuses.map((s) => s.value.toLowerCase()));
    const stillValid = selStatuses.filter((s) => validNames.has(s.toLowerCase()));
    if (stillValid.length !== selStatuses.length) setSelStatuses(stillValid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSpaces]);

  /* load saved filters */
  const loadSavedFilters = async () => {
    try { const data = await api.getFilters(); setSavedFilters(data as any); } catch { /* ignore */ }
  };
  useEffect(() => { loadSavedFilters(); }, []);

  // Sets EVERY filter from a criteria object -- anything the object doesn't
  // mention is reset, so applying a saved filter (or clearing) never leaves
  // an earlier selection silently applied on top. Clear all, applying a
  // saved filter, and currentCriteria below must all cover the same fields
  // as FilterCriteria; a field missing from any one of them is how filters
  // used to survive "Clear all" or get dropped from saved filters.
  const applyCriteria = (c: FilterCriteria) => {
    setText(c.text || '');
    setSelSpaces(c.spaces || []);
    setSelQueue(c.queue || '');
    setSelAssignees(c.assignees || []);
    setSelReporters(c.reporters || []);
    setSelTypes(c.types || []);
    setSelStatuses(c.statuses || []);
    setSelPriorities(c.priorities || []);
    setSelCreated(c.createdRange || '');
    setSelUpdated(c.updatedRange || '');
    setSelWorked(c.workedRange || '');
    setSelDueDate(c.dueDateRange || '');
    setSelResolved(c.resolvedRange || '');
    setSelDepartment(c.department || '');
    setSelProductType(c.productType || []);
    setSelProductionTicket(c.productionTicket || []);
    setSelCombination(c.combination || '');
    setSelCustomerName(c.customerName || []);
    setSelClientName(c.clientName || []);
    setSelProjectManager(c.projectManager || []);
    setSelProjectPool(c.projectPool || '');
    setSelInfraIssueType(c.infraIssueType || []);
    setSelBreached(c.slaBreached || '');
    setSelOverdue(c.overdue || '');
    // Show the bar button of every field that has a value, plus whatever
    // was visible when it was saved.
    const implied: [boolean, string][] = [
      [!!c.reporters?.length, 'reporter'], [!!c.priorities?.length, 'priority'],
      [!!c.createdRange, 'created'], [!!c.updatedRange, 'updated'], [!!c.workedRange, 'worked'],
      [!!c.dueDateRange, 'dueDate'], [!!c.resolvedRange, 'resolved'], [!!c.department, 'department'],
      [!!c.productType?.length, 'productType'], [!!c.productionTicket?.length, 'productionTicket'],
      [!!c.combination, 'combination'], [!!c.customerName?.length, 'customerName'],
      [!!c.clientName?.length, 'clientName'], [!!c.projectManager?.length, 'projectManager'],
      [!!c.projectPool, 'projectPool'], [!!c.infraIssueType?.length, 'infraIssueType'],
    ];
    setActiveExtras(Array.from(new Set([...(c.extras || []), ...implied.filter(([on]) => on).map(([, k]) => k)])));
  };

  const clearAll = () => {
    applyCriteria({});
    setActiveFilterId(null);
  };

  const applyFilter = (f: SavedFilter) => {
    applyCriteria(f.criteria || {});
    setActiveFilterId(f.id);
    setShowSavedPanel(false);
  };

  const handleStar = async (f: SavedFilter) => {
    const starred = f.starredBy?.includes(user?.id || '');
    if (starred) await api.unstarFilter(f.id); else await api.starFilter(f.id);
    loadSavedFilters();
  };

  const handleDelete = async (id: string) => {
    await api.deleteFilter(id);
    setDeleteConfirmId(null);
    loadSavedFilters();
    if (activeFilterId === id) clearAll();
  };

  // What "Save filter" stores -- every field, see applyCriteria above.
  const currentCriteria: FilterCriteria = {
    ...(text.trim() ? { text: text.trim() } : {}),
    ...(selSpaces.length ? { spaces: selSpaces } : {}),
    ...(selQueue ? { queue: selQueue } : {}),
    ...(selAssignees.length ? { assignees: selAssignees } : {}),
    ...(selReporters.length ? { reporters: selReporters } : {}),
    ...(selTypes.length ? { types: selTypes } : {}),
    ...(selStatuses.length ? { statuses: selStatuses } : {}),
    ...(selPriorities.length ? { priorities: selPriorities } : {}),
    ...(selCreated ? { createdRange: selCreated } : {}),
    ...(selUpdated ? { updatedRange: selUpdated } : {}),
    ...(selWorked ? { workedRange: selWorked } : {}),
    ...(selDueDate ? { dueDateRange: selDueDate } : {}),
    ...(selResolved ? { resolvedRange: selResolved } : {}),
    ...(selDepartment ? { department: selDepartment } : {}),
    ...(selProductType.length ? { productType: selProductType } : {}),
    ...(selProductionTicket.length ? { productionTicket: selProductionTicket } : {}),
    ...(selCombination ? { combination: selCombination } : {}),
    ...(selCustomerName.length ? { customerName: selCustomerName } : {}),
    ...(selClientName.length ? { clientName: selClientName } : {}),
    ...(selProjectManager.length ? { projectManager: selProjectManager } : {}),
    ...(selProjectPool ? { projectPool: selProjectPool } : {}),
    ...(selInfraIssueType.length ? { infraIssueType: selInfraIssueType } : {}),
    ...(selBreached ? { slaBreached: selBreached } : {}),
    ...(selOverdue ? { overdue: selOverdue } : {}),
    ...(activeExtras.length ? { extras: activeExtras } : {}),
  };

  // Helper: member name by ID
  const memberName = (id: string) => {
    const m = allMembers.find((mm: any) => mm.id === id || mm.email === id);
    return m ? `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email : id;
  };

  const activeFilter = savedFilters.find((f) => f.id === activeFilterId);
  const starredFilters = savedFilters.filter((f) => f.starredBy?.includes(user?.id || ''));

  return (
    <div className="max-w-[1800px] mx-auto space-y-4">

      {/* ── Page header ── */}
      <div>
        <h1 className="text-[22px] font-semibold text-gray-900 mb-3">Filters</h1>

        {/* ── Tabs: All Work | Saved Filters ── */}
        <div className="flex items-center border-b border-gray-200">
          <button
            onClick={() => setShowSavedPanel(false)}
            className={cn(
              'relative px-4 py-2.5 text-[13.5px] font-medium transition-colors',
              !showSavedPanel
                ? 'text-blue-600 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-blue-600 after:rounded-t'
                : 'text-gray-500 hover:text-gray-800',
            )}
          >
            <div className="flex items-center gap-1.5">
              <List size={14} />
              All Work
              {activeFilter && (
                <span className="rounded-full bg-blue-100 text-blue-600 text-[10px] font-bold px-1.5 py-0.5">Filter active</span>
              )}
            </div>
          </button>
          <button
            onClick={() => setShowSavedPanel(true)}
            className={cn(
              'relative px-4 py-2.5 text-[13.5px] font-medium transition-colors',
              showSavedPanel
                ? 'text-blue-600 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-blue-600 after:rounded-t'
                : 'text-gray-500 hover:text-gray-800',
            )}
          >
            <div className="flex items-center gap-1.5">
              <Bookmark size={14} />
              Saved Filters
              {savedFilters.length > 0 && (
                <span className={cn(
                  'rounded-full text-[10px] font-bold px-1.5 py-0.5',
                  showSavedPanel ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500',
                )}>{savedFilters.length}</span>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* ── Saved filters panel — Jira-style table ── */}
      {showSavedPanel && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">

          {savedFilters.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <Bookmark size={32} className="mb-3 text-gray-200" />
              <p className="text-[13.5px] font-semibold text-gray-500">No saved filters yet</p>
              <p className="text-[12px] text-gray-400 mt-1">Apply filters and click "Save filter" to save them here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/60">
                    <th className="w-8 px-4 py-2.5" />
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Name</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Owner</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Filters</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Starred by</th>
                    <th className="w-10 px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[...savedFilters]
                    .sort((a, b) => {
                      const aS = a.starredBy?.includes(user?.id || '') ? 0 : 1;
                      const bS = b.starredBy?.includes(user?.id || '') ? 0 : 1;
                      return aS - bS;
                    })
                    .map((f) => {
                      const isStarred = f.starredBy?.includes(user?.id || '');
                      const isActive  = activeFilterId === f.id;
                      const chips     = [
                        ...(f.criteria?.spaces || []).map((v: string) => spaces.find((s: any) => s.key === v)?.name || v),
                        ...((f.criteria as any)?.queue ? [(f.criteria as any).queue] : []),
                        ...(f.criteria?.assignees || []).map((v: string) => memberName(v)),
                        ...((f.criteria as any)?.reporters || []).map((v: string) => memberName(v)),
                        ...(f.criteria?.types || []).map((v: string) => TYPE_LABELS[v] || v),
                        ...(f.criteria?.statuses || []),
                        ...(f.criteria?.priorities || []).map((v: string) => PRIORITY_LABELS[v] || v),
                      ].filter(Boolean);
                      const ownerInitials = ((f as any).ownerName || 'U')
                        .split(' ').slice(0, 2).map((p: string) => p[0] || '').join('').toUpperCase();
                      const starCount = (f.starredBy || []).length;

                      return (
                        <tr
                          key={f.id}
                          className={cn(
                            'group hover:bg-blue-50/40 transition-colors cursor-pointer',
                            isActive && 'bg-blue-50',
                          )}
                          onClick={() => applyFilter(f)}
                        >
                          {/* Star */}
                          <td className="px-4 py-3 w-8">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStar(f); }}
                              className="transition-colors"
                            >
                              <Star
                                size={15}
                                className={isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300 hover:text-yellow-400'}
                              />
                            </button>
                          </td>

                          {/* Name */}
                          <td className="px-3 py-3 min-w-[160px]">
                            <span className={cn(
                              'text-[13px] font-semibold hover:underline',
                              isActive ? 'text-blue-700' : 'text-blue-600',
                            )}>
                              {f.name}
                            </span>
                            {isActive && (
                              <span className="ml-2 rounded-full bg-blue-600 text-white text-[9px] font-bold px-1.5 py-0.5 align-middle">Active</span>
                            )}
                          </td>

                          {/* Owner */}
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-6 w-6 flex-shrink-0 rounded-full bg-blue-500 flex items-center justify-center text-[9px] font-bold text-white">
                                {ownerInitials}
                              </div>
                              <span className="text-[12.5px] text-gray-700 whitespace-nowrap">
                                {(f as any).ownerName || 'Unknown'}
                              </span>
                            </div>
                          </td>

                          {/* Filters applied */}
                          <td className="px-3 py-3 max-w-[320px]">
                            {chips.length === 0 ? (
                              <span className="text-[11.5px] text-gray-300">—</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {chips.slice(0, 5).map((c, i) => (
                                  <span key={i} className="rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10.5px] text-gray-600">
                                    {c}
                                  </span>
                                ))}
                                {chips.length > 5 && (
                                  <span className="rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10.5px] text-gray-400">
                                    +{chips.length - 5}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>

                          {/* Starred by */}
                          <td className="px-3 py-3">
                            <span className="text-[12.5px] text-gray-500">
                              {starCount === 0 ? '—' : `${starCount} ${starCount === 1 ? 'person' : 'people'}`}
                            </span>
                          </td>

                          {/* Actions */}
                          <td className="px-4 py-3 w-10">
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setMenuId(menuId === f.id ? null : f.id); }}
                                className="opacity-0 group-hover:opacity-100 flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-200 transition-all"
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {menuId === f.id && (
                                <>
                                  <div className="fixed inset-0 z-40" onClick={() => setMenuId(null)} />
                                  <div className="absolute right-0 top-full z-[9999] mt-1 w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
                                    {f.ownerId === user?.id && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setMenuId(null); setEditingFilter(f); applyFilter(f); setShowSaveModal(true); }}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50"
                                      >
                                        <Edit2 size={13} className="text-gray-400" /> Edit
                                      </button>
                                    )}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setMenuId(null); handleStar(f); }}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-50"
                                    >
                                      <Star size={13} className={isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-gray-400'} />
                                      {isStarred ? 'Unstar' : 'Star'}
                                    </button>
                                    {f.ownerId === user?.id && (
                                      <>
                                        <div className="my-1 h-px bg-gray-100" />
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setMenuId(null); setDeleteConfirmId(f.id); }}
                                          className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] text-red-600 hover:bg-red-50"
                                        >
                                          <Trash2 size={13} className="text-red-400" /> Delete
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Filter bar (only on All Work tab) ── */}
      {/* z-30, not the z-[100] this had before — that was higher than modals opened from
          elsewhere in the app (e.g. Create Task's z-50 backdrop), so this sticky bar was
          painting over the top of them. It only needs to stay above this page's own
          scrolling table rows, not above app-wide modals. */}
      {!showSavedPanel && <div className="sticky top-0 z-30 rounded-xl border border-gray-200 bg-white shadow-sm overflow-visible">

        {/* Row 1: fixed filters */}
        <div className="flex items-center gap-2 px-4 py-3 flex-wrap border-b border-gray-100">
          {/* search */}
          <div className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 min-w-[180px] flex-1 max-w-xs">
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search work…"
              className="flex-1 bg-transparent text-[12.5px] text-gray-800 outline-none placeholder:text-gray-400"
            />
            {text && <button onClick={() => setText('')}><X size={12} className="text-gray-400 hover:text-gray-600" /></button>}
          </div>

          <SpaceQueueDropBtn spaces={spaces} selSpaces={selSpaces} onSpacesChange={setSelSpaces} selQueue={selQueue} onQueueChange={setSelQueue} />
          <DropBtn
            label="Assignee"
            options={allMembers.map((m: any) => ({ value: m.id, label: `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email || m.id }))}
            selected={selAssignees}
            onChange={setSelAssignees}
          />
          <DropBtn label="Type" options={ISSUE_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] || t }))} selected={selTypes} onChange={setSelTypes} />
          <DropBtn label="Status" options={availableStatuses} selected={selStatuses} onChange={setSelStatuses} />

          {/* SLA Breached filter */}
          <YesNoFilterBtn value={selBreached} onChange={setSelBreached} label="SLA Breached" yesLabel="Yes — Breached" noLabel="No — Not Breached" />

          {/* Overdue filter -- distinct from SLA Breached: this is the ticket's
              own dueDate field crossing "now" while still open, unrelated to
              any SLA policy's own duration clock (see the dueDate-vs-SLA
              comment on the Monitoring Agent's due-date section). */}
          <YesNoFilterBtn value={selOverdue} onChange={setSelOverdue} label="Overdue" yesLabel="Yes — Overdue" noLabel="No — Not Overdue" />

          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {/* More filters — adds extras to row 2 */}
            <MoreFiltersBtn activeExtras={activeExtras} onToggleExtra={toggleExtra} />
            {hasCriteria && (
              <button onClick={clearAll} className="text-[12px] text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors whitespace-nowrap">
                <X size={12} /> Clear
              </button>
            )}
            <DropBtn
              label="Columns"
              options={columnsDropdownOptions}
              selected={columnsDropdownSelected}
              onChange={handleColumnsDropdownChange}
            />
            {can(user?.role, 'exportData') && (
              <div className="relative">
              <button
                onClick={() => setExportMenuOpen((o) => !o)}
                disabled={exporting || issues.length === 0}
                // min-w fits "Exporting…" (the wider of the two labels) so
                // toggling the label doesn't change this button's own width --
                // in a flex-wrap toolbar (see Row 1 above), a width change on
                // any one button can shift where the whole row wraps,
                // visible as the toolbar jumping the moment Export is clicked.
                className="flex items-center justify-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap min-w-[92px]"
              >
                <Download size={13} /> {exporting ? 'Exporting…' : 'Export'} <ChevronDown size={12} className="text-gray-400" />
              </button>
              {exportMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
                    <button
                      onClick={() => { setExportMenuOpen(false); handleExport('ticket'); }}
                      className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                    >
                      <span className="block text-[12.5px] font-medium text-gray-800">One row per ticket</span>
                      <span className="block text-[11.5px] text-gray-500">Each ticket once, with its assignee.</span>
                    </button>
                    <button
                      onClick={() => { setExportMenuOpen(false); handleExport('person'); }}
                      className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                    >
                      <span className="block text-[12.5px] font-medium text-gray-800">One row per person</span>
                      <span className="block text-[11.5px] text-gray-500">
                        A ticket appears once for each person who owned or worked it in the queue. Filter the Person column in Excel to get the same counts as the Assignee filter here.
                      </span>
                    </button>
                  </div>
                </>
              )}
              </div>
            )}
            <button
              onClick={() => { setEditingFilter(null); setShowSaveModal(true); }}
              className="flex items-center gap-1.5 rounded-md border border-blue-500 px-3 py-1.5 text-[12.5px] font-semibold text-blue-600 hover:bg-blue-50 transition-colors whitespace-nowrap"
            >
              <Bookmark size={13} /> Save filter
            </button>
          </div>
        </div>

        {/* Row 2: active extra filters (only shown when extras are added) */}
        {activeExtras.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mr-1">Active filters:</span>

            {activeExtras.includes('reporter') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Reporter"
                  options={allMembers.map((m: any) => ({ value: m.id, label: `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email || m.id }))}
                  selected={selReporters}
                  onChange={setSelReporters}
                />
                <button onClick={() => toggleExtra('reporter')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors">
                  <X size={11} />
                </button>
              </div>
            )}
            {activeExtras.includes('priority') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Priority"
                  options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] || p }))}
                  selected={selPriorities}
                  onChange={setSelPriorities}
                />
                <button onClick={() => toggleExtra('priority')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors">
                  <X size={11} />
                </button>
              </div>
            )}
            {activeExtras.includes('department') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Department" value={selDepartment} onChange={setSelDepartment} />
                <button onClick={() => toggleExtra('department')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('productType') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Product Type"
                  options={PRODUCT_TYPE_OPTIONS.map(v => ({ value: v, label: v }))}
                  selected={selProductType}
                  onChange={setSelProductType}
                />
                <button onClick={() => toggleExtra('productType')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('productionTicket') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Production Ticket"
                  options={PRODUCTION_TICKET_OPTIONS.map(v => ({ value: v, label: v }))}
                  selected={selProductionTicket}
                  onChange={setSelProductionTicket}
                />
                <button onClick={() => toggleExtra('productionTicket')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('combination') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Combination" value={selCombination} onChange={setSelCombination} />
                <button onClick={() => toggleExtra('combination')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('customerName') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Customer Name"
                  options={CUSTOMER_NAME_OPTIONS.map(v => ({ value: v, label: v }))}
                  selected={selCustomerName}
                  onChange={setSelCustomerName}
                />
                <button onClick={() => toggleExtra('customerName')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('clientName') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Client Name"
                  options={CLIENT_NAME_OPTIONS.map(v => ({ value: v, label: v }))}
                  selected={selClientName}
                  onChange={setSelClientName}
                />
                <button onClick={() => toggleExtra('clientName')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('projectPool') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Project Pool" value={selProjectPool} onChange={setSelProjectPool} />
                <button onClick={() => toggleExtra('projectPool')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('infraIssueType') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Infra Issue Type"
                  options={INFRA_ISSUE_TYPES.map(v => ({ value: v, label: v }))}
                  selected={selInfraIssueType}
                  onChange={setSelInfraIssueType}
                />
                <button onClick={() => toggleExtra('infraIssueType')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('projectManager') && (
              <div className="flex items-center gap-1">
                <DropBtn
                  label="Project Manager"
                  options={PROJECT_MANAGER_OPTIONS.map(v => ({ value: v, label: v }))}
                  selected={selProjectManager}
                  onChange={setSelProjectManager}
                />
                <button onClick={() => toggleExtra('projectManager')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('created') && (
              <div className="flex items-center gap-1">
                <DateDropBtn
                  label="Created"
                  selected={selCreated}
                  onChange={setSelCreated}
                />
                <button onClick={() => toggleExtra('created')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors">
                  <X size={11} />
                </button>
              </div>
            )}
            {activeExtras.includes('updated') && (
              <div className="flex items-center gap-1">
                <DateDropBtn label="Updated" selected={selUpdated} onChange={setSelUpdated} />
                <button onClick={() => toggleExtra('updated')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('worked') && (
              <div className="flex items-center gap-1">
                <DateDropBtn label="Worked" selected={selWorked} onChange={setSelWorked} />
                <button onClick={() => toggleExtra('worked')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors" title="Who actually did the work in that queue, not just who currently owns it -- requires a Queue and an Assignee selected."><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('dueDate') && (
              <div className="flex items-center gap-1">
                <DateDropBtn label="Due Date" selected={selDueDate} onChange={setSelDueDate} />
                <button onClick={() => toggleExtra('dueDate')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('resolved') && (
              <div className="flex items-center gap-1">
                <DateDropBtn label="Resolved date" selected={selResolved} onChange={setSelResolved} />
                <button onClick={() => toggleExtra('resolved')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
          </div>
        )}
        {/* Created+Updated together = created in range OR updated in range,
            with or without a Queue (the server applies the same union in
            both branches). */}
        {selCreated && selUpdated && (
          <div className="flex items-start gap-2 px-4 py-2 bg-blue-50 border-b border-blue-100 text-[11.5px] text-blue-800">
            <Filter size={13} className="mt-0.5 flex-shrink-0" />
            <span>
              Created and Updated are combined as <strong>either one</strong>: a ticket created in its range, or
              updated in its range, is included.
            </span>
          </div>
        )}
        {/* Filters the server can't apply in the current combination --
            shown instead of silently doing nothing (buildFilterParams only
            sends a Queue with exactly one space, and Worked only with a
            Queue and an Assignee). */}
        {selQueue && selSpaces.length !== 1 && (
          <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11.5px] text-amber-800">
            <Filter size={13} className="mt-0.5 flex-shrink-0" />
            <span>
              <strong>Queue: {selQueue}</strong> isn&apos;t applied, because a queue only works with exactly one space selected.
              Select a single space, or remove the queue.
            </span>
          </div>
        )}
        {selWorked && !(selQueue && selSpaces.length === 1 && selAssignees.length > 0) && (
          <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11.5px] text-amber-800">
            <Filter size={13} className="mt-0.5 flex-shrink-0" />
            <span>
              <strong>Worked</strong> isn&apos;t applied: it needs a Queue (with one space) and an Assignee selected.
            </span>
          </div>
        )}
      </div>}

      {/* ── Results table (only on All Work tab) ── */}
      {!showSavedPanel && <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {/* table header */}
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-2.5">
          <p className="text-[12.5px] font-semibold text-gray-600">
            {loadingIssues ? 'Loading…' : `${total.toLocaleString()} issue${total !== 1 ? 's' : ''}`}
          </p>
        </div>

        {loadingIssues && issues.length === 0 ? (
          // Only shown on a genuine cold start (no rows to show yet at all) --
          // previously fired on EVERY filter change regardless of whether
          // there were already rows on screen, collapsing the whole table
          // down to this ~80px spinner and then snapping back to full height
          // the moment the refetch finished. With a long results list that
          // happened on every single filter click, reading as the page
          // visibly "shaking" with each interaction. Now a refetch with
          // existing rows already on screen keeps showing them (slightly
          // dimmed below, see the table wrapper's opacity) instead of
          // collapsing the page, and only the "Loading…" label up in the
          // header changes.
          <DotLoader className="py-20" />
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Filter size={36} className="mb-3 text-gray-300" />
            <p className="text-[14px] font-semibold text-gray-600">No issues found</p>
            <p className="text-[13px] text-gray-400 mt-1">
              {hasCriteria ? 'Try adjusting your filters' : 'No issues available'}
            </p>
          </div>
        ) : (
          // Wrapped in its own horizontal-scroll container -- the card
          // around this table uses overflow-hidden (for its rounded
          // corners), which with no inner scroll wrapper CLIPPED away any
          // column past the visible width instead of making it reachable
          // by scrolling. Adding fields via "More filters" pushes the
          // table well past 1800px, so those columns were being cut off
          // entirely, not just off-screen.
          <div className={`overflow-x-auto transition-opacity ${loadingIssues ? 'opacity-50' : 'opacity-100'}`}>
          <table className="table-fixed">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                {/* Key + Work used to be pinned to the left edge (sticky) so
                    they stayed visible while scrolling right -- reverted per
                    explicit request: the whole row (key included) should
                    scroll together as one unit, not leave Key/Work frozen
                    while the rest of the row moves underneath them. */}
                <th className="bg-gray-50 px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24 border-r border-gray-200">Key</th>
                {/* Explicit width, not left to soak up whatever's left --
                    table-fixed hands 100% of any unclaimed width to the one
                    column with no width class, which at the page's widened
                    max-width (1800px) stretched Work to roughly 600px wider
                    than its own text needed, leaving a long dead gap before
                    Created. Dropped the table's own w-full for the same
                    reason: with every column now explicitly sized, forcing
                    the table to fill 100% would just redistribute that same
                    slack across all of them instead of Work alone -- letting
                    it size to its natural (sum-of-columns) width and leaving
                    any leftover space as plain page margin reads as a normal
                    right-aligned table, not a stretched column. */}
                {/* Narrowed from 380px -- at typical laptop/browser widths this
                    pushed Assignee/Status/Priority/SLA Breached off-screen,
                    forcing a horizontal scroll just to see them. The cell
                    below already truncates with an ellipsis, so this only
                    trades off how much of a long title shows before
                    truncating, not readability of what does fit. */}
                <th className="bg-gray-50 px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-[220px] border-r border-gray-200">Work</th>
                {tableExtraCols.map((id) => (
                  <th key={id} className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-32">
                    {TABLE_COLUMN_DEFS[id].label}
                  </th>
                ))}
                {/* Assignee/Reported By/Time Spent narrowed further (176px/176px/96px
                    -> 144px/144px/80px), same reasoning as Work above -- matches the
                    more compact column sizing the space board view (spaces/[spaceKey]/
                    page.tsx's STATIC_COLUMNS, ~150px per text column) already uses, so
                    more of the row fits on screen before needing to scroll. */}
                {visibleStaticCols.includes('assignee') && (
                  <th
                    className={`px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-36 ${selAssignees.length ? 'cursor-help' : ''}`}
                    // Only shown while an Assignee filter is active -- that's
                    // the one case where this column can show someone OTHER
                    // than the ticket's current owner. A selected Assignee
                    // also credits a ticket to someone who genuinely worked
                    // it and later handed it off, not just whoever holds it
                    // now -- by design, so a person doesn't lose credit for
                    // real work just because they moved the ticket along.
                    // That means this column, exported or on screen, can
                    // show a different name than you'd get by filtering the
                    // SAME column again afterward in Excel (which only ever
                    // sees each row's current owner, with no way to know
                    // about that earlier work) -- confirmed for real:
                    // Assignee: Pragati Pandey matched 70 tickets, 6 of them
                    // via real work she did before handing off, so Excel's
                    // own column filter on an export taken WITHOUT this
                    // filter applied found only 64. Filtering by Assignee in
                    // the app BEFORE exporting avoids the mismatch entirely.
                    title={selAssignees.length ? 'Can include someone credited for real work they did on a ticket before handing it off, not only its current owner -- filter by Assignee here (not in Excel afterward) for an export that matches this count exactly.' : undefined}
                  >
                    Assignee
                  </th>
                )}
                {visibleStaticCols.includes('reportedBy') && <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-36">Reported By</th>}
                {visibleStaticCols.includes('status') && <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-28">Status</th>}
                {visibleStaticCols.includes('priority') && <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-16">Priority</th>}
                {visibleStaticCols.includes('slaBreached') && <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-20">SLA Breached</th>}
                {visibleStaticCols.includes('overdue') && <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-16">Overdue</th>}
                {visibleStaticCols.includes('timeSpent') && <th className="px-2 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wide w-20">Time Spent</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {/* Used to hard-cap rendering to the first 100 of whatever was
                  fetched, regardless of how many rows actually came back --
                  confirmed for real: back when PAGE_SIZE was 1000, a filter
                  matching hundreds of tickets (sorted newest first) fetched
                  all of them correctly but only ever SHOWED the newest ~100,
                  silently cutting off everything older mid-range (e.g. a
                  same-day cluster of ~100 tickets on one date made the whole
                  rest of the selected date range invisible, with no visual
                  sign anything was missing). PAGE_SIZE is back to 100 now
                  (see its own declaration -- the 1000 value that caused an
                  11s/2.64MB unfiltered load turned out to have crept back
                  in independent of this fix), so fetch and render size
                  always match again regardless; rendering everything
                  that comes back is the correct behavior now. */}
              {issues.map((issue: any) => {
                // Carries which queue this row was shown under, same as the
                // Queue Dashboard's own "Worked on" list -- without it, the
                // issue detail page had no way to know it was opened from a
                // Queue: X view and always showed the ticket's LIVE current
                // assignee/status, even for a row Filters itself displayed
                // using THIS queue's own frozen dept_assignees/dept_statuses
                // snapshot (e.g. via the worked-on broadening above). A
                // ticket showing "Guru M" as assignee in Queue: Dev's list
                // (its real Dev worker) opened to show "Harshith Kaduluri"
                // instead (Migration's current holder) -- directly
                // contradicting the row it was just opened from. Confirmed
                // for real on CF-29885.
                const issueHref = selQueue
                  ? `/issues/${issue.cfKey ?? issue.key}?ref=filters&viewDept=${encodeURIComponent(selQueue)}`
                  : `/issues/${issue.cfKey ?? issue.key}?ref=filters`;
                return (
                <tr key={issue.id || issue.key} className="group hover:bg-gray-50 transition-colors">
                  <td className="bg-white group-hover:bg-gray-50 transition-colors px-4 py-2.5 border-r border-gray-100">
                    <div className="flex items-center gap-1.5">
                      <IssueTypeIcon type={issue.type || 'task'} size={15} />
                      <Link
                        href={issueHref}
                        className="font-mono text-[11.5px] font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap"
                      >
                        {issue.cfKey ?? issue.key}
                      </Link>
                    </div>
                  </td>
                  <td className="bg-white group-hover:bg-gray-50 transition-colors px-2 py-2.5 border-r border-gray-100">
                    <Link
                      href={issueHref}
                      className="block truncate text-[13px] text-gray-900 hover:text-blue-600 transition-colors"
                    >
                      {issue.summary}
                    </Link>
                  </td>
                  {tableExtraCols.map((id) => (
                    <td key={id} className="px-2 py-2.5">
                      <span className="text-[11.5px] text-gray-600 truncate">
                        {TABLE_COLUMN_DEFS[id].getValue(issue) || '—'}
                      </span>
                    </td>
                  ))}
                  {visibleStaticCols.includes('assignee') && (
                  <td className="px-2 py-2.5">
                    {issue.assignee ? (
                      <div className="flex items-center gap-1.5">
                        <div className="h-6 w-6 flex-shrink-0 rounded-full bg-blue-500 flex items-center justify-center text-[9px] font-bold text-white">
                          {`${issue.assignee.firstName?.[0] || ''}${issue.assignee.lastName?.[0] || ''}`.toUpperCase()}
                        </div>
                        <span className="text-[12px] text-gray-600 truncate">
                          {`${issue.assignee.firstName || ''} ${issue.assignee.lastName || ''}`.trim()}
                        </span>
                        {/* This queue's OWN historical assignee for this ticket, not
                            whoever holds it now -- shown whenever the ticket has since
                            moved to a different department (the same "Queue: X + date
                            range" broadening that surfaces the ticket at all here in
                            the first place). Without this, a Migration-queue result
                            could show a Dev or Pre-Sales person's name with nothing
                            explaining why, reading as a data bug instead of the
                            intentional per-department view it is -- the ticket detail
                            page already has an amber banner saying exactly this when
                            opened via ?viewDept=, this table had no equivalent at all. */}
                        {issue.assigneeIsHistorical && (
                          <span
                            className="ml-0.5 inline-flex items-center px-1 py-0.5 rounded-full text-[9px] font-medium bg-amber-50 text-amber-700 whitespace-nowrap"
                            title={`Who this ticket was assigned to while it was in ${selQueue || 'this queue'} -- it has since moved to a different department`}
                          >
                            in {selQueue || 'queue'}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-gray-300">Unassigned</span>
                    )}
                  </td>
                  )}
                  {visibleStaticCols.includes('reportedBy') && (
                  <td className="px-2 py-2.5">
                    {issue.reporter ? (
                      <div className="flex items-center gap-1.5">
                        <div className="h-6 w-6 flex-shrink-0 rounded-full bg-purple-500 flex items-center justify-center text-[9px] font-bold text-white">
                          {`${issue.reporter.firstName?.[0] || ''}${issue.reporter.lastName?.[0] || ''}`.toUpperCase()}
                        </div>
                        <span className="text-[12px] text-gray-600 truncate">
                          {`${issue.reporter.firstName || ''} ${issue.reporter.lastName || ''}`.trim()}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-gray-300">—</span>
                    )}
                  </td>
                  )}
                  {visibleStaticCols.includes('status') && (
                  <td className="px-2 py-2.5">
                    {(() => {
                      // Queue-scoped, same as the Assignee column right next
                      // to it -- a Migration-queue result for a ticket that's
                      // since moved to Infra should show Migration's own
                      // status snapshot (what it looked like while it sat
                      // here), not Infra's current one, which has nothing to
                      // do with why this row appeared in this queue's export.
                      //
                      // getEffectiveIssueStatus falls through to the ticket's
                      // LIVE status once it's genuinely done (a "Routed to X"
                      // label is stale once the ticket's actually finished --
                      // right for someone just browsing "Queue: Migration"
                      // with no status filter, who shouldn't see "Routed to
                      // Dev" forever on something Dev finished ages ago). But
                      // that same fallback directly contradicted a row's own
                      // reason for appearing here at all when Status was the
                      // active filter: selecting "Routed to Dev" and getting
                      // back rows whose visible Status said "Resolved" instead
                      // read as if the filter and the display disagreed about
                      // what these tickets even are. When the queue's own raw
                      // snapshot matches one of the explicitly SELECTED
                      // statuses, show that snapshot directly instead of
                      // letting the staleness fallback override it -- the
                      // general no-filter browsing case is untouched.
                      // Same fix, but was scoped to only apply when a specific
                      // Queue filter was active -- with no Queue selected (just
                      // browsing by Status across every department, e.g. Status:
                      // "Routed to Dev, In Progress, ..." with no Queue chip),
                      // rawDeptKey stayed undefined and every row fell straight
                      // through to the same staleness fallback this was meant to
                      // fix. getEffectiveIssueStatus's own default (no viewDept
                      // given) is the ticket's CURRENT department -- check that
                      // same department's own snapshot here too when no Queue
                      // filter narrows it to something more specific.
                      const rawDeptStatuses = (issue as any).dept_statuses || {};
                      // Still not enough with only the current/selected-queue
                      // department checked: confirmed for real (CF-29947) --
                      // matched the filter through INFRA's own "In Progress"
                      // snapshot, but its CURRENT department (Migration) has
                      // its own genuine "Resolved" snapshot (a real, non-stale
                      // queue status, not a routing label), which
                      // getEffectiveIssueStatus returns immediately without
                      // ever considering why the row actually matched. The
                      // backend's own general-search match (deptMatchRows)
                      // already checks EVERY department's snapshot when no
                      // Queue is selected, not just the current one -- mirror
                      // that here too: with no Queue picked, check every
                      // department (current one first, most likely the
                      // intended match) instead of only the current/selected
                      // one.
                      // A ticket that's genuinely, currently Resolved/Closed
                      // (its real live status, not any department's frozen
                      // snapshot) must never display as anything else --
                      // confirmed for real: CF-29947/CF-29923/CF-29885 are
                      // all live-Resolved in their current department
                      // (Migration), but matched this exact Status filter
                      // (Resolved unchecked, In Progress checked) only
                      // because an OLDER department they'd already left
                      // (Dev/Infra) still has its own stale "In Progress"
                      // snapshot from before the handoff -- correct as a
                      // record of what happened there, but showing it as
                      // this row's CURRENT status read as "these are stuck
                      // in progress" when they're actually done. Once a
                      // ticket is really done, that wins over any
                      // department-snapshot match, regardless of which
                      // department's old status is why the row matched the
                      // filter at all.
                      const liveIsDone = issue.status?.category === 'done';
                      let matchedDeptSt: any = null;
                      if (liveIsDone) {
                        matchedDeptSt = null;
                      } else if (selQueue) {
                        const key = Object.keys(rawDeptStatuses).find((k) => k.toLowerCase() === selQueue.toLowerCase());
                        const st = key ? rawDeptStatuses[key] : null;
                        if (st?.name && selStatuses.some((s) => s.trim().toLowerCase() === String(st.name).trim().toLowerCase())) {
                          matchedDeptSt = st;
                        }
                      } else if (selStatuses.length > 0) {
                        const currentDept = ((issue as any).current_department || '').toLowerCase();
                        const deptKeys = Object.keys(rawDeptStatuses);
                        const orderedKeys = [
                          ...deptKeys.filter((k) => k.toLowerCase() === currentDept),
                          ...deptKeys.filter((k) => k.toLowerCase() !== currentDept),
                        ];
                        for (const k of orderedKeys) {
                          const st = rawDeptStatuses[k];
                          if (st?.name && selStatuses.some((s) => s.trim().toLowerCase() === String(st.name).trim().toLowerCase())) {
                            matchedDeptSt = st;
                            break;
                          }
                        }
                      }
                      const effectiveStatus = matchedDeptSt
                        ? { ...matchedDeptSt, color: resolveStatusColor(matchedDeptSt) }
                        : getEffectiveIssueStatus(issue, selQueue || undefined);
                      return (
                        <span
                          className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold text-white whitespace-nowrap"
                          style={{ backgroundColor: effectiveStatus.color || '#6B7280' }}
                        >
                          {effectiveStatus.name || 'Open'}
                        </span>
                      );
                    })()}
                  </td>
                  )}
                  {visibleStaticCols.includes('priority') && (
                  <td className="px-2 py-2.5">
                    <PriorityIcon priority={issue.priority} size={14} />
                  </td>
                  )}
                  {visibleStaticCols.includes('slaBreached') && (
                  <td className="px-2 py-2.5">
                    {issue.sla_breached == null ? (
                      // No SLA policy applies to this ticket's department at all
                      // (e.g. a queue like Infra that's never had one configured)
                      // -- "No" would misleadingly read as "there's an SLA and
                      // it's fine", when there's really nothing being measured.
                      <span className="inline-flex items-center rounded-full bg-gray-50 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-300" title="No SLA policy is configured for this ticket's department">—</span>
                    ) : issue.sla_breached ? (
                      <div className="flex flex-col items-start gap-0.5">
                        <span className="inline-flex items-center rounded-full bg-red-100 border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-600">Yes</span>
                        {/* Per explicit request: shows the ticket's actual
                            ASSIGNEE, not whoever happened to click Resolved
                            -- reversed from an earlier design that
                            attributed the breach to the resolving action's
                            author, since someone else (an admin, a
                            handoff) closing out a ticket on the assignee's
                            behalf is routine, and the business wants the
                            breach pinned on whoever was actually
                            responsible for the work. */}
                        {issue.sla_breached_by && (
                          <span className="text-[10px] text-gray-400 whitespace-nowrap" title="This ticket's assignee">
                            by {issue.sla_breached_by}
                          </span>
                        )}
                        {/* Which department this breach belongs to -- a plain
                            "Yes" said nothing about where. Matches the same
                            rule MBR's own SLA-breach counts use (the ticket's
                            CURRENT department), so Filters and MBR agree on
                            "which dept" instead of each implying a different
                            answer. */}
                        {issue.sla_breached_dept && (
                          <span className="text-[10px] text-gray-400 whitespace-nowrap" title="The department this breach is attributed to (the ticket's current department)">
                            in {issue.sla_breached_dept}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-400">No</span>
                    )}
                  </td>
                  )}
                  {visibleStaticCols.includes('overdue') && (
                  <td className="px-2 py-2.5">
                    {/* The ticket's own dueDate crossing "now" while still open --
                        independent of SLA Breached, which is the fact this exact
                        column used to be confused with (see YesNoFilterBtn above). */}
                    {issue.overdue ? (
                      <span className="inline-flex items-center rounded-full bg-orange-100 border border-orange-200 px-2 py-0.5 text-[11px] font-semibold text-orange-600">Yes</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-400">No</span>
                    )}
                  </td>
                  )}
                  {visibleStaticCols.includes('timeSpent') && (
                  <td className="px-2 py-2.5 text-right">
                    <span className="text-[11.5px] text-gray-600 tabular-nums font-medium whitespace-nowrap">
                      {typeof issue.inProgressHrs === 'number' ? `${issue.inProgressHrs}h` : '—'}
                      {issue.noHistory && (
                        <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded-full text-[9px] font-medium bg-amber-50 text-amber-700 align-middle">No history</span>
                      )}
                    </span>
                  </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}

        {/* Pagination -- results beyond the first 100 matches used to be
            completely unreachable (no page control existed at all), even
            though the header above correctly showed the true total. */}
        {!loadingIssues && total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-5 py-2.5">
            <p className="text-[12px] text-gray-500">
              Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <span className="text-[12px] text-gray-500">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>}

      {/* ── Save modal (portal → renders outside scroll container) ── */}
      {showSaveModal && typeof document !== 'undefined' && createPortal(
        <SaveModal
          criteria={currentCriteria}
          editFilter={editingFilter}
          onClose={() => { setShowSaveModal(false); setEditingFilter(null); }}
          onSaved={(f) => {
            setShowSaveModal(false); setEditingFilter(null);
            loadSavedFilters(); setActiveFilterId(f?.id || null);
          }}
        />,
        document.body,
      )}

      {/* ── Delete confirm (portal) ── */}
      {deleteConfirmId && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
          <div className="w-[360px] rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="text-[15px] font-semibold text-gray-900 mb-2">Delete filter</h3>
            <p className="text-[13px] text-gray-500 mb-5">Are you sure? This cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirmId(null)}
                className="rounded-md border border-gray-300 px-4 py-1.5 text-[12.5px] font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteConfirmId)}
                className="rounded-md bg-red-600 px-4 py-1.5 text-[12.5px] font-semibold text-white hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

