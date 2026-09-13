import { parseTodos } from './util.js';

// Bespoke rendering of a tool *call* — the arguments only. The tool *result* is
// rendered separately (and unchanged) by Message.tsx. Every tool registered in
// src/tools.js gets a view; anything else (or an unparseable `arguments`
// string) falls back to the generic pretty-JSON <pre>. All values are
// untrusted, LLM-supplied text and are rendered as text nodes only — never HTML.

const firstLine = (s, n = 80) => {
  const l = (s ?? '').split('\n')[0];
  return l.length > n ? l.slice(0, n) + '…' : l;
};

const PRE = 'm-0 px-2 py-1.5 text-dim text-xs whitespace-pre-wrap break-words rounded bg-line/50';
const HEAD = 'px-2 py-1.5 rounded bg-line/50 text-xs font-mono break-all';
const SCROLL = 'max-h-[300px] overflow-y-auto';

// read_file — the path, plus a "raw" flag when the line-number gutter is off.
const ReadFile = ({ a }) => (
  <div class={HEAD}>
    <span class="text-dim">read </span><span class="text-ink">{a.path ?? ''}</span>
    {a.raw ? <span class="text-dim/70"> · raw</span> : null}
  </div>
);

// write_file — path + line count, then the full content (the real payload).
const WriteFile = ({ a }) => {
  const c = a.content ?? '';
  const lines = c.length ? c.split('\n').length : 0;
  return (
    <div class="space-y-1">
      <div class={HEAD}>
        <span class="text-dim">write </span><span class="text-ink">{a.path ?? ''}</span>
        {lines ? <span class="text-dim/70"> · {lines} line{lines === 1 ? '' : 's'}</span> : null}
      </div>
      {c ? <pre class={`${PRE} ${SCROLL}`}>{c}</pre> : null}
    </div>
  );
};

// edit_file — path, then a stacked mini-diff: the removed old content (err
// tint, − gutter) above the added new content (ok tint, + gutter). The star of
// the set: turns a big JSON blob with embedded newlines into a red/green pair.
const EditFile = ({ a }) => {
  const old = a.old_content ?? '';
  const neu = a.new_content ?? '';
  const diff = 'px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words border-l-2 ' + SCROLL;
  return (
    <div class="space-y-1">
      <div class={HEAD}>
        <span class="text-dim">edit </span><span class="text-ink">{a.path ?? ''}</span>
        {a.replace_all ? <span class="text-dim/70"> · all</span> : null}
      </div>
      <div class={`${diff} border-err bg-err/10`}><span class="text-err">− </span>{old}</div>
      <div class={`${diff} border-ok bg-ok/10`}><span class="text-ok">+ </span>{neu}</div>
    </div>
  );
};

// run_command — a $-prefixed prompt line, with the cwd noted when set.
const RunCommand = ({ a }) => (
  <div class="space-y-1">
    <pre class={PRE}><span class="text-accent">$ </span><span class="text-ink">{a.command ?? ''}</span></pre>
    {a.cwd ? <div class="px-2 text-xs font-mono break-all"><span class="text-dim/70">cwd </span><span class="text-dim">{a.cwd}</span></div> : null}
  </div>
);

// write_todos — a count header, then the parsed list (strike = done, accent =
// in progress) via parseTodos, mirroring the Todos panel styling.
const WriteTodos = ({ a }) => {
  const items = parseTodos(a.content ?? '');
  const tasks = items.filter((t) => t.done !== undefined);
  const done = tasks.filter((t) => t.done).length;
  return (
    <div class="space-y-1">
      <div class={HEAD}>
        <span class="text-dim">todos </span><span class="text-ink">{tasks.length} item{tasks.length === 1 ? '' : 's'}</span>
        {done ? <span class="text-dim/70"> · {done} done</span> : null}
      </div>
      {tasks.length ? (
        <ul class={`m-0 px-2 py-1.5 text-xs list-none space-y-0.5 rounded bg-line/50 ${SCROLL}`}>
          {items.map((t, i) => t.done !== undefined
            ? <li key={i} class={`break-words ${t.done ? 'text-dim/60 line-through' : t.inProgress ? 'text-accent font-medium' : 'text-dim'}`}>{t.done ? '✓' : '•'} {t.text}</li>
            : <li key={i} class="text-dim/70 break-words">{t.text}</li>)}
        </ul>
      ) : null}
    </div>
  );
};

// load_skill — just the skill name.
const LoadSkill = ({ a }) => (
  <div class={HEAD}>
    <span class="text-dim">load_skill </span><span class="text-ink">{a.skill_name ?? ''}</span>
  </div>
);

// Fallback for unknown tools / unparseable args — the original pretty-JSON view.
const Generic = ({ raw }) => <pre class={PRE}>{raw ?? ''}</pre>;

const RENDERERS = {
  read_file: ReadFile,
  write_file: WriteFile,
  edit_file: EditFile,
  run_command: RunCommand,
  write_todos: WriteTodos,
  load_skill: LoadSkill,
};

// Short, bounded title for the collapsed <summary> line. Returns null when the
// tool has no bespoke title (or args didn't parse) so the caller can fall back
// to the generic `name(argsPreview)` form.
export const toolCallTitle = (name, args) => {
  if (!args || typeof args !== 'object') return null;
  switch (name) {
    case 'read_file': return `read_file ${args.path ?? ''}`.trim();
    case 'write_file': return `write_file ${args.path ?? ''}`.trim();
    case 'edit_file': return `edit_file ${args.path ?? ''}`.trim();
    case 'run_command': return `run_command ${firstLine(args.command)}`.trim();
    case 'write_todos': {
      const n = parseTodos(args.content ?? '').filter((t) => t.done !== undefined).length;
      return n ? `write_todos (${n} items)` : 'write_todos';
    }
    case 'load_skill': return `load_skill ${args.skill_name ?? ''}`.trim();
    default: return null;
  }
};

// The expanded body for one tool call's arguments. `args` is the parsed object
// (or null) and `raw` is the pretty-JSON string used by the fallback.
export const ToolCall = ({ name, args, raw }) => {
  const R = RENDERERS[name];
  return R && args ? <R a={args} /> : <Generic raw={raw} />;
};
