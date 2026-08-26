'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { typeIcons, priorityColors, getInitials, getIssueStatus, resolveStatusColor } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { Issue, WorkflowStatus } from '@/types';

export default function BoardPage() {
  const params = useParams();
  const spaceKey = (params.spaceKey as string).toUpperCase();
  const { currentSpace, loadSpace, issues, loadIssues } = useStore(
    useShallow((s) => ({
      currentSpace: s.currentSpace,
      loadSpace: s.loadSpace,
      issues: s.issues,
      loadIssues: s.loadIssues,
    })),
  );
  const [draggedIssue, setDraggedIssue] = useState<Issue | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  useEffect(() => {
    loadSpace(spaceKey).catch(console.error);
    loadIssues({ spaceKey }).catch(console.error);
  }, [spaceKey, loadSpace, loadIssues]);

  const handleDragStart = (e: React.DragEvent, issue: Issue) => {
    setDraggedIssue(issue);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, statusId: string) => {
    e.preventDefault();
    setDragOverColumn(statusId);
  };

  const handleDrop = async (e: React.DragEvent, statusId: string) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (!draggedIssue || getIssueStatus(draggedIssue).id === statusId) return;
    try {
      await api.updateIssue(draggedIssue.key, { statusId });
      loadIssues({ spaceKey });
    } catch (err) {
      console.error('Failed to move issue:', err);
    }
    setDraggedIssue(null);
  };

  if (!currentSpace) return <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" /></div>;

  const statuses = currentSpace.statuses || [];
  const getColumnIssues = (statusId: string) => issues.filter((i) => getIssueStatus(i).id === statusId);

  return (
    <div className="h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link href={`/spaces/${spaceKey}`} className="text-sm text-blue-600 hover:underline">{currentSpace.name}</Link>
          <span className="text-gray-400">/</span>
          <h1 className="text-xl font-bold text-gray-900">Board</h1>
        </div>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 200px)' }}>
        {statuses.map(status => {
          const columnIssues = getColumnIssues(status.id);
          return (
            <div
              key={status.id}
              className={`flex-shrink-0 w-72 bg-gray-100 rounded-lg flex flex-col ${dragOverColumn === status.id ? 'ring-2 ring-blue-400 bg-blue-50' : ''}`}
              onDragOver={(e) => handleDragOver(e, status.id)}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(e) => handleDrop(e, status.id)}
            >
              {/* Column Header */}
              <div className="px-3 py-2.5 flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: resolveStatusColor(status) }} />
                <span className="text-sm font-semibold text-gray-700 uppercase">{status.name}</span>
                <span className="text-xs text-gray-400 ml-auto bg-gray-200 px-1.5 py-0.5 rounded-full">{columnIssues.length}</span>
              </div>

              {/* Cards */}
              <div className="flex-1 px-2 pb-2 space-y-2 overflow-y-auto">
                {columnIssues.map(issue => (
                  <div
                    key={issue.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, issue)}
                    className="bg-white rounded-lg p-3 shadow-sm border border-gray-200 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm text-gray-900 font-medium line-clamp-2">{issue.summary}</p>
                    </div>
                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-1.5">
                        <IssueTypeIcon type={issue.type || 'task'} size={14} />
                        <Link href={`/issues/${(issue as any).cfKey ?? issue.key}`} className="text-xs text-gray-500 hover:text-blue-600">{issue.key}</Link>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-4 h-1.5 rounded-full" style={{ backgroundColor: priorityColors[issue.priority] }} title={issue.priority} />
                        {issue.storyPoints && <span className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded font-medium">{issue.storyPoints}</span>}
                        {issue.assignee ? (
                          <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-[9px]" title={`${issue.assignee.firstName} ${issue.assignee.lastName}`}>
                            {getInitials(issue.assignee.firstName, issue.assignee.lastName)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
