/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 14 only calls src/instrumentation.ts's register() in production
  // (never in `next dev`) AND only when this flag is on — without it, the
  // file's register() function is dead code. This is what actually starts
  // the email-poller bootstrap and the periodic SLA breach-warning check on
  // server boot; neither was ever running without this.
  experimental: {
    instrumentationHook: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        // /uploads/* is excluded here and given its own relaxed rule below --
        // the blanket X-Frame-Options: DENY + frame-ancestors 'none' applied
        // to every route also applied to uploaded files, which blocked the
        // app's own same-origin attachment-preview <iframe> (a PDF opened
        // from a ticket's Attachments list showed Chrome's "refused to
        // connect", its wording for a framing violation, not an actual
        // network failure) -- DENY means "never embeddable in ANY iframe,
        // including this app embedding its own files."
        source: '/((?!uploads/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Hotjar needs every one of the hotjar.com/hotjar.io entries below; with a partial
          // list the snippet fails in a way that looks like it simply never loaded. frame-src and
          // worker-src are spelled out because without them both fall back to default-src 'self',
          // which blocks Hotjar's consent iframe and its blob: worker. frame-ancestors stays
          // 'none' -- it governs who may embed THIS app, which Hotjar does not need.
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.hotjar.com https://script.hotjar.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https://script.hotjar.com; connect-src 'self' https: https://*.hotjar.com https://*.hotjar.io wss://*.hotjar.com; frame-src 'self' https://vars.hotjar.com; worker-src 'self' blob:; frame-ancestors 'none';" },
        ],
      },
      {
        source: '/api/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        // Relaxed to SAMEORIGIN so the app's own attachment-preview iframe
        // (image/PDF/etc. opened from a ticket) can actually embed these
        // files -- still blocks any THIRD-PARTY site from framing them,
        // just no longer blocks this app from framing its own uploads.
        source: '/uploads/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self';" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
