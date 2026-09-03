// Thin OpenAI-compatible chat client (replaces tk.ai.Client).
// base_url is joined as `${baseUrl}/v1/...`. Auth via optional Bearer key.

export class LlmError extends Error {
  constructor(kind, message) {
    super(message ?? kind);
    this.kind = kind; // 'aborted' | 'timeout' | 'unavailable' | 'http'
  }
}

export const createLlm = (config) => {
  const headers = () => {
    const h = { 'content-type': 'application/json' };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    return h;
  };

  // One chat completion. Returns { message, usage }.
  // `signal` is the session's stop signal; aborting it raises LlmError('aborted')
  // (a clean stop, not an error). Timeouts/network/HTTP errors raise LlmError.
  const chat = async ({ model, messages, tools, maxCompletionTokens, timeoutMs, signal }) => {
    const ctrl = new AbortController();
    const onStop = () => ctrl.abort('stop');
    signal?.addEventListener('abort', onStop);
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);

    const body = { model, messages, max_completion_tokens: maxCompletionTokens };
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
      throw new LlmError('unavailable', err.message);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
    }

    if (!res.ok) throw new LlmError('http', `LLM responded ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('http', 'LLM returned no choices');
    return { message: choice.message, usage: data.usage ?? {} };
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
      throw new LlmError('unavailable', err.message);
    }
  };

  return { chat, listModels };
};
