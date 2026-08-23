import { config } from "../config.js";

/**
 * Public OAuth/OIDC/Federation error codes. These are the only values we
 * expose to browsers or third-party clients; internal failure details stay
 * in server logs.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "access_denied"
  | "server_error"
  | "identity_broker_failure";

export interface OAuthErrorResponse {
  statusCode: number;
  body: {
    error: OAuthErrorCode;
    error_description?: string;
  };
}

function isDevelopment(): boolean {
  return config.NODE_ENV === "development";
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Map an internal error to a stable public OAuth-style code and HTTP status.
 *
 * The mapping is intentionally conservative: anything that could reveal
 * implementation details or provider-specific behaviour collapses into a
 * small set of opaque codes. Detailed diagnostics are written to server logs
 * by the caller before this helper is invoked.
 */
export function classifyOAuthError(error: unknown): { code: OAuthErrorCode; statusCode: number } {
  const message = errorMessage(error)?.toLowerCase() ?? "";

  if (message.includes("state") || message.includes("denied") || message.includes("cancel")) {
    return { code: "access_denied", statusCode: 400 };
  }

  if (
    message.includes("client") &&
    (message.includes("unknown") || message.includes("invalid") || message.includes("not found"))
  ) {
    return { code: "invalid_client", statusCode: 400 };
  }

  if (
    message.includes("token exchange failed") ||
    message.includes("pkce") ||
    message.includes("authorization code") ||
    message.includes("invalid grant") ||
    message.includes("code verifier")
  ) {
    return { code: "invalid_grant", statusCode: 400 };
  }

  if (message.includes("not configured") || message.includes("missing required")) {
    return { code: "server_error", statusCode: 500 };
  }

  if (
    message.includes("connector") ||
    message.includes("federation") ||
    message.includes("oidc") ||
    message.includes("provider") ||
    message.includes("userinfo") ||
    message.includes("broker") ||
    message.includes("idp")
  ) {
    return { code: "identity_broker_failure", statusCode: 502 };
  }

  return { code: "server_error", statusCode: 500 };
}

export interface OAuthRedirectOptions {
  /** OAuth `state` value that must be echoed back to the client. */
  state?: string;
  /** Override whether to include the original error message. Defaults to `true` only in development. */
  includeDescription?: boolean;
}

/**
 * Build a redirect URL that carries only a sanitized error code (and, in
 * development, an optional description). Any existing query parameters on
 * `redirectUrl` are preserved.
 */
export function buildOAuthErrorRedirect(
  error: unknown,
  redirectUrl: string,
  options?: OAuthRedirectOptions
): string {
  const { code } = classifyOAuthError(error);
  const url = new URL(redirectUrl);
  url.searchParams.set("error", code);

  const includeDescription = options?.includeDescription ?? isDevelopment();
  const description = errorMessage(error);
  if (includeDescription && description) {
    url.searchParams.set("error_description", description);
  }

  if (options?.state) {
    url.searchParams.set("state", options.state);
  }

  return url.toString();
}

export interface OAuthResponseOptions {
  /** Override whether to include the original error message. Defaults to `true` only in development. */
  includeDescription?: boolean;
}

/**
 * Build a sanitized JSON error response for endpoints that do not redirect.
 */
export function buildOAuthErrorResponse(
  error: unknown,
  options?: OAuthResponseOptions
): OAuthErrorResponse {
  const { code, statusCode } = classifyOAuthError(error);
  const body: OAuthErrorResponse["body"] = { error: code };

  const includeDescription = options?.includeDescription ?? isDevelopment();
  const description = errorMessage(error);
  if (includeDescription && description) {
    body.error_description = description;
  }

  return { statusCode, body };
}
