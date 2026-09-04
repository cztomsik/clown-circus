import { useRef, useLayoutEffect } from 'preact/hooks';
import { html, PRE } from './ui.js';
import { prettyArgs } from './util.js';

const Pre = ({ text, cls = PRE }) => html`<pre class=${cls}>${text ?? ''}</pre>`;

const firstLine = (s, n = 120) => {
  const l = (s ?? '').split('\n')[0];
  return l.length > n ? l.slice(0, n) + '…' : l;
};

// Pair an assistant turn's tool_calls with the tool results that immediately
// follow it (matched by tool_call_id). `consumed` is how many messages were
// absorbed, so the caller can skip past them.
const pairCalls = (m, messages, i) => {
  const results = new Map();
  for (let j = i + 1; j < messages.length; j++) {
    const r = messages[j];
    if (r.role !== 'tool') break;
    results.set(r.tool_call_id, r);
  }
  return { m, consumed: results.size, pairs: m.tool_calls.map((tc) => ({ tc, result: results.get(tc.id) })) };
};

// Flatten messages into render blocks: an assistant turn with tool calls
// absorbs its following tool results so each call+result renders together;
// everything else stands alone.
const buildBlocks = (messages) => {
  const blocks = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const b = pairCalls(m, messages, i);
      blocks.push(b);
      i += b.consumed;
    } else blocks.push({ m });
  }
  return blocks;
};

// One collapsible call+result pair: the summary is the call line with a dim
// first-line preview of the result; the body stacks two <pre> blocks — args
// (bg-line tint) and result (bg-bg tint) — so the two read distinctly. A call
// without a result (e.g. after /clear-tools) shows just the args block.
const ToolPair = ({ tc, result }) => {
  const args = prettyArgs(tc.function.arguments);
  return html`
    <details class="border-l-2 border-line bg-panel/70 rounded-r-md">
      <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer select-none break-words">
        ${tc.function.name}(${args})${result ? html` <span class="opacity-60">— ${firstLine(result.content)}</span>` : null}
      </summary>
      <div class="p-1.5 space-y-1">
        <pre class="m-0 px-2 py-1.5 text-dim text-xs whitespace-pre-wrap break-words rounded bg-line/50">${args}</pre>
        ${result ? html`
          <pre class="m-0 px-2 py-1.5 text-dim text-xs whitespace-pre-wrap break-words rounded bg-bg/80">${result.content ?? ''}</pre>` : null}
      </div>
    </details>`;
};

// Assistant turn: optional text followed by its tool-call pairs.
const AssistantBlock = ({ m, pairs }) => html`
  <div>
    ${m.content ? html`<${Pre} text=${m.content} />` : null}
    ${pairs.map((p, i) => html`<${ToolPair} key=${p.tc.id ?? i} tc=${p.tc} result=${p.result} />`)}
  </div>`;

// Roles are distinguished by colour / weight / tint instead of boxed cards:
// user = accent amber on a faint amber wash, assistant = plain ink (tool calls
// render as ToolPair blocks above), system/tool = collapsed dim details with
// a thin left rule (a tool message reaching here is unpaired, e.g. after an
// inconsistent edit — the fallback keeps it visible).
const Message = ({ m }) => {
  if (m.role === 'system') {
    return html`
      <details class="border-l-2 border-line pl-2.5">
        <summary class="py-0.5 text-dim/70 text-xs italic cursor-pointer select-none">system</summary>
        <${Pre} text=${m.content} cls="m-0 pt-1.5 pb-1 text-dim text-xs italic whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto" />
      </details>`;
  }
  if (m.role === 'tool') {
    const first = firstLine(m.content);
    return html`
      <details class="border-l-2 border-line bg-panel/70 rounded-r-md">
        <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer select-none">tool result — ${first}</summary>
        <${Pre} text=${m.content} cls="m-0 pt-0.5 pb-1.5 px-2.5 text-dim text-xs whitespace-pre-wrap break-words" />
      </details>`;
  }
  const isUser = m.role === 'user';
  const content = m.content;
  return html`
    <div class=${`font-mono ${isUser ? 'border-l-2 border-accent bg-accent/10 rounded-r-md pl-3 pr-2 py-1.5' : ''}`}>
      ${Array.isArray(content)
        ? content.map((part, i) => part.type === 'text'
            ? html`<${Pre} key=${i} text=${part.text} cls=${isUser ? 'm-0 font-medium text-accent whitespace-pre-wrap break-words' : PRE} />`
            : html`<img key=${i} src=${part.image_url?.url} alt="attachment" class="max-h-64 max-w-full rounded border border-line my-1" />`)
        : content ? html`<${Pre} text=${content} cls=${isUser ? 'm-0 font-medium text-accent whitespace-pre-wrap break-words' : PRE} />` : null}
    </div>`;
};

// List of messages; keeps the container scrolled to the newest turn.
export const Messages = ({ messages }) => {
  const ref = useRef(null);
  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  return html`
    <div ref=${ref} class="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
      ${buildBlocks(messages).map((b, i) => b.pairs
        ? html`<${AssistantBlock} key=${i} m=${b.m} pairs=${b.pairs} />`
        : html`<${Message} key=${i} m=${b.m} />`)}
    </div>`;
};
