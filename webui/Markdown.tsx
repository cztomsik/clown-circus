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

// `.md` prose typography for assistant / user text, referencing the same
// --color-* tokens (defined in index.html) so dark/light theming stays free.
// The body font stays sans (only code is mono). Injected once at module load
// so every <Markdown> instance shares a single <style>.
const MD_CSS = `
.md { line-height: 1.55; word-break: break-word; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 .5em; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-weight: 600; margin: .9em 0 .35em; line-height: 1.3; }
.md h1 { font-size: 1.25em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; }
.md h4, .md h5, .md h6 { font-size: 1em; }
/* Tailwind preflight zeroes list-style/padding, so restore markers here. */
.md ul { margin: 0 0 .5em; padding-left: 1.4em; list-style: disc; }
.md ol { margin: 0 0 .5em; padding-left: 1.4em; list-style: decimal; }
.md li { margin: .15em 0; }
.md li > ul { margin: .15em 0; list-style: circle; }
.md li > ol { margin: .15em 0; list-style: lower-alpha; }
.md blockquote { margin: 0 0 .5em; border-left: 2px solid var(--color-line); padding-left: .8em; color: var(--color-dim); }
.md a { color: var(--color-accent); text-decoration: underline; text-underline-offset: 2px; }
/* Inline code: plain mono, no pill/bubble — muted blue, distinct from
   links (accent) but calm against the body ink. */
.md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .9em; color: var(--color-code);
}
.md pre {
  background: var(--color-bg); border: 1px solid var(--color-line); border-radius: 6px;
  padding: .6em .75em; margin: 0 0 .5em; overflow-x: auto;
}
.md pre code { background: none; border: 0; padding: 0; font-size: .85em; }
.md table { border-collapse: collapse; margin: 0 0 .5em; display: block; max-width: 100%; overflow-x: auto; }
.md th, .md td { border: 1px solid var(--color-line); padding: .25em .6em; text-align: left; }
.md th { background: var(--color-panel); font-weight: 600; }
.md hr { border: 0; border-top: 1px solid var(--color-line); margin: .8em 0; }
.md img { max-width: 100%; }
.md del { color: var(--color-dim); }
`;

if (!document.getElementById('md-css')) {
  const el = document.createElement('style');
  el.id = 'md-css';
  el.textContent = MD_CSS;
  document.head.appendChild(el);
}

// Chat feel: single newlines become <br> (matches the old pre-wrap behaviour);
// GFM for tables + strikethrough. `async: false` selects the sync overload
// that returns a plain string (we never register async extensions).
const md = (text) => marked.parse(text ?? '', { gfm: true, breaks: true, async: false });

// One parse per text change. Re-parsing on every SSE snapshot is cheap at
// transcript scale; a micro-cache would just complicate invalidation.
const render = (text) => DOMPurify.sanitize(md(text));

// Markdown block. `cls` lets the caller keep its own layout tint (e.g. the
// user's accent border/wash) — typography lives in the `.md` rules above,
// which reference the theme tokens.
export const Markdown = ({ text, cls = null }: { text: string; cls?: string | null }) =>
  <div class={cls ? `md ${cls}` : 'md'} dangerouslySetInnerHTML={{ __html: render(text) }} />;
