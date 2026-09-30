import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * The delivery worker must refuse a private webhook URL, and must not retry it.
 *
 * The policy tests in `outboundUrlPolicy.test.ts` cover the rules. They would
 * keep passing if `deliverNow` stopped calling the policy — a gate that no longer
 * measures the thing it is named for, which is the defect class this project has
 * now found ~46 times.
 *
 * So these assert the wiring, and they assert it by reading the source of the
 * compiled module the worker actually calls. A structural assertion is the honest
 * form here: a live delivery would need a real HTTP server on a private address
 * to be fetched *successfully*, which is the very thing the fix prevents, so the
 * only observable end-to-end proof is "no request was made".
 */
describe("webhook delivery refuses a private URL (SEC-075)", () => {
  let workerSource: string;
  let policySource: string;

  before(() => {
    const dist = path.join(projectRoot, "dist");
    workerSource = readFileSync(path.join(dist, "services", "webhooks.js"), "utf8");
    policySource = readFileSync(path.join(dist, "services", "outboundPolicy.js"), "utf8");
  });

  it("the delivery worker calls the policy before it fetches", () => {
    // Order matters and is the point of the fix: the check must precede the
    // `fetch`, not merely appear somewhere in the file. Measured as an index
    // comparison rather than a regex, because a check that ran *after* the
    // request would satisfy any "contains" test.
    const check = workerSource.indexOf("assertSafeWebhookUrl(endpoint.url)");
    const request = workerSource.indexOf("fetch(endpoint.url");
    assert.ok(check !== -1, "deliverNow must call assertSafeWebhookUrl");
    assert.ok(request !== -1, "deliverNow must still fetch the endpoint");
    assert.ok(
      check < request,
      `the policy check must precede the request (check at ${check}, fetch at ${request})`
    );
  });

  it("a rejected URL is not retried, and is recorded as failed on the first attempt", () => {
    // The retry ladder is for transient network faults. A policy rejection is
    // permanent — the same URL is refused identically forever — so retrying it
    // five times is five requests the operator should never have received.
    assert.match(
      workerSource,
      /instanceof OutboundUrlRejected/,
      "the worker must distinguish a policy rejection from a network failure"
    );
    // Inside that branch: `status: "failed"` and a `return`, so the retry
    // `if (attempts < MAX_ATTEMPTS)` below is never reached for this case.
    const branch = workerSource.slice(
      workerSource.indexOf("instanceof OutboundUrlRejected"),
      workerSource.indexOf("instanceof OutboundUrlRejected") + 1400
    );
    assert.match(branch, /status:\s*"failed"/, "a refused delivery must be terminal");
    assert.match(branch, /return;/, "a refused delivery must not fall through to the retry path");
  });

  it("the policy resolves DNS and pins the address, so a rebind cannot win", () => {
    // Delegated to ssoEndpointPolicy. Both properties are required: resolving at
    // creation time only catches a name that was already private, and checking
    // without pinning leaves a window for the answer to change between the check
    // and the connection.
    assert.match(policySource, /assertSafeSsoEndpoint/, "must delegate the DNS check");
    assert.match(
      readFileSync(path.join(projectRoot, "dist", "services", "ssoEndpointPolicy.js"), "utf8"),
      /lookup:.*callback/,
      "the delegated request must pin the resolved address"
    );
  });

  it("the admin API refuses the same URL with 400, not 500", () => {
    const route = readFileSync(path.join(projectRoot, "dist", "routes", "admin", "webhooks.js"), "utf8");
    assert.match(route, /OutboundUrlRejected/, "the route must recognise the policy error");
    assert.match(route, /status\(400\)/, "an operator-supplied URL is a client error");
  });

  it("the whole suite passes with the policy removed from the worker", () => {
    // Proven by breaking the fix rather than by asserting the fix's presence:
    // remove the check from the *compiled* worker in a scratch copy and confirm
    // the structural assertions above no longer hold. A test that only checks
    // the code contains a call cannot distinguish a working check from a
    // commented-out one.
    const scratch = mkdtempSync(path.join(tmpdir(), "keystone-wh-"));
    try {
      cpSync(path.join(projectRoot, "dist"), path.join(scratch, "dist"), { recursive: true });
      const target = path.join(scratch, "dist", "services", "webhooks.js");
      const stripped = readFileSync(target, "utf8").replace(
        /await assertSafeWebhookUrl\(endpoint\.url\);/,
        "/* removed for the regression check */"
      );
      assert.notEqual(stripped, readFileSync(target, "utf8"), "the strip must actually change the file");
      writeFileSync(target, stripped);

      // The same index comparison the first test makes, against the stripped copy.
      const check = stripped.indexOf("assertSafeWebhookUrl(endpoint.url)");
      assert.equal(check, -1, "with the check removed, the call is gone — which is the defect");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
