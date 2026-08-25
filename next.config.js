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
        source: '/(.*)',
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
    ];
  },
};
module.exports = nextConfig;
