import { useState } from 'preact/hooks';
import { parseTodos } from './util.js';

// Collapsible floating todo panel. Anchored top-right inside the main pane
// (Main.tsx makes <main> relative), so it overlays the transcript instead of
// taking flow space. The session's todos are a user-visible markdown string,
// parsed best-effort (see parseTodos): checkbox lines render as a styled list
// (dim strikethrough = done, accent bold = in progress), any other lines as-is
// (dim); when there are no checkbox lines at all the raw string is shown
// preformatted. The header row toggles the list and the chevron rotates when
// collapsed.
export const Todos = ({ todos }) => {
  const [open, setOpen] = useState(true);
  if (!todos?.trim()) return null;
  const entries = parseTodos(todos);
  const tasks = entries.filter((e) => e.done !== undefined);
  const done = tasks.filter((t) => t.done).length;
  return (
    <div class="absolute top-2 right-2 z-20 w-72 max-w-[85%]">
      <div class="border border-line rounded shadow-lg bg-panel/95 backdrop-blur-sm overflow-hidden">
        <button class="w-full flex items-center justify-between px-2.5 py-1.5 text-xs cursor-pointer hover:bg-line/40"
                title={open ? 'collapse todos' : 'expand todos'}
                onClick={() => setOpen((o) => !o)}>
          <span class="font-medium">Todos {tasks.length ? <span class="text-dim">{done}/{tasks.length}</span> : null}</span>
          <span class={`inline-block text-dim transition-transform ${open ? '' : '-rotate-90'}`}>▾</span>
        </button>
        {open ? (tasks.length
          ? (
            <ul class="list-none m-0 p-1.5 text-xs max-h-64 overflow-y-auto">
              {entries.map((e, i) => (
                <li key={i} class={e.done !== undefined
                  ? e.done ? 'text-dim line-through'
                  : e.inProgress ? 'text-accent font-medium'
                  : ''
                  : 'text-dim'}>{e.text}</li>
              ))}
            </ul>
          )
          : <pre class="m-0 p-1.5 text-xs max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono">{todos}</pre>) : null}
      </div>
    </div>
  );
};
