'use client';

/**
 * NavigationLoader
 *
 * Most internal navigations resolve well under a second (client-side route,
 * already-cached data). This used to show a full-screen blur+dots overlay on
 * EVERY link click, held for a forced minimum of 400ms even if the route had
 * already resolved — so a click that was actually instant still felt like it
 * was "loading" for almost half a second, on every single navigation.
 *
 * Now: only shows the overlay if the route is still pending after a short
 * delay (SHOW_DELAY_MS) — fast navigations (the common case) never show
 * anything at all, and once shown there's no artificial minimum hold, it
 * hides the instant the route resolves. A hard cap still applies so it can
 * never get stuck if a navigation genuinely hangs.
 */

import { useEffect, useState, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import DotLoader from './DotLoader';

const SHOW_DELAY_MS = 150;  // only show if still pending after this long
const MAX_DISPLAY_MS = 2000; // safety cap — loader never stays longer than 2s

export default function NavigationLoader() {
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);

  const pendingRef   = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => {
    pendingRef.current = false;
    setLoading(false);
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (maxTimerRef.current)  clearTimeout(maxTimerRef.current);
  };

  // Route resolved (pathname OR searchParams changed) → hide loader immediately,
  // cancelling the delayed show if the route resolved before it ever fired
  useEffect(() => {
    if (!pendingRef.current) return;
    hide();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  // Listen for link clicks → schedule a delayed show (not immediate)
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

      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (maxTimerRef.current)  clearTimeout(maxTimerRef.current);

      pendingRef.current = true;
      showTimerRef.current = setTimeout(() => {
        if (pendingRef.current) setLoading(true);
      }, SHOW_DELAY_MS);

      // Hard cap — never show longer than MAX_DISPLAY_MS total
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
