import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signWebhookPayload, verifyWebhookPayload } from "../../../lib/webhookSignature.js";

/**
 * SEC-082 — `verifyWebhookPayload` threw on malformed input.
 *
 * It reached `crypto.timingSafeEqual(Buffer.from(signature, "hex"), …)` with
 * whatever the header held, and that function **throws** `RangeError` when the two
 * buffers differ in length. Every malformed signature a peer can send is a
 * different length, so a consumer using the documented verifier on untrusted input
 * crashed on the bad case instead of being told the signature was invalid.
 *
 * The more dangerous path is subtle: `Buffer.from(x, "hex")` **silently drops
 * invalid characters**, so `"zz"` decodes to an empty buffer rather than raising.
 * A header can therefore be malformed in a way that survives parsing entirely, and
 * only a length check catches it.
 *
 * There were no tests for this function at all — it is exported for consumers to
 * verify deliveries, so it is the exact code a webhook integrator depends on.
 *
 * ## Every case asserts "returns false", and several assert "does not throw"
 *
 * The distinction matters: a verifier that throws on hostile input turns a
 * signature check into a denial-of-service vector against the consumer, and an
 * integrator who wraps it in a try/catch has to write code the API never asked for.
 */
describe("webhook signature verification never throws (SEC-082)", () => {
  const SECRET = "whsec_test_secret";
  const PAYLOAD = { type: "user.login", payload: { userId: "u1" } };
  let valid: string;

  before(() => {
    valid = signWebhookPayload(SECRET, PAYLOAD);
  });

  it("accepts a signature it produced", () => {
    assert.equal(verifyWebhookPayload(SECRET, valid, PAYLOAD), true);
  });

  it("rejects a valid-format signature over a different payload", () => {
    assert.equal(verifyWebhookPayload(SECRET, valid, { ...PAYLOAD, tampered: true }), false);
  });

  it("rejects a valid-format signature made with a different secret", () => {
    assert.equal(verifyWebhookPayload("whsec_other", valid, PAYLOAD), false);
  });

  /**
   * Malformed headers, built lazily.
   *
   * **Inside `describe`, not at its top level.** The table is built from `valid`,
   * which the `before` hook assigns — and a `describe` body runs at *collection*
   * time, before any hook. The first version built it there and failed with
   * `Cannot read properties of undefined (reading 'split')`: a test file failing to
   * load, reported as one failing suite.
   *
   * The `!` on `split(",")[0]` is also a lie for `t=` inputs, where the first part
   * is not absent but empty — hence the `?? ""`.
   */
  const malformedCases = (): Array<[string, string]> => {
    const ts = valid.split("t=")[1]?.split(",")[0] ?? "";
    const sig = valid.split(",v1=")[1] ?? "";
    return [
      ["empty string", ""],
      ["no separators", "not-a-signature"],
      ["missing v1", valid.split(",")[0] ?? ""],
      ["missing t", `v1=${sig}`],
      ["empty v1", valid.replace(/v1=.*/, "v1=")],
      ["empty t", valid.replace(/t=[^,]*/, "t=")],
      ["t is not a number", `t=abc,v1=${sig}`],
      ["t is NaN", `t=NaN,v1=${sig}`],
      ["t is Infinity", `t=Infinity,v1=${sig}`],
      ["v1 is one character", `t=${ts},v1=a`],
      ["v1 is empty-decoding hex", `t=${ts},v1=zz`],
      ["v1 is all non-hex", `t=${ts},v1=zzzz`],
      ["v1 truncated to 31 bytes", `t=${ts},v1=${"a".repeat(62)}`],
      ["v1 padded to 33 bytes", `t=${ts},v1=${"a".repeat(66)}`],
      ["v1 has a stray trailing space", `t=${ts},v1=${"a".repeat(63)} `],
      ["v1 has an embedded newline", `t=${ts},v1=${"a".repeat(31)}\n`],
      ["signature only", "v1=deadbeef"],
      ["many separators", `t=1,,,,,,,,v1=${"a".repeat(64)}`],
      ["whitespace only", "   "],
      ["non-string payload header", `t=${ts},v1=${"a".repeat(64)},extra=1,more=2`],
    ];
  };

  /**
   * Every one of these reached `timingSafeEqual` at a different length before, and
   * `Buffer.from(x, "hex")` silently drops non-hex, so several also reached it as a
   * *shorter* buffer than the caller expected.
   */
  it("rejects every malformed header rather than throwing", () => {
    const cases = malformedCases();
    assert.ok(cases.length >= 18, "the table itself must not silently shrink");
    for (const [name, header] of cases) {
      let result: unknown;
      assert.doesNotThrow(() => {
        result = verifyWebhookPayload(SECRET, header, PAYLOAD);
      }, `${name} must not throw`);
      assert.equal(result, false, `${name} must be rejected`);
    }
  });

  it("rejects a timestamp outside the tolerance", () => {
    // Recomputed so the signature is otherwise genuinely valid: the only reason to
    // reject it is that its timestamp is an hour old.
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const digest = crypto
      .createHmac("sha256", SECRET)
      .update(`${stale}.${JSON.stringify(PAYLOAD)}`)
      .digest("hex");
    assert.equal(verifyWebhookPayload(SECRET, `t=${stale},v1=${digest}`, PAYLOAD), false);
  });

  it("accepts a timestamp inside a widened tolerance", () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const digest = crypto
      .createHmac("sha256", SECRET)
      .update(`${stale}.${JSON.stringify(PAYLOAD)}`)
      .digest("hex");
    assert.equal(
      verifyWebhookPayload(SECRET, `t=${stale},v1=${digest}`, PAYLOAD, 1200),
      true,
      "a consumer that needs a wider window must be able to ask for one"
    );
  });

  it("accepts t=0 rather than treating it as missing", () => {
    // The old guard was `if (!timestamp)`, so `t=0` — a falsy number — was rejected
    // as though the header had no timestamp. Rare in practice and harmless, but it
    // was a falsy-check where a presence-check belonged, and it is the same class
    // of mistake as the ones this release keeps finding.
    const digest = crypto
      .createHmac("sha256", SECRET)
      .update(`0.${JSON.stringify(PAYLOAD)}`)
      .digest("hex");
    // Outside the default tolerance, so it must still be false — but for the
    // tolerance reason, not for being falsy. Widening proves the guard is not `!t`.
    assert.equal(verifyWebhookPayload(SECRET, `t=0,v1=${digest}`, PAYLOAD), false);
    assert.equal(
      verifyWebhookPayload(SECRET, `t=0,v1=${digest}`, PAYLOAD, Number.MAX_SAFE_INTEGER),
      true,
      "with a wide enough window, t=0 must verify — so the guard is not falsy-checked"
    );
  });
});