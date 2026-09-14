import { extractTodos } from './util';
import { Todos } from './Todos';
import { Messages } from './Message';
import { InputBar } from './InputBar';

const ErrorBox = ({ message }) => message
  ? <div class="mx-3 mt-2 p-2 px-2.5 border border-err text-err rounded whitespace-pre-wrap">{message}</div>
  : null;

// Right-hand pane: error banner, todos, the transcript, and the composer — or
// a placeholder when no session is selected. (The session status + actions now
// live in the unified top bar, see Header.tsx.) `relative` on <main> anchors
// the floating Todos overlay (top-right, see Todos.tsx).
export const Main = (p) => !p.view
  ? (
    <main class="relative flex-1 flex flex-col min-w-0 bg-content">
      <div class="flex-1 flex items-center justify-center text-dim">select or create a session</div>
    </main>
  )
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
