/**
 * kb-templates.ts
 * Starting content for a new KB article or release note. The editor opens
 * with this filled in; the writer replaces the [bracketed] parts and deletes
 * sections that don't apply. Kept in step with the Word template that's
 * handed out (KB_Article_and_Release_Note_Templates.docx).
 */

import type { KbKind } from '@/lib/api';

const ph = (text: string) => `<em>[${text}]</em>`;

const KB_ARTICLE = [
  `<h2>Summary</h2>`,
  `<p>${ph('One or two sentences: what this article helps with, and the short answer.')}</p>`,
  `<h2>Applies to</h2>`,
  `<p>${ph('Product, module or migration type')} · ${ph('Version or environment, if relevant')}</p>`,
  `<h2>Before you start</h2>`,
  `<ul><li>${ph('Access, permission or tool needed')}</li><li>${ph('Anything to check first')}</li></ul>`,
  `<h2>Steps</h2>`,
  `<ol><li>${ph('First action, using exact button and field names')}</li><li>${ph('Next action')}</li><li>${ph('How to confirm it worked')}</li></ol>`,
  `<h2>If it doesn't work</h2>`,
  `<ul><li>${ph('Symptom or error message')} → ${ph('What to do')}</li><li>Still stuck? ${ph('Who to contact, or which queue to raise a ticket in')}</li></ul>`,
  `<h2>Related</h2>`,
  `<ul><li>${ph('Link to a related article, ticket or document')}</li></ul>`,
].join('');

const RELEASE_NOTE = [
  `<p><strong>Release date:</strong> ${ph('DD Mon YYYY')}<br><strong>Applies to:</strong> ${ph('Product, module or migration type')}</p>`,
  `<h2>Summary</h2>`,
  `<p>${ph('One or two sentences: the most important change, and who it affects.')}</p>`,
  `<h2>New</h2>`,
  `<ul><li><strong>${ph('Feature')}</strong>: ${ph('what it does and why it helps')}</li></ul>`,
  `<h2>Improved</h2>`,
  `<ul><li><strong>${ph('Area')}</strong>: ${ph("what's better, with a number if you have one")}</li></ul>`,
  `<h2>Fixed</h2>`,
  `<ul><li>${ph('Problem users saw')} is fixed.</li></ul>`,
  `<h2>Changed or removed</h2>`,
  `<ul><li>${ph('Old behaviour')} → ${ph('new behaviour')}. ${ph('What users need to do, if anything')}</li></ul>`,
  `<h2>Known issues</h2>`,
  `<ul><li>${ph('Issue')} – ${ph('workaround')}</li></ul>`,
  `<h2>More information</h2>`,
  `<ul><li>${ph('Link to a KB article, guide or ticket')}</li></ul>`,
].join('');

export const KB_TEMPLATES: Record<KbKind, string> = {
  kb: KB_ARTICLE,
  release: RELEASE_NOTE,
};

/** True while the body still has [placeholders] the writer hasn't replaced. */
export function hasTemplatePlaceholders(html: string) {
  // The editor may re-save <em> as <i>.
  return /<(em|i)\b[^>]*>\s*\[[^\]<]+\]\s*<\/(em|i)>/i.test(html);
}
