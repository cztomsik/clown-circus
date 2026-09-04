import { useRef, useLayoutEffect } from 'preact/hooks';
import { html } from './ui.js';

const SEND_BTN = 'text-ink bg-panel border border-line rounded py-1.5 px-2 cursor-pointer hover:border-accent disabled:opacity-40 disabled:cursor-default disabled:hover:border-line';

export const InputBar = ({ running, current, value, onInput, onKey, onSend, onStop }) => {
  const ref = useRef(null);
  // Autofocus the composer when it mounts, when the active session changes, and
  // when its value is set programmatically (e.g. undo restoring a message) so
  // focus returns to the box from the clicked toolbar button. A no-op while the
  // box is already focused during normal typing.
  useLayoutEffect(() => { ref.current?.focus(); }, [current, value]);
  return html`
    <div class="flex gap-2 px-3 py-2.5 border-t border-line">
      <!-- field-sizing:content grows the box with its text; capped at ~1/3 of
           the viewport height, after which it scrolls internally. While running
           the box looks disabled (faded) but stays enabled so you keep focus and
           can type ahead; Enter is a no-op until the run ends. -->
      <textarea ref=${ref} value=${value} oninput=${onInput} onkeydown=${onKey}
                placeholder="message (Enter to send, / for commands)"
                class=${`flex-1 [field-sizing:content] min-h-[5rem] max-h-[33dvh] overflow-y-auto text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent transition-opacity ${running ? 'opacity-50' : ''}`}></textarea>
      <div class="flex flex-col gap-1.5">
        <button disabled=${running} class=${SEND_BTN} onclick=${onSend}>send</button>
        ${running ? html`<button class=${SEND_BTN} onclick=${onStop}>stop</button>` : null}
      </div>
    </div>`;
};
