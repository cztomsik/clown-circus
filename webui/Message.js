import { useRef, useLayoutEffect } from 'preact/hooks';
import { html, PRE } from './ui.js';
import { prettyArgs } from './util.js';

const Pre = ({ text, cls = PRE }) => html`<pre class=${cls}>${text ?? ''}</pre>`;

// Roles are distinguished by colour / weight / tint instead of boxed cards:
// user = accent amber on a faint amber wash, assistant = plain ink (tool
// calls as dim `» name(args)` lines), system/tool = collapsed dim details
// with a thin left rule.
const Message = ({ m }) => {
  if (m.role === 'system') {
    return html`
      <details class="border-l-2 border-line pl-2.5">
        <summary class="py-0.5 text-dim/70 text-xs italic cursor-pointer select-none">system</summary>
        <${Pre} text=${m.content} cls="m-0 pt-1.5 pb-1 text-dim text-xs italic whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto" />
      </details>`;
  }
  if (m.role === 'tool') {
    const first = (m.content ?? '').split('\n')[0].slice(0, 120);
    return html`
      <details class="border-l-2 border-line bg-panel/70 rounded-r-md">
        <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer select-none">tool result — ${first}</summary>
        <${Pre} text=${m.content} cls="m-0 pt-0.5 pb-1.5 px-2.5 text-dim text-xs whitespace-pre-wrap break-words" />
      </details>`;
  }
  const isUser = m.role === 'user';
  return html`
    <div class=${`font-mono ${isUser ? 'border-l-2 border-accent bg-accent/10 rounded-r-md pl-3 pr-2 py-1.5' : ''}`}>
      ${m.content ? html`<${Pre} text=${m.content} cls=${isUser ? 'm-0 font-medium text-accent whitespace-pre-wrap break-words' : PRE} />` : null}
      ${(m.tool_calls ?? []).map((tc) => html`
        <div class="text-dim text-xs mb-1 break-words">» ${tc.function.name}(${prettyArgs(tc.function.arguments)})</div>`)}
    </div>`;
};

// List of messages; keeps the container scrolled to the newest turn.
export const Messages = ({ messages }) => {
  const ref = useRef(null);
  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  return html`
    <div ref=${ref} class="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      ${messages.map((m, i) => html`<${Message} key=${i} m=${m} />`)}
    </div>`;
};
