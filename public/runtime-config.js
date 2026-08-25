// Runtime configuration -- read when the page loads, NOT compiled into the bundle. Files in
// public/ are served verbatim, so this stays editable on the server after `next build`: no
// rebuild, no toolchain, no Node.js required.
//
// Loaded from src/app/layout.tsx with next/script strategy="beforeInteractive" so it runs before
// the app bundle evaluates src/config/runtimeConfig.ts.
window.__APP_CONFIG__ = {
  // Hotjar Site ID (digits only). Not a secret: it ships inside client-side JavaScript that any
  // visitor can read. Blank = Hotjar fully off, no script requested, no session recorded.
  hotjarSiteId: "6766543",
};
