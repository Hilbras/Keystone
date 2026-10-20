/**
 * The stable `code` a JSON error body carries when its handler did not supply one.
 *
 * §7.2. Before this the contract was `{ error, code }` in name only: `sendResultError`
 * always set `code`, and most hand-written handlers set neither, so a client had to
 * branch on English prose. The fallback lives in one place rather than in fifty
 * handlers, and handlers with something more specific to say still say it.
 */
export function defaultErrorCodeForStatus(statusCode: number, hasDetails = false): string {
  if (hasDetails && statusCode === 400) return "VALIDATION_ERROR";

  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMITED";
    case 501:
      return "NOT_IMPLEMENTED";
    case 502:
      return "BAD_GATEWAY";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return statusCode >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR";
  }
}
