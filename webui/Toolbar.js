import { html, BTN } from './ui.js';

const badgeColor = { running: 'text-accent', idle: 'text-ok', error: 'text-err', stopped: 'text-dim' };

// Session toolbar: status badge + live summary on the left; the action groups
// (agent / history-editing / destructive) on the right, split by thin rules.
export const Toolbar = ({ view, onAction, onDel }) => html`
  <div class="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
    <span class="py-0.5 px-2 rounded-full text-xs border border-line ${badgeColor[view.status] ?? 'text-ok'}">${view.status ?? 'idle'}</span>
    <span class="text-dim text-xs break-all">${view.cwd ?? ''} · ${view.model ?? ''} · ${view.tokens ?? 0} tokens</span>
    <span class="flex-1"></span>
    <button title="strip trailing assistant/tool messages and re-run" class=${BTN} onclick=${() => onAction('retry')}>retry</button>
    <button title="run the /init skill on this project" class=${BTN} onclick=${() => onAction('init')}>init</button>
    <span class="w-px h-4 bg-line"></span>
    <button title="summarize and replace the history" class=${BTN} onclick=${() => onAction('compact')}>compact</button>
    <button title="pop the last message" class=${BTN} onclick=${() => onAction('undo')}>undo</button>
    <button title="remove all tool results from history" class=${BTN} onclick=${() => onAction('clear-tools')}>clear-tools</button>
    <button title="reset history to the system prompt" class=${BTN} onclick=${() => onAction('clear')}>clear</button>
    <span class="w-px h-4 bg-line"></span>
    <button title="delete this session" class=${BTN} onclick=${onDel}>delete</button>
  </div>`;
