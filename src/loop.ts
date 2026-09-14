import { LlmError } from './llm.ts';

// The agent loop. Never throws: it converts all outcomes
// into a terminal status + events. Runs to completion for a single `run`.
// Each appended message (next/accept) is persisted + emitted as a granular
// `message` event the moment it exists, so the DB and the stream are current
// before the loop advances to the next turn.
export const runLoop = async (session) => {
  let status = 'idle';
  let error = null;

  try {
    session.begin();
    for (;;) {
      if (session.signal?.aborted) {
        status = 'stopped';
        break;
      }
      const toolCalls = await session.next(); // one LLM turn; appends the assistant msg
      if (!toolCalls) break; // final turn: no tool batch
      if (session.signal?.aborted) {
        status = 'stopped';
        break;
      }
      for (const tc of toolCalls) {
        if (session.signal?.aborted) {
          status = 'stopped';
          break;
        }
        await session.accept(tc); // execute tool, append tool-result msg
      }
    }
  } catch (err) {
    if (err instanceof LlmError && err.kind === 'aborted') {
      status = 'stopped';
    } else {
      status = 'error';
      error = err?.message ?? String(err);
      session.emit('error', { message: error });
    }
  }

  // A stop can land mid-tool-batch: the in-flight tool's result was appended
  // but the rest of the batch is unanswered, leaving a dangling tool_call that
  // is invalid to send back. Roll the tail to a valid boundary and resync the
  // client (a granular `message` event already went out for the partial result).
  // Finalizing (settle/end -> persist, emit) can hit a DB error; the run is
  // fire-and-forget, so a throw here would be an unhandled rejection that
  // crashes the process. end() set running=false before persist, so the session
  // stays reusable even if the final write fails.
  try {
    if (status === 'stopped' && session.settle()) session.emitHistory();
    session.end(status, error);
    if (status !== 'error') session.emit('done', { total_tokens: session.totalTokens });
  } catch (err) {
    console.error(`[loop] session=${session.id} failed to finalize run:`, err);
  }
};
