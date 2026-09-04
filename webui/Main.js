import { html } from './ui.js';
import { Toolbar } from './Toolbar.js';
import { Todos } from './Todos.js';
import { Messages } from './Message.js';
import { InputBar } from './InputBar.js';

const ErrorBox = ({ message }) => message
  ? html`<div class="mx-3 mt-2 p-2 px-2.5 border border-err text-err rounded whitespace-pre-wrap">${message}</div>`
  : null;

// Right-hand pane: the toolbar, error/todos, the transcript, and the composer —
// or a placeholder when no session is selected.
export const Main = (p) => !p.view
  ? html`
      <main class="flex-1 flex flex-col min-w-0">
        <div class="flex-1 flex items-center justify-center text-dim">select or create a session</div>
      </main>`
  : html`
      <main class="flex-1 flex flex-col min-w-0">
        <${Toolbar} view=${p.view} onAction=${p.onAction} onDel=${p.onDel} />
        <${ErrorBox} message=${p.flash ?? p.view.last_error} />
        <${Todos} todos=${p.view.todos} />
        <${Messages} messages=${p.view.messages} />
        <${InputBar} running=${p.view.status === 'running'} current=${p.view.id} value=${p.input}
                      onInput=${(e) => p.setInput(e.target.value)} onKey=${p.onKey} onSend=${p.onSend} onStop=${p.onStop} />
      </main>`;
