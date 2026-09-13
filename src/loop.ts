import { LlmError } from './llm.ts';

// The agent loop. Never throws: it converts all outcomes
// into a terminal status + events. Runs to completion for a single `run`.
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
      const toolCalls = await session.next(); // one LLM turn; appends assistant msg
      // Persist + emit the assistant turn (incl. its tool calls) BEFORE executing
      // them: the intent must be durable and visible to the client first.
      session.emit('snapshot', session.snapshot());
      session.persist();
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
      session.emit('snapshot', session.snapshot());
      session.persist();
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

  session.end(status, error);
  if (status !== 'error') session.emit('done', { total_tokens: session.totalTokens });
};
