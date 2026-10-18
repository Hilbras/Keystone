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
     * This policy used to be environment-dependent: production required HTTPS,
     * and every other environment permitted plain HTTP to any host. That made a
     * shared staging deployment identical to a developer's laptop from the
     * config's point of view, and put the webhook signing secret in the clear on
     * whatever public hop staging happened to traverse.
     *
     * It now takes an explicit opt-in — `KEYSTONE_ALLOW_INSECURE_WEBHOOK=localhost`
     * — and, even then, only outside production and only to a loopback host. The
     * whole rule is asserted here rather than conditionally, because the test
     * environment (NODE_ENV=test, no opt-in) is exactly the case that used to
     * permit everything and no longer does.
     */
    it("refuses plain HTTP to a public host in every environment", () => {
      refuses("http://hooks.example.com/hook", /HTTPS/i);
    });

    it("refuses plain HTTP to loopback without the explicit opt-in", () => {
      // The opt-in is unset in this process, so even the one address the
      // exception exists for is refused — the exception is opt-in, not default.
      refuses("http://localhost:3000/hook", /KEYSTONE_ALLOW_INSECURE_WEBHOOK|HTTPS/i);
    });

    it("refuses a non-HTTP(S) scheme outright", () => {
      // `file://` would read the server's own filesystem; `gopher://` and
      // friends are the classic SSRF protocol-smuggling primitives. These are
      // refused in every environment, unlike plain http.
      refuses("file:///etc/passwd", /HTTPS/i);
    });

    it("still accepts HTTPS unconditionally", () => {
      // The positive control: the tightening above must not have closed the
      // ordinary path.
      assert.equal(validate("https://hooks.example.com/hook").protocol, "https:");
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
