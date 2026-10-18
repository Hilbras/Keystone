import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * §1.2 — the plain-HTTP rule for webhook destinations, asserted against each
 * environment it depends on.
 *
 * The rule is: HTTPS always; plain HTTP only when the operator has opted in with
 * `KEYSTONE_ALLOW_INSECURE_WEBHOOK=localhost`, only outside production, and only
 * to a loopback address. Before this it was "HTTPS in production, anything
 * anywhere else" — so a shared staging box, which traverses public hops, was
 * indistinguishable from a developer's laptop and the webhook signing secret
 * travelled in the clear.
 *
 * `config` is frozen when the module is first imported, so the environment
 * branches cannot be exercised by mutating `process.env` inside this process —
 * that would test a different module instance than the one under test. Each case
 * therefore runs in a child process that boots the policy with the environment it
 * is meant to be judged in. A webhook body carries an HMAC signature over the
 * payload, which is a credential, so these are the cases worth paying a process
 * for.
 */
interface ProbeResult {
  accepted: boolean;
  protocol?: string;
  message?: string;
}

function probe(url: string, env: Record<string, string>): ProbeResult {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "dist", "services", "outboundPolicy.js")).href;
  const script = `
import { validateWebhookUrl } from ${JSON.stringify(moduleUrl)};
try {
  const u = validateWebhookUrl(process.argv[1]);
  console.log(JSON.stringify({ accepted: true, protocol: u.protocol }));
} catch (err) {
  console.log(JSON.stringify({ accepted: false, message: err.message }));
}
`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, url], {
    env: {
      ...process.env,
      // A placeholder, so the child never reaches a real database: the policy
      // module resolves a URL and nothing else. `config` still requires the
      // variable to be present.
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      ...env,
    },
    encoding: "utf8",
  });

  // dotenv prints a banner on stdout, so the payload is the last line that parses.
  const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
  assert.ok(lines.length > 0, `the probe produced no JSON result; output was:\n${out}`);
  return JSON.parse(lines[lines.length - 1]!) as ProbeResult;
}

/** The opt-in and the private-target flag, which a loopback HTTP URL needs both of. */
const DEV_LOOPBACK_OPTS = {
  NODE_ENV: "development",
  KEYSTONE_ALLOW_INSECURE_WEBHOOK: "localhost",
  ALLOW_PRIVATE_WEBHOOK_TARGETS: "true",
};

describe("webhook plain-HTTP policy (§1.2)", () => {
  it("accepts HTTPS in production", () => {
    const result = probe("https://hooks.example.com/inbound", { NODE_ENV: "production" });
    assert.equal(result.accepted, true, result.message ?? "expected the URL to be accepted");
  });

  it("refuses plain HTTP to a public host in production", () => {
    const result = probe("http://hooks.example.com/inbound", { NODE_ENV: "production" });
    assert.equal(result.accepted, false);
    assert.match(result.message ?? "", /HTTPS/i);
  });

  it("refuses plain HTTP even with the opt-in, in production", () => {
    // The opt-in is a development affordance. A production deployment that set it
    // — by copying a staging env file, say — must still not put a signing secret
    // on the wire in the clear.
    const result = probe("http://localhost:3000/hook", {
      ...DEV_LOOPBACK_OPTS,
      NODE_ENV: "production",
    });
    assert.equal(result.accepted, false);
    assert.match(result.message ?? "", /HTTPS/i);
  });

  it("refuses plain HTTP to a public host outside production", () => {
    const result = probe("http://hooks.example.com/inbound", { NODE_ENV: "development" });
    assert.equal(result.accepted, false);
  });

  it("refuses plain HTTP to loopback without the explicit opt-in", () => {
    const result = probe("http://localhost:3000/hook", {
      NODE_ENV: "development",
      ALLOW_PRIVATE_WEBHOOK_TARGETS: "true",
    });
    assert.equal(result.accepted, false, "the development exception must be opt-in, not default");
  });

  it("accepts plain HTTP to loopback with the opt-in outside production", () => {
    const result = probe("http://localhost:3000/hook", DEV_LOOPBACK_OPTS);
    assert.equal(result.accepted, true, result.message ?? "expected the URL to be accepted");
    assert.equal(result.protocol, "http:");
  });

  it("accepts plain HTTP to 127.0.0.1 with the opt-in", () => {
    // "localhost" is a name; the exception is about the destination being this
    // machine, and the name is only one way to spell it.
    const result = probe("http://127.0.0.1:8080/hook", DEV_LOOPBACK_OPTS);
    assert.equal(result.accepted, true, result.message ?? "expected the URL to be accepted");
  });

  it("refuses the opt-in when it is set to any value other than `localhost`", () => {
    // `KEYSTONE_ALLOW_INSECURE_WEBHOOK=true` reads as "HTTP is fine everywhere",
    // which is not what is being permitted. Only the literal value counts.
    const result = probe("http://localhost:3000/hook", {
      NODE_ENV: "development",
      KEYSTONE_ALLOW_INSECURE_WEBHOOK: "true",
      ALLOW_PRIVATE_WEBHOOK_TARGETS: "true",
    });
    assert.equal(result.accepted, false);
  });

  it("does not extend the opt-in to a private, non-loopback address", () => {
    // 10.0.0.5 is private but it is not this machine. Allowing HTTP to it is a
    // different decision, with its own flag, and the transport exception is not a
    // back door to it.
    const result = probe("http://10.0.0.5:3000/hook", DEV_LOOPBACK_OPTS);
    assert.equal(result.accepted, false);
  });
});
