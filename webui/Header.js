import { html, BTN } from './ui.js';

// Top bar: sidebar toggle, brand, live config summary, theme toggle.
export const Header = ({ cfg, theme, sideOpen, onSideToggle, onThemeToggle }) => html`
  <header class="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line">
    <button title="toggle sidebar" aria-label="toggle sidebar" aria-pressed=${sideOpen}
            class=${`${BTN} flex-none ${sideOpen ? 'border-accent' : ''}`}
            onclick=${onSideToggle}>☰</button>
    <h1 class="text-[15px] m-0 text-accent flex-none">clown-circus</h1>
    <div class="text-dim text-xs min-w-0 flex-1 truncate">${cfg}</div>
    <button title="toggle theme" class=${`${BTN} flex-none`} onclick=${onThemeToggle}>${theme === 'dark' ? '→ light' : '→ dark'}</button>
  </header>`;
