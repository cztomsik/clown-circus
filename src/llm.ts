// Thin OpenAI-compatible chat client.
// base_url is joined as `${baseUrl}/v1/...`. Auth via optional Bearer key.
//
// Node's global fetch (undici) bakes in a 300s headers/body timeout that
// cannot be overridden via fetch init options; it would kill slow,
// non-streaming completions with an opaque "fetch failed". We patch the
// built-in global dispatcher instead of driving node:http by hand: only our
// own timeoutMs (-> LlmError 'timeout') or a user stop (-> 'aborted') can end
// a request.

import { config } from './config.ts';

// Disables undici's 300s headers/body timeouts on the builtin global
// dispatcher, so only our own AbortController (timeout + stop) can end a
// request. The dispatcher is lazily created by the first fetch — `data:`
// URLs materialize it synchronously without touching the network.
let patchedDispatcher = false;
const patchGlobalDispatcher = () => {
  if (patchedDispatcher) return;
  patchedDispatcher = true;
  fetch('data:text/plain,').catch(() => {});
  const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
  const kOptions = d && Object.getOwnPropertySymbols(d).find(
    (s) => d[s] && typeof d[s] === 'object' && 'maxOrigins' in d[s],
  );
  if (!kOptions) {
    console.warn('[llm] could not find the fetch dispatcher options; undici defaults (300s headers/body timeout) remain active');
    return;
  }
  d[kOptions].headersTimeout = 0; // 0 = disabled; applied to clients created afterwards
  d[kOptions].bodyTimeout = 0;
};

export class LlmError extends Error {
  kind: string; // 'aborted' | 'timeout' | 'unavailable' | 'http'
  constructor(kind: string, message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

const createLlm = () => {
  patchGlobalDispatcher();

  const headers = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    return h;
  };

  // One chat completion. Returns { message, usage }.
  // `signal` is the session's stop signal; aborting it raises LlmError('aborted')
  // (a clean stop, not an error). Timeouts/network/HTTP errors raise LlmError.
  const chat = async ({ model, messages, tools, maxCompletionTokens, timeoutMs, signal }) => {
    if (signal?.aborted) throw new LlmError('aborted');
    const ctrl = new AbortController();
    const onStop = () => ctrl.abort('stop');
    signal?.addEventListener('abort', onStop);
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);

    const body: Record<string, any> = { model, messages, max_completion_tokens: maxCompletionTokens };
    if (tools?.length) body.tools = tools;

    let res;
    try {
      res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) throw new LlmError(ctrl.signal.reason === 'timeout' ? 'timeout' : 'aborted');
      // undici wraps socket errors in a TypeError; surface the real one.
      throw new LlmError('unavailable', err.cause?.message ?? err.message);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
    }

    if (!res.ok) throw new LlmError('http', `LLM responded ${res.status}: ${(await res.text()).slice(0, 500)}`);

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new LlmError('http', `LLM returned invalid JSON: ${err.message}`);
    }
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('http', 'LLM returned no choices');
    const usage = data.usage ?? {};
    console.log(`[llm] completion model=${model} total_tokens=${usage.total_tokens ?? 'n/a'}`);
    return { message: choice.message, usage };
  };

  const listModels = async (timeoutMs = 10000) => {
    const ctrl = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${config.baseUrl}/v1/models`, { headers: headers(), signal: ctrl });
      if (!res.ok) throw new LlmError('http', `LLM responded ${res.status}`);
      const data = await res.json();
      return data.data ?? [];
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('unavailable', err.cause?.message ?? err.message);
    }
  };

  return { chat, listModels };
};

// One client for the whole process — created at import time (this is what
// patches the global fetch dispatcher).
export const llm = createLlm();
