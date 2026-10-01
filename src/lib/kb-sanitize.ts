/**
 * Allowlist HTML sanitizer for rendering KB article bodies in the browser.
 * The server already strips scripts on save (sanitizeKbHtml in kb-api.ts);
 * this is the second layer, applied right before dangerouslySetInnerHTML.
 * Anything not on the allowlist is unwrapped (its text kept) or dropped.
 */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sub', 'sup', 'mark', 'small',
  'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'figure', 'figcaption',
]);
// Removed together with everything inside them.
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base']);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'style', 'colspan', 'rowspan', 'width', 'height', 'align', 'target', 'rel']);

function isSafeUrl(value: string, forImage: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (v.startsWith('/') || v.startsWith('#') || v.startsWith('http://') || v.startsWith('https://')) return true;
  if (!forImage && v.startsWith('mailto:')) return true;
  if (forImage && /^data:image\/(png|jpe?g|gif|webp);/.test(v)) return true;
  return !/^[a-z][a-z0-9+.-]*:/.test(v); // relative URL with no scheme
}

function cleanNode(node: Element) {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase();
    // The editor's hover-only "remove image" control isn't article content.
    if (DROP_TAGS.has(tag) || child.hasAttribute('data-rte-img-remove')) {
      child.remove();
      continue;
    }
    cleanNode(child);
    if (!ALLOWED_TAGS.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      const keep =
        name.startsWith('data-') ||
        (ALLOWED_ATTRS.has(name) &&
          (name !== 'href' || isSafeUrl(attr.value, false)) &&
          (name !== 'src' || isSafeUrl(attr.value, true)) &&
          (name !== 'style' || !/url\s*\(|expression\s*\(|javascript:/i.test(attr.value)));
      if (!keep) child.removeAttribute(attr.name);
    }
    if (tag === 'a') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

export function sanitizeForDisplay(html: string): string {
  if (typeof window === 'undefined' || !html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  // Comments can't run script, but drop them so nothing odd survives.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  cleanNode(doc.body);
  return doc.body.innerHTML;
}
