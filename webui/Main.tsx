import { extractTodos, baseName, timeAgo } from './util';
import { Todos } from './Todos';
import { Messages } from './Message';
import { InputBar } from './InputBar';
import { StatusDot, Kbd } from './primitives';
import { AppIcon } from './icons';

const ErrorBox = ({ message }) => message
  ? <div class="mx-3 mt-2 p-2 px-2.5 border border-err text-err rounded whitespace-pre-wrap">{message}</div>
  : null;

// The pane shown while no session is open: the brand mark, the /config
// summary, the three most recent sessions (quick-open), and a usage hint.
const Empty = ({ cfg, sessions, onSelect }) => {
  const recent = sessions
    .filter((s) => !s.archived)
    .sort((a, b) => (Date.parse(b.last_activity) || 0) - (Date.parse(a.last_activity) || 0))
    .slice(0, 3);
  return (
    <main class="relative flex-1 flex flex-col min-w-0 bg-content">
      <div class="flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center">
        <div class="flex items-center gap-2.5">
          <AppIcon />
          <span class="text-[1.05rem] font-semibold tracking-[-.01em] text-ink">Clown-Circus</span>
        </div>
        {cfg && cfg !== 'loading…'
          ? <div class="text-[.72rem] font-mono text-text3 truncate max-w-full">{cfg}</div>
          : null}
        {recent.length ? (
          <div class="w-full max-w-sm flex flex-col items-stretch">
            <div class="text-[.66rem] font-bold tracking-[.04em] uppercase text-text3 mb-1.5 text-left">recent</div>
            {recent.map((s) => (
              <div key={s.id} class="px-3 py-2 rounded-lg hover:bg-material2 cursor-pointer flex items-center gap-2.5 transition-colors text-left"
                   onClick={() => onSelect(s.id)}>
                <StatusDot status={s.status} />
                <div class="min-w-0">
                  <div class="text-[.84rem] text-ink truncate">{s.title ?? baseName(s.cwd)}</div>
                  <div class="text-[.7rem] text-text3 truncate">{s.status} · {timeAgo(s.last_activity)} · {s.message_count} msgs</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <p class="text-xs text-text3 leading-relaxed">
          Select a session, or create one from the sidebar.<br />
          In the composer, <Kbd>/</Kbd> opens the command list.
        </p>
      </div>
    </main>
  );
};

// Right-hand pane: error banner, todos, the transcript, and the composer — or
// a placeholder when no session is selected. (The session status + actions now
// live in the unified top bar, see Header.tsx.) `relative` on <main> anchors
// the floating Todos overlay (top-right, see Todos.tsx).
export const Main = (p) => !p.view
  ? <Empty cfg={p.cfg} sessions={p.sessions} onSelect={p.onSelect} />
  : (
    <main class="relative flex-1 flex flex-col min-w-0 bg-content">
      <ErrorBox message={p.flash ?? p.view.last_error} />
      <Todos todos={extractTodos(p.view.messages)} />
      {/* keyed by session: remount resets the scroll "pinned" state so a
           switch always lands at the bottom of the new transcript */}
      <Messages key={p.view.id} messages={p.view.messages} running={p.view.status === 'running'} cwd={p.view.cwd} />
      <InputBar running={p.view.status === 'running'} current={p.view.id} value={p.input}
                onInput={(e) => p.setInput(e.target.value)} onKey={p.onKey} onSend={p.onSend} onStop={p.onStop}
                attachments={p.attachments} onAddFiles={p.onAddFiles} onRemoveAttachment={p.onRemoveAttachment}
                visionCapable={p.visionCapable} />
    </main>
  );
