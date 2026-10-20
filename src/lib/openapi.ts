import { readFileSync } from "node:fs";

/**
 * The version the OpenAPI document advertises.
 *
 * It used to be the literal `"3.0.1"` in `index.ts`, three minor releases behind
 * the package it described. Nothing compared the two, so the document a client
 * generated code from claimed a server version that did not exist. Reading the
 * manifest makes the claim true by construction; `scripts/verify-openapi-version.mjs`
 * checks it anyway, because the path this resolves depends on the build layout
 * (`src/lib` and `dist/lib` are the same depth below the root) and a future move
 * would break it silently.
 */
export function readPackageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

/**
 * Tag rules, most specific first.
 *
 * Tags are how a generated client groups operations, and before this every route
 * in the document was untagged except the eight that passed a schema. Deriving a
 * tag from the mount point means a new route is filed correctly without its author
 * remembering to say so — and `verify-openapi-version.mjs` requires every operation
 * to have one, so forgetting is a build failure rather than a gap in the document.
 */
const TAG_RULES: ReadonlyArray<{ prefix: string; tag: string }> = [
  { prefix: "/v1/admin", tag: "Admin" },
  { prefix: "/scim", tag: "SCIM" },
  { prefix: "/sso", tag: "SSO" },
  { prefix: "/oauth2", tag: "OAuth" },
  { prefix: "/auth", tag: "Auth" },
  { prefix: "/sdk", tag: "SDK" },
  { prefix: "/federation", tag: "Federation" },
  { prefix: "/setup", tag: "Setup" },
  { prefix: "/v1/authz", tag: "Authorization" },
  { prefix: "/v1", tag: "API" },
  { prefix: "/.well-known", tag: "Discovery" },
  { prefix: "/health", tag: "Discovery" },
  { prefix: "/ready", tag: "Discovery" },
  { prefix: "/openapi.json", tag: "Discovery" },
];

export function tagForRoute(url: string): string {
  return TAG_RULES.find((rule) => url.startsWith(rule.prefix))?.tag ?? "API";
}

/** Tag definitions, in the order the document lists them. */
export const OPENAPI_TAGS = [
  { name: "Auth", description: "Authentication, sessions, MFA and personal API keys" },
  { name: "OAuth", description: "OAuth 2.0 / OpenID Connect provider endpoints" },
  { name: "API", description: "Versioned identity and authorization APIs" },
  { name: "Admin", description: "Organization, application and platform administration" },
  { name: "Authorization", description: "Fine-grained authorization decisions" },
  { name: "SSO", description: "Enterprise SAML and OIDC single sign-on" },
  { name: "SCIM", description: "SCIM 2.0 provisioning" },
  { name: "Federation", description: "Identity federation connectors" },
  { name: "SDK", description: "Browser SDK bootstrap" },
  { name: "Setup", description: "First-run setup wizard" },
  { name: "Discovery", description: "Health, JWKS and service discovery" },
] as const;

/**
 * Credential schemes, declared so a generated client knows how to authenticate.
 *
 * Deliberately no top-level `security`: half of this server's routes are public
 * (login, JWKS, discovery), and a global requirement would tell a generated client
 * to attach a token to all of them. The schemes are here to be referenced, and the
 * per-route requirements are added as routes gain schemas.
 */
export const OPENAPI_SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Access token issued by /auth/login, /auth/refresh or /oauth2/token",
  },
  apiKey: {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description: "Personal or organization API key",
  },
} as const;
