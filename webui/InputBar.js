import { useRef, useLayoutEffect, useState } from 'preact/hooks';
import { html } from './ui.js';

const SEND_BTN = 'text-ink bg-panel border border-line rounded py-1.5 px-2 cursor-pointer hover:border-accent disabled:opacity-40 disabled:cursor-default disabled:hover:border-line';

export const InputBar = ({ running, current, value, onInput, onKey, onSend, onStop,
                           attachments = [], onAddFiles, onRemoveAttachment, visionCapable }) => {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const dragCounter = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // Autofocus the composer when it mounts, when the active session changes, and
  // when its value is set programmatically (e.g. undo restoring a message) so
  // focus returns to the box from the clicked toolbar button. A no-op while the
  // box is already focused during normal typing.
  useLayoutEffect(() => { ref.current?.focus(); }, [current, value]);

  // Pull file objects out of a paste or drop event. items → getAsFile() is the
  // reliable path on iOS Safari (where clipboardData.files can be empty for a
  // pasted image); fall back to the files collection for everything else.
  const extractFiles = (dt) => {
    const fromItems = Array.from(dt?.items ?? [])
      .map((it) => (it.kind === 'file' ? it.getAsFile() : null))
      .filter(Boolean);
    return fromItems.length ? fromItems : Array.from(dt?.files ?? []);
  };

  // Paste: pull image files from clipboardData.
  const onPaste = (e) => {
    const files = extractFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); onAddFiles(files); }
  };

  // Drag-drop: counter-based so nested dragenter/leave don't flicker.
  const onDragEnter = (e) => { e.preventDefault(); dragCounter.current++; setDragOver(true); };
  const onDragLeave = (e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false); } };
  const onDragOver = (e) => e.preventDefault();
  const onDrop = (e) => { e.preventDefault(); dragCounter.current = 0; setDragOver(false); const files = extractFiles(e.dataTransfer); if (files.length) onAddFiles(files); };

  const onFileChange = (e) => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ''; };

  return html`
    <div class="flex flex-col gap-1.5 border-t border-line px-3 py-2.5"
         ${visionCapable ? html`ondragenter=${onDragEnter} ondragleave=${onDragLeave} ondragover=${onDragOver} ondrop=${onDrop}` : null}>
      <!-- Thumbnail strip (only when there are attachments) -->
      ${attachments.length ? html`
        <div class="flex flex-wrap gap-1.5">
          ${attachments.map((a) => html`
            <div key=${a.id} class="relative group w-16 h-16 border border-line rounded overflow-hidden">
              <img src=${a.dataUrl} alt=${a.name} class="w-full h-full object-cover" />
              <!-- Hover-gated only on desktop: touch devices never fire :hover,
                   so below md the × is always visible. -->
              <button class="absolute top-0.5 right-0.5 w-6 h-6 flex items-center justify-center bg-black/60 text-white text-xs rounded-full transition-opacity cursor-pointer md:opacity-0 md:group-hover:opacity-100"
                      onclick=${() => onRemoveAttachment(a.id)}>×</button>
            </div>`)}
        </div>` : null}
      <!-- Composer row: textarea + buttons -->
      <div class="flex gap-2">
        <!-- field-sizing:content grows the box with its text; capped at ~1/3 of
             the viewport height, after which it scrolls internally. While running
             the box looks disabled (faded) but stays enabled so you keep focus and
             can type ahead; Enter is a no-op until the run ends. -->
        <textarea ref=${ref} value=${value} oninput=${onInput} onkeydown=${onKey} onpaste=${visionCapable ? onPaste : null}
                  placeholder="message (Enter to send, / for commands)"
                  class=${`flex-1 [field-sizing:content] min-h-[5rem] max-h-[33dvh] overflow-y-auto text-ink bg-panel border border-line rounded py-1.5 px-2 focus:outline-none focus:border-accent transition-opacity ${running ? 'opacity-50' : ''} ${dragOver ? 'border-accent bg-accent/5' : ''}`}></textarea>
        <div class="flex flex-col gap-1.5">
          ${visionCapable ? html`
            <!-- sr-only (not display:none): iOS Safari won't open the picker
                 from a programmatic .click() on a display:none file input. -->
            <input ref=${fileRef} type="file" accept="image/*" multiple class="sr-only" onchange=${onFileChange} />
            <button disabled=${running} class=${SEND_BTN + ' text-sm'}
                    title="attach image"
                    onclick=${() => fileRef.current?.click()}>📎</button>` : null}
          <button disabled=${running} class=${SEND_BTN} onclick=${onSend}>send</button>
          ${running ? html`<button class=${SEND_BTN} onclick=${onStop}>stop</button>` : null}
        </div>
      </div>
    </div>`;
};
