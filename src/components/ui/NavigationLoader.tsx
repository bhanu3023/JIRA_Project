'use client';

/**
 * NavigationLoader
 *
 * Shows a full-screen dot loader whenever the user clicks an internal link
 * that changes the page. Hides after the route resolves AND a minimum display
 * time (400ms) has passed.
 *
 * Fix: also tracks searchParams changes (not just pathname) so clicking
 * queue/tab links (same path, different ?query) hides the loader correctly.
 * Also has a hard 2s max timeout so it can never get stuck.
 */

import { useEffect, useState, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import DotLoader from './DotLoader';

const MIN_DISPLAY_MS = 400;
const MAX_DISPLAY_MS = 2000; // safety cap — loader never stays longer than 2s

export default function NavigationLoader() {
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);

  const loadingRef   = useRef(false);
  const shownAtRef   = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => {
    loadingRef.current = false;
    setLoading(false);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (maxTimerRef.current)  clearTimeout(maxTimerRef.current);
  };

  // Route resolved (pathname OR searchParams changed) → hide loader
  useEffect(() => {
    if (!loadingRef.current) return;
    const elapsed   = Date.now() - shownAtRef.current;
    const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(hide, remaining);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  // Listen for link clicks → show loader
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';

      // Ignore: external, hash-only, empty, mailto, new-tab, modified clicks
      if (
        !href ||
        href.startsWith('http') ||
        href.startsWith('//') ||
        href.startsWith('#') ||
        href.startsWith('mailto:') ||
        anchor.target === '_blank' ||
        e.ctrlKey || e.metaKey || e.shiftKey
      ) return;

      // Don't show loader if already on that exact URL (path + query)
      const currentFull = window.location.pathname + window.location.search;
      if (href === currentFull || href === window.location.pathname) return;

      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (maxTimerRef.current)  clearTimeout(maxTimerRef.current);

      loadingRef.current = true;
      shownAtRef.current = Date.now();
      setLoading(true);

      // Hard cap — never show longer than MAX_DISPLAY_MS
      maxTimerRef.current = setTimeout(hide, MAX_DISPLAY_MS);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  if (!loading) return null;

  return (
    <div className="absolute inset-0 z-[9999] flex items-center justify-center bg-white/70 backdrop-blur-[2px]">
      <DotLoader />
    </div>
  );
}
