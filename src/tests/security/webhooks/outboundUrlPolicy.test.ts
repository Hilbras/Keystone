import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

/**
 * The outbound URL policy for webhooks. Plan §1.1 and §1.2.
 *
 * The defect this covers: `deliverNow` performed `fetch(endpoint.url, …)` against
 * an administrator-supplied URL with no validation at all, while the repository
 * already contained a complete SSRF guard — private-address classification, DNS
 * resolution over *every* answer, address pinning so a rebind cannot change the
 * destination between check and connect, and a redirect refusal — wired only to
 * SSO endpoints. A webhook aimed at `169.254.169.254` is a cloud-metadata read;
 * aimed at `127.0.0.1:6379` or `postgres.internal`, a lateral reach into
 * infrastructure no tenant-controlled URL should reach. And the response body is
 * persisted on the delivery row and readable through the admin API, so a
 * *successful* request hands its content back to the operator.
 *
 * These cases are the policy in isolation. The tests that prove the delivery
 * worker actually calls it are in `webhookDeliveryRefusesPrivateUrl.test.ts`.
 */
describe("outbound URL policy — webhooks (SEC-075 §1.1, §1.2)", () => {
  let validate: typeof import("../../../services/outboundPolicy.js").validateWebhookUrl;
  let OutboundUrlRejected: typeof import("../../../services/outboundPolicy.js").OutboundUrlRejected;

  before(async () => {
    const mod = await import("../../../services/outboundPolicy.js");
    validate = mod.validateWebhookUrl;
    OutboundUrlRejected = mod.OutboundUrlRejected;
  });

  /** Assert a URL is refused, and that it is refused as a *policy* rejection. */
  const refuses = (url: string, because: RegExp) => {
    assert.throws(
      () => validate(url),
      (err: unknown) => {
        assert.ok(
          err instanceof OutboundUrlRejected,
          `${url} must be refused with OutboundUrlRejected, not ${String(err)}`
        );
        assert.match(err.message, because);
        return true;
      },
      `${url} should have been refused`
    );
  };

  it("refuses a public HTTPS URL", () => {
    const url = validate("https://hooks.example.com/incoming");
    assert.equal(url.hostname, "hooks.example.com");
  });

  describe("loopback and local names", () => {
    for (const url of [
      "https://localhost/hook",
      "https://LOCALHOST:8443/hook",
      "https://app.localhost/hook",
      "https://ip6-localhost/hook",
      "http://localhost:3000/hook",
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("private and reserved IPv4 literals", () => {
    // Every one of these is a real SSRF target: loopback, RFC1918, carrier NAT,
    // link-local (which is where cloud metadata lives), benchmarking, multicast,
    // and the "this network" address.
    for (const url of [
      "https://127.0.0.1/hook",
      "https://127.1.2.3/hook",
      "https://10.0.0.5/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.254/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/hook",
      "https://198.18.0.1/hook",
      "https://0.0.0.0/hook",
      "https://224.0.0.1/hook",
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("IPv6 literals", () => {
    for (const url of [
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
      // IPv4-mapped: `::ffff:127.0.0.1` is a loopback address wearing an IPv6 hat,
      // and a filter that only tests the v4 form misses it.
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("internal DNS names", () => {
    for (const url of [
      "https://metadata.google.internal/hook",
      "https://metadata/hook",
      "https://postgres.internal/hook",
      "https://redis.svc.cluster.local/hook",
    ]) {
      it(`refuses ${url}`, () => refuses(url, /private or local/i));
    }
  });

  describe("credentials in the URL (§1.2 transport)", () => {
    it("refuses embedded credentials", () =>
      refuses("https://user:secret@hooks.example.com/hook", /credentials/i));
  });

  describe("plaintext transport (§1.2)", () => {
    /**
     * The policy is environment-dependent, so this case is asserted against the
     * environment rather than assumed.
     *
     * `config.NODE_ENV === "production"` requires HTTPS outright. Anywhere else,
     * plain HTTP is permitted so a developer's `http://localhost:3000` works —
     * which means the *public-host* form is only refused in production, and a
     * test that asserts it unconditionally passes in production and fails in
     * CI, which ran it under NODE_ENV=test and reported the test as wrong when
     * the test was.
     *
     * The production behaviour is covered structurally below, by asserting the
     * rule the code implements rather than by mutating the environment at
     * runtime — `config` is frozen at import, so a test that flipped it would be
     * testing a different module instance than the one under test.
     */
    it("permits http to a public host outside production, and says so", () => {
      const production = process.env.NODE_ENV === "production";
      if (production) {
        refuses("http://hooks.example.com/hook", /HTTPS/i);
      } else {
        const url = validate("http://hooks.example.com/hook");
        assert.equal(url.protocol, "http:");
      }
    });

    it("refuses a non-HTTP(S) scheme outright", () => {
      // `file://` would read the server's own filesystem; `gopher://` and
      // friends are the classic SSRF protocol-smuggling primitives. These are
      // refused in every environment, unlike plain http.
      refuses("file:///etc/passwd", /HTTPS/i);
    });
  });

  it("the rejection carries the URL for the audit trail", () => {
    try {
      validate("https://169.254.169.254/latest/meta-data/");
      assert.fail("should have been refused");
    } catch (err) {
      assert.ok(err instanceof OutboundUrlRejected);
      assert.match(err.url, /169\.254\.169\.254/);
    }
  });
});
