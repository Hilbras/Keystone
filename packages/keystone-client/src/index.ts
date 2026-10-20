/**
 * `@hilbras/keystone-client` — the typed client for the Hilbras Keystone API.
 *
 * ```ts
 * import { KeystoneClient } from "@hilbras/keystone-client";
 *
 * const keystone = new KeystoneClient({ baseUrl: "https://auth.example.com" });
 * const session = await keystone.auth.login({ email, password });
 * const client = keystone.withAccessToken(session.accessToken!);
 * const { sessions } = await client.sessions.list();
 * ```
 *
 * Safe methods (GET/HEAD/OPTIONS) retry twice by default with exponential backoff
 * and jitter, honouring `Retry-After`. Writes never retry unless the caller passes
 * `retry: true` — see `docs/SDK.md`.
 */
export { KeystoneClient } from "./client.js";
export type { KeystoneClientOptions } from "./client.js";
export {
  AdminResource,
  ApiKeysResource,
  AuthResource,
  HealthResource,
  OAuthResource,
  OrganizationsResource,
  SessionsResource,
  TokensResource,
  WebhooksResource,
} from "./client.js";
export {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  KeystoneError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./errors.js";
export type { KeystoneErrorOptions } from "./errors.js";
export type {
  FetchInit,
  FetchLike,
  FetchResponse,
  HttpClientOptions,
  HttpMethod,
  QueryValue,
  RequestOptions,
} from "./http.js";
export type * from "./types.js";
