/**
 * Errors a Keystone client can tell apart without reading the message.
 *
 * §7.4. The server answers with `{ error, code, requestId }`; the classes below
 * map a status to the decision a caller actually has to make — retry, re-authenticate,
 * ask for permission, fix the request, or give up — so a caller never has to match
 * on prose and never retries a failure that cannot succeed.
 */

export interface KeystoneErrorOptions {
  /** HTTP status, absent for transport failures. */
  status?: number;
  /** Stable Keystone error code (`RATE_LIMITED`, `VALIDATION_ERROR`, …). */
  code?: string;
  /** The server's request id, for support and log correlation. */
  requestId?: string;
  /** Validation details, when the server supplied them. */
  details?: unknown;
  /** The decoded response body, when there was one. */
  body?: unknown;
  /** Seconds to wait, taken from `Retry-After`. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class KeystoneError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly body?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: KeystoneErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
    this.body = options.body;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Whether repeating the request could produce a different answer. */
  get retryable(): boolean {
    return this.code === "RATE_LIMITED";
  }
}

/** 401 — the credential is missing, expired or invalid. */
export class AuthenticationError extends KeystoneError {}

/** 403 — the credential is valid but not allowed to do this. */
export class AuthorizationError extends KeystoneError {}

/** 400/422 — the request body, query or parameters are invalid. */
export class ValidationError extends KeystoneError {}

/** 404 — the resource does not exist or is outside the caller's tenant. */
export class NotFoundError extends KeystoneError {}

/** 409 — the request conflicts with current state. */
export class ConflictError extends KeystoneError {}

/** 429 — a rate limit was hit. Retryable after `retryAfterSeconds`. */
export class RateLimitError extends KeystoneError {
  override get retryable(): boolean {
    return true;
  }
}

/** 5xx — the server failed; retryable, but the operation may or may not have applied. */
export class ServerError extends KeystoneError {
  override get retryable(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** No HTTP response: DNS, TLS, connection reset, timeout. Always retryable. */
export class NetworkError extends KeystoneError {
  override get retryable(): boolean {
    return true;
  }
}

/** Build the class that fits a response, from its status and decoded body. */
export function errorForResponse(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null }
): KeystoneError {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const message =
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    (typeof record.detail === "string" && record.detail) ||
    `Keystone request failed with status ${status}`;

  const code =
    (typeof record.code === "string" && record.code) ||
    (typeof record.error === "string" && record.error) ||
    undefined;

  const requestId =
    (typeof record.requestId === "string" && record.requestId) ||
    headers.get("request-id") ||
    headers.get("x-request-id") ||
    undefined;

  const retryAfter = parseRetryAfter(headers.get("retry-after"));

  const options: KeystoneErrorOptions = {
    status,
    code,
    requestId,
    details: record.details,
    body,
    retryAfterSeconds: retryAfter,
  };

  if (status === 401) return new AuthenticationError(message, options);
  if (status === 403) return new AuthorizationError(message, options);
  if (status === 404) return new NotFoundError(message, options);
  if (status === 409) return new ConflictError(message, options);
  if (status === 429) return new RateLimitError(message, options);
  if (status >= 500) return new ServerError(message, options);
  if (status >= 400) return new ValidationError(message, options);
  return new KeystoneError(message, options);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}
