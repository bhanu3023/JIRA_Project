'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useRouter } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { timeAgo, cn, getEffectiveIssueStatus } from '@/lib/utils';
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

/* ─── types ─── */
interface FilterCriteria {
  spaces?: string[];
  queue?: string;
  assignees?: string[];
  types?: string[];
  statuses?: string[];
  priorities?: string[];
  text?: string;
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
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];
// Same fixed list the ticket's own Project Manager field picks from (CreateIssueModal.tsx,
// issues/[issueKey]/page.tsx) — individual people, not the comma-joined combinations a
// ticket ends up storing once multiple are picked (e.g. "Abhishikth, Abhishek").
const PROJECT_MANAGER_OPTIONS = ['Harika', 'Abhishek', 'Ajay Singh', 'Abhishikth', 'Raghu', 'Lakshmi Prasanna', 'Sri Ram', 'Chandra Mouli', 'Sravan', 'Pranavi', 'Others'];
// Same fixed list the ticket's own Product Type field picks from (see
// CreateIssueModal.tsx / issues/[issueKey]/page.tsx) — a free-text box here
// required typing the value out exactly (case and all) to match anything,
// which is why it looked broken; a handful of known values is a dropdown.
const PRODUCT_TYPE_OPTIONS = ['Content Migration', 'Email Migration', 'Message Migration', 'Board Migration', 'CF Connect', 'CF Manage', 'UI', 'others', 'Others'];
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
    return `More than ${n} ${unit} ago`;
  }
  if (val.startsWith('between:')) {
    const parts = val.split(':');
    return `${parts[1]} → ${parts[2]}`;
  }
  return IN_RANGE_PRESETS.find((p) => p.value === val)?.label || val;
}

/** Today's date as YYYY-MM-DD for default */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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
    const val = encodeDateFilter(mode, wlN, wlUnit, btFrom, btTo, preset);
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

            {/* More than */}
            <RadioRow m="moreThan">
              <span className="text-[13px] font-medium text-gray-800 flex-1">More than</span>
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

// All available "extra" filter options that can be added to the bar from More filters
const EXTRA_FILTER_OPTIONS = [
  { id: 'reporter',       label: 'Reporter',        group: 'People' },
  { id: 'projectManager', label: 'Project Manager', group: 'People' },
  { id: 'priority',       label: 'Priority',        group: 'Issue' },
  { id: 'department',     label: 'Department',      group: 'Issue' },
  { id: 'productType',    label: 'Product Type',    group: 'Issue' },
  { id: 'combination',    label: 'Combination',     group: 'Issue' },
  { id: 'customerName',   label: 'Customer Name',   group: 'Issue' },
  { id: 'clientName',     label: 'Client Name',     group: 'Issue' },
  { id: 'projectPool',    label: 'Project Pool',    group: 'Issue' },
  { id: 'created',        label: 'Created date',    group: 'Date' },
  { id: 'updated',        label: 'Updated date',    group: 'Date' },
  { id: 'dueDate',        label: 'Due Date',        group: 'Date' },
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
  const [selDueDate, setSelDueDate]       = useState('');
  const [selDepartment, setSelDepartment] = useState('');
  const [selProductType, setSelProductType] = useState<string[]>([]);
  const [selCombination, setSelCombination] = useState('');
  const [selCustomerName, setSelCustomerName] = useState('');
  const [selClientName, setSelClientName] = useState('');
  const [selProjectManager, setSelProjectManager] = useState<string[]>([]);
  const [selProjectPool, setSelProjectPool] = useState('');
  const [selBreached, setSelBreached] = useState<'yes' | 'no' | ''>('');
  const [selOverdue, setSelOverdue] = useState<'yes' | 'no' | ''>('');

  /* issues */
  const [issues, setIssues]   = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
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
  const DATE_GROUP_KEYS = ['created', 'updated', 'dueDate'];
  const clearExtraValue = (key: string) => {
    if (key === 'created')        setSelCreated('');
    if (key === 'updated')        setSelUpdated('');
    if (key === 'dueDate')        setSelDueDate('');
    if (key === 'reporter')       setSelReporters([]);
    if (key === 'priority')       setSelPriorities([]);
    if (key === 'department')     setSelDepartment('');
    if (key === 'productType')    setSelProductType([]);
    if (key === 'combination')    setSelCombination('');
    if (key === 'customerName')   setSelCustomerName('');
    if (key === 'clientName')     setSelClientName('');
    if (key === 'projectManager') setSelProjectManager([]);
    if (key === 'projectPool')    setSelProjectPool('');
  };
  const toggleExtra = (key: string) => {
    setActiveExtras((prev) => {
      if (prev.includes(key)) {
        clearExtraValue(key);
        return prev.filter((k) => k !== key);
      }
      let next = [...prev, key];
      if (key === 'dueDate') {
        // Due Date still exclusive with Created/Updated -- no backend
        // union support for combining it with either.
        const others = ['created', 'updated'].filter((k) => prev.includes(k));
        others.forEach(clearExtraValue);
        next = next.filter((k) => !others.includes(k));
      } else if (DATE_GROUP_KEYS.includes(key) && prev.includes('dueDate')) {
        clearExtraValue('dueDate');
        next = next.filter((k) => k !== 'dueDate');
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
    const rDueDate         = urlParams?.get('rDueDate');
    const rDepartment      = urlParams?.get('rDepartment');
    const rProductType     = urlParams?.get('rProductType');
    const rCombination     = urlParams?.get('rCombination');
    const rCustomerName    = urlParams?.get('rCustomerName');
    const rClientName      = urlParams?.get('rClientName');
    const rProjectManager  = urlParams?.get('rProjectManager');
    const rProjectPool     = urlParams?.get('rProjectPool');
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
    if (rDueDate) setSelDueDate(rDueDate);
    if (rDepartment) setSelDepartment(rDepartment);
    if (rProductType) setSelProductType(rProductType.split(','));
    if (rCombination) setSelCombination(rCombination);
    if (rCustomerName) setSelCustomerName(rCustomerName);
    if (rClientName) setSelClientName(rClientName);
    if (rProjectManager) setSelProjectManager(rProjectManager.split('|||'));
    if (rProjectPool) setSelProjectPool(rProjectPool);
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
      rProductType && 'productType', rCombination && 'combination', rCustomerName && 'customerName',
      rClientName && 'clientName', rProjectManager && 'projectManager', rProjectPool && 'projectPool',
      rDueDate && 'dueDate',
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
    if (selDueDate) p.rDueDate = selDueDate;
    if (selDepartment) p.rDepartment = selDepartment;
    if (selProductType.length) p.rProductType = selProductType.join(',');
    if (selCombination) p.rCombination = selCombination;
    if (selCustomerName) p.rCustomerName = selCustomerName;
    if (selClientName) p.rClientName = selClientName;
    if (selProjectManager.length) p.rProjectManager = selProjectManager.join('|||');
    if (selProjectPool) p.rProjectPool = selProjectPool;
    if (selBreached) p.rBreached = selBreached;
    if (selOverdue) p.rOverdue = selOverdue;
    if (text.trim()) p.rQ = text.trim();
    if (activeExtras.length) p.rExtras = activeExtras.join(',');
    return p;
  }, [selSpaces, selQueue, selAssignees, selReporters, selTypes, selStatuses, selPriorities, selCreated, selUpdated, selDueDate, selDepartment, selProductType, selCombination, selCustomerName, selClientName, selProjectManager, selProjectPool, selBreached, selOverdue, text, activeExtras]);

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
  const ALLOWED_STATUSES = new Set(['open', 'in progress', 'waiting for dev', 'waiting for migration', 'waiting for qa', 'waiting for infra', 'resolved']);
  const availableStatuses: { value: string; label: string }[] = Array.from(
    new Map([
      ...filteredSpacesForStatus
        .flatMap((sp: any) => (sp.statuses || []))
        .filter((s: any) => ALLOWED_STATUSES.has((s.name || '').toLowerCase()))
        .map((s: any) => [s.name, { value: s.name, label: s.name, order: s.order ?? 0 }] as const),
      // Merged in on top -- the selected queue's own "Routed to X" set, only
      // ever meaningful once a specific queue is chosen (see queueStatusOptions above).
      ...queueStatusOptions.map((s) => [s.value, { ...s, order: 99 }] as const),
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
    selCreated || selUpdated || selDueDate || selDepartment ||
    selProductType.length || selCombination || selCustomerName || selClientName || selProjectManager.length || selProjectPool || selBreached || selOverdue,
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
          // Queue + Assignee together should mean "did this person work this
          // dept's tickets", not "is this person the ticket's CURRENT owner
          // right now" -- without this, a ticket this person genuinely
          // worked here (e.g. resolved it) but which has since moved to
          // another department and been reassigned there silently drops out,
          // even though it's exactly the kind of ticket this combination is
          // meant to surface. Backend already supports this (includeHistory
          // folds in user_worked_on_tickets alongside the plain current-
          // assignee match) -- just never wired up from this page before.
          if (selQueue) params.includeHistory = 'true';
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
        if (selDueDate) params.dueDateRange = selDueDate;

        // Hours actually spent in an "In Progress"-type status per ticket --
        // needs an extra issue_history query on the backend, so opt-in rather
        // than always paid by every issues list fetch.
        params.includeTimeSpent = 'true';

        // Extra text/field filters
        if (selDepartment)     params.department     = selDepartment;
        if (selProductType.length) params.productType = selProductType.join(',');
        if (selCombination)    params.combination    = selCombination;
        if (selCustomerName)   params.customerName   = selCustomerName;
        if (selClientName)     params.clientName     = selClientName;
        // Joined with a delimiter that won't collide with commas already inside a
        // stored value (e.g. "Abhishikth, Abhishek" naming two people as one value).
        if (selProjectManager.length) params.projectManager = selProjectManager.join('|||');
        if (selProjectPool)    params.projectPool    = selProjectPool;
        if (selBreached) params.slaBreached = selBreached;
        if (selOverdue) params.overdue = selOverdue;

        // Text search
        if (text.trim()) params.q = text.trim();

        return params;
  }, [spaces, selSpaces, selQueue, allMembers, selAssignees, selReporters, selTypes, selStatuses, selPriorities, selCreated, selUpdated, selDueDate, selDepartment, selProductType, selCombination, selCustomerName, selClientName, selProjectManager, selProjectPool, selBreached, selOverdue, text]);

  /* fetch issues — all filtering done server-side for accuracy */
  const fetchIssues = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoadingIssues(true);
      try {
        // limit was 1000 — on an unfiltered view that's a ~2.7MB response (1000 full
        // issue objects with nested status/assignee/reporter), which is what made this
        // page take multiple seconds to load. 100 keeps a generous browsing window
        // while cutting the payload by ~90%.
        const params = { ...buildFilterParams(), page: '1', limit: '100' };
        const { issues: list, total: tot } = await api.getIssues(params);
        setIssues(list as any[]);
        setTotal(tot);
      } catch { setIssues([]); setTotal(0); }
      setLoadingIssues(false);
    }, 400);
  }, [buildFilterParams]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

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
    projectManager: { label: 'Project Manager', getValue: (i) => i.projectManager ?? '' },
    combination:    { label: 'Combination',     getValue: (i) => i.combination ?? '' },
    customerName:   { label: 'Customer Name',   getValue: (i) => i.customerName ?? '' },
    clientName:     { label: 'Client Name',     getValue: (i) => i.clientName ?? '' },
    projectPool:    { label: 'Project Pool',    getValue: (i) => i.projectPool ?? '' },
    dueDate:        { label: 'Due Date',        getValue: (i) => i.dueDate ?? '' },
  };
  const handleExport = async () => {
    setExporting(true);
    try {
      const EXPORT_LIMIT = 2000; // server's own hard cap (Math.min(2000, ...) in the issues list handler)
      const params = { ...buildFilterParams(), page: '1', limit: String(EXPORT_LIMIT) };
      const { issues: rows, total: matchedTotal } = await api.getIssues(params);
      const list = rows as any[];
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
        combination: !!selCombination,
        customerName: !!selCustomerName,
        clientName: !!selClientName,
        projectManager: selProjectManager.length > 0,
        projectPool: !!selProjectPool,
        dueDate: !!selDueDate,
      };
      const extraCols = Object.keys(EXPORT_EXTRA_COLUMNS).filter(
        (id) => activeExtras.includes(id) || fieldsWithSelectedValue[id as keyof typeof fieldsWithSelectedValue],
      );
      const header = [
        'Key', 'Type', 'Summary', 'Assignee', 'Reporter', 'Status', 'Priority', 'SLA Breached', 'SLA Breached By', 'Overdue', 'Department',
        'Created', 'Updated',
        ...extraCols.map((id) => EXPORT_EXTRA_COLUMNS[id].label),
      ];
      const lines = [header.map(csvCell).join(',')];
      for (const issue of list) {
        lines.push([
          issue.cfKey ?? issue.key,
          issue.type ?? '',
          issue.summary ?? '',
          issue.assignee ? `${issue.assignee.firstName || ''} ${issue.assignee.lastName || ''}`.trim() : 'Unassigned',
          issue.reporter ? `${issue.reporter.firstName || ''} ${issue.reporter.lastName || ''}`.trim() : '',
          issue.status?.name ?? '',
          issue.priority ?? '',
          issue.sla_breached == null ? 'N/A' : issue.sla_breached ? 'Yes' : 'No',
          issue.sla_breached ? (issue.sla_breached_by ?? '') : '',
          issue.overdue ? 'Yes' : 'No',
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
      a.download = `filtered-issues-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (matchedTotal > EXPORT_LIMIT) {
        alert(`Exported the first ${EXPORT_LIMIT.toLocaleString()} of ${matchedTotal.toLocaleString()} matching issues. Narrow your filters to export everything.`);
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
  // "Created" is table-only (kept out of EXPORT_EXTRA_COLUMNS since the CSV
  // export already always includes its own fixed Created column -- adding
  // it there too would double it up in the export).
  const TABLE_ONLY_COLUMNS: Record<string, { label: string; getValue: (issue: any) => string }> = {
    created: { label: 'Created', getValue: (i) => i.createdAt ? new Date(i.createdAt).toLocaleDateString() : '' },
  };
  const TABLE_COLUMN_DEFS: Record<string, { label: string; getValue: (issue: any) => string }> = {
    ...TABLE_ONLY_COLUMNS,
    ...EXPORT_EXTRA_COLUMNS,
  };
  const EXTRA_COLUMN_HAS_VALUE: Record<string, boolean> = {
    created: !!selCreated,
    productType: selProductType.length > 0,
    combination: !!selCombination,
    projectManager: selProjectManager.length > 0,
    customerName: !!selCustomerName,
    clientName: !!selClientName,
    projectPool: !!selProjectPool,
    dueDate: !!selDueDate,
  };
  const tableExtraCols = EXTRA_FILTER_OPTIONS
    .map((f) => f.id)
    .filter((id) => TABLE_COLUMN_DEFS[id] && (activeExtras.includes(id) || EXTRA_COLUMN_HAS_VALUE[id]));

  // When space selection changes, drop any selected statuses that no longer exist in the new scope
  useEffect(() => {
    if (selStatuses.length === 0) return;
    const validNames = new Set(availableStatuses.map((s) => s.value));
    const stillValid = selStatuses.filter((s) => validNames.has(s));
    if (stillValid.length !== selStatuses.length) setSelStatuses(stillValid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSpaces]);

  /* load saved filters */
  const loadSavedFilters = async () => {
    try { const data = await api.getFilters(); setSavedFilters(data as any); } catch { /* ignore */ }
  };
  useEffect(() => { loadSavedFilters(); }, []);

  const clearAll = () => {
    setText(''); setSelSpaces([]); setSelQueue(''); setSelAssignees([]); setSelReporters([]);
    setSelTypes([]); setSelStatuses([]); setSelPriorities([]);
    setSelCreated(''); setSelUpdated(''); setSelDueDate('');
    setSelDepartment(''); setSelProductType([]);
    setSelCombination(''); setSelCustomerName(''); setSelClientName(''); setSelProjectManager([]);
    setSelProjectPool('');
    setSelBreached('');
    setSelOverdue('');
    setActiveExtras([]);
    setActiveFilterId(null);
  };

  const applyFilter = (f: SavedFilter) => {
    const c = f.criteria || {};
    setText(c.text || '');
    setSelSpaces(c.spaces || []);
    setSelQueue((c as any).queue || '');
    setSelAssignees(c.assignees || []);
    setSelReporters((c as any).reporters || []);
    setSelTypes(c.types || []);
    setSelStatuses(c.statuses || []);
    setSelPriorities(c.priorities || []);
    const cr = (c as any).createdRange || '';
    const ur = (c as any).updatedRange || '';
    setSelCreated(cr);
    setSelUpdated(ur);
    // auto-show bar buttons for any criteria that have values
    const extras: string[] = [];
    if ((c as any).reporters?.length) extras.push('reporter');
    if (c.priorities?.length)         extras.push('priority');
    if (cr)                           extras.push('created');
    if (ur)                           extras.push('updated');
    setActiveExtras(extras);
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

  const currentCriteria: FilterCriteria & { reporters?: string[]; createdRange?: string; updatedRange?: string } = {
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
            {can(user?.role, 'exportData') && (
              <button
                onClick={handleExport}
                disabled={exporting || issues.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <Download size={13} /> {exporting ? 'Exporting…' : 'Export'}
              </button>
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
            {activeExtras.includes('combination') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Combination" value={selCombination} onChange={setSelCombination} />
                <button onClick={() => toggleExtra('combination')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('customerName') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Customer Name" value={selCustomerName} onChange={setSelCustomerName} />
                <button onClick={() => toggleExtra('customerName')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('clientName') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Client Name" value={selClientName} onChange={setSelClientName} />
                <button onClick={() => toggleExtra('clientName')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
            {activeExtras.includes('projectPool') && (
              <div className="flex items-center gap-1">
                <TextFilterBtn label="Project Pool" value={selProjectPool} onChange={setSelProjectPool} />
                <button onClick={() => toggleExtra('projectPool')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
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
            {activeExtras.includes('dueDate') && (
              <div className="flex items-center gap-1">
                <DateDropBtn label="Due Date" selected={selDueDate} onChange={setSelDueDate} />
                <button onClick={() => toggleExtra('dueDate')} className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><X size={11} /></button>
              </div>
            )}
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

        {loadingIssues ? (
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
          <table className="w-full table-fixed">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
                <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-24">Key</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">Work</th>
                {tableExtraCols.map((id) => (
                  <th key={id} className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-32">
                    {TABLE_COLUMN_DEFS[id].label}
                  </th>
                ))}
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-44 hidden sm:table-cell">Assignee</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-44 hidden sm:table-cell">Reported By</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-28 hidden sm:table-cell">Status</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-16 hidden md:table-cell">Priority</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-20 hidden sm:table-cell">SLA Breached</th>
                <th className="px-2 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide w-16 hidden sm:table-cell">Overdue</th>
                <th className="px-2 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wide w-24 hidden md:table-cell">Time Spent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {issues.slice(0, 100).map((issue: any) => {
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
                  <td className="px-4 py-2.5">
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
                  <td className="px-2 py-2.5">
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
                  <td className="px-2 py-2.5 hidden sm:table-cell">
                    {issue.assignee ? (
                      <div className="flex items-center gap-1.5">
                        <div className="h-6 w-6 flex-shrink-0 rounded-full bg-blue-500 flex items-center justify-center text-[9px] font-bold text-white">
                          {`${issue.assignee.firstName?.[0] || ''}${issue.assignee.lastName?.[0] || ''}`.toUpperCase()}
                        </div>
                        <span className="text-[12px] text-gray-600 truncate">
                          {`${issue.assignee.firstName || ''} ${issue.assignee.lastName || ''}`.trim()}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-gray-300">Unassigned</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 hidden sm:table-cell">
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
                  <td className="px-2 py-2.5 hidden sm:table-cell">
                    {(() => {
                      const effectiveStatus = getEffectiveIssueStatus(issue);
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
                  <td className="px-2 py-2.5 hidden md:table-cell">
                    <PriorityIcon priority={issue.priority} size={14} />
                  </td>
                  <td className="px-2 py-2.5 hidden sm:table-cell">
                    {issue.sla_breached == null ? (
                      // No SLA policy applies to this ticket's department at all
                      // (e.g. a queue like Infra that's never had one configured)
                      // -- "No" would misleadingly read as "there's an SLA and
                      // it's fine", when there's really nothing being measured.
                      <span className="inline-flex items-center rounded-full bg-gray-50 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-300" title="No SLA policy is configured for this ticket's department">—</span>
                    ) : issue.sla_breached ? (
                      <div className="flex flex-col items-start gap-0.5">
                        <span className="inline-flex items-center rounded-full bg-red-100 border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-600">Yes</span>
                        {/* Whoever currently holds the ticket (the Assignee column)
                            isn't necessarily who caused this -- a ticket resolved
                            late and reassigned afterward would otherwise pin the
                            breach on the wrong person. This is the author of the
                            status change that actually put it in its current
                            state, same definition the ticket detail page's own
                            SLA panel already uses for "Resolved by". */}
                        {issue.sla_breached_by && (
                          <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Author of the status change that resolved this ticket">
                            by {issue.sla_breached_by}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-400">No</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 hidden sm:table-cell">
                    {/* The ticket's own dueDate crossing "now" while still open --
                        independent of SLA Breached, which is the fact this exact
                        column used to be confused with (see YesNoFilterBtn above). */}
                    {issue.overdue ? (
                      <span className="inline-flex items-center rounded-full bg-orange-100 border border-orange-200 px-2 py-0.5 text-[11px] font-semibold text-orange-600">Yes</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-400">No</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right hidden md:table-cell">
                    <span className="text-[11.5px] text-gray-600 tabular-nums font-medium whitespace-nowrap">
                      {typeof issue.inProgressHrs === 'number' ? `${issue.inProgressHrs}h` : '—'}
                      {issue.noHistory && (
                        <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded-full text-[9px] font-medium bg-amber-50 text-amber-700 align-middle">No history</span>
                      )}
                    </span>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
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

