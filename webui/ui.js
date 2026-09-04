import { h } from 'preact';
import htm from 'htm';

// One shared htm→h binding for every component module (no build step, so there
// is no bundler to inject it — a single module owns it and the rest import it).
export const html = htm.bind(h);

// Shared Tailwind class tokens. Every utility references var(--color-*), so
// flipping <html data-theme> recolours them automatically.
export const BTN = 'text-ink bg-panel border border-line rounded py-[3px] px-2.5 text-xs cursor-pointer hover:border-accent';
export const PRE = 'm-0 py-2 px-2.5 whitespace-pre-wrap break-words';
