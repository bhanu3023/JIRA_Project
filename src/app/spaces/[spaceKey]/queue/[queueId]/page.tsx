'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ArrowLeft, Users, Clock, Plus, X, Check, Search,
  Trash2, Calendar, ChevronRight, Edit2, AlertCircle, RefreshCw, Mail, Link2, Unlink,
  Eye, EyeOff, Wifi, WifiOff, Loader2, GitMerge, Network
} from 'lucide-react';
import { cn } from '@/lib/utils';

type SLAGoal = { id: string; priority: string; timeValue: string; timeUnit: 'minutes' | 'hours' | 'days' };
type SLAPolicy = {
  id: string; name: string; goals: SLAGoal[];
  startCondition?: string; pauseCondition?: string; stopCondition?: string;
  enabled?: boolean;
};
type CustomQueue = {
  id: string; name: string; memberIds: string[]; suspendedIds?: string[];
  sla?: { timeValue: string; timeUnit: 'minutes' | 'hours' | 'days' };
  slaPolicies?: SLAPolicy[];
  workflowSpaceKey?: string;
  statusIds?: string[];
  queueStatuses?: { id: string; name: string; color: string; category: string; order: number }[];
  queueTransitions?: { from: string; to: string }[];
};

const ALL_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
const COLORS = ['bg-blue-500','bg-purple-500','bg-green-500','bg-orange-500','bg-rose-500','bg-teal-500','bg-indigo-500','bg-amber-500'];
const avatarColor = (name: string) => COLORS[(name||'').charCodeAt(0) % COLORS.length];
const mkInitials = (f: string, l: string) => `${(f||'')[0]||''}${(l||'')[0]||''}`.toUpperCase();

const PRIORITY_META: Record<string, { color: string; icon: string }> = {
  Highest: { color: 'text-red-600',    icon: '▲' },
  High:    { color: 'text-orange-500', icon: '▲' },
  Medium:  { color: 'text-blue-500',   icon: '▬' },
  Low:     { color: 'text-blue-400',   icon: '▼' },
  Lowest:  { color: 'text-gray-400',   icon: '▼' },
};

const mkPolicy = (name: string, startCond: string, pauseCond: string, stopCond: string): SLAPolicy => ({
  id: `sla_${Date.now()}`,
  name,
  startCondition: startCond,
  pauseCondition: pauseCond,
  stopCondition: stopCond,
  goals: ALL_PRIORITIES.map(p => ({ id: `g_${Date.now()}_${p}`, priority: p, timeValue: '', timeUnit: 'hours' })),
});

// Converts a raw sla_definitions row (the canonical DB shape this page
// writes via createSLA/updateSLA) into the UI's SLAPolicy shape. Only the
// isPriorityGroup goal entry is understood here -- that's the only shape
// this page itself ever writes -- a row with some other goal shape (e.g.
// imported from Jira with per-goal JQL/calendar fields) just shows up with
// its priority rows empty rather than crashing.
const dbRowToPolicy = (row: any): SLAPolicy => {
  const rawGoals = Array.isArray(row.goals) ? row.goals : [];
  const priorityGroup = rawGoals.find((g: any) => g?.isPriorityGroup && Array.isArray(g.priorityRows));
  const byPriority: Record<string, { timeValue: string; timeUnit: string }> = {};
  (priorityGroup?.priorityRows || []).forEach((r: any) => {
    byPriority[String(r.priority || '').toLowerCase()] = { timeValue: String(r.timeValue ?? ''), timeUnit: r.timeUnit || 'hours' };
  });
  return {
    id: row.id,
    name: row.name,
    startCondition: row.startCondition || undefined,
    stopCondition: row.stopCondition || undefined,
    enabled: row.status !== 'inactive',
    goals: ALL_PRIORITIES.map(p => ({
      id: `g_${row.id}_${p}`,
      priority: p,
      timeValue: byPriority[p.toLowerCase()]?.timeValue || '',
      timeUnit: (byPriority[p.toLowerCase()]?.timeUnit as 'minutes' | 'hours' | 'days') || 'hours',
    })),
  };
};

/* ─── Create SLA Modal ─── */
function CreateSLAModal({ onClose, onCreate }: { onClose: () => void; onCreate: (p: SLAPolicy) => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('Issue created');
  const [pause, setPause] = useState('Status = Waiting for customer');
  const [stop, setStop] = useState('Status = Resolved OR Status = Closed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] p-7" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[18px] font-bold text-gray-900">Create SLA</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"><X size={16} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">SLA name <span className="text-red-500">*</span></label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(mkPolicy(name.trim(), start, pause, stop)); }}
              placeholder="e.g. Time to first response"
              className="w-full border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
          </div>
          <div>
            <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">Start condition</label>
            <input value={start} onChange={e => setStart(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-gray-50" />
          </div>
          <div>
            <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">Pause condition</label>
            <input value={pause} onChange={e => setPause(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-gray-50" />
          </div>
          <div>
            <label className="block text-[12.5px] font-semibold text-gray-700 mb-1.5">Stop condition</label>
            <input value={stop} onChange={e => setStop(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-gray-50" />
          </div>
          <p className="text-[11.5px] text-blue-600 bg-blue-50 rounded-lg px-3 py-2">Goals (time targets per priority) can be configured after creation.</p>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-5 py-2.5 text-[13px] font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">Cancel</button>
          <button onClick={() => name.trim() && onCreate(mkPolicy(name.trim(), start, pause, stop))} disabled={!name.trim()}
            className="px-5 py-2.5 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            Create SLA
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── SLA Detail View ─── */
function SLADetail({ policy, onBack, onSave, onDelete }: {
  policy: SLAPolicy;
  onBack: () => void;
  onSave: (p: SLAPolicy) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [goals, setGoals] = useState<SLAGoal[]>(policy.goals);
  const [startCond, setStartCond] = useState(policy.startCondition || 'Issue created');
  const [pauseCond, setPauseCond] = useState(policy.pauseCondition || 'Status = Waiting for customer');
  const [stopCond, setStopCond] = useState(policy.stopCondition || 'Status = Resolved OR Status = Closed');
  const [enabled, setEnabled] = useState(policy.enabled !== false); // default true
  const configuredCount = goals.filter(g => g.timeValue).length;

  const updateGoal = (priority: string, field: 'timeValue' | 'timeUnit', val: string) => {
    setGoals(prev => prev.map(g => g.priority === priority ? { ...g, [field]: val } : g));
  };

  const handleToggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    onSave({ ...policy, goals, startCondition: startCond, pauseCondition: pauseCond, stopCondition: stopCond, enabled: next });
  };

  const handleSave = () => {
    onSave({ ...policy, goals, startCondition: startCond, pauseCondition: pauseCond, stopCondition: stopCond, enabled });
    setEditing(false);
  };

  const handleCancel = () => {
    setGoals(policy.goals);
    setStartCond(policy.startCondition || 'Issue created');
    setPauseCond(policy.pauseCondition || 'Status = Waiting for customer');
    setStopCond(policy.stopCondition || 'Status = Resolved OR Status = Closed');
    setEnabled(policy.enabled !== false);
    setEditing(false);
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      {/* Back + Edit header */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-blue-600 hover:text-blue-800 font-medium">
          <ArrowLeft size={14} /> Back to SLAs
        </button>
        {!editing ? (
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 px-4 py-2 border border-gray-200 rounded-lg text-[13px] font-medium text-gray-700 hover:bg-gray-100 transition-colors">
            <Edit2 size={13} /> Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={handleSave} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-[13px] font-medium hover:bg-blue-700 transition-colors">
              <Check size={13} /> Save changes
            </button>
            <button onClick={handleCancel} className="px-4 py-2 border border-gray-200 rounded-lg text-[13px] font-medium text-gray-700 hover:bg-gray-100 transition-colors">Cancel</button>
          </div>
        )}
      </div>

      {/* SLA header card */}
      <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 mb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Clock size={20} className="text-blue-500" />
            <h1 className="text-[20px] font-bold text-gray-900">{policy.name}</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[12.5px] text-gray-500">{configuredCount} goal{configuredCount !== 1 ? 's' : ''}</span>
            {/* Enable / Disable toggle */}
            <div className="flex items-center gap-2.5">
              <span className={`text-[12.5px] font-semibold ${enabled ? 'text-emerald-700' : 'text-gray-400'}`}>
                {enabled ? 'Enabled' : 'Disabled'}
              </span>
              <button
                onClick={handleToggleEnabled}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                title={enabled ? 'Click to disable SLA' : 'Click to enable SLA'}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
              </button>
            </div>
            <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3 py-1 ${enabled ? 'text-emerald-700 bg-emerald-50 border border-emerald-200' : 'text-gray-500 bg-gray-100 border border-gray-200'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {enabled ? 'active' : 'inactive'}
            </span>
          </div>
        </div>
      </div>

      {/* Goals section */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-5">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-[14px] font-bold text-gray-900">Goals</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Work items will be checked against this list, top to bottom, and assigned a time goal based on the first matching priority.</p>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-500 uppercase tracking-wider">Apply to work items</th>
              <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-500 uppercase tracking-wider">Calendar</th>
              <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-500 uppercase tracking-wider">Time Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {goals.map(goal => {
              const meta = PRIORITY_META[goal.priority] || { color: 'text-gray-500', icon: '•' };
              return (
                <tr key={goal.priority} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-3.5">
                    <span className={cn('flex items-center gap-2 text-[13px] font-medium', meta.color)}>
                      <span className="text-[10px]">{meta.icon}</span>{goal.priority}
                    </span>
                  </td>
                  <td className="px-6 py-3.5">
                    <span className="flex items-center gap-1.5 text-[12.5px] text-gray-500">
                      <Calendar size={13} className="text-gray-400" />24/7 Calendar (Default)
                    </span>
                  </td>
                  <td className="px-6 py-3.5">
                    {editing ? (
                      <div className="flex items-center gap-2">
                        <input type="number" min="1" max="9999" value={goal.timeValue}
                          onChange={e => updateGoal(goal.priority, 'timeValue', e.target.value)}
                          placeholder="—"
                          className="w-20 border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100" />
                        <select value={goal.timeUnit} onChange={e => updateGoal(goal.priority, 'timeUnit', e.target.value)}
                          className="border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-blue-400 bg-white">
                          <option value="minutes">min</option>
                          <option value="hours">h</option>
                          <option value="days">d</option>
                        </select>
                      </div>
                    ) : (
                      <span className={`text-[13px] font-semibold ${goal.timeValue ? 'text-gray-800' : 'text-gray-300'}`}>
                        {goal.timeValue ? `${goal.timeValue}${goal.timeUnit === 'hours' ? 'h' : goal.timeUnit === 'days' ? 'd' : 'min'}` : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {/* All remaining */}
            <tr className="hover:bg-gray-50/50 transition-colors">
              <td className="px-6 py-3.5"><span className="text-[13px] font-medium text-orange-600">All remaining work items</span></td>
              <td className="px-6 py-3.5"><span className="flex items-center gap-1.5 text-[12.5px] text-gray-500"><Calendar size={13} className="text-gray-400" />24/7 Calendar (Default)</span></td>
              <td className="px-6 py-3.5"><span className="text-[13px] text-gray-300">—</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Conditions section */}
      <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 mb-5">
        <h2 className="text-[14px] font-bold text-gray-900 mb-1">Conditions</h2>
        <p className="text-[12px] text-gray-500 mb-5">Time will be measured based on when start/stop/pause conditions are met.</p>
        <div className="space-y-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider mb-0.5 text-emerald-600">START CONDITION</p>
            <p className="text-[11.5px] text-gray-400 mb-2">When does the SLA clock start?</p>
            <input value={startCond} onChange={e => setStartCond(e.target.value)}
              className="w-full max-w-md font-mono text-[12.5px] bg-white border border-emerald-300 rounded-lg px-3 py-2 text-gray-700 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider mb-0.5 text-amber-600">PAUSE CONDITION</p>
            <p className="text-[11.5px] text-gray-400 mb-2">When does the SLA clock pause?</p>
            <input value={pauseCond} onChange={e => setPauseCond(e.target.value)}
              className="w-full max-w-md font-mono text-[12.5px] bg-white border border-amber-300 rounded-lg px-3 py-2 text-gray-700 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider mb-0.5 text-red-500">STOP CONDITION</p>
            <p className="text-[11.5px] text-gray-400 mb-2">When does the SLA clock stop?</p>
            <input value={stopCond} onChange={e => setStopCond(e.target.value)}
              className="w-full max-w-md font-mono text-[12.5px] bg-white border border-red-300 rounded-lg px-3 py-2 text-gray-700 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100" />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <Check size={13} /> Save conditions
          </button>
        </div>
      </div>

      {/* Delete */}
      <div className="flex justify-end">
        <button onClick={() => { onDelete(policy.id); onBack(); }}
          className="flex items-center gap-1.5 text-[12.5px] text-red-500 hover:text-red-700 px-4 py-2 rounded-lg hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors">
          <Trash2 size={13} /> Delete SLA
        </button>
      </div>
    </div>
  );
}

/* ─── SLA List Tab ─── */
function SLATab({ queue, policies, savedMsg, savePolicies }: {
  queue: { name: string };
  policies: SLAPolicy[];
  savedMsg: string;
  savePolicies: (p: SLAPolicy[]) => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const detailPolicy = detailId ? policies.find(p => p.id === detailId) : null;

  const handleCreate = (p: SLAPolicy) => {
    savePolicies([...policies, p]);
    setShowModal(false);
    setDetailId(p.id);
  };

  const handleSave = (updated: SLAPolicy) => {
    savePolicies(policies.map(p => p.id === updated.id ? updated : p));
  };

  const handleDelete = (id: string) => {
    savePolicies(policies.filter(p => p.id !== id));
    setDetailId(null);
  };

  if (detailPolicy) {
    return <SLADetail policy={detailPolicy} onBack={() => setDetailId(null)} onSave={handleSave} onDelete={handleDelete} />;
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      {showModal && <CreateSLAModal onClose={() => setShowModal(false)} onCreate={handleCreate} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[20px] font-bold text-gray-900">SLAs</h1>
          <p className="text-[13px] text-gray-500 mt-0.5">Define service level agreements to ensure timely responses and resolutions.</p>
        </div>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600"><Check size={14} />{savedMsg}</span>}
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <Plus size={14} /> Create SLA
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-[2fr_3fr_2fr_1fr] border-b border-gray-200 bg-gray-50 px-5 py-3">
          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">SLA Name</span>
          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Goals</span>
          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Start Condition</span>
          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</span>
        </div>

        {policies.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Clock size={32} className="text-gray-200 mb-3" />
            <p className="text-[15px] font-semibold text-gray-400">No SLAs configured</p>
            <p className="text-[12.5px] text-gray-400 mt-1">Create your first SLA to track response times.</p>
          </div>
        ) : (
          policies.map(policy => {
            const configured = policy.goals.filter(g => g.timeValue);
            return (
              <div key={policy.id}
                className="grid grid-cols-[2fr_3fr_2fr_1fr] items-center px-5 py-4 border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors group"
                onClick={() => setDetailId(policy.id)}>
                <div className="flex items-center gap-2.5">
                  <Clock size={15} className="text-blue-500 flex-shrink-0" />
                  <span className="text-[13.5px] font-semibold text-blue-600 group-hover:underline">{policy.name}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {configured.length > 0
                    ? configured.map(g => {
                        const meta = PRIORITY_META[g.priority] || { color: 'text-gray-500', icon: '•' };
                        return (
                          <span key={g.priority} className={cn('text-[11.5px] font-semibold', meta.color)}>
                            {g.priority}: {g.timeValue}{g.timeUnit === 'hours' ? 'h' : g.timeUnit === 'days' ? 'd' : 'm'}
                          </span>
                        );
                      })
                    : <span className="text-[12px] text-gray-300 italic">No goals set — click to configure</span>}
                </div>
                <div>
                  <span className="text-[12.5px] text-gray-500">{policy.startCondition || 'Issue created'}</span>
                </div>
                <div onClick={e => e.stopPropagation()}>
                  {policy.enabled !== false ? (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2.5 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />Inactive
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ─── Queue Email Tab ─── */
function QueueEmailTab({ spaceKey, queueName }: { spaceKey: string; queueName: string }) {
  const [allEmails, setAllEmails] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState<string | null>(null);
  const [savedMsg, setSavedMsg]   = useState('');
  const [restarting, setRestarting]   = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showPwd, setShowPwd]     = useState(false);
  const [form, setForm]           = useState({ email: '', password: '', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' });
  const [testing, setTesting]     = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [adding, setAdding]       = useState(false);

  const linked   = allEmails.filter(e => e.department?.toLowerCase() === queueName.toLowerCase());
  const unlinked = allEmails.filter(e => !e.department || e.department.toLowerCase() !== queueName.toLowerCase());

  useEffect(() => {
    api.request<any[]>(`/email-addresses/${spaceKey}`)
      .then(rows => setAllEmails(rows || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [spaceKey]);

  const flash = (msg: string) => { setSavedMsg(msg); setTimeout(() => setSavedMsg(''), 2500); };

  const linkEmail = async (emailId: string) => {
    setSaving(emailId);
    try {
      await api.request(`/email-addresses/${spaceKey}/${emailId}`, { method: 'PATCH', body: JSON.stringify({ department: queueName }) });
      setAllEmails(prev => prev.map(e => e.id === emailId ? { ...e, department: queueName } : e));
      flash('Linked');
    } catch { flash('Failed'); }
    setSaving(null);
  };

  const unlinkEmail = async (emailId: string) => {
    setSaving(emailId);
    try {
      // DELETE fully removes the email config and stops the IMAP poller
      await api.request(`/email-addresses/${spaceKey}/${emailId}`, { method: 'DELETE' });
      setAllEmails(prev => prev.filter(e => e.id !== emailId));
      flash('Email disconnected');
    } catch { flash('Failed'); }
    setSaving(null);
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/email/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, password: form.password, imapHost: form.imapHost, smtpHost: form.smtpHost, spaceKey, testOnly: true, appUrl: window.location.origin }),
      });
      const data = await res.json();
      setTestResult({ ok: !!data.ok, message: data.ok ? `Connected successfully to ${form.imapHost}` : (data.error || 'Connection failed') });
    } catch {
      setTestResult({ ok: false, message: 'Network error — check your credentials' });
    }
    setTesting(false);
  };

  const restartPoller = async (address: string) => {
    setRestarting(address);
    try {
      const res = await fetch('/api/email/restart-pollers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const data = await res.json();
      flash(data.ok ? `Poller restarted for ${address}` : (data.error || 'Restart failed'));
    } catch { flash('Restart failed'); }
    setRestarting(null);
  };

  const addAndLink = async () => {
    setAdding(true);
    try {
      const res = await fetch('/api/email/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, password: form.password, imapHost: form.imapHost, smtpHost: form.smtpHost, spaceKey, department: queueName, appUrl: window.location.origin }),
      });
      const data = await res.json();
      if (!data.ok) { setTestResult({ ok: false, message: data.error || 'Failed to add email' }); setAdding(false); return; }
      // Reload email list
      const rows = await api.request<any[]>(`/email-addresses/${spaceKey}`).catch(() => []);
      setAllEmails(rows || []);
      setShowAddForm(false);
      setForm({ email: '', password: '', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' });
      setTestResult(null);
      flash('Email added & linked');
    } catch { setTestResult({ ok: false, message: 'Failed to add email' }); }
    setAdding(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400 text-[13px]">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-[20px] font-bold text-gray-900">Email</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            Link email addresses to the <strong>{queueName}</strong> queue. Incoming emails will create tickets here automatically.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600"><Check size={14} />{savedMsg}</span>}
          <button onClick={() => { setShowAddForm(v => !v); setTestResult(null); }}
            className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3.5 py-2 rounded-lg transition-colors">
            {showAddForm ? <X size={13} /> : <Plus size={13} />}
            {showAddForm ? 'Cancel' : 'Add Email'}
          </button>
        </div>
      </div>

      {/* ── Add Email Form ── */}
      {showAddForm && (
        <div className="mb-6 border border-blue-200 bg-blue-50/40 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-blue-100 bg-blue-50">
            <Mail size={14} className="text-blue-600" />
            <span className="text-[13px] font-semibold text-blue-800">Connect a new email address</span>
          </div>
          <div className="px-5 py-5 space-y-4">
            {/* Provider quick-select */}
            <div>
              <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-2">Choose Provider</label>
              <div className="grid grid-cols-2 gap-3">
                {/* Microsoft OAuth — recommended for Office 365 / cloudfuze.com */}
                <button type="button"
                  onClick={() => {
                    if (!form.email) { setTestResult({ ok: false, message: 'Enter your email address first' }); return; }
                    const returnUrl = `/spaces/${spaceKey}/queue/${window.location.pathname.split('/').pop()}?tab=email`;
                    window.location.href = `/api/auth/oauth/microsoft?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(window.location.pathname + '?tab=email')}&mode=email&loginHint=${encodeURIComponent(form.email)}&department=${encodeURIComponent(queueName)}`;
                  }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-[#0078D4] bg-[#0078D4]/5 hover:bg-[#0078D4]/10 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 21 21" fill="none"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>
                  <div className="text-left">
                    <p className="text-[13px] font-semibold text-[#0078D4]">Microsoft / Office 365</p>
                    <p className="text-[11px] text-gray-500">Outlook, cloudfuze.com — Recommended</p>
                  </div>
                </button>

                {/* Google OAuth */}
                <button type="button"
                  onClick={() => {
                    if (!form.email) { setTestResult({ ok: false, message: 'Enter your email address first' }); return; }
                    window.location.href = `/api/auth/oauth/google?spaceKey=${spaceKey}&returnUrl=${encodeURIComponent(window.location.pathname + '?tab=email')}&mode=email&loginHint=${encodeURIComponent(form.email)}&department=${encodeURIComponent(queueName)}`;
                  }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-gray-200 hover:border-gray-300 bg-white hover:bg-gray-50 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                  <div className="text-left">
                    <p className="text-[13px] font-semibold text-gray-700">Google / Gmail</p>
                    <p className="text-[11px] text-gray-500">Gmail accounts</p>
                  </div>
                </button>
              </div>
            </div>

            <div className="relative flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-[11px] text-gray-400 font-medium">OR enter email manually (IMAP password)</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            <div>
              <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Email Address</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="you@example.com"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-300" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">IMAP Host</label>
                <select value={form.imapHost} onChange={e => setForm(f => ({ ...f, imapHost: e.target.value, smtpHost: e.target.value === 'imap.gmail.com' ? 'smtp.gmail.com' : e.target.value === 'outlook.office365.com' ? 'smtp.office365.com' : f.smtpHost }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-300">
                  <option value="outlook.office365.com">Outlook / Office 365</option>
                  <option value="imap.gmail.com">Gmail</option>
                  <option value="imap.mail.yahoo.com">Yahoo</option>
                </select>
              </div>
              <div>
                <label className="block text-[11.5px] font-semibold text-gray-600 uppercase tracking-wide mb-1.5">App Password</label>
                <div className="relative">
                  <input type={showPwd ? 'text' : 'password'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="App password"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-9 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>

            {/* Test result banner */}
            {testResult && (
              <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-[12.5px] font-medium ${testResult.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                {testResult.ok ? <Wifi size={14} /> : <WifiOff size={14} />}
                {testResult.message}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button onClick={testConnection} disabled={testing || !form.email || !form.password || !form.imapHost}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-300 bg-white text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors">
                {testing ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              <button onClick={addAndLink} disabled={adding || !form.email || !form.password || !form.imapHost}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-[12.5px] font-semibold hover:bg-blue-700 disabled:opacity-40 transition-colors">
                {adding ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {adding ? 'Connecting…' : 'Add & Link to Queue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Linked emails */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50">
          <Link2 size={14} className="text-blue-500" />
          <span className="text-[13px] font-semibold text-gray-800">Linked to this queue</span>
          <span className="text-[11px] font-medium text-gray-400 bg-gray-200 rounded-full px-2 py-0.5">{linked.length}</span>
        </div>
        {linked.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <Mail size={24} className="text-gray-200 mb-2" />
            <p className="text-[13px] text-gray-400">No email addresses linked yet</p>
            <p className="text-[12px] text-gray-400 mt-0.5">Add an email above or link one from the list below.</p>
          </div>
        ) : linked.map(email => (
          <div key={email.id} className="flex items-center justify-between px-5 py-3.5 border-b border-gray-50 last:border-0 hover:bg-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                <Mail size={14} className="text-blue-600" />
              </div>
              <div>
                <p className="text-[13px] font-medium text-gray-800">{email.address}</p>
                <p className="text-[11.5px] text-gray-400 flex items-center gap-1">
                  <Wifi size={11} className="text-emerald-500" /> Active · {email.requestType || 'Emailed request'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => restartPoller(email.address)} disabled={restarting === email.address}
                className="flex items-center gap-1.5 text-[12px] font-medium text-blue-600 hover:text-blue-800 px-3 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-50 transition-colors disabled:opacity-40"
                title="Restart IMAP poller (use if emails stopped creating tickets)">
                {restarting === email.address ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {restarting === email.address ? 'Restarting…' : 'Restart'}
              </button>
              <button onClick={() => unlinkEmail(email.id)} disabled={saving === email.id}
                className="flex items-center gap-1.5 text-[12px] font-medium text-red-500 hover:text-red-700 px-3 py-1.5 rounded-lg border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-40">
                <Unlink size={13} /> {saving === email.id ? 'Saving…' : 'Unlink'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* All other space emails */}
      {unlinked.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50">
            <Mail size={14} className="text-gray-400" />
            <span className="text-[13px] font-semibold text-gray-800">Other space emails</span>
            <span className="text-[11px] font-medium text-gray-400 bg-gray-200 rounded-full px-2 py-0.5">{unlinked.length}</span>
          </div>
          {unlinked.map(email => (
            <div key={email.id} className="flex items-center justify-between px-5 py-3.5 border-b border-gray-50 last:border-0 hover:bg-gray-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                  <Mail size={14} className="text-gray-400" />
                </div>
                <div>
                  <p className="text-[13px] font-medium text-gray-700">{email.address}</p>
                  <p className="text-[11.5px] text-gray-400">
                    {email.department ? `Linked to: ${email.department}` : 'Not linked to any queue'}
                  </p>
                </div>
              </div>
              <button onClick={() => linkEmail(email.id)} disabled={saving === email.id}
                className="flex items-center gap-1.5 text-[12px] font-medium text-blue-600 hover:text-blue-800 px-3 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-50 transition-colors disabled:opacity-40">
                <Link2 size={13} /> {saving === email.id ? 'Saving…' : 'Link to this queue'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Round Robin Tab ─── */
function RoundRobinTab({ spaceKey, queueName, spaceMembers }: {
  spaceKey: string;
  queueName: string;
  spaceMembers: any[];
}) {
  const [agents, setAgents] = useState<Array<{
    userId: string; name: string; email: string;
    shiftStart: string; shiftEnd: string; isActive: boolean;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [allDepts, setAllDepts] = useState<any[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [productTypeRules, setProductTypeRules] = useState<Array<{ productType: string; userId: string; name: string }>>([]);
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleProductType, setRuleProductType] = useState('');
  const [ruleAgentSearch, setRuleAgentSearch] = useState('');

  // Load existing RR config for this department
  useEffect(() => {
    api.getRrConfig(spaceKey).then((res: any) => {
      const depts: any[] = res?.config?.departments || [];
      setAllDepts(depts);
      const dept = depts.find((d: any) => d.name.toLowerCase() === queueName.toLowerCase());
      if (dept) {
        setIsDefault(!!dept.isDefault);
        setAgents((dept.agents || []).map((a: any) => ({
          userId: a.userId, name: a.name, email: a.email || '',
          shiftStart: a.shiftStart || '', shiftEnd: a.shiftEnd || '',
          isActive: a.isActive !== false,
        })));
        setProductTypeRules(dept.productTypeRules || []);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [spaceKey, queueName]);

  const persist = async (nextAgents: typeof agents, nextIsDefault = isDefault, nextRules = productTypeRules) => {
    setSaving(true);
    try {
      const existing = allDepts.filter((d: any) => d.name.toLowerCase() !== queueName.toLowerCase());
      const thisDept = {
        name: queueName,
        order: allDepts.find((d: any) => d.name.toLowerCase() === queueName.toLowerCase())?.order ?? existing.length,
        isDefault: nextIsDefault,
        agents: nextAgents.map((a, i) => ({ ...a, maxTickets: 10 })),
        currentIndex: allDepts.find((d: any) => d.name.toLowerCase() === queueName.toLowerCase())?.currentIndex ?? 0,
        productTypeRules: nextRules,
      };
      const updated = [...existing, thisDept];
      await api.saveRrConfig(spaceKey, updated);
      setAllDepts(updated);
      setAgents(nextAgents);
      setIsDefault(nextIsDefault);
      setProductTypeRules(nextRules);
      setSavedMsg('Saved');
      setTimeout(() => setSavedMsg(''), 2000);
    } catch { setSavedMsg('Failed to save'); setTimeout(() => setSavedMsg(''), 2500); }
    finally { setSaving(false); }
  };

  const PRODUCT_TYPE_OPTIONS = ['Content Migration', 'Email Migration', 'Message Migration', 'Board Migration', 'CF Connect', 'CF Manage', 'UI', 'others'];
  const addRule = (member: any) => {
    if (!ruleProductType) return;
    const mb = member.user || member;
    const name = `${mb.firstName || ''} ${mb.lastName || ''}`.trim();
    const nextRules = [...productTypeRules.filter(r => r.productType !== ruleProductType), { productType: ruleProductType, userId: mb.id, name }];
    persist(agents, isDefault, nextRules);
    setShowAddRule(false); setRuleProductType(''); setRuleAgentSearch('');
  };
  const removeRule = (productType: string) => persist(agents, isDefault, productTypeRules.filter(r => r.productType !== productType));

  const addAgent = (member: any) => {
    const mb = member.user || member;
    if (agents.find(a => a.userId === mb.id)) return;
    const next = [...agents, { userId: mb.id, name: `${mb.firstName||''} ${mb.lastName||''}`.trim(), email: mb.email||'', shiftStart: '09:00', shiftEnd: '17:00', isActive: true }];
    persist(next);
    setSearch(''); setShowAdd(false);
  };

  const removeAgent = (userId: string) => persist(agents.filter(a => a.userId !== userId));
  const toggleActive = (userId: string) => persist(agents.map(a => a.userId === userId ? { ...a, isActive: !a.isActive } : a));
  const updateShift = (userId: string, field: 'shiftStart' | 'shiftEnd', val: string) =>
    setAgents(prev => prev.map(a => a.userId === userId ? { ...a, [field]: val } : a));
  const saveShift = (userId: string) => persist([...agents]);

  const nonAdded = spaceMembers.filter(m => { const mb = m.user||m; return !agents.find(a => a.userId === mb.id); });
  const filtered = nonAdded.filter(m => { const mb = m.user||m; const s = search.toLowerCase(); return !s || `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(s) || (mb.email||'').toLowerCase().includes(s); });

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400 text-[13px]">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[20px] font-bold text-gray-900">Round Robin</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            Tickets arriving in <strong>{queueName}</strong> are auto-assigned to agents in rotation based on their shift hours.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600"><Check size={14} />{savedMsg}</span>}
          <button onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white text-[13px] font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <Plus size={14} /> Add agent
          </button>
        </div>
      </div>

      {/* Default queue toggle */}
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5 flex items-center justify-between">
        <div>
          <p className="text-[13px] font-semibold text-gray-800">Default queue for email tickets</p>
          <p className="text-[12px] text-gray-500 mt-0.5">When an email arrives with no matching queue, it lands here and gets auto-assigned.</p>
        </div>
        <button onClick={() => persist(agents, !isDefault)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isDefault ? 'bg-blue-600' : 'bg-gray-300'}`}>
          <span className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${isDefault ? 'translate-x-5.5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* Add agent search */}
      {showAdd && (
        <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 mb-5">
          <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 focus-within:border-blue-500 mb-3">
            <Search size={14} className="text-gray-400" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search agents…"
              className="flex-1 text-[13px] outline-none text-gray-700 placeholder:text-gray-400" />
            <button onClick={() => { setShowAdd(false); setSearch(''); }}><X size={13} className="text-gray-400 hover:text-gray-600" /></button>
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {filtered.map(m => { const mb = m.user||m; return (
              <div key={mb.id} onClick={() => addAgent(m)}
                className="flex items-center gap-3 px-4 py-2.5 bg-white rounded-xl border border-gray-100 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${avatarColor(mb.firstName||'')}`}>{mkInitials(mb.firstName||'',mb.lastName||'')}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-gray-800">{mb.firstName} {mb.lastName}</p>
                  <p data-hj-suppress className="text-[11.5px] text-gray-400">{mb.email||''}</p>
                </div>
                <span className="text-[12px] text-blue-600 font-medium">+ Add</span>
              </div>
            );})}
            {filtered.length === 0 && <p className="text-center text-[12.5px] text-gray-400 py-3">{search ? 'No matches' : 'All agents already added'}</p>}
          </div>
        </div>
      )}

      {/* Agent list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_80px] border-b border-gray-100 bg-gray-50 px-5 py-3">
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Agent</span>
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Shift Start</span>
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Shift End</span>
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Status</span>
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider"></span>
        </div>

        {agents.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <RefreshCw size={28} className="text-gray-200 mb-3" />
            <p className="text-[14px] font-medium text-gray-400">No agents configured</p>
            <p className="text-[12.5px] text-gray-400 mt-1">Add agents to start auto-assigning incoming tickets.</p>
          </div>
        ) : (
          agents.map(agent => (
            <div key={agent.userId} className="grid grid-cols-[2fr_1fr_1fr_1fr_80px] items-center px-5 py-3.5 border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${agent.isActive ? avatarColor(agent.name) : 'bg-gray-300'}`}>
                  {mkInitials(agent.name.split(' ')[0]||'', agent.name.split(' ')[1]||'')}
                </div>
                <div>
                  <p className={`text-[13px] font-medium ${agent.isActive ? 'text-gray-800' : 'text-gray-400'}`}>{agent.name}</p>
                  <p data-hj-suppress className="text-[11px] text-gray-400">{agent.email}</p>
                </div>
              </div>
              <div>
                <input type="text" value={agent.shiftStart}
                  onChange={e => updateShift(agent.userId, 'shiftStart', e.target.value)}
                  onBlur={() => saveShift(agent.userId)}
                  placeholder="09:00"
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 bg-white w-[90px]" />
              </div>
              <div>
                <input type="text" value={agent.shiftEnd}
                  onChange={e => updateShift(agent.userId, 'shiftEnd', e.target.value)}
                  onBlur={() => saveShift(agent.userId)}
                  placeholder="17:00"
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-[12.5px] text-gray-700 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 bg-white w-[90px]" />
              </div>
              <div>
                <button onClick={() => toggleActive(agent.userId)}
                  className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium rounded-full px-2.5 py-1 border transition-colors ${agent.isActive ? 'text-green-700 bg-green-50 border-green-200 hover:bg-green-100' : 'text-gray-500 bg-gray-100 border-gray-200 hover:bg-gray-200'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${agent.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                  {agent.isActive ? 'Active' : 'Paused'}
                </button>
              </div>
              <div className="flex justify-end">
                <button onClick={() => removeAgent(agent.userId)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Product Type Rules — deterministic override, bypasses rotation entirely */}
      <div className="flex items-center justify-between mt-8 mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-gray-900">Product Type Rules</h2>
          <p className="text-[12.5px] text-gray-500 mt-0.5">
            Send tickets of a specific product type straight to one person, instead of the rotation above — e.g. Content Migration always goes to the same agent.
          </p>
        </div>
        <button onClick={() => setShowAddRule(v => !v)}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-gray-200 text-gray-700 text-[12.5px] font-medium rounded-lg hover:bg-gray-50 transition-colors flex-shrink-0">
          <Plus size={13} /> Add rule
        </button>
      </div>

      {showAddRule && (
        <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 mb-5">
          <label className="block text-[12px] font-semibold text-gray-700 mb-1.5">Product type</label>
          <select value={ruleProductType} onChange={e => setRuleProductType(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-gray-700 bg-white mb-3 focus:outline-none focus:border-blue-400">
            <option value="">Select product type…</option>
            {PRODUCT_TYPE_OPTIONS.map(pt => <option key={pt} value={pt}>{pt}</option>)}
          </select>
          {ruleProductType && (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 focus-within:border-blue-500 mb-3">
                <Search size={14} className="text-gray-400" />
                <input autoFocus value={ruleAgentSearch} onChange={e => setRuleAgentSearch(e.target.value)}
                  placeholder="Search person to assign…"
                  className="flex-1 text-[13px] outline-none text-gray-700 placeholder:text-gray-400" />
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {spaceMembers
                  .filter(m => { const mb = m.user||m; const s = ruleAgentSearch.toLowerCase(); return !s || `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(s) || (mb.email||'').toLowerCase().includes(s); })
                  .map(m => { const mb = m.user||m; return (
                    <div key={mb.id} onClick={() => addRule(m)}
                      className="flex items-center gap-3 px-4 py-2.5 bg-white rounded-xl border border-gray-100 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${avatarColor(mb.firstName||'')}`}>{mkInitials(mb.firstName||'',mb.lastName||'')}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-gray-800">{mb.firstName} {mb.lastName}</p>
                        <p data-hj-suppress className="text-[11.5px] text-gray-400">{mb.email||''}</p>
                      </div>
                      <span className="text-[12px] text-blue-600 font-medium">+ Assign</span>
                    </div>
                  );})}
              </div>
            </>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {productTypeRules.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <RefreshCw size={24} className="text-gray-200 mb-2" />
            <p className="text-[13.5px] font-medium text-gray-400">No product type rules</p>
            <p className="text-[12px] text-gray-400 mt-1">Every ticket follows the rotation above.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {productTypeRules.map(rule => (
              <div key={rule.productType} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50/50">
                <div className="flex items-center gap-3">
                  <span className="text-[11.5px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1">{rule.productType}</span>
                  <span className="text-[12.5px] text-gray-400">→</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${avatarColor(rule.name.split(' ')[0]||'')}`}>{mkInitials(rule.name.split(' ')[0]||'',rule.name.split(' ')[1]||'')}</div>
                    <span className="text-[13px] font-medium text-gray-800">{rule.name}</span>
                  </div>
                </div>
                <button onClick={() => removeRule(rule.productType)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 p-4 bg-blue-50 rounded-xl border border-blue-100">
        <p className="text-[12px] text-blue-700">
          <strong>How it works:</strong> When a ticket arrives in this queue, a matching product type rule (if any) assigns it directly to that person.
          Otherwise it goes to the next active agent in the rotation whose shift is currently active — falling back to all active agents if no one is on
          shift. This applies whether the ticket was just created or transferred in from another queue.
        </p>
      </div>
    </div>
  );
}

/* ─── Main Page ─── */
export default function QueueSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const spaceKey = (params?.spaceKey as string || '').toUpperCase();
  const queueId = params?.queueId as string || '';
  const initialTab = (searchParams?.get('tab') || 'people') as 'people' | 'sla' | 'rr' | 'email' | 'workflow';

  const [tab, setTab] = useState<'people' | 'sla' | 'rr' | 'email' | 'workflow'>(initialTab);
  const [queue, setQueue] = useState<CustomQueue | null>(null);
  const [spaceStatuses, setSpaceStatuses] = useState<{ id: string; name: string; color: string; category: string }[]>([]);
  const [allSpaces, setAllSpaces] = useState<{ key: string; name: string }[]>([]);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [spaceMembers, setSpaceMembers] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [policies, setPolicies] = useState<SLAPolicy[]>([]);
  const [dbSlaIds, setDbSlaIds] = useState<Record<string, string>>({}); // policyId → DB id

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q: CustomQueue | null = null;
      try {
        const queues = await api.request<any[]>(`custom-queues/${spaceKey}`);
        if (Array.isArray(queues)) q = queues.find((x: any) => x.id === queueId) || null;
      } catch {
        try {
          const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
          if (stored) {
            const queues: CustomQueue[] = JSON.parse(stored);
            q = queues.find(x => x.id === queueId) || null;
          }
        } catch {}
      }
      if (cancelled || !q) return;
      setQueue(q);

      // sla_definitions (matched by dept_name, i.e. the queue's name) is the
      // canonical SLA source -- it's what breach tracking everywhere else in
      // the app actually reads. queue.slaPolicies is only a denormalized
      // copy this page writes alongside it for its own convenience; a queue
      // that got recreated/restored under a new id (this one's id ends in
      // "_restored2") starts with that copy empty even though its real SLA
      // definitions are untouched in the DB -- which showed "No SLAs
      // configured" here for a queue whose SLA was actively enforcing
      // elsewhere. Load from the DB and treat it as ground truth; fall back
      // to the queue's own cached copy only if the DB fetch itself fails.
      try {
        const rows = await api.getSLAs(spaceKey);
        if (cancelled) return;
        const map: Record<string, string> = {};
        rows.forEach(r => { if (r.dept_name) map[r.dept_name + ':' + r.name] = r.id; });
        setDbSlaIds(map);
        const deptRows = rows.filter(r => (r.dept_name || '').toLowerCase() === q!.name.toLowerCase());
        setPolicies(deptRows.length ? deptRows.map(dbRowToPolicy) : (q!.slaPolicies || []));
      } catch {
        setPolicies(q.slaPolicies || []);
      }
    })();
    return () => { cancelled = true; };
  }, [spaceKey, queueId]);

  useEffect(() => {
    api.getSpace(spaceKey).then((sp: any) => {
      setSpaceName(sp?.name || spaceKey);
      setSpaceMembers(sp?.members || []);
      setSpaceStatuses(sp?.statuses || []);
    }).catch(() => {});
    api.request<any[]>('users').then((users) => {
      if (Array.isArray(users)) setAllUsers(users);
    }).catch(() => {});
    api.getSpaces().then((spaces: any[]) => {
      setAllSpaces(spaces.map((s: any) => ({ key: s.key, name: s.name })));
    }).catch(() => {});
  }, [spaceKey]);

  const persistQueue = async (updated: CustomQueue) => {
    try {
      // Was GET custom-queues/:spaceKey (which the server filters to only the
      // caller's OWN queues if they're not an admin/manager) → replace this
      // queue in that list → PUT the whole thing back. For a plain member
      // managing just their own queue, that GET had already filtered out
      // every other queue — so the PUT permanently deleted them. This PATCH
      // updates only this one queue, entirely server-side, and never
      // round-trips a possibly-filtered view of the others.
      await api.request(`custom-queues/${spaceKey}/${queueId}`, { method: 'PATCH', body: JSON.stringify(updated) });
      try {
        const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
        const list: CustomQueue[] = stored ? JSON.parse(stored) : [];
        localStorage.setItem(`custom_queues_${spaceKey}`, JSON.stringify(list.map(q => q.id === queueId ? updated : q)));
      } catch {}
      setQueue(updated);
    } catch {}
  };

  const savePolicies = async (p: SLAPolicy[]) => {
    if (!queue) return;
    const updated = { ...queue, slaPolicies: p };
    persistQueue(updated);
    setPolicies(p);
    // Persist each policy to DB so SLA timings work in Sent/Watching
    const newIds = { ...dbSlaIds };
    for (const policy of p) {
      const dbKey = queue.name + ':' + policy.name;
      const goals = policy.goals.filter(g => g.timeValue).map(g => ({
        id: g.id, isPriorityGroup: false,
        priorityRows: [{ priority: g.priority, timeValue: g.timeValue, timeUnit: g.timeUnit }],
        timeValue: g.timeValue, timeUnit: g.timeUnit,
      }));
      // Build a single isPriorityGroup goal with all priorities
      const priorityGoal = {
        id: `pg_${policy.id}`,
        isPriorityGroup: true,
        priorityRows: policy.goals.filter(g => g.timeValue).map(g => ({ priority: g.priority.toLowerCase(), timeValue: g.timeValue, timeUnit: g.timeUnit })),
      };
      const payload = {
        name: policy.name,
        status: policy.enabled !== false ? 'active' : 'inactive',
        dept_name: queue.name,
        startCondition: policy.startCondition || null,
        pauseStatuses: [],
        stopCondition: policy.stopCondition || null,
        goals: policy.goals.some(g => g.timeValue) ? [priorityGoal] : [],
      };
      try {
        if (newIds[dbKey]) {
          await api.updateSLA(spaceKey, newIds[dbKey], payload);
        } else {
          const created = await api.createSLA(spaceKey, payload);
          if (created?.id) newIds[dbKey] = created.id;
        }
      } catch { /* non-critical — localStorage copy still works */ }
    }
    setDbSlaIds(newIds);
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 2000);
  };

  const removeMember  = (id: string) => { if (!queue) return; persistQueue({ ...queue, memberIds: queue.memberIds.filter(x => x !== id), suspendedIds: (queue.suspendedIds||[]).filter(x => x !== id) }); };
  const suspendMember = (id: string) => { if (!queue) return; persistQueue({ ...queue, suspendedIds: [...(queue.suspendedIds||[]), id] }); };
  const reactivate    = (id: string) => { if (!queue) return; persistQueue({ ...queue, suspendedIds: (queue.suspendedIds||[]).filter(x => x !== id) }); };
  const addMember = async (id: string) => {
    if (!queue) return;
    // If user is not in space_members yet, add them first
    const inSpace = spaceMembers.some(m => (m.user||m).id === id);
    if (!inSpace) {
      await api.request(`spaces/${spaceKey}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: id, role: 'member' }),
      }).catch(() => {});
      // Refresh space members
      const sp = await api.getSpace(spaceKey).catch(() => null);
      if (sp) setSpaceMembers(sp.members || []);
    }
    persistQueue({ ...queue, memberIds: [...queue.memberIds, id] });
    setMemberSearch(''); setShowAddMember(false);
  };

  if (!queue) return <div className="flex items-center justify-center h-screen text-gray-400 text-[13px]">Loading queue…</div>;

  // Use allUsers for member search so invited users who logged in also appear
  const userPool = allUsers.length > 0 ? allUsers : spaceMembers;
  const members = userPool.filter(m => { const mb = m.user||m; return queue.memberIds.includes(mb.id); });
  const nonMembers = userPool.filter(m => { const mb = m.user||m; return !queue.memberIds.includes(mb.id); });
  const suspended = queue.suspendedIds || [];

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Left sidebar */}
      <div className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-100">
          <button onClick={() => router.push(`/spaces/${spaceKey}`)}
            className="flex items-center gap-2 text-[12.5px] text-gray-500 hover:text-gray-900 transition-colors">
            <ArrowLeft size={14} /><span>{spaceName || spaceKey}</span>
          </button>
        </div>
        <div className="px-4 py-4 border-b border-gray-100">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Queue</p>
          <p className="text-[14px] font-bold text-gray-900">{queue.name}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{queue.memberIds.length} member{queue.memberIds.length !== 1 ? 's' : ''}</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          <button onClick={() => setTab('people')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab === 'people' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            <Users size={15} className={tab === 'people' ? 'text-blue-600' : 'text-gray-400'} />
            People &amp; Access
          </button>
          <button onClick={() => setTab('sla')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab === 'sla' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            <Clock size={15} className={tab === 'sla' ? 'text-blue-600' : 'text-gray-400'} />
            SLAs
          </button>
          <button onClick={() => setTab('rr')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab === 'rr' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            <RefreshCw size={15} className={tab === 'rr' ? 'text-blue-600' : 'text-gray-400'} />
            Round Robin
          </button>
          <button onClick={() => setTab('email')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab === 'email' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            <Mail size={15} className={tab === 'email' ? 'text-blue-600' : 'text-gray-400'} />
            Email
          </button>
          <button onClick={() => setTab('workflow')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab === 'workflow' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')}>
            <GitMerge size={15} className={tab === 'workflow' ? 'text-blue-600' : 'text-gray-400'} />
            Workflow
          </button>
        </nav>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── PEOPLE & ACCESS ── */}
        {tab === 'people' && (
          <div className="max-w-3xl mx-auto px-8 py-8">
            <div className="mb-6">
              <h1 className="text-[20px] font-bold text-gray-900">People &amp; Access</h1>
              <p className="text-[13px] text-gray-500 mt-1">Manage who has access to the <strong>{queue.name}</strong> queue.</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-6">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <h2 className="text-[14px] font-semibold text-gray-800">Members</h2>
                  <span className="text-[11.5px] font-medium text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">{members.length}</span>
                </div>
                <button onClick={() => setShowAddMember(v => !v)}
                  className="flex items-center gap-1.5 px-4 py-2 text-[12.5px] font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
                  <Plus size={13} /> Add member
                </button>
              </div>
              {showAddMember && (
                <div className="px-6 py-4 border-b border-gray-100 bg-blue-50">
                  <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 focus-within:border-blue-500">
                    <Search size={14} className="text-gray-400" />
                    <input autoFocus value={memberSearch} onChange={e => setMemberSearch(e.target.value)}
                      placeholder="Search by name or email…"
                      className="flex-1 text-[13px] outline-none text-gray-700 placeholder:text-gray-400" />
                    <button onClick={() => { setShowAddMember(false); setMemberSearch(''); }}><X size={13} className="text-gray-400 hover:text-gray-600" /></button>
                  </div>
                  <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto">
                    {nonMembers
                      .filter(m => { const mb = m.user||m; const s = memberSearch.toLowerCase(); return !s || `${mb.firstName} ${mb.lastName}`.toLowerCase().includes(s) || (mb.email||'').toLowerCase().includes(s); })
                      .map(m => { const mb = m.user||m; return (
                        <div key={mb.id} onClick={() => addMember(mb.id)}
                          className="flex items-center gap-3 px-4 py-2.5 bg-white rounded-xl border border-gray-100 hover:border-blue-300 hover:bg-blue-50 cursor-pointer transition-colors">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${avatarColor(mb.firstName||'')}`}>{mkInitials(mb.firstName||'',mb.lastName||'')}</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-gray-800">{mb.firstName} {mb.lastName}</p>
                            <p data-hj-suppress className="text-[11.5px] text-gray-400">{mb.email||''}</p>
                          </div>
                          <span className="text-[12px] text-blue-600 font-medium">+ Add</span>
                        </div>
                      );})}
                    {nonMembers.length === 0 && <p className="text-center text-[12.5px] text-gray-400 py-3">All space members are already added</p>}
                  </div>
                </div>
              )}
              {members.length === 0 ? (
                <div className="flex flex-col items-center py-14 text-center">
                  <Users size={28} className="text-gray-200 mb-3" />
                  <p className="text-[14px] font-medium text-gray-400">No members yet</p>
                  <p className="text-[12.5px] text-gray-400 mt-1">Add people above to give them access to this queue</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-400 uppercase tracking-wider">Member</th>
                      <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-400 uppercase tracking-wider">Status</th>
                      <th className="text-left px-6 py-3 text-[11px] font-bold text-gray-400 uppercase tracking-wider">Role</th>
                      <th className="px-6 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {members.map(m => {
                      const mb = m.user||m;
                      const isSuspended = suspended.includes(mb.id);
                      return (
                        <tr key={mb.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0 ${isSuspended ? 'bg-gray-300' : avatarColor(mb.firstName||'')}`}>
                                {mkInitials(mb.firstName||'',mb.lastName||'')}
                              </div>
                              <div>
                                <p className={`text-[13px] font-medium ${isSuspended ? 'text-gray-400' : 'text-gray-800'}`}>{mb.firstName} {mb.lastName}</p>
                                <p data-hj-suppress className="text-[11.5px] text-gray-400">{mb.email||''}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {isSuspended
                              ? <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">Suspended</span>
                              : <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Active</span>}
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-[12.5px] text-gray-500 bg-gray-100 rounded-md px-2.5 py-1">Member</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center justify-end gap-2">
                              {isSuspended
                                ? <button onClick={() => reactivate(mb.id)} className="text-[12px] font-medium text-emerald-600 hover:text-emerald-800 px-3 py-1.5 rounded-lg border border-emerald-200 hover:bg-emerald-50 transition-colors">Reactivate</button>
                                : <button onClick={() => suspendMember(mb.id)} className="text-[12px] font-medium text-amber-600 hover:text-amber-800 px-3 py-1.5 rounded-lg border border-amber-200 hover:bg-amber-50 transition-colors">Suspend</button>}
                              <button onClick={() => removeMember(mb.id)} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"><Trash2 size={14} /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── SLAs ── */}
        {tab === 'sla' && (
          <SLATab queue={queue} policies={policies} savedMsg={savedMsg} savePolicies={savePolicies} />
        )}

        {/* ── Round Robin ── */}
        {tab === 'rr' && (
          <RoundRobinTab spaceKey={spaceKey} queueName={queue.name} spaceMembers={spaceMembers} />
        )}

        {/* ── Email ── */}
        {tab === 'email' && (
          <QueueEmailTab spaceKey={spaceKey} queueName={queue.name} />
        )}

        {/* ── Workflow ── */}
        {tab === 'workflow' && (
          <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
            <div className="mb-2">
              <h1 className="text-[20px] font-bold text-gray-900">Queue Workflow</h1>
              <p className="text-[13px] text-gray-500 mt-1">
                Configure the status workflow for tickets in the <strong>{queue.name}</strong> queue.
              </p>
            </div>

            {/* Step 1 — Board source */}
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100 bg-gray-50">
                <Network size={15} className="text-blue-500" />
                <span className="text-[13px] font-semibold text-gray-800">Step 1 — Select Workflow Source Board</span>
                {queue.workflowSpaceKey && (
                  <span className="ml-auto text-[11px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5">
                    {queue.workflowSpaceKey}
                  </span>
                )}
              </div>
              <div className="px-6 py-4">
                <p className="text-[12.5px] text-gray-500 mb-3">
                  Choose which board&apos;s statuses &amp; transitions this queue uses.
                  Currently: <span className="font-semibold text-gray-800">{queue.workflowSpaceKey || 'Default (this space)'}</span>
                </p>
                <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                  <button
                    onClick={async () => {
                      setWorkflowSaving(true);
                      await persistQueue({ ...queue, workflowSpaceKey: '' });
                      setWorkflowSaving(false);
                      setSavedMsg('Saved!'); setTimeout(() => setSavedMsg(''), 2000);
                    }}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all',
                      !queue.workflowSpaceKey ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                    )}>
                    <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <GitMerge size={13} className="text-gray-500" />
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-gray-800">Default (this space)</p>
                      <p className="text-[11px] text-gray-400">Use this queue space&apos;s own workflow</p>
                    </div>
                    {!queue.workflowSpaceKey && <Check size={14} className="ml-auto text-blue-600 flex-shrink-0" />}
                  </button>
                  {allSpaces.filter(s => s.key !== spaceKey).map(s => (
                    <button
                      key={s.key}
                      onClick={async () => {
                        setWorkflowSaving(true);
                        await persistQueue({ ...queue, workflowSpaceKey: s.key });
                        setWorkflowSaving(false);
                        setSavedMsg('Saved!'); setTimeout(() => setSavedMsg(''), 2000);
                      }}
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all',
                        queue.workflowSpaceKey === s.key ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                      )}>
                      <div className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-bold text-indigo-700">{s.key.slice(0, 3)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-gray-800 truncate">{s.name}</p>
                        <p className="text-[11px] text-gray-400">{s.key}</p>
                      </div>
                      {queue.workflowSpaceKey === s.key && <Check size={14} className="ml-auto text-blue-600 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
                {workflowSaving && (
                  <div className="flex items-center gap-2 mt-3 text-[12.5px] text-blue-600">
                    <Loader2 size={13} className="animate-spin" /> Saving…
                  </div>
                )}
                {savedMsg && !workflowSaving && (
                  <div className="flex items-center gap-1.5 mt-3 text-[12.5px] text-emerald-600">
                    <Check size={13} /> {savedMsg}
                  </div>
                )}
              </div>
            </div>

            {/* Step 2 — Status filter */}
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50">
                <div className="flex items-center gap-2">
                  <GitMerge size={15} className="text-blue-500" />
                  <span className="text-[13px] font-semibold text-gray-800">Step 2 — Select Visible Statuses</span>
                  {queue.statusIds?.length ? (
                    <span className="text-[11px] font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-2.5 py-0.5">
                      {queue.statusIds.length} selected
                    </span>
                  ) : (
                    <span className="text-[11px] font-semibold text-gray-400 bg-gray-100 border border-gray-200 rounded-full px-2.5 py-0.5">
                      All
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { persistQueue({ ...queue, statusIds: spaceStatuses.map(s => s.id) }); setSavedMsg('Saved!'); setTimeout(() => setSavedMsg(''), 2000); }}
                    className="text-[12px] font-medium text-blue-600 hover:text-blue-800 px-3 py-1.5 rounded-lg border border-blue-200 hover:bg-blue-50 transition-colors"
                  >Select All</button>
                  <button
                    onClick={() => { persistQueue({ ...queue, statusIds: [] }); setSavedMsg('Saved!'); setTimeout(() => setSavedMsg(''), 2000); }}
                    className="text-[12px] font-medium text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors"
                  >Clear All</button>
                </div>
              </div>
              <p className="text-[12px] text-gray-500 px-6 pt-3 pb-1">
                Check only the statuses that should be visible for this queue. Unchecked statuses won&apos;t appear in the ticket status dropdown.
              </p>
              {spaceStatuses.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-center">
                  <p className="text-[13px] text-gray-400">No statuses found for this space.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {spaceStatuses.map(st => {
                    const isChecked = !queue.statusIds?.length || queue.statusIds.includes(st.id);
                    return (
                      <label key={st.id} className="flex items-center gap-4 px-6 py-3.5 hover:bg-gray-50 cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const current = queue.statusIds?.length ? queue.statusIds : spaceStatuses.map(s => s.id);
                            const next = isChecked ? current.filter(id => id !== st.id) : [...current, st.id];
                            persistQueue({ ...queue, statusIds: next });
                            setSavedMsg('Saved!'); setTimeout(() => setSavedMsg(''), 2000);
                          }}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: st.color || '#94a3b8' }} />
                        <span className="flex-1 text-[13.5px] font-medium text-gray-800">{st.name}</span>
                        <span className="text-[11px] text-gray-400 capitalize">{(st.category || '').replace('_', ' ')}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
