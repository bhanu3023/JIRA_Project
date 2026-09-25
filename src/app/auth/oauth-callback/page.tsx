'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';

/**
 * /auth/oauth-callback
 *
 * Server → client bridge: the Microsoft OAuth callback (server route)
 * already set the session as an httpOnly cookie on this redirect (no token
 * in the URL anymore -- a raw JWT in a redirect URL ends up in browser
 * history and often server/proxy access logs, a worse exposure than
 * localStorage ever was). This page just confirms the cookie session is
 * live via loadUser()/GET /auth/me, then navigates to the intended
 * destination.
 */
function OAuthCallbackContent() {
  const searchParams   = useSearchParams();
  const router         = useRouter();
  const loadUser       = useStore((s) => s.loadUser);

  useEffect(() => {
    const next      = searchParams.get('next') || '/dashboard';
    const oauthErr  = searchParams.get('oauth_error');

    if (oauthErr) {
      router.replace(`/auth/login?oauth_error=${encodeURIComponent(oauthErr)}`);
      return;
    }

    loadUser().then(() => {
      // Hard navigation to ensure fresh JS is loaded, same as before.
      window.location.replace(next);
    }).catch(() => {
      router.replace('/auth/login?oauth_error=session_not_established');
    });
  }, [searchParams]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" />
      <p className="text-sm text-gray-500">Signing you in…</p>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" />
        </div>
      }
    >
      <OAuthCallbackContent />
    </Suspense>
  );
}
