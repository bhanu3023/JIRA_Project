'use client';

import { useEffect, useState, useMemo } from 'react';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import type { Issue } from '@/types';
import Link from 'next/link';
import { typeIcons, formatDate, getInitials, cn } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import DotLoader from '@/components/ui/DotLoader';
import { PriorityIcon } from '@/components/ui/PriorityIcon';

const PRIVILEGED_ROLES = ['admin'];

function groupByAssignee(issues: Issue[]) {
  const m = new Map<string, { assignee: Issue['assignee']; issues: Issue[] }>();
  for (const issue of issues) {
    const id = issue.assignee?.id ?? '__unassigned__';
    if (!m.has(id)) {
      m.set(id, { assignee: issue.assignee ?? null, issues: [] });
    }
    m.get(id)!.issues.push(issue);
  }
  return Array.from(m.values()).sort((a, b) => {
    if (!a.assignee && !b.assignee) return 0;
    if (!a.assignee) return 1;
    if (!b.assignee) return -1;
    const an = `${a.assignee.firstName} ${a.assignee.lastName}`.toLowerCase();
    const bn = `${b.assignee.firstName} ${b.assignee.lastName}`.toLowerCase();
    return an.localeCompare(bn);
  });
}

function IssueTable({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) {
    return (
      <p className="border-t border-gray-200 bg-gray-50 px-6 py-8 text-sm text-gray-500">
        No issues in this group.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto border-t border-gray-200">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-jira-dark text-left text-white/95">
            <th className="w-10 px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Type</th>
            <th className="w-28 px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Key</th>
            <th className="px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Summary</th>
            <th className="w-24 px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Space</th>
            <th className="w-36 px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Status</th>
            <th className="w-12 px-4 py-3 text-center font-sans text-[10px] font-semibold uppercase tracking-wide">P</th>
            <th className="w-32 px-4 py-3 font-sans text-[10px] font-semibold uppercase tracking-wide">Updated</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, row) => {
            const t = typeIcons[issue.type] || typeIcons.task;
            return (
              <tr
                key={issue.id}
                className={cn(
                  'border-b border-gray-200 font-sans transition-colors',
                  row % 2 === 0 ? 'bg-white' : 'bg-gray-50',
                  'hover:bg-blue-50/50',
                )}
              >
                <td className="px-4 py-3 align-middle text-gray-500">
                  <IssueTypeIcon type={issue.type || 'task'} size={14} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <Link
                    href={`/issues/${issue.cfKey ?? issue.key}`}
                    className="font-mono text-[13px] font-semibold tracking-tight text-blue-600 hover:text-blue-800"
                  >
                    {issue.cfKey ?? issue.key}
                  </Link>
                </td>
                <td className="max-w-md px-4 py-3 align-middle">
                  <Link
                    href={`/issues/${issue.cfKey ?? issue.key}`}
                    className="text-[14px] leading-snug text-gray-900 hover:text-jira-dark"
                  >
                    {issue.summary}
                  </Link>
                </td>
                <td className="px-4 py-3 align-middle">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    {issue.spaceKey}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle">
                  <span
                    className="inline-block rounded-sm px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white shadow-sm"
                    style={{ backgroundColor: issue.status?.color || '#57534e' }}
                  >
                    {issue.status?.name || '—'}
                  </span>
                </td>
                <td className="px-4 py-3 text-center align-middle text-gray-500">
                  <PriorityIcon priority={issue.priority} size={16} />
                </td>
                <td className="px-4 py-3 align-middle font-mono text-[12px] tabular-nums text-gray-500">
                  {formatDate(issue.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function MyAssignedPage() {
  const user = useStore((s) => s.user);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        if (isPrivileged) {
          const data = await api.getIssues({ limit: '100' });
          const assigned = data.issues.filter((i) => i.assignee);
          if (!cancelled) setIssues(assigned);
        } else if (user?.id) {
          const data = await api.getIssues({ assignee: user.id, limit: '100' });
          if (!cancelled) setIssues(data.issues);
        } else if (!cancelled) {
          setIssues([]);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load issues');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isPrivileged]);

  const sections = useMemo(() => {
    if (isPrivileged) {
      return groupByAssignee(issues);
    }
    if (!user) return [];
    return [
      {
        assignee: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        } as NonNullable<Issue['assignee']>,
        issues,
      },
    ];
  }, [issues, isPrivileged, user]);

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 pb-12">
      <header>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-blue-600">My work</p>
        <h1 className="text-2xl font-bold text-jira-dark md:text-3xl">My Assigned Tickets</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          {isPrivileged
            ? 'Issues with an assignee, grouped by assignee.'
            : 'Issues currently assigned to you.'}
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <DotLoader className="py-28" />
      ) : sections.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-8 py-14 text-center shadow-sm">
          <p className="text-xl font-semibold text-jira-dark">No assigned tickets</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            When issues are assigned, they will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => {
            const label = section.assignee
              ? `${section.assignee.firstName} ${section.assignee.lastName}`.trim() || section.assignee.email
              : 'Unassigned';
            const initials = section.assignee
              ? getInitials(section.assignee.firstName, section.assignee.lastName)
              : '—';
            return (
              <section
                key={section.assignee?.id ?? 'unassigned'}
                className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm ring-1 ring-black/[0.03]"
              >
                <div className="flex items-center gap-4 border-b border-gray-200 bg-gray-50 px-5 py-4">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border-2 border-blue-200 bg-jira-dark text-xs font-semibold text-white shadow-sm">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-semibold tracking-tight text-jira-dark">{label}</h2>
                    {section.assignee?.email && (
                      <p data-hj-suppress className="mt-0.5 truncate text-[12px] text-gray-500">{section.assignee.email}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5 pr-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Count</span>
                    <span className="text-2xl font-semibold tabular-nums text-jira-dark">{section.issues.length}</span>
                  </div>
                </div>
                <IssueTable issues={section.issues} />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
