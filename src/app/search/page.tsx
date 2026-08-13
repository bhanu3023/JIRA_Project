'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Search } from 'lucide-react';
import { formatDate, getIssueStatus } from '@/lib/utils';
import IssueTypeIcon from '@/components/ui/IssueTypeIcon';
import { PriorityIcon } from '@/components/ui/PriorityIcon';

function extractIssueKey(input: string): string | null {
  const urlMatch = input.match(/\/issues\/([A-Za-z0-9_-]+(?:-[A-Za-z0-9]+)*)(?:\?|#|$)/);
  if (urlMatch) return urlMatch[1];
  const keyMatch = input.trim().match(/^(CF-\d+|[A-Z][A-Z0-9]+-\d+)$/i);
  if (keyMatch) return keyMatch[1].toUpperCase();
  return null;
}

function SearchInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawQuery = searchParams.get('q') || '';
  const issueKey = extractIssueKey(rawQuery);
  const [query, setQuery] = useState(issueKey || rawQuery);
  const [results, setResults] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (q = query) => {
    if (!q.trim()) return;
    const key = extractIssueKey(q);
    if (key) {
      router.push(`/issues/${key}`);
      return;
    }
    setLoading(true);
    try {
      const data = await api.search(q, 1);
      setResults(data.issues);
      setTotal(data.total);
      setSearched(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (issueKey) {
      router.replace(`/issues/${issueKey}`);
      return;
    }
    if (query) handleSearch(query);
  }, []);

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="flex gap-2 max-w-2xl">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="w-full border border-gray-300 rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Search tickets..."
            autoFocus
          />
        </div>
        <button
          onClick={() => handleSearch()}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Results header */}
      {searched && (
        <p className="text-sm text-gray-500">
          {total > 0 ? `${total} result${total === 1 ? '' : 's'} for "${query}"` : `No results for "${query}"`}
        </p>
      )}

      {/* Results Table */}
      {results.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-8"></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-28">Key</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Summary</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-24">Space</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-36">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-8">P</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-36">Assignee</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-28">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {results.map(issue => {
                const st = getIssueStatus(issue);
                const assigneeName = typeof issue.assignee === 'object' && issue.assignee
                  ? (issue.assignee as any).displayName || (issue.assignee as any).firstName || '--'
                  : issue.assignee || '--';
                return (
                  <tr key={issue.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5"><IssueTypeIcon type={issue.type || 'task'} size={14} /></td>
                    <td className="px-4 py-2.5">
                      <Link href={`/issues/${issue.cfKey ?? issue.key}`} className="text-sm text-blue-600 font-medium hover:underline font-mono">
                        {issue.cfKey ?? issue.key}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-900 truncate max-w-md">{issue.summary}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{issue.spaceKey}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: st.color }}>
                        {st.name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5"><PriorityIcon priority={issue.priority} size={16} /></td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{assigneeName}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{formatDate(issue.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {searched && results.length === 0 && !loading && (
        <div className="text-center py-16 text-gray-400">
          <Search size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No tickets found for "{query}"</p>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" /></div>}>
      <SearchInner />
    </Suspense>
  );
}
