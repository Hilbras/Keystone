import { NetworkError, errorForResponse } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type QueryValue = string | number | boolean | undefined | null;

/** The slice of `fetch` this client uses, so a caller can supply its own. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  credentials?: "include" | "omit" | "same-origin";
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string | (() => string | Promise<string>);
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  credentials?: "include" | "omit" | "same-origin";
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /**
   * Sent as `Idempotency-Key`. Pass-through: Keystone does not yet deduplicate
   * on it, so it is useful for a proxy or gateway that does, and for a service
   * that will add it. It does not by itself make a retry safe here.
   */
  idempotencyKey?: string;
  /**
   * Override the default retry policy. Safe methods retry by default; a write
   * retries only when the caller says so, because only the caller knows whether
   * repeating it is harmless.
   */
  retry?: boolean;
  signal?: AbortSignal;
}

const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly accessToken?: HttpClientOptions["accessToken"];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly credentials?: HttpClientOptions["credentials"];

  constructor(options: HttpClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    // Fail here rather than on the first request: a base URL missing its scheme
    // is a configuration error, and the message a URL parse gives for it is not.
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TypeError(`baseUrl must be http or https, got ${parsed.protocol}`);
    }

    this.baseUrl = base;
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.fetchImpl =
      options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined) ?? (() => {
        throw new NetworkError("No fetch implementation available; pass options.fetch", {
          code: "NO_FETCH",
        });
      });
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.userAgent = options.userAgent ?? "keystone-client";
    this.defaultHeaders = options.headers ?? {};
    this.credentials = options.credentials;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const retryable = options.retry ?? SAFE_METHODS.has(method);
    const attempts = 1 + (retryable ? this.maxRetries : 0);
    const url = this.buildUrl(path, options.query);

    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.attempt(url, method, options);

        if (response.ok) {
          return (await this.parse(response)) as T;
        }

        const body = this.decode(await response.text());
        if (retryable && attempt + 1 < attempts && RETRY_STATUS.has(response.status)) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          await sleep(retryAfter ?? this.backoff(attempt));
          continue;
        }

        throw errorForResponse(response.status, body, response.headers);
      } catch (error) {
        lastError = error;
        if (error instanceof NetworkError && error.code === "ABORTED") throw error;
        const transient = error instanceof NetworkError;
        if (!transient || !retryable || attempt + 1 >= attempts) throw error;
        await sleep(this.backoff(attempt));
      }
    }

    throw lastError;
  }

  private async attempt(
    url: string,
    method: HttpMethod,
    options: RequestOptions
  ): Promise<FetchResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers,
    };

    if (!headers["user-agent"]) headers["user-agent"] = this.userAgent;

    const token =
      typeof this.accessToken === "function" ? await this.accessToken() : this.accessToken;
    if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
    if (this.apiKey && !headers["x-api-key"]) headers["x-api-key"] = this.apiKey;
    if (options.idempotencyKey && !headers["idempotency-key"]) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        credentials: this.credentials,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new NetworkError("Request aborted", { code: "ABORTED", cause: error });
      }
      if (timedOut) {
        throw new NetworkError(`Request timed out after ${this.timeoutMs}ms`, {
          code: "TIMEOUT",
          cause: error,
        });
      }
      throw new NetworkError(error instanceof Error ? error.message : "Network request failed", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private decode(text: string): unknown {
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async parse(response: FetchResponse): Promise<unknown> {
    // `text()` is what the FetchLike contract guarantees; parsing is local so a
    // caller-supplied implementation does not have to provide `json()`.
    return this.decode(await response.text());
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(this.maxBackoffMs, this.backoffBaseMs * 2 ** attempt);
    // Equal jitter: keeps a fleet of clients from retrying in lockstep while
    // never waiting longer than the cap.
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
