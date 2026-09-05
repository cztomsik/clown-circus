import { h } from 'preact';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Agent output is untrusted, so everything marked emits goes through DOMPurify.
// Links open in a new tab without leaking focus (noopener), and javascript:
// URLs are dropped outright.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener');
  }
  if (node.hasAttribute('href') && /^javascript:/i.test(node.getAttribute('href'))) {
    node.removeAttribute('href');
  }
});

// Chat feel: single newlines become <br> (matches the old pre-wrap behaviour);
// GFM for tables + strikethrough. `async: false` selects the sync overload
// that returns a plain string (we never register async extensions).
const md = (text) => marked.parse(text ?? '', { gfm: true, breaks: true, async: false });

// One parse per text change. Re-parsing on every SSE snapshot is cheap at
// transcript scale; a micro-cache would just complicate invalidation.
const render = (text) => DOMPurify.sanitize(md(text));

// Markdown block. `cls` lets the caller keep its own layout tint (e.g. the
// user's accent border/wash) — typography lives in the `.md` rules in
// index.html, which reference the theme tokens.
export const Markdown = ({ text, cls }) =>
  h('div', { class: cls ? `md ${cls}` : 'md', dangerouslySetInnerHTML: { __html: render(text) } });
