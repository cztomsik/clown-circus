import { useRef, useState, useEffect, useLayoutEffect } from 'preact/hooks';
import { html, PRE } from './ui.js';
import { prettyArgs, parseArgs, reasoningText } from './util.js';
import { ToolCall, toolCallTitle } from './toolcall.js';
import { Markdown } from './md.js';

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

// One collapsible call+result pair. The summary shows a short, bounded per-tool
// title (e.g. `edit_file src/foo.js`) plus a first-line preview of the result,
// so a large payload can't stretch the collapsed line. The body stacks the call
// — rendered by ToolCall (webui/toolcall.js) with a bespoke view per tool, or
// the generic pretty-JSON <pre> for unknown ones — above the result, which keeps
// the original args/result distinction (bg-line tint vs bg-bg tint). A call
// without a result (e.g. after /clear-tools) shows just the call block.
const ToolPair = ({ tc, result }) => {
  const name = tc.function.name;
  const raw = prettyArgs(tc.function.arguments);
  const args = parseArgs(tc.function.arguments);
  const title = toolCallTitle(name, args) ?? `${name}(${firstLine(raw, 80)})`;
  return html`
    <details class="border-l-2 border-line bg-panel/70 rounded-r-md">
      <summary class="py-1 px-2.5 text-dim text-xs cursor-pointer select-none break-words">
        ${title}${result ? html` <span class="opacity-60">— ${firstLine(result.content)}</span>` : null}
      </summary>
      <div class="p-1.5 space-y-1">
        <${ToolCall} name=${name} args=${args} raw=${raw} />
        ${result ? html`
          <pre class="m-0 px-2 py-1.5 text-dim text-xs whitespace-pre-wrap break-words rounded bg-bg/80">${result.content ?? ''}</pre>` : null}
      </div>
    </details>`;
};

// The model's chain-of-thought, when the provider emits reasoning on an
// assistant turn (llama.cpp: `reasoning_content`, vLLM: `reasoning`). Rendered
// collapsed + dim/italic so it reads as secondary to the visible response.
const Reasoning = ({ text }) => html`
  <details class="border-l-2 border-line bg-panel/40 rounded-r-md">
    <summary class="py-1 px-2.5 text-dim/70 text-xs italic cursor-pointer select-none">reasoning</summary>
    <${Pre} text=${text} cls="m-0 px-2.5 pb-1.5 pt-0.5 text-dim text-xs italic whitespace-pre-wrap break-words" />
  </details>`;

// Assistant turn: optional reasoning + text, followed by its tool-call pairs.
const AssistantBlock = ({ m, pairs }) => {
  const r = reasoningText(m);
  return html`
    <div>
      ${r ? html`<${Reasoning} text=${r} />` : null}
      ${m.content ? html`<${Markdown} text=${m.content} />` : null}
      ${pairs.map((p, i) => html`<${ToolPair} key=${p.tc.id ?? i} tc=${p.tc} result=${p.result} />`)}
    </div>`;
};

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
  const cls = isUser ? 'font-medium text-accent' : undefined;
  const r = reasoningText(m);
  return html`
    <div class=${isUser ? 'border-l-2 border-accent bg-accent/10 rounded-r-md pl-3 pr-2 py-1.5' : ''}>
      ${r ? html`<${Reasoning} text=${r} />` : null}
      ${Array.isArray(content)
        ? content.map((part, i) => part.type === 'text'
            ? html`<${Markdown} key=${i} text=${part.text} cls=${cls} />`
            : html`<img key=${i} src=${part.image_url?.url} alt="attachment" class="max-h-64 max-w-full rounded border border-line my-1" />`)
        : content ? html`<${Markdown} text=${content} cls=${cls} />` : null}
    </div>`;
};

// While a run is in flight, the latest assistant turn ends with tool calls
// whose results have not arrived yet — the first one is what's executing now.
const inFlightTool = (blocks) => {
  const last = blocks[blocks.length - 1];
  const pending = last?.pairs?.find((p) => !p.result);
  return pending ? pending.tc.function.name : null;
};

// Elapsed-run clock: Working mounts exactly when a run starts (its caller
// renders it conditionally on `running`), so mount time ≈ run start as far as
// the client knows. Recomputed from Date.now() on every 1s tick, so a
// backgrounded tab's throttled interval can't drift it — only the *display*
// lags while hidden.
const fmtElapsed = (total) => {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

// Shown after the last message while a run is in flight: three small staggered-
// bouncing dim dots (keyframes in index.html), the in-flight tool's name when
// it's known, and a live elapsed-time readout (tabular nums, so it doesn't
// jitter as the digits change).
const Working = ({ tool }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return html`
    <div class="flex items-center gap-2 py-0.5" aria-label="working">
      <span class="flex items-end gap-[3px] h-3">
        <span class="working-dot inline-block w-1.5 h-1.5 rounded-full bg-dim"></span>
        <span class="working-dot inline-block w-1.5 h-1.5 rounded-full bg-dim"></span>
        <span class="working-dot inline-block w-1.5 h-1.5 rounded-full bg-dim"></span>
      </span>
      ${tool ? html`<span class="text-dim/70 text-xs font-mono">${tool}…</span>` : null}
      <span class="text-dim/70 text-xs font-mono tabular-nums">${fmtElapsed(elapsed)}</span>
    </div>`;
};

// Distance (from the bottom) that still counts as "pinned".
const NEAR_BOTTOM = 80;

// List of messages. Keeps the container scrolled to the newest turn (and to
// the working indicator when a run starts) — but only while the reader is
// "pinned" near the bottom. Scrolled up → new SSE snapshots don't yank them
// back; a floating "↓ latest" pill (bottom-centre of the pane) smooth-scrolls
// back and re-pins. `pinned` mirrors `pinnedRef` for the pill's visibility;
// the ref is what the layout effect reads (no effect-ordering dependency).
export const Messages = ({ messages, running = false }) => {
  const ref = useRef(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  const isPinned = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = isPinned(el);
    setPinned(pinnedRef.current); // same value → Preact bails out, no re-render
  };

  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  const blocks = buildBlocks(messages);
  return html`
    <div class="relative flex-1 flex flex-col min-h-0">
      <div ref=${ref} class="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5" onscroll=${onScroll}>
        ${blocks.map((b, i) => b.pairs
          ? html`<${AssistantBlock} key=${i} m=${b.m} pairs=${b.pairs} />`
          : html`<${Message} key=${i} m=${b.m} />`)}
        ${running ? html`<${Working} tool=${inFlightTool(blocks)} />` : null}
      </div>
      ${!pinned ? html`
        <button class="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 text-xs text-ink bg-panel border border-line rounded-full shadow-lg cursor-pointer hover:border-accent"
                title="scroll to the latest message"
                onclick=${jumpToLatest}>↓ latest</button>` : null}
    </div>`;
};
