import { getHotjarSiteId } from '@/config/runtimeConfig';
import type { User } from '@/types';

const SCRIPT_ID = 'hotjar-snippet';

// Snippet version Hotjar expects in both _hjSettings and the script URL. Bumping this is Hotjar's
// call, not ours -- it changes only when they ship a new loader contract.
const SNIPPET_VERSION = 6;

export function isHotjarEnabled(): boolean {
  return Boolean(getHotjarSiteId());
}

/**
 * Injects the Hotjar snippet. No-ops when no site ID is configured, which is the normal state in
 * local development and on any deploy that has not opted in.
 *
 * Idempotent on purpose: next.config.js sets reactStrictMode, so React double-invokes effects in
 * development, and two copies of the snippet would open two recordings for one page view.
 *
 * @returns true only when this call actually injected the script.
 */
export function initHotjar(): boolean {
  if (!isHotjarEnabled()) return false;
  // Guarded for SSR: this module is imported from a client component, but Next still evaluates and
  // renders that component on the server, where neither global exists.
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (document.getElementById(SCRIPT_ID)) return false;

  const siteId = getHotjarSiteId();

  // A non-numeric ID would silently request hotjar-NaN.js and fail with nothing in the console
  // pointing at the cause. Say so instead -- a typo'd ID and a deliberately disabled Hotjar should
  // not look identical to whoever is debugging.
  if (!/^\d+$/.test(siteId)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[analytics] Ignoring hotjarSiteId="${siteId}": a Hotjar Site ID is digits only ` +
        `(e.g. "3847291"). Find it under Settings -> Sites & Organizations in Hotjar. Recording is off.`,
    );
    return false;
  }

  // The queue has to exist before the remote script loads, so calls made during the first render --
  // identify, in particular -- are replayed instead of dropped on the floor.
  const w = window as any;
  w.hj =
    w.hj ||
    function (...args: unknown[]) {
      (w.hj.q = w.hj.q || []).push(args);
    };
  // Number, not string: Hotjar's own snippet emits `hjid:6766543` as a numeric literal and the
  // remote script reads this value back. The digits-only guard above means Number() cannot NaN here.
  w._hjSettings = { hjid: Number(siteId), hjsv: SNIPPET_VERSION };

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = `https://static.hotjar.com/c/hotjar-${siteId}.js?sv=${SNIPPET_VERSION}`;
  document.head.appendChild(script);
  return true;
}

/**
 * Tags the current recording with who is using the app, so recordings can be filtered per person.
 *
 * Identifies by the opaque user id, NOT by email: /auth/register is open self-signup with a
 * caller-supplied organizationName, so sign-ins are not restricted to internal staff and an email
 * here would ship a stranger's address into a third-party analytics tool. Look the id up in the
 * users table when a recording needs a name against it. role and organizationId are sent because
 * they are the two dimensions worth segmenting recordings by and neither identifies a person.
 *
 * Note: filtering by these attributes is a paid Hotjar feature. On a tier without it the call is
 * accepted and ignored, so this stays safe to ship regardless of plan.
 *
 * @returns true only when an identify call was actually sent.
 */
export function identifyHotjarUser(user: Pick<User, 'id' | 'role' | 'organizationId'> | null | undefined): boolean {
  if (!isHotjarEnabled()) return false;
  if (typeof window === 'undefined' || typeof (window as any).hj !== 'function') return false;

  const id = (user?.id || '').trim();
  if (!id) return false;

  (window as any).hj('identify', id, {
    role: user?.role || 'UNKNOWN',
    organizationId: user?.organizationId || 'UNKNOWN',
  });
  return true;
}
