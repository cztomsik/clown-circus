import { html } from './ui.js';

// Live todo list from the snapshot.
export const Todos = ({ todos }) => todos?.length
  ? html`
      <div class="mx-3 mt-2 p-2 px-2.5 border border-line rounded text-xs">
        <ul class="list-none m-0 p-0">
          ${todos.map((t, i) => html`
            <li key=${i} class=${t.status === 'completed' ? 'text-dim line-through' : t.status === 'in_progress' ? 'text-accent' : ''}>[${t.status}] ${t.name}</li>`)}
        </ul>
      </div>`
  : null;
