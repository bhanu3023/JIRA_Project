'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ArrowLeft, Plus, X, Check, Trash2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type QueueStatus = { id: string; name: string; color: string; category: 'todo' | 'in_progress' | 'done'; order: number };
type QueueTransition = { from: string; to: string };

const PRESET_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

const categoryMeta: Record<string, { label: string; className: string }> = {
  todo: { label: 'To Do', className: 'bg-gray-100 text-gray-600' },
  in_progress: { label: 'In Progress', className: 'bg-blue-100 text-blue-700' },
  done: { label: 'Done', className: 'bg-green-100 text-green-700' },
};

export default function QueueWorkflowPage() {
  const params = useParams();
  const spaceKey = (params?.spaceKey as string || '').toUpperCase();
  const queueId = params?.queueId as string || '';
  const router = useRouter();

  const [queue, setQueue] = useState<any | null>(null);
  const [queueStatuses, setQueueStatuses] = useState<QueueStatus[]>([]);
  const [queueTransitions, setQueueTransitions] = useState<QueueTransition[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [showAddStatus, setShowAddStatus] = useState(false);
  const [newStatusName, setNewStatusName] = useState('');
  const [newStatusColor, setNewStatusColor] = useState(PRESET_COLORS[0]);
  const [newStatusCategory, setNewStatusCategory] = useState<'todo' | 'in_progress' | 'done'>('todo');

  useEffect(() => {
    api.request<any[]>(`custom-queues/${spaceKey}`).then(queues => {
      if (Array.isArray(queues)) {
        const q = queues.find((q: any) => q.id === queueId);
        if (q) {
          setQueue(q);
          setQueueStatuses(q.queueStatuses || []);
          setQueueTransitions(q.queueTransitions || []);
        }
      }
    }).catch(() => {});
  }, [spaceKey, queueId]);

  const save = async (statuses: QueueStatus[], transitions: QueueTransition[]) => {
    setSaving(true);
    try {
      // Was GET custom-queues/:spaceKey (which the server filters to only the
      // caller's OWN queues if they're not an admin/manager) → replace this
      // queue in that list → PUT the whole thing back. For a plain member
      // managing just their own queue's workflow, that GET had already
      // filtered out every other queue — so the PUT permanently deleted
      // them. This PATCH updates only this one queue, entirely server-side.
      const updated = { ...queue!, queueStatuses: statuses, queueTransitions: transitions };
      await api.request(`custom-queues/${spaceKey}/${queueId}`, { method: 'PATCH', body: JSON.stringify(updated) });
      try {
        const stored = localStorage.getItem(`custom_queues_${spaceKey}`);
        const list = stored ? JSON.parse(stored) : [];
        localStorage.setItem(`custom_queues_${spaceKey}`, JSON.stringify(list.map((q: any) => q.id === queueId ? updated : q)));
      } catch {}
      setQueue(updated);
      setSavedMsg('Saved!');
      setTimeout(() => setSavedMsg(''), 2000);
    } catch {}
    setSaving(false);
  };

  const addStatus = () => {
    if (!newStatusName.trim()) return;
    const newSt: QueueStatus = {
      id: `qst_${Date.now()}`,
      name: newStatusName.trim(),
      color: newStatusColor,
      category: newStatusCategory,
      order: queueStatuses.length,
    };
    const updated = [...queueStatuses, newSt];
    setQueueStatuses(updated);
    save(updated, queueTransitions);
    setNewStatusName('');
    setShowAddStatus(false);
  };

  const deleteStatus = (id: string) => {
    const updated = queueStatuses.filter(s => s.id !== id);
    const updatedTransitions = queueTransitions.filter(t => t.from !== id && t.to !== id);
    setQueueStatuses(updated);
    setQueueTransitions(updatedTransitions);
    save(updated, updatedTransitions);
  };

  const toggleTransition = (fromId: string, toId: string) => {
    const exists = queueTransitions.some(t => t.from === fromId && t.to === toId);
    const updated = exists
      ? queueTransitions.filter(t => !(t.from === fromId && t.to === toId))
      : [...queueTransitions, { from: fromId, to: toId }];
    setQueueTransitions(updated);
    save(queueStatuses, updated);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-4 transition-colors"
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{queue?.name || 'Queue'} Workflow</h1>
              <p className="text-sm text-gray-500 mt-1">Define statuses and allowed transitions for this queue</p>
            </div>
            {savedMsg && (
              <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
                <Check size={15} /> {savedMsg}
              </span>
            )}
            {saving && !savedMsg && (
              <span className="text-sm text-gray-400">Saving…</span>
            )}
          </div>
        </div>

        {/* Statuses section */}
        <div className="bg-white rounded-2xl border border-gray-200 mb-6">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-800">Statuses</h2>
            <button
              onClick={() => setShowAddStatus(true)}
              className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
            >
              <Plus size={15} /> Add Status
            </button>
          </div>

          {queueStatuses.length === 0 && !showAddStatus && (
            <p className="px-6 py-6 text-sm text-gray-400 italic">No statuses yet. Add one to get started.</p>
          )}

          <ul className="divide-y divide-gray-50">
            {queueStatuses.map(st => {
              const meta = categoryMeta[st.category] || categoryMeta.todo;
              return (
                <li key={st.id} className="flex items-center gap-3 px-6 py-3">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: st.color }} />
                  <span className="flex-1 text-sm font-medium text-gray-800">{st.name}</span>
                  <span className={cn('text-[11px] font-semibold px-2 py-0.5 rounded-full', meta.className)}>
                    {meta.label}
                  </span>
                  <button
                    onClick={() => deleteStatus(st.id)}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-2"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Add status form */}
          {showAddStatus && (
            <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  autoFocus
                  type="text"
                  placeholder="Status name"
                  value={newStatusName}
                  onChange={e => setNewStatusName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addStatus(); if (e.key === 'Escape') setShowAddStatus(false); }}
                  className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 w-44"
                />
                {/* Color picker */}
                <div className="flex items-center gap-1.5">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewStatusColor(c)}
                      className={cn('w-5 h-5 rounded-full border-2 transition-all', newStatusColor === c ? 'border-gray-700 scale-110' : 'border-transparent')}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                {/* Category */}
                <select
                  value={newStatusCategory}
                  onChange={e => setNewStatusCategory(e.target.value as any)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="done">Done</option>
                </select>
                <button
                  onClick={addStatus}
                  className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowAddStatus(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Transitions section */}
        <div className="bg-white rounded-2xl border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-800">Transitions</h2>
            <p className="text-sm text-gray-400 mt-0.5">Check a cell to allow moving from row status → column status</p>
          </div>

          {queueStatuses.length < 2 ? (
            <p className="px-6 py-6 text-sm text-gray-400 italic">Add at least 2 statuses to configure transitions.</p>
          ) : (
            <div className="px-6 py-4 overflow-x-auto">
              <table className="border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="w-36 text-left pr-4 pb-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">From \ To</th>
                    {queueStatuses.map(st => (
                      <th key={st.id} className="pb-3 px-2 text-center min-w-[80px]">
                        <div className="flex flex-col items-center gap-1">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: st.color }} />
                          <span className="text-[11px] font-semibold text-gray-600 leading-tight">{st.name}</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queueStatuses.map(from => (
                    <tr key={from.id} className="border-t border-gray-50">
                      <td className="pr-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: from.color }} />
                          <span className="text-[12px] font-medium text-gray-700 truncate max-w-[120px]">{from.name}</span>
                        </div>
                      </td>
                      {queueStatuses.map(to => {
                        const isSame = from.id === to.id;
                        const checked = !isSame && queueTransitions.some(t => t.from === from.id && t.to === to.id);
                        return (
                          <td key={to.id} className="px-2 py-2.5 text-center">
                            {isSame ? (
                              <span className="text-gray-200 text-lg">—</span>
                            ) : (
                              <button
                                onClick={() => toggleTransition(from.id, to.id)}
                                className={cn(
                                  'w-5 h-5 rounded border-2 flex items-center justify-center mx-auto transition-all',
                                  checked
                                    ? 'bg-blue-600 border-blue-600 text-white'
                                    : 'border-gray-300 hover:border-blue-400'
                                )}
                              >
                                {checked && <Check size={11} strokeWidth={3} />}
                              </button>
                            )}
                          </td>
                        );
                      })}
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
