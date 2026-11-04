// HTTP error type + mapping of thrown errors to the §7.7 table.

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Map any thrown error to a HttpError (idempotent for HttpError, LLM-aware).
export const mapError = (err) => {
  if (err instanceof HttpError) return err;
  if (err?.kind === 'timeout') return new HttpError(504, 'llm_timeout', err.message);
  if (err?.kind === 'unavailable' || err?.kind === 'http') return new HttpError(502, 'llm_unavailable', err.message);
  return new HttpError(500, 'internal', err?.message ?? String(err));
};
