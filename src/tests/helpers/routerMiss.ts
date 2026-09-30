/**
 * A 404 from a route handler and a 404 from Fastify's router are different failures.
 *
 * Both arrive as `{ statusCode: 404 }`, and treating them as one number is how a dead
 * endpoint came to look like a guarded one — the subject of SEC-062, where the enterprise
 * OIDC `redirect_uri` named a path the server did not serve, and the only evidence was a
 * status code that a "is this route protected?" assertion would have read as a working
 * route answering correctly.
 *
 * ## Why the shape of the body is the test
 *
 * Fastify's default not-found handler answers with `error: "Not Found"` and a `message`
 * naming the route. A handler that means to return 404 says something else — in this
 * repository, `{ "error": "OIDC connection not found" }` or `{ "error": "User not found" }`.
 *
 * So the discriminator is deliberately **shape-based and loose** (`"Not Found"` in the
 * body) rather than an exact string. An exact match would be a second thing to keep in
 * step with Fastify, and it would fail *open* — a body that changed shape would stop being
 * recognised as a router miss, and every assertion built on this would quietly start
 * treating a dead route as a served one. Loose here fails toward reporting the problem.
 */
export function isRouterMiss(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 404) return false;
  return /"error"\s*:\s*"Not Found"/.test(res.body) || /\bnot found\b/i.test(res.body);
}

/** The path a `redirect_uri`, `issuer`-derived endpoint or similar absolute URL points at. */
export function pathOf(absoluteUrl: string): string {
  try {
    return new URL(absoluteUrl).pathname;
  } catch {
    return absoluteUrl;
  }
}
