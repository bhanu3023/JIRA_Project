'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { Zap, Plus, Trash2, Power, PowerOff } from 'lucide-react';
import { AutomationRule } from '@/types';
import { formatDateTime } from '@/lib/utils';

const TRIGGER_TYPES = [
  { value: 'issue_created', label: 'Issue Created' },
  { value: 'issue_updated', label: 'Issue Updated' },
  { value: 'status_changed', label: 'Status Changed' },
];

const CONDITION_FIELDS = ['priority', 'type', 'status', 'assignee'];
const ACTION_TYPES = [
  { value: 'assign_user', label: 'Assign User' },
  { value: 'change_status', label: 'Change Status' },
  { value: 'add_comment', label: 'Add Comment' },
  { value: 'create_linked_issue', label: 'Create Linked Issue in Another Board' },
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'set_priority', label: 'Set Priority' },
];

export default function AutomationPage() {
  const params = useParams();
  const spaceKey = (params.spaceKey as string).toUpperCase();
  const { currentSpace, loadSpace } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      loadSpace: s.loadSpace,
    })),
  );
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '', triggerType: 'issue_created',
    conditions: [{ field: 'priority', operator: '=', value: '' }],
    actions: [{ type: 'add_comment', comment: '', targetSpaceKey: '', summaryTemplate: '', userId: '', statusId: '', priority: '' }],
  });

  useEffect(() => {
    loadSpace(spaceKey);
    loadRules();
  }, [spaceKey]);

  const loadRules = async () => {
    const data = await api.getAutomationRules(spaceKey);
    setRules(data);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createAutomationRule({
        spaceKey, name: form.name, triggerType: form.triggerType,
        conditions: form.conditions.filter(c => c.value),
        actions: form.actions,
      });
      setShowCreate(false);
      loadRules();
    } catch (err) { console.error(err); }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    await api.updateAutomationRule(id, { isActive: !isActive });
    loadRules();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this rule?')) return;
    await api.deleteAutomationRule(id);
    loadRules();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/spaces/${spaceKey}`} className="text-sm text-blue-600 hover:underline">{currentSpace?.name || spaceKey}</Link>
          <span className="text-gray-400">/</span>
          <h1 className="text-xl font-bold flex items-center gap-2"><Zap size={20} /> Automation</h1>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1"><Plus size={14} /> Create Rule</button>
      </div>

      {/* Rules List */}
      <div className="space-y-3">
        {rules.map(rule => (
          <div key={rule.id} className="card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Zap size={16} className={rule.isActive ? 'text-yellow-500' : 'text-gray-300'} />
                <div>
                  <h3 className="font-semibold text-gray-900">{rule.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Trigger: <span className="font-medium">{rule.triggerType.replace('_', ' ')}</span>
                    {' | '}Executed: {rule.executionCount} times
                    {rule.lastExecutedAt && <> | Last: {formatDateTime(rule.lastExecutedAt)}</>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggle(rule.id, rule.isActive)} className={`p-1.5 rounded ${rule.isActive ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-50'}`}>
                  {rule.isActive ? <Power size={16} /> : <PowerOff size={16} />}
                </button>
                <button onClick={() => handleDelete(rule.id)} className="p-1.5 rounded text-red-400 hover:bg-red-50"><Trash2 size={16} /></button>
              </div>
            </div>
            <div className="mt-2 flex gap-4 text-xs">
              <div>
                <span className="text-gray-500">Conditions:</span>
                {rule.conditions.length > 0 ? rule.conditions.map((c: any, i: number) => (
                  <span key={i} className="ml-1 badge bg-blue-50 text-blue-700">{c.field} = {c.value}</span>
                )) : <span className="ml-1 text-gray-400">None</span>}
              </div>
              <div>
                <span className="text-gray-500">Actions:</span>
                {rule.actions.map((a: any, i: number) => (
                  <span key={i} className="ml-1 badge bg-purple-50 text-purple-700">{a.type.replace('_', ' ')}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
        {rules.length === 0 && <div className="card p-8 text-center text-gray-500">No automation rules yet. Create your first rule to automate workflows.</div>}
      </div>

      {/* Create Rule Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-lg font-semibold">Create Automation Rule</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input-field" placeholder="e.g., Auto-assign high priority bugs" required />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Trigger</label>
              <select value={form.triggerType} onChange={e => setForm(f => ({ ...f, triggerType: e.target.value }))} className="input-field">
                {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Conditions</label>
              {form.conditions.map((condition, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <select value={condition.field} onChange={e => { const c = [...form.conditions]; c[i].field = e.target.value; setForm(f => ({ ...f, conditions: c })); }} className="input-field w-32">
                    {CONDITION_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <span className="input-field w-12 text-center bg-gray-50">=</span>
                  <input type="text" value={condition.value} onChange={e => { const c = [...form.conditions]; c[i].value = e.target.value; setForm(f => ({ ...f, conditions: c })); }}
                    className="input-field flex-1" placeholder="value" />
                </div>
              ))}
              <button type="button" onClick={() => setForm(f => ({ ...f, conditions: [...f.conditions, { field: 'priority', operator: '=', value: '' }] }))} className="text-sm text-blue-600 hover:underline">+ Add condition</button>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Actions</label>
              {form.actions.map((action, i) => (
                <div key={i} className="border border-gray-200 rounded-md p-3 mb-2 space-y-2">
                  <select value={action.type} onChange={e => { const a = [...form.actions]; a[i].type = e.target.value; setForm(f => ({ ...f, actions: a })); }} className="input-field">
                    {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  {action.type === 'add_comment' && (
                    <input type="text" value={action.comment} onChange={e => { const a = [...form.actions]; a[i].comment = e.target.value; setForm(f => ({ ...f, actions: a })); }}
                      className="input-field" placeholder="Comment text" />
                  )}
                  {action.type === 'create_linked_issue' && (
                    <>
                      <input type="text" value={action.targetSpaceKey} onChange={e => { const a = [...form.actions]; a[i].targetSpaceKey = e.target.value; setForm(f => ({ ...f, actions: a })); }}
                        className="input-field" placeholder="Target space key (e.g., L2)" />
                      <input type="text" value={action.summaryTemplate} onChange={e => { const a = [...form.actions]; a[i].summaryTemplate = e.target.value; setForm(f => ({ ...f, actions: a })); }}
                        className="input-field" placeholder="Summary template (use {summary})" />
                    </>
                  )}
                  {action.type === 'set_priority' && (
                    <select value={action.priority} onChange={e => { const a = [...form.actions]; a[i].priority = e.target.value; setForm(f => ({ ...f, actions: a })); }} className="input-field">
                      {/* Highest removed per explicit request -- see filters/page.tsx's own PRIORITIES comment. */}
                      {['high', 'medium', 'low', 'lowest'].map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}
                </div>
              ))}
              <button type="button" onClick={() => setForm(f => ({ ...f, actions: [...f.actions, { type: 'add_comment', comment: '', targetSpaceKey: '', summaryTemplate: '', userId: '', statusId: '', priority: '' }] }))} className="text-sm text-blue-600 hover:underline">+ Add action</button>
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary">Cancel</button>
              <button type="submit" className="btn-primary">Create Rule</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
