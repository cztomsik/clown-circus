import { useState } from 'preact/hooks';
import { html } from './ui.js';

// Collapsible floating todo panel. Anchored top-right inside the main pane
// (Main.js makes <main> relative), so it overlays the transcript instead of
// taking flow space. The session's todos are a user-visible markdown string,
// shown as-is (best-effort checkbox parsing is a planned follow-up); the
// header row toggles the block and the chevron rotates when collapsed.
export const Todos = ({ todos }) => {
  const [open, setOpen] = useState(true);
  if (!todos?.trim()) return null;
  return html`
    <div class="absolute top-2 right-2 z-20 w-72 max-w-[85%]">
      <div class="border border-line rounded shadow-lg bg-panel/95 backdrop-blur-sm overflow-hidden">
        <button class="w-full flex items-center justify-between px-2.5 py-1.5 text-xs cursor-pointer hover:bg-line/40"
                title=${open ? 'collapse todos' : 'expand todos'}
                onclick=${() => setOpen((o) => !o)}>
          <span class="font-medium">Todos</span>
          <span class=${`inline-block text-dim transition-transform ${open ? '' : '-rotate-90'}`}>▾</span>
        </button>
        ${open ? html`
          <pre class="m-0 p-1.5 text-xs max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono">${todos}</pre>` : null}
      </div>
    </div>`;
};
