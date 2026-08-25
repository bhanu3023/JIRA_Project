/**
 * Runtime-resolved client configuration.
 *
 * Next.js freezes NEXT_PUBLIC_* env vars into the built JavaScript at `next build` time, so a
 * bundle built with tracking on can never be un-tracked without a rebuild, and one built without
 * an ID can never be switched on. Reading public/runtime-config.js at page load first — with the
 * baked-in build value only as a fallback — is what makes these values changeable after a build.
 */

type AppConfig = { hotjarSiteId?: string };

function appConfig(): AppConfig {
  return typeof window !== 'undefined' && (window as any).__APP_CONFIG__
    ? ((window as any).__APP_CONFIG__ as AppConfig)
    : {};
}

/**
 * Treated as "not set": undefined, null, blank, and the "__PLACEHOLDER__" shape container
 * entrypoints substitute at start-up — an unsubstituted placeholder must fall through to the next
 * source, not be used as a real value.
 */
function isUnset(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return !t || /^__.*__$/.test(t);
}

function resolve(runtimeValue: unknown, buildTimeValue: unknown): string {
  for (const raw of [runtimeValue, buildTimeValue]) {
    if (!isUnset(raw)) return (raw as string).trim();
  }
  return '';
}

/**
 * Read on every call rather than resolved once at module scope, and this is load-order critical:
 * next/script strategy="beforeInteractive" renders runtime-config.js as a preload plus an entry in
 * Next's `__next_s` queue, while this module arrives inside an async chunk in <head>. There is no
 * guarantee the queue has been flushed by the time this module first evaluates — a module-scope
 * const could therefore latch the empty pre-config state permanently and silently disable Hotjar
 * on a deploy that had configured it. Callers run inside effects, long after the queue is drained.
 */
export function getHotjarSiteId(): string {
  return resolve(appConfig().hotjarSiteId, process.env.NEXT_PUBLIC_HOTJAR_SITE_ID);
}
