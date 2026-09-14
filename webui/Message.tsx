import { useRef, useState, useEffect, useLayoutEffect } from 'preact/hooks';
import { PRE } from './ui';
import { Spinner, Dot, Guide } from './primitives';
import { prettyArgs, parseArgs, reasoningText, firstLine } from './util';
import { ToolCall, toolCallTitle } from './ToolCall';
import { Markdown } from './Markdown';

const Pre = ({ text, cls = PRE }) => <pre class={cls}>{text ?? ''}</pre>;

// Whether a tool-result text looks like a failure: accept() renders tool
// exceptions as `Error: …` content, run_command returns `Error running
// command: …` (spawn failed) or `Command failed with exit code N …`
// (non-zero exit). A display-only heuristic — the transcript (and what the
// model sees) is untouched.
const isToolError = (c) =>
  typeof c === 'string' && (/^Error\b/.test(c) || c.startsWith('Command failed with exit code'));

// A tool call's result: plain dim <pre> — except a failed result, whose
// first line renders in the error tint so the failure stands out even when
// the detail is collapsed to the one-line preview.
const ToolResult = ({ content }) => {
  if (content == null) return null;
  const text = String(content);
  if (!isToolError(text))
    return <pre class="m-0 text-dim text-xs font-mono whitespace-pre-wrap break-words">{text}</pre>;
  const nl = text.indexOf('\n');
  return (
    <pre class="m-0 text-xs font-mono whitespace-pre-wrap break-words">
      <span class="text-err">{nl === -1 ? text : text.slice(0, nl)}</span>
      <span class="text-dim">{nl === -1 ? '' : text.slice(nl)}</span>
    </pre>
  );
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

// A quiet "thing that happened" line: a small bullet + a short dim label, with
// an optional right-aligned muted status; it expands to a faint, indented detail
// under a hairline left guide (no box). Used by reasoning, unpaired tools, and
// any non-system disclosure. The native <details> triangle is hidden (see
// index.html) in favour of the bullet dot.
const Activity = ({ label, status = null, mono = false, children }) => (
  <details class="q-activity group">
    <summary class="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-2 py-1 pl-1
                    text-xs cursor-pointer select-none list-none">
      <span class="w-1 h-1 rounded-full bg-dim/50 flex-none group-hover:bg-dim"></span>
      <span class={`truncate text-dim group-hover:text-ink/70 ${mono ? 'font-mono' : 'italic'}`}>{label}</span>
      {status ? <span class="hidden sm:block justify-self-end truncate max-w-[48%] text-dim/55 whitespace-nowrap">{status}</span> : null}
    </summary>
    {children ? <div class="mb-1.5 ml-[6px] py-1 pl-3 border-l border-line/70">{children}</div> : null}
  </details>
);

// One quiet call+result line. The collapsed line is a 4-column grid:
// dot · name · arg · state — three tints, matching the mockup. Expanded,
// a faint guide holds the call (rendered by ToolCall) above the result.
const ToolPair = ({ tc, result, cwd }) => {
  const name = tc.function.name;
  const args = parseArgs(tc.function.arguments);
  const raw = prettyArgs(tc.function.arguments);
  // Split the title into name / arg for the 3-tint layout.
  const title = toolCallTitle(name, args);
  const arg = title ? title.slice(name.length).trim() : (raw ? firstLine(raw, 60) : '');
  const failed = isToolError(result?.content);
  return (
    <details class="q-activity group">
      <summary class="grid grid-cols-[6px_minmax(0,auto)_minmax(0,1fr)_auto] items-baseline gap-x-2.5
                      py-[3px] pl-1 pr-1.5 text-xs cursor-pointer select-none list-none
                      rounded hover:bg-material2 transition-colors">
        <Dot />
        <span class="text-dim font-medium whitespace-nowrap">{name}</span>
        {arg ? <span class="text-text3 whitespace-nowrap overflow-hidden text-ellipsis font-mono">{arg}</span> : null}
        {result ? <span class={`${failed ? 'text-err' : 'text-text3'} text-[.72rem] justify-self-end whitespace-nowrap opacity-90 font-mono`}>{firstLine(result.content, 40)}</span> : null}
      </summary>
      <Guide cls="space-y-1.5">
        <ToolCall name={name} args={args} raw={raw} cwd={cwd} />
        {result ? <ToolResult content={result.content} /> : null}
      </Guide>
    </details>
  );
};

// The model's chain-of-thought, when the provider emits reasoning on an
// assistant turn (llama.cpp: `reasoning_content`, vLLM: `reasoning`).
// Rendered as the same quiet line as a tool call — dot · "reasoning" · a
// one-line preview — so it reads as just another step in the run's inline
// list rather than a separate kind of line.
const Reasoning = ({ text }) => (
  <details class="q-activity group">
    <summary class="grid grid-cols-[6px_minmax(0,auto)_minmax(0,1fr)_auto] items-baseline gap-x-2.5
                    py-[3px] pl-1 pr-1.5 text-xs cursor-pointer select-none list-none
                    rounded hover:bg-material2 transition-colors">
      <Dot />
      <span class="text-dim font-medium whitespace-nowrap">reasoning</span>
      <span class="text-text3 whitespace-nowrap overflow-hidden text-ellipsis font-mono">{firstLine(text, 60)}</span>
    </summary>
    <Guide>
      <Pre text={text} cls="m-0 text-dim text-xs whitespace-pre-wrap break-words" />
    </Guide>
  </details>
);

// Flatten a run's assistant turns into one transcript-ordered list of rows:
// reasoning, prose, and tool-call. Rendered with uniform spacing and no
// per-turn wrapper, all of a run's reasoning + tool calls read as ONE inline
// list instead of a separate fragment per turn.
const runRows = (blocks, cwd) => {
  const rows = [];
  let k = 0;
  for (const b of blocks) {
    const m = b.m;
    const r = reasoningText(m);
    if (r) rows.push(<Reasoning key={k++} text={r} />);
    if (m.content) rows.push(<Markdown key={k++} text={m.content} />);
    if (b.pairs) for (const p of b.pairs) rows.push(<ToolPair key={k++} tc={p.tc} result={p.result} cwd={cwd} />);
  }
  return rows;
};

// Roles are distinguished by colour / weight / alignment instead of boxed
// cards: user = a right-aligned blue bubble (white text, image attachments
// above it), system = a circular disc disclosure, tool = the same quiet
// Activity line (a tool message reaching here is unpaired, e.g. after an
// inconsistent edit — the fallback keeps it visible). Assistant turns are
// grouped and rendered by runRows as one inline list, so they never reach
// here.
const Message = ({ m }) => {
  if (m.role === 'system') {
    // System prompt: a circular disclosure disc with a rotating chevron,
    // replacing the generic bullet.
    return (
      <details class="q-activity disc">
        <summary class="flex items-center gap-2 py-1.5 cursor-pointer select-none list-none">
          <span class="w-4 h-4 rounded-full bg-field grid place-items-center flex-none">
            <svg class="disc-chevron text-text3" width="8" height="8" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 6l6 6-6 6"/>
            </svg>
          </span>
          <span class="text-xs text-text3">system prompt</span>
        </summary>
        <pre class="mt-2.5 text-dim text-xs font-mono whitespace-pre-wrap break-words rounded-[10px] border border-hairline p-3 max-h-[220px] overflow-y-auto">{m.content}</pre>
      </details>
    );
  }
  if (m.role === 'tool') {
    return (
      <Activity label="tool result" mono status={firstLine(m.content, 60)}>
        <ToolResult content={m.content} />
      </Activity>
    );
  }
  const content = m.content;

  // User message: a right-aligned blue bubble (iMessage-style) with white text.
  // The .user-bubble CSS class adds the pop entrance animation + shadow.
  if (m.role === 'user') {
    const parts = Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : [];
    const images = parts.filter((p) => p.type === 'image_url');
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return (
      <div class="flex flex-col items-end gap-1.5">
        {images.map((p, i) => (
          <img key={i} src={p.image_url?.url} alt="attachment" class="max-h-64 max-w-full rounded border border-line" />
        ))}
        {text ? (
          <div class="user-bubble bg-accent text-white rounded-2xl rounded-br-md max-w-[85%] px-3.5 py-2">
            <Markdown text={text} />
          </div>
        ) : null}
      </div>
    );
  }

};

// Consecutive assistant turns (one agent run's worth of LLM calls, ending in
// the tool-less final turn) render as a single visual unit with a tight gap,
// so a run reads as one continuous flow instead of a staircase of fragments.
const isAssistantTurn = (b) => b.pairs || b.m.role === 'assistant';
const groupRuns = (blocks) => {
  const groups = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (last?.blocks && isAssistantTurn(b)) last.blocks.push(b);
    else groups.push(isAssistantTurn(b) ? { blocks: [b] } : b);
  }
  return groups;
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

// Shown after the last message while a run is in flight: a CSS spinner (see
// index.html), "Working · `toolname`" when the in-flight tool is known, and a
// live elapsed-time readout.
const Working = ({ tool }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div class="flex items-center gap-2.5 py-0.5" aria-label="working">
      <Spinner />
      <span class="text-dim text-xs">Working{tool ? ` · <code class="font-mono text-text3">${tool}</code>` : ''}</span>
      <span class="text-text3 text-xs font-mono tabular-nums">{fmtElapsed(elapsed)}</span>
    </div>
  );
};

// Distance (from the bottom) that still counts as "pinned".
const NEAR_BOTTOM = 80;

// List of messages. Keeps the container scrolled to the newest turn (and to
// the working indicator when a run starts) — but only while the reader is
// "pinned" near the bottom. Scrolled up → new SSE snapshots don't yank them
// back; a floating "↓ latest" pill (bottom-centre of the pane) smooth-scrolls
// back and re-pins. `pinned` mirrors `pinnedRef` for the pill's visibility;
// the ref is what the layout effect reads (no effect-ordering dependency).
export const Messages = ({ messages, running = false, cwd = '' }) => {
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
  const groups = groupRuns(blocks);
  return (
    <div class="relative flex-1 flex flex-col min-h-0">
      <div ref={ref} class="flex-1 overflow-y-auto" onScroll={onScroll}>
        <div class="max-w-3xl mx-auto w-full p-3 flex flex-col gap-3">
          {groups.map((g, i) => g.blocks
            ? <div key={i} class="flex flex-col gap-1">{runRows(g.blocks, cwd)}</div>
            : <Message key={i} m={g.m} />)}
          {running ? <Working tool={inFlightTool(blocks)} /> : null}
        </div>
      </div>
      {!pinned ? (
        <button class="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 text-xs text-ink bg-panel border border-line rounded-full shadow-lg cursor-pointer hover:border-accent"
                title="scroll to the latest message"
                onClick={jumpToLatest}>↓ latest</button>
      ) : null}
    </div>
  );
};
