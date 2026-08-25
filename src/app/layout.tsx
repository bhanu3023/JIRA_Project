import './globals.css';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import RootLayoutClient from '@/components/layout/RootLayoutClient';

const inter = Inter({ subsets: ['latin'] });

// A raw <title> JSX tag here (as this used to be) always wins over any child
// route's generateMetadata, since Next's metadata system doesn't know about
// it — no page could ever set its own title. Using the metadata export
// instead makes this just the default, so a route like /issues/[issueKey]
// can override just the title while still inheriting everything else here.
export const metadata: Metadata = {
  title: 'Neutara Technologies Ticketing',
  description: 'Neutara Technologies Ticketing - Unified Support Platform',
  icons: { icon: '/neutara-logo.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased bg-white text-gray-900 min-h-screen overflow-x-hidden`}>
        {/* Serves public/runtime-config.js, which sets window.__APP_CONFIG__. beforeInteractive so
            it runs before the app bundle evaluates src/config/runtimeConfig.ts -- with any later
            strategy the bundle would read an undefined config and fall back to the baked-in
            build-time value, defeating the point of a runtime-editable file. */}
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        <Suspense
          fallback={
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
              <div className="flex items-center justify-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.3s'}} />
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'-0.15s'}} />
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-bounce" style={{animationDelay:'0s'}} />
              </div>
            </div>
          }
        >
          <RootLayoutClient>{children}</RootLayoutClient>
        </Suspense>
      </body>
    </html>
  );
}
