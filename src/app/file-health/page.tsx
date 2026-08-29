'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useStore } from '@/store';
import { api } from '@/lib/api';
import { FileWarning, RefreshCw, CheckCircle2 } from 'lucide-react';

const PRIVILEGED_ROLES = ['admin'];

type MissingFile = { ticketKey: string; filename: string; url: string; source: string };

const SOURCE_LABEL: Record<string, string> = {
  attachment: 'Attachment',
  description: 'Description',
  comment: 'Comment',
};

export default function FileHealthPage() {
  const user = useStore((s) => s.user);
  const router = useRouter();
  const isPrivileged = PRIVILEGED_ROLES.includes(user?.role || '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ totalChecked: number; missingCount: number; missing: MissingFile[] } | null>(null);

  // Redirect non-admins away -- same guard the MBR tab uses.
  useEffect(() => {
    if (user && !isPrivileged) router.replace('/dashboard');
  }, [user, isPrivileged, router]);

  const runCheck = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFileHealth();
      setResult(data);
    } catch (e: any) {
      setError(e?.message || 'Check failed');
    } finally {
      setLoading(false);
    }
  };

  if (!isPrivileged) return null;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <FileWarning size={20} className="text-gray-700" />
        <h1 className="text-xl font-bold text-gray-900">File Health</h1>
      </div>
      <p className="text-[13px] text-gray-500 mb-5">
        Scans every attachment, and every file/image link embedded directly in a description or
        comment, and reports which ones are actually missing on disk — a link can look fine here
        but 404 the moment someone clicks it if the underlying file was ever lost (e.g. a server
        rebuild before persistent storage was configured).
      </p>

      <button
        onClick={runCheck}
        disabled={loading}
        className="flex items-center gap-2 bg-indigo-600 text-white text-[13px] font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Scanning…' : 'Run check'}
      </button>

      {error && <p className="text-sm text-red-600 mt-4">{error}</p>}

      {result && (
        <div className="mt-6">
          <div className="flex items-center gap-4 mb-4">
            <span className="text-[13px] text-gray-600">
              Checked <span className="font-semibold text-gray-900">{result.totalChecked}</span> file{result.totalChecked === 1 ? '' : 's'}
            </span>
            <span className={`text-[13px] font-semibold ${result.missingCount > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {result.missingCount} missing
            </span>
          </div>

          {result.missingCount === 0 ? (
            <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-[13px]">
              <CheckCircle2 size={16} />
              Every file checked is present on disk.
            </div>
          ) : (
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4 font-semibold">Ticket</th>
                  <th className="py-2 pr-4 font-semibold">Filename</th>
                  <th className="py-2 pr-4 font-semibold">Found in</th>
                </tr>
              </thead>
              <tbody>
                {result.missing.map((m, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4">
                      <Link href={`/issues/${m.ticketKey}`} className="text-indigo-600 hover:underline font-medium">
                        {m.ticketKey}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-gray-700 truncate max-w-[320px]" title={m.filename}>{m.filename}</td>
                    <td className="py-2 pr-4 text-gray-500">{SOURCE_LABEL[m.source] || m.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
