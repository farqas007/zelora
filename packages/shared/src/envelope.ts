export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;

  /**
   * Per-field validation messages, keyed by field name
   * (e.g. `{ email: ["Email is required"] }`). Additive and optional, so
   * existing consumers of `code`/`message`/`details` are unaffected.
   */
  fields?: Record<string, string[]>;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;