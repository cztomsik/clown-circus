import { useRef, useLayoutEffect, useState, useEffect } from 'preact/hooks';
import { IconBtn, Kbd, MENU_ITEM } from './primitives';
import { IcSend, IcStop, IcAttach } from './icons';
import { SLASH_COMMANDS } from './util';

// The single circular action slot: the accent send when idle, morphing in place
// to a red stop while a run is in flight (so the bar never reflows).
const Action = ({ running, canSend, onSend, onStop }) => running
  ? (
    <button class="w-8 h-8 rounded-full grid place-items-center bg-err text-white cursor-pointer hover:brightness-105 transition"
            title="stop the running turn" aria-label="stop" onClick={onStop}>
      <IcStop />
    </button>
  )
  : (
    <button class="w-8 h-8 rounded-full grid place-items-center bg-accent text-white cursor-pointer hover:brightness-105 transition
                   disabled:bg-line disabled:text-dim disabled:cursor-default disabled:hover:brightness-100"
            title="send" aria-label="send" disabled={!canSend} onClick={onSend}>
      <IcSend />
    </button>
  );

// The composer: a rounded, field-tinted card that frames a growing textarea and
// a bottom action bar (attach · key hints · send/stop). It self-frames (no
// border-t) and centers to the transcript's max-w-3xl column. Drag-drop and
// paste land on the whole bar when the model accepts images.
export const InputBar = ({ running, current, value, onValue, onKey, onSend, onStop,
                           attachments = [], onAddFiles, onRemoveAttachment, visionCapable }) => {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const dragCounter = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  // Slash-command palette: the keyboard highlight (-1 = none) and the Escape
  // dismissal — both reset whenever the text changes.
  const [palIdx, setPalIdx] = useState(-1);
  const [palDismissed, setPalDismissed] = useState(false);
  useEffect(() => { setPalIdx(-1); setPalDismissed(false); }, [value]);

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

  // Slash-command palette: while a command name is being typed (a single
  // `/token`, no whitespace yet), every command extending the prefix is
  // listed above the field — Chrome never renders a native <datalist> on a
  // <textarea>, so the popup is ours (and can carry each command's hint). A
  // completed name hides the list; its one-line hint then takes the action
  // bar's slack space.
  const slashing = value != null && value.startsWith('/') && !/\s/.test(value);
  const typed = slashing ? value.slice(1).toLowerCase() : '';
  const matches = slashing
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(typed))
    : [];
  const showPal = matches.length > 0 && !palDismissed;
  const hint = slashing ? SLASH_COMMANDS.find((c) => c.name === typed)?.hint ?? null : null;
  const pick = (name) => onValue(`/${name} `);
  // The palette's keys (↑/↓ highlight, Tab/Enter pick, Esc dismiss) are
  // consumed here; everything else falls through to the app's handler.
  const onKeyDown = (e) => {
    if (showPal) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPalIdx((i) => e.key === 'ArrowDown' ? (i + 1) % matches.length
                                              : (i <= 0 ? matches.length - 1 : i - 1));
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && palIdx >= 0) {
        e.preventDefault(); pick(matches[palIdx].name); return;
      }
      if (e.key === 'Escape') { setPalDismissed(true); return; }
    }
    onKey(e);
  };

  return (
    <div class="px-3 py-2.5"
         {...(visionCapable ? { onDragEnter, onDragLeave, onDragOver, onDrop } : {})}>
      {/* The field, centered — the palette (open above it) anchors here. */}
      <div class="relative mx-auto max-w-3xl">
        {/* Slash-command palette: opens upward over the transcript while a
            command name is being typed (hover highlights, click/Tab/Enter
            picks — the trailing space leaves room for an arg). */}
        {showPal ? (
          <div class="menu-card absolute bottom-full inset-x-0 z-40 mb-2 rounded-xl border border-line p-1 shadow-2xl">
            {matches.map((c, i) => (
              <button key={c.name} type="button" title={c.hint}
                      class={`${MENU_ITEM} text-ink ${i === palIdx ? 'bg-material2' : 'hover:bg-material2'}`}
                      onMouseEnter={() => setPalIdx(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(c.name)}>
                <span class="flex-none">/{c.name}</span>
                <span class="truncate text-[.76rem] text-text3">{c.hint}</span>
              </button>
            ))}
          </div>
        ) : null}
        {/* Field card: frames the textarea + action bar, lights up on focus. */}
        <div class={`border rounded-[15px] bg-field overflow-hidden transition
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
          <textarea ref={ref} value={value}
                    onInput={(e: any) => onValue(e.target.value)} onKeyDown={onKeyDown}
                    onPaste={visionCapable ? onPaste : null}
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
                <IcAttach />
              </IconBtn>
            </>) : null}
            {hint
              ? <span class="flex-1 text-right text-[11px] text-text3 truncate" title={hint}>{hint}</span>
              : <span class="flex-1"></span>}
            <span class="hidden sm:flex items-center gap-1.5 text-[11px] text-dim select-none">
              <Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> newline
            </span>
            <Action running={running} canSend={canSend} onSend={onSend} onStop={onStop} />
          </div>
        </div>
      </div>
    </div>
  );
};
