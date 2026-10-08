'use client';

/**
 * ChunkErrorReloader
 *
 * After every deploy, the app's JS file hashes change. A browser tab that's
 * been open since before the latest deploy still has old chunk URLs baked
 * into its already-loaded router/page code -- clicking any internal link
 * tries to fetch a JS file that no longer exists on the server (replaced by
 * the new build), which the browser can't resolve. Next.js's router has no
 * graceful way to recover from that mid-navigation; what the user actually
 * sees is a blank white page with no sidebar/header while the browser
 * silently falls back toward a full reload, with zero explanation of why.
 *
 * Catches that failure explicitly (both a thrown error and an unhandled
 * promise rejection match it, depending on exactly where the fetch fails)
 * and replaces the confusing blank page with one clear message, then
 * reloads automatically. A sessionStorage guard stops this from looping
 * forever if the reload itself doesn't fix it for some other reason (shows
 * a manual "please refresh" prompt instead after one attempt).
 */

import { useEffect, useState } from 'react';
import DotLoader from '@/components/ui/DotLoader';

const CHUNK_ERROR_PATTERN = /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk [\w-]+ failed|error loading dynamically imported module|failed to fetch dynamically imported module/i;
const RELOAD_GUARD_KEY = 'chunk_error_reload_attempted_at';
const RELOAD_GUARD_WINDOW_MS = 15_000; // a second failure within 15s of our own reload means reloading isn't fixing it

export default function ChunkErrorReloader() {
  const [state, setState] = useState<'idle' | 'reloading' | 'stuck'>('idle');

  useEffect(() => {
    const handleChunkError = () => {
      if (state !== 'idle') return;
      const lastAttempt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      if (Date.now() - lastAttempt < RELOAD_GUARD_WINDOW_MS) {
        // We already reloaded once very recently and it's still happening --
        // reloading again would likely just loop. Ask for a manual refresh
        // instead of fighting it silently forever.
        setState('stuck');
        return;
      }
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      setState('reloading');
      window.location.reload();
    };

    const onError = (e: ErrorEvent) => {
      if (CHUNK_ERROR_PATTERN.test(e.message || '') || CHUNK_ERROR_PATTERN.test(String(e.error?.message || ''))) {
        handleChunkError();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = String(e.reason?.message || e.reason || '');
      if (CHUNK_ERROR_PATTERN.test(msg)) handleChunkError();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (state === 'idle') return null;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-3 text-center px-6">
        <DotLoader />
        {state === 'reloading' ? (
          <p className="text-[13px] text-gray-500">Updating to the latest version…</p>
        ) : (
          <>
            <p className="text-[13px] text-gray-700 font-medium">This page needs a refresh to load the latest version.</p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              Refresh now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
