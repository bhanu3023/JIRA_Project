/**
 * The Migration board (L1BOAR) requires every ticket description to carry
 * these 9 headings, and they must never be editable/removable by anyone
 * (agents, reporters, or admins) once inserted -- not at creation, and not
 * later while the ticket moves between queues.
 *
 * Each heading renders as a `contenteditable="false"` block carrying
 * `data-locked-heading="true"`. RichTextEditor (src/components/ui/RichTextEditor.tsx)
 * treats any element with that attribute as protected: if an edit would
 * remove or alter one, the edit is reverted wholesale. That protection is
 * generic and content-driven -- it doesn't know about "Migration" or this
 * specific wording, it just guards whatever locked-heading nodes are
 * already present in the HTML it's given. This file is only responsible
 * for producing that HTML with the right wording.
 *
 * fix-migration-description-headings.mjs (repo root) uses the exact same
 * heading text to retrofit this protection onto existing L1BOAR tickets
 * that already had this template typed in as plain, unprotected text.
 */

export const MIGRATION_DESCRIPTION_HEADINGS = [
  'Issue Reported',
  'Error Description',
  'Screenshots',
  'Source and Destination Comparison and Findings',
  'Metabase Results',
  'Postman Results',
  'Grafana Results',
  'Workspace Ids',
  'Server Url',
];

export function lockedHeadingHtml(index: number, text: string): string {
  return `<div data-locked-heading="true" contenteditable="false" draggable="false">${index}. ${text}</div>`;
}

export const MIGRATION_DESCRIPTION_TEMPLATE_HTML = MIGRATION_DESCRIPTION_HEADINGS
  .map((text, i) => `${lockedHeadingHtml(i + 1, text)}<p><br></p>`)
  .join('');
