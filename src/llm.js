// Thin OpenAI-compatible chat client (replaces tk.ai.Client).
// base_url is joined as `${baseUrl}/v1/...`. Auth via optional Bearer key.
//
// Deliberately uses node:http directly, NOT global fetch: undici (the engine
// behind fetch) bakes in a 300s headers/body timeout that cannot be overridden
// via fetch's init options (they are silently dropped) and that kills slow,
// non-streaming completions with an opaque "fetch failed". Here only our own
// timeoutMs (-> LlmError 'timeout') or a user stop (-> 'aborted') can end a
// request, and real socket errors report their actual message/code.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export class LlmError extends Error {
  constructor(kind, message) {
    super(message ?? kind);
    this.kind = kind; // 'aborted' | 'timeout' | 'unavailable' | 'http'
  }
}

export const createLlm = (config) => {
  const doRequest = config.baseUrl.startsWith('https://') ? httpsRequest : httpRequest;

  const target = (path) => {
    const url = new URL(config.baseUrl + path);
    return {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
    };
  };

  const headers = () => {
    const h = { 'content-type': 'application/json' };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    return h;
  };

  // One JSON request. Resolves with the parsed body; rejects with LlmError only.
  const request = (method, path, body, timeoutMs, signal) =>
    new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      const onAbort = () => ctrl.abort('stop');
      signal?.addEventListener('abort', onAbort, { once: true });
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      const fail = (err) => finish(reject, err);

      // Classify a failure: our own timeout/stop first, then the raw error.
      const liveError = (err) => {
        if (ctrl.signal.reason === 'timeout')
          return new LlmError('timeout', `LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
        if (ctrl.signal.reason === 'stop') return new LlmError('aborted');
        return new LlmError('unavailable', err?.code ? `${err.message} (${err.code})` : err?.message ?? String(err));
      };

      if (signal?.aborted) return fail(new LlmError('aborted'));

      const req = doRequest({ ...target(path), method, headers: headers() }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            fail(new LlmError('http', `LLM responded ${res.statusCode}: ${text.slice(0, 500)}`));
          } else {
            try {
              finish(resolve, JSON.parse(text));
            } catch (err) {
              fail(new LlmError('http', `LLM returned invalid JSON: ${err.message}`));
            }
          }
        });
        res.on('error', (err) => fail(liveError(err)));
      });
      ctrl.signal.addEventListener('abort', () => req.destroy(), { once: true });
      req.on('error', (err) => fail(liveError(err)));
      req.on('close', () => {
        if (ctrl.signal.aborted) fail(liveError(new Error('aborted')));
        else fail(new LlmError('unavailable', 'connection to LLM server closed'));
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  // One chat completion. Returns { message, usage }.
  // `signal` is the session's stop signal; aborting it raises LlmError('aborted')
  // (a clean stop, not an error). Timeouts/network/HTTP errors raise LlmError.
  const chat = async ({ model, messages, tools, maxCompletionTokens, timeoutMs, signal }) => {
    const body = { model, messages, max_completion_tokens: maxCompletionTokens };
    if (tools?.length) body.tools = tools;
    const data = await request('POST', '/v1/chat/completions', body, timeoutMs, signal);
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('http', 'LLM returned no choices');
    return { message: choice.message, usage: data.usage ?? {} };
  };

  const listModels = async (timeoutMs = 10000) => {
    const data = await request('GET', '/v1/models', undefined, timeoutMs);
    return data.data ?? [];
  };

  return { chat, listModels };
};
