import { LlmError } from './llm.js';

// The agent loop (port of workerInner). Never throws: it converts all outcomes
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
      if (!toolCalls) break;
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
