'use client';

import { useEffect, useState } from 'react';
import { Lock, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/store';

type Section = 'reports' | 'test_repo' | 'mbr';

const SECTION_LABELS: Record<Section, string> = {
  reports: 'Reports',
  test_repo: 'Test Repository',
  mbr: 'MBR',
};

/** Locked placeholder shown instead of a page's real content when the
 * current user lacks the per-section grant (Reports/Test Repository/MBR --
 * see can_view_reports/can_view_test_repo/can_view_mbr and the
 * access_requests table in jira-pg-api.ts). Checks for an existing pending
 * request on mount so a second visit shows "waiting for approval" instead
 * of the button again. */
export default function AccessGate({ section }: { section: Section }) {
  const [status, setStatus] = useState<'checking' | 'pending' | 'none' | 'sending'>('checking');
  const loadUser = useStore((s) => s.loadUser);

  // Covers the other half of the same staleness problem: the request was
  // already approved (and is no longer "pending" at all) before this visit
  // -- e.g. the user reloads after being told it went through. Refreshing
  // once up front means an already-granted user never sees this screen
  // flash at all; the page's own gate re-evaluates against the freshly
  // loaded user and renders the real content instead.
  useEffect(() => { loadUser(); }, [loadUser]);

  useEffect(() => {
    let cancelled = false;
    api.getAccessRequests()
      .then((rows: any[]) => {
        if (cancelled) return;
        const mine = rows.find((r) => r.section === section && r.status === 'pending');
        setStatus(mine ? 'pending' : 'none');
      })
      .catch(() => { if (!cancelled) setStatus('none'); });
    return () => { cancelled = true; };
  }, [section]);

  // The page's own gate (e.g. Reports' `if (!canViewReports) return
  // <AccessGate .../>`) reads the GLOBAL user object in the Zustand store --
  // approving a request updates the DB, not this already-logged-in
  // session's cached user, so without this the page stayed locked even
  // right after approval until a manual full reload. Re-fetching /auth/me
  // while a request sits pending means the moment it's approved, the next
  // tick's updated user object makes the page's own gate condition flip and
  // re-render past this component automatically -- no reload needed.
  useEffect(() => {
    if (status !== 'pending') return;
    const id = setInterval(() => { loadUser(); }, 8000);
    return () => clearInterval(id);
  }, [status, loadUser]);

  const handleRequest = async () => {
    setStatus('sending');
    try {
      await api.requestAccess(section);
      setStatus('pending');
    } catch {
      setStatus('none');
    }
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <Lock size={24} />
      </div>
      <h2 className="text-[16px] font-semibold text-gray-800">You don&apos;t have access to {SECTION_LABELS[section]}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-gray-500">
        Ask an admin to grant access, or send a request below.
      </p>
      <div className="mt-5">
        {status === 'checking' && <div className="h-9 w-36 animate-pulse rounded-lg bg-gray-100" />}
        {(status === 'none' || status === 'sending') && (
          <button
            onClick={handleRequest}
            disabled={status === 'sending'}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {status === 'sending' ? 'Sending…' : 'Request Access'}
          </button>
        )}
        {status === 'pending' && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] font-medium text-amber-700">
            <Clock size={14} /> Request sent — waiting for admin approval
          </div>
        )}
      </div>
    </div>
  );
}
