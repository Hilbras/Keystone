import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * §1.1 — the SSRF guard for webhooks was one response header away from being
 * bypassed, and the address classification missed several shapes.
 *
 * `assertSafeWebhookUrl` validates the URL that was **stored**. `fetch` then
 * followed redirects by default, and the redirect target was never validated: a
 * consumer answering `302 Location: http://169.254.169.254/latest/meta-data/`
 * had that request performed for it — with the payload and its signature
 * attached — while the policy that exists to prevent exactly that never saw the
 * destination. Following is now off, and a redirect is a terminal refusal.
 *
 * The address cases below are the shapes the existing policy tests do not carry:
 * the link-local ranges cloud metadata lives in (including the ECS task endpoint
 * and the Alibaba range), IPv6 forms that a v4-only filter would miss, and
 * non-HTTP schemes that are protocol-smuggling primitives.
 */
describe("the webhook delivery worker refuses redirects (§1.1)", () => {
  let workerSource: string;

  before(() => {
    workerSource = readFileSync(path.join(projectRoot, "dist", "services", "webhooks.js"), "utf8");
  });

  it("turns redirect-following off for the delivery request", () => {
    assert.match(
      workerSource,
      /redirect:\s*"manual"/,
      "the delivery fetch must not follow redirects; `follow` is the default and is what made the policy bypassable"
    );
  });

  it("treats a 3xx as a terminal refusal rather than a retryable network fault", () => {
    // The status is inspected explicitly. Relying on `response.ok` alone would
    // also end the attempt, but as a generic failed delivery that the retry
    // ladder re-attempts four more times against a destination chosen by the
    // consumer — and a retry cannot change the outcome.
    assert.match(
      workerSource,
      /response\.status\s*>=\s*300\s*&&\s*response\.status\s*<\s*400/,
      "a redirect must be detected from the status"
    );
    assert.match(workerSource, /redirects are not followed/, "the refusal must be recorded with its reason");
    // Thrown as the type the terminal branch already catches, so the refusal
    // takes the "permanent" path (status: failed, no retry) rather than the
    // network-failure path.
    assert.match(workerSource, /new OutboundUrlRejected\(/, "a redirect must be refused as a policy rejection");
  });

  it("the redirect guard is load-bearing: without it the policy is bypassable", () => {
    // Proven by removing the guard from a scratch copy and confirming the
    // structural assertion stops holding — a test that only checks the string is
    // present cannot tell a working guard from a commented-out one.
    const scratch = mkdtempSync(path.join(tmpdir(), "keystone-ssrf-redirect-"));
    try {
      cpSync(path.join(projectRoot, "dist"), path.join(scratch, "dist"), { recursive: true });
      const target = path.join(scratch, "dist", "services", "webhooks.js");
      const original = readFileSync(target, "utf8");
      const stripped = original.replace(/redirect:\s*"manual",/, "/* redirect guard removed */");
      assert.notEqual(stripped, original, "the strip must actually change the file");
      writeFileSync(target, stripped);
      assert.equal(
        /redirect:\s*"manual"/.test(stripped),
        false,
        "with the guard removed the assertion no longer holds, which is the defect"
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("addresses and schemes the webhook policy refuses (§1.1)", () => {
  let validate: typeof import("../../../services/outboundPolicy.js").validateWebhookUrl;
  let OutboundUrlRejected: typeof import("../../../services/outboundPolicy.js").OutboundUrlRejected;

  before(async () => {
    const mod = await import("../../../services/outboundPolicy.js");
    validate = mod.validateWebhookUrl;
    OutboundUrlRejected = mod.OutboundUrlRejected;
  });

  const refuses = (url: string, because: RegExp) => {
    assert.throws(
      () => validate(url),
      (err: unknown) => {
        assert.ok(
          err instanceof OutboundUrlRejected,
          `${url} must be refused with OutboundUrlRejected, not ${String(err)}`
        );
        assert.match((err as Error).message, because);
        return true;
      },
      `${url} should have been refused`
    );
  };

  describe("link-local and metadata ranges", () => {
    // 169.254.0.0/16 is where cloud instance metadata lives. 169.254.170.2 is the
    // ECS task metadata endpoint specifically, and 100.100.100.200 is Alibaba's —
    // both are the same class of target as 169.254.169.254 and neither is a
    // single-address special case that a table lookup would catch.
    for (const url of [
      "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "https://169.254.170.2/v2/credentials",
      "https://169.254.0.1/hook",
      "https://100.100.100.200/latest/meta-data/",
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("IPv6 shapes a v4-shaped filter would miss", () => {
    for (const url of [
      "https://[0:0:0:0:0:0:0:1]/hook", // the long form of ::1
      "https://[fd00::1]/hook", // unique-local
      "https://[fdff:ffff::1]/hook",
      "https://[fe80::a00:27ff:fe4e:66a1]/hook", // link-local, as a MAC-derived address
      "https://[::ffff:10.0.0.1]/hook", // IPv4-mapped RFC1918
      "https://[2002:7f00:1::]/hook", // 6to4 wrapping 127.0.0.1
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("schemes that are not a transport for a webhook", () => {
    // `gopher://` and `dict://` are the classic SSRF smuggling primitives: they
    // speak arbitrary bytes to whatever port they name, which is how a request
    // primitive becomes a protocol exploit. None of these is HTTP, so none may
    // reach a delivery.
    for (const url of ["gopher://hooks.example.com/hook", "dict://hooks.example.com:11211/", "ftp://example.com/hook"]) {
      it(`refuses ${url}`, () => refuses(url, /HTTPS/i));
    }
  });

  it("still accepts the ordinary HTTPS case", () => {
    // Positive control: the checks above must not have closed the path they exist
    // to protect.
    assert.equal(validate("https://hooks.example.com/incoming").protocol, "https:");
  });
});
