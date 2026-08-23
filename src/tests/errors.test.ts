import { describe, it } from "node:test";
import assert from "node:assert";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://hilbras:hilbras@localhost:5432/hilbras";

const { classifyOAuthError, buildOAuthErrorRedirect, buildOAuthErrorResponse } = await import("../lib/errors.js");

describe("OAuth error sanitization", () => {
  it("classifies state mismatches as access_denied", () => {
    const result = classifyOAuthError(new Error("Invalid OAuth state"));
    assert.strictEqual(result.code, "access_denied");
    assert.strictEqual(result.statusCode, 400);
  });

  it("classifies unknown clients as invalid_client", () => {
    const result = classifyOAuthError(new Error("Unknown client"));
    assert.strictEqual(result.code, "invalid_client");
    assert.strictEqual(result.statusCode, 400);
  });

  it("classifies token exchange failures as invalid_grant", () => {
    const result = classifyOAuthError(new Error("Token exchange failed: invalid code"));
    assert.strictEqual(result.code, "invalid_grant");
    assert.strictEqual(result.statusCode, 400);
  });

  it("classifies provider communication failures as identity_broker_failure", () => {
    const result = classifyOAuthError(new Error("Federation callback failed"));
    assert.strictEqual(result.code, "identity_broker_failure");
    assert.strictEqual(result.statusCode, 502);
  });

  it("classifies configuration errors as server_error", () => {
    const result = classifyOAuthError(new Error("Connector not configured"));
    assert.strictEqual(result.code, "server_error");
    assert.strictEqual(result.statusCode, 500);
  });

  it("classifies generic errors as server_error", () => {
    const result = classifyOAuthError(new Error("Something went wrong"));
    assert.strictEqual(result.code, "server_error");
    assert.strictEqual(result.statusCode, 500);
  });

  it("builds a redirect URL with a sanitized code and state", () => {
    const url = buildOAuthErrorRedirect(new Error("secret details"), "http://example.com/cb?foo=bar", {
      state: "xyz",
      includeDescription: false,
    });
    assert.ok(url.startsWith("http://example.com/cb"));
    assert.ok(url.includes("error=server_error"));
    assert.ok(url.includes("state=xyz"));
    assert.ok(url.includes("foo=bar"));
    assert.ok(!url.includes("secret"));
  });

  it("includes descriptions in development mode", () => {
    const { statusCode, body } = buildOAuthErrorResponse(new Error("detailed message"), {
      includeDescription: true,
    });
    assert.strictEqual(statusCode, 500);
    assert.strictEqual(body.error, "server_error");
    assert.strictEqual(body.error_description, "detailed message");
  });

  it("omits descriptions outside development mode", () => {
    const { statusCode, body } = buildOAuthErrorResponse(new Error("detailed message"), {
      includeDescription: false,
    });
    assert.strictEqual(statusCode, 500);
    assert.strictEqual(body.error, "server_error");
    assert.strictEqual(body.error_description, undefined);
  });
});
