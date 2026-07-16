'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import DotLoader from '@/components/ui/DotLoader';
import NavigationLoader from '@/components/ui/NavigationLoader';

export default function RootLayoutClient({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, initializing, loadUser, sidebarOpen } = useStore(
    useShallow((s) => ({
      isAuthenticated: s.isAuthenticated,
      initializing: s.initializing,
      loadUser: s.loadUser,
      sidebarOpen: s.sidebarOpen,
    })),
  );
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const isAuthPage = pathname.startsWith('/auth');

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  // Auto-reconnect IMAP pollers once per authenticated session (not on auth pages)
  useEffect(() => {
    if (isAuthPage) return;
    const sessionKey = 'pollers_reconnected_at';
    const last = Number(sessionStorage.getItem(sessionKey) || 0);
    // Only reconnect at most once every 10 minutes to avoid hammering the server
    if (Date.now() - last < 10 * 60 * 1000) return;
    sessionStorage.setItem(sessionKey, String(Date.now()));
    fetch('/api/email/reconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json())
      .then(d => { if (d.started?.length) console.log('[App] Auto-reconnected pollers:', d.started); })
      .catch(() => {});
  }, [isAuthPage]);

  // Redirect to login if not authenticated after init
  useEffect(() => {
    if (!initializing && !isAuthenticated && !isAuthPage) {
      router.replace('/auth/login');
    }
  }, [initializing, isAuthenticated, isAuthPage, router]);

  if (isAuthPage) {
    return <main className="min-h-screen bg-white">{children}</main>;
  }

  if (initializing || (!isAuthenticated && !isAuthPage)) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <DotLoader />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <NavigationLoader />
      {isAuthenticated && <Sidebar />}
      <div
        className={`flex flex-1 flex-col overflow-hidden ${isAuthenticated && sidebarOpen ? 'ml-72' : isAuthenticated ? 'ml-[60px]' : ''}`}
      >
        {isAuthenticated && <Header />}
        <main className="flex-1 overflow-auto bg-white">{children}</main>
      </div>
    </div>
  );
}
