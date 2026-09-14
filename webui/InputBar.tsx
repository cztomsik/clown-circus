import { useRef, useLayoutEffect, useState } from 'preact/hooks';
import { IconBtn } from './primitives';

// A bottom-bar key hint (the composer's ↵ / ⇧↵ affordances).
const Kbd = ({ children }) => (
  <kbd class="text-[11px] leading-none px-1 py-[1px] rounded border border-line bg-line/40 text-dim">{children}</kbd>
);

// The single circular action slot: the accent send when idle, morphing in place
// to a red stop while a run is in flight (so the bar never reflows).
const Action = ({ running, canSend, onSend, onStop }) => running
  ? (
    <button class="w-8 h-8 rounded-full grid place-items-center bg-err text-white cursor-pointer hover:brightness-105 transition"
            title="stop the running turn" aria-label="stop" onClick={onStop}>
      <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
    </button>
  )
  : (
    <button class="w-8 h-8 rounded-full grid place-items-center bg-accent text-white cursor-pointer hover:brightness-105 transition
                   disabled:bg-line disabled:text-dim disabled:cursor-default disabled:hover:brightness-100"
            title="send" aria-label="send" disabled={!canSend} onClick={onSend}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
    </button>
  );

// The composer: a rounded, field-tinted card that frames a growing textarea and
// a bottom action bar (attach · key hints · send/stop). It self-frames (no
// border-t) and centers to the transcript's max-w-3xl column. Drag-drop and
// paste land on the whole bar when the model accepts images.
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
  const extractFiles = (dt: any) => {
    const fromItems = Array.from(dt?.items ?? [])
      .map((it: any) => (it.kind === 'file' ? it.getAsFile() : null))
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

  const canSend = (value?.trim().length > 0 || attachments.length > 0) && !running;

  return (
    <div class="px-3 py-2.5"
         {...(visionCapable ? { onDragEnter, onDragLeave, onDragOver, onDrop } : {})}>
      {/* Field card: frames the textarea + action bar, lights up on focus. */}
      <div class={`mx-auto max-w-3xl border rounded-[15px] bg-field overflow-hidden transition
                  focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/20
                  ${dragOver ? 'border-accent' : 'border-line'}`}>
        {/* Image attachments sit inside the box, above the text (they belong to
            the message being composed). */}
        {attachments.length ? (
          <div class="flex flex-wrap gap-1.5 p-2.5 pb-0">
            {attachments.map((a) => (
              <div key={a.id} class="relative group w-16 h-16 border border-line rounded overflow-hidden">
                <img src={a.dataUrl} alt={a.name} class="w-full h-full object-cover" />
                {/* Hover-gated only on desktop: touch devices never fire :hover,
                    so below md the × is always visible. */}
                <button class="absolute top-0.5 right-0.5 w-6 h-6 flex items-center justify-center bg-black/60 text-white text-xs rounded-full cursor-pointer transition-opacity md:opacity-0 md:group-hover:opacity-100"
                        onClick={() => onRemoveAttachment(a.id)}>×</button>
              </div>
            ))}
          </div>
        ) : null}
        {/* The field: grows with its text (field-sizing:content), capped at ~1/3
             of the viewport, after which it scrolls internally. While running it
             looks disabled (faded) but stays focused so you can type ahead;
             Enter is a no-op until the run ends. */}
        <textarea ref={ref} value={value} onInput={onInput} onKeyDown={onKey} onPaste={visionCapable ? onPaste : null}
                  placeholder="Message…  ( / for commands )"
                  class={`w-full block [field-sizing:content] min-h-[52px] max-h-[33dvh] resize-none overflow-y-auto
                          bg-transparent text-ink py-3 px-3.5 leading-[1.5] placeholder:text-dim focus:outline-none
                          ${running ? 'opacity-50' : ''}`}></textarea>
        {/* Bottom action bar: attach (left) · key hints (centre-right) · the
             send/stop action (right). */}
        <div class="flex items-center gap-1.5 px-2 pt-1 pb-2">
          {visionCapable ? (<>
            {/* sr-only (not display:none): iOS Safari won't open the picker
                 from a programmatic .click() on a display:none file input. */}
            <input ref={fileRef} type="file" accept="image/*" multiple class="sr-only" onChange={onFileChange} />
            <IconBtn title="attach image" aria-label="attach image"
                     onClick={() => fileRef.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round" class="w-[17px] h-[17px]">
                <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
              </svg>
            </IconBtn>
          </>) : null}
          <span class="flex-1"></span>
          <span class="hidden sm:flex items-center gap-1.5 text-[11px] text-dim select-none">
            <Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> newline
          </span>
          <Action running={running} canSend={canSend} onSend={onSend} onStop={onStop} />
        </div>
      </div>
    </div>
  );
};
