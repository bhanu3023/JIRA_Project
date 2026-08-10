import type { Metadata } from 'next';
import { headers } from 'next/headers';

// Link-preview unfurling in Teams/Slack/etc. replaces a pasted URL's visible
// text with whatever this route's title resolves to, not the URL itself —
// that's the unfurling client's own behavior and isn't something a page can
// turn off. Setting the title to the ticket's own URL means whatever text an
// unfurler substitutes in is exactly the URL that was pasted, rather than the
// generic app name every page used to share (see the root layout fix).
export function generateMetadata({ params }: { params: { issueKey: string } }): Metadata {
  const h = headers();
  const host = h.get('host') || 'neutaraticketing.cftools.live';
  const proto = h.get('x-forwarded-proto') || 'https';
  return { title: `${proto}://${host}/issues/${params.issueKey}` };
}

export default function IssueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
