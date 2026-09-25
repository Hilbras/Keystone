import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The address policy itself is pure, but its module graph loads application
// config, which requires a database URL. Set it before the dynamic import
// because static imports are hoisted above any assignment.
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
const { isPrivateAddress } = await import("../../services/ssoEndpointPolicy.js");

describe("SSO endpoint address policy", () => {
  it("blocks private, loopback, carrier-grade, benchmarking, and mapped IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:c0a8:1",
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    assert.equal(isPrivateAddress("8.8.8.8"), false);
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  });
});
