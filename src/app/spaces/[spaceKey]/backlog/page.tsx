'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { typeIcons, getInitials, getIssueStatus } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { PriorityIcon } from '@/components/ui/PriorityIcon';
import { Plus, Play, CheckCircle } from 'lucide-react';

export default function BacklogPage() {
  const params = useParams();
  const spaceKey = (params.spaceKey as string).toUpperCase();
  const { currentSpace, loadSpace, issues, loadIssues, sprints, loadSprints } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      loadSpace: s.loadSpace,
      issues: s.issues,
      loadIssues: s.loadIssues,
      sprints: s.sprints,
      loadSprints: s.loadSprints,
    })),
  );
  const [showCreateSprint, setShowCreateSprint] = useState(false);
  const [sprintForm, setSprintForm] = useState({ name: '', goal: '', startDate: '', endDate: '' });

  useEffect(() => {
    loadSpace(spaceKey);
    loadIssues({ spaceKey });
    loadSprints({ spaceKey });
  }, [spaceKey, loadSpace, loadIssues, loadSprints]);

  const activeSprint = sprints.find(s => s.status === 'active');
  const planningSprints = sprints.filter(s => s.status === 'planning');
  const backlogIssues = issues.filter(i => !i.sprintId);
  const getSprintIssues = (sprintId: string) => issues.filter(i => i.sprintId === sprintId);

  const handleCreateSprint = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createSprint({ spaceKey, ...sprintForm });
      setShowCreateSprint(false);
      setSprintForm({ name: '', goal: '', startDate: '', endDate: '' });
      loadSprints({ spaceKey });
    } catch (err) { console.error(err); }
  };

  const handleStartSprint = async (sprintId: string) => {
    try {
      await api.updateSprint(sprintId, { status: 'active', startDate: new Date().toISOString() });
      loadSprints({ spaceKey });
    } catch (err: any) { alert(err.message); }
  };

  const handleCompleteSprint = async (sprintId: string) => {
    const nextSprint = planningSprints[0];
    try {
      await api.completeSprint(sprintId, { moveToSprintId: nextSprint?.id || null });
      loadSprints({ spaceKey });
      loadIssues({ spaceKey });
    } catch (err) { console.error(err); }
  };

  const handleMoveToSprint = async (issueKey: string, sprintId: string | null) => {
    try {
      await api.updateIssue(issueKey, { sprintId });
      loadIssues({ spaceKey });
    } catch (err) { console.error(err); }
  };

  const renderIssueRow = (issue: any, showSprintActions = false) => {
    const t = typeIcons[issue.type] || typeIcons.task;
    const st = getIssueStatus(issue);
    return (
      <div key={issue.id} className="flex items-center gap-3 py-2 px-3 hover:bg-gray-50 border-b border-gray-100 group">
        <IssueTypeIcon type={issue.type || 'task'} size={14} />
        <Link href={`/issues/${issue.cfKey ?? issue.key}`} className="text-sm text-blue-600 font-medium hover:underline w-20">{issue.key}</Link>
        <span className="text-sm text-gray-900 flex-1 truncate">{issue.summary}</span>
        <span className="badge text-white text-[10px]" style={{ backgroundColor: st.color }}>{st.name}</span>
        <PriorityIcon priority={issue.priority} size={16} />
        {issue.storyPoints && <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{issue.storyPoints}pt</span>}
        {issue.assignee && (
          <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px]">
            {getInitials(issue.assignee.firstName, issue.assignee.lastName)}
          </div>
        )}
        {/* Sprint actions - visible on hover */}
        {showSprintActions && (
          <div className="hidden group-hover:flex items-center gap-1">
            {[activeSprint, ...planningSprints].filter(Boolean).map(sprint => (
              <button key={sprint!.id} onClick={() => handleMoveToSprint(issue.key, sprint!.id)}
                className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-100">
                → {sprint!.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (!currentSpace) return <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/spaces/${spaceKey}`} className="text-sm text-blue-600 hover:underline">{currentSpace.name}</Link>
          <span className="text-gray-400">/</span>
          <h1 className="text-xl font-bold">Backlog</h1>
        </div>
        <button onClick={() => setShowCreateSprint(true)} className="btn-primary flex items-center gap-1 text-sm"><Plus size={14} /> Create Sprint</button>
      </div>

      {/* Create Sprint Modal */}
      {showCreateSprint && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <form onSubmit={handleCreateSprint} className="bg-white rounded-xl p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Create Sprint</h2>
            <input type="text" value={sprintForm.name} onChange={e => setSprintForm(f => ({ ...f, name: e.target.value }))} placeholder="Sprint name" className="input-field" required />
            <textarea value={sprintForm.goal} onChange={e => setSprintForm(f => ({ ...f, goal: e.target.value }))} placeholder="Sprint goal" className="input-field" rows={2} />
            <div className="grid grid-cols-2 gap-3">
              <input type="date" value={sprintForm.startDate} onChange={e => setSprintForm(f => ({ ...f, startDate: e.target.value }))} className="input-field" />
              <input type="date" value={sprintForm.endDate} onChange={e => setSprintForm(f => ({ ...f, endDate: e.target.value }))} className="input-field" />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowCreateSprint(false)} className="btn-secondary">Cancel</button>
              <button type="submit" className="btn-primary">Create</button>
            </div>
          </form>
        </div>
      )}

      {/* Active Sprint */}
      {activeSprint && (
        <div className="card">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-green-50">
            <div className="flex items-center gap-2">
              <Play size={14} className="text-green-600" />
              <span className="font-semibold text-green-800">{activeSprint.name}</span>
              <span className="text-xs text-green-600">{activeSprint.issueCount} issues | {activeSprint.totalPoints} points</span>
            </div>
            <button onClick={() => handleCompleteSprint(activeSprint.id)} className="text-sm text-green-700 hover:underline flex items-center gap-1">
              <CheckCircle size={14} /> Complete Sprint
            </button>
          </div>
          <div>{getSprintIssues(activeSprint.id).map(i => renderIssueRow(i))}</div>
          {getSprintIssues(activeSprint.id).length === 0 && <div className="text-center py-4 text-sm text-gray-400">No issues in this sprint</div>}
        </div>
      )}

      {/* Planning Sprints */}
      {planningSprints.map(sprint => (
        <div key={sprint.id} className="card">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-700">{sprint.name}</span>
              <span className="badge bg-gray-200 text-gray-600">Planning</span>
              <span className="text-xs text-gray-500">{sprint.issueCount} issues</span>
            </div>
            <button onClick={() => handleStartSprint(sprint.id)} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
              <Play size={14} /> Start Sprint
            </button>
          </div>
          <div>{getSprintIssues(sprint.id).map(i => renderIssueRow(i))}</div>
          {getSprintIssues(sprint.id).length === 0 && <div className="text-center py-4 text-sm text-gray-400">Drag issues here from backlog</div>}
        </div>
      ))}

      {/* Backlog */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">Backlog</span>
            <span className="text-xs text-gray-500">{backlogIssues.length} issues</span>
          </div>
        </div>
        <div>{backlogIssues.map(i => renderIssueRow(i, true))}</div>
        {backlogIssues.length === 0 && <div className="text-center py-4 text-sm text-gray-400">No issues in backlog</div>}
      </div>
    </div>
  );
}
