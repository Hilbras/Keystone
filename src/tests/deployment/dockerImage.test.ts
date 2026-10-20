import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §6.7. The image and its deployment descriptors.
 *
 * These are static assertions rather than a container run, because the properties
 * that matter here are declared in text: the image runs as a non-root user, it
 * declares a health check against an endpoint that actually exists, and the
 * orchestrator's probes match the three endpoints the application serves. A `docker
 * build` is covered by CI's `docker` job; this suite is what fails on the *next*
 * change to one of these files, before an image is ever built.
 *
 * It also pins the image name the k8s manifest expects to the one `release.yml`
 * publishes, which had drifted to a different organization.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

describe("docker image", () => {
  const dockerfile = read("Dockerfile");

  it("runs as the non-root user", () => {
    const userLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^USER\s+/i.test(line));
    assert.ok(userLines.length > 0, "the image must drop root with USER");
    assert.equal(userLines.at(-1), "USER node");

    // `USER` must come after the last root-only instruction that needs it. The
    // chown is the one that writes into /app, so it has to precede the drop.
    const userIndex = dockerfile.lastIndexOf("USER node");
    const chownIndex = dockerfile.indexOf("chown -R node:node /app");
    assert.ok(chownIndex > 0 && chownIndex < userIndex);
  });

  it("declares a health check against the liveness endpoint", () => {
    const start = dockerfile.indexOf("HEALTHCHECK");
    assert.ok(start >= 0, "the published image must declare a HEALTHCHECK");
    // Take the block, not the line: the instruction continues with a `\`.
    const block = dockerfile.slice(start, dockerfile.indexOf("\nSTOPSIGNAL", start));
    // `/health/live`, not `/ready`: a readiness failure is the orchestrator's
    // decision, and reporting unhealthy on a Redis outage restarts a process that
    // is serving correctly.
    assert.match(block, /\/health\/live/);
    assert.doesNotMatch(block, /\/ready/);
  });

  it("stops on SIGTERM so the graceful handler can run", () => {
    assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  });

  it("runs the production entrypoint with production defaults", () => {
    assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
    assert.match(dockerfile, /^CMD \["node", "dist\/index\.js"\]$/m);
  });

  it("boots the setup server through the same entrypoint", () => {
    // `index.ts` reads KEYSTONE_SETUP_MODE and dynamically imports setup-server;
    // a separate CMD here would make the documented setup flow unreachable.
    const compose = read("docker-compose.yml");
    assert.match(compose, /KEYSTONE_SETUP_MODE/);
  });
});

describe("deployment descriptors", () => {
  it("probes the endpoints the application actually serves", () => {
    const health = read("src/routes/health.ts");
    for (const route of ["/health", "/health/live", "/health/ready", "/ready", "/health/startup"]) {
      assert.ok(health.includes(`"${route}"`), `${route} must be registered`);
    }

    const deployment = read("k8s/base/deployment.yaml");
    assert.match(deployment, /path: \/health\/startup/);
    assert.match(deployment, /path: \/health$/m);
    assert.match(deployment, /path: \/ready/);

    const compose = read("docker-compose.yml");
    // Compose probes readiness, because it is deciding whether to route traffic to
    // this container, not whether to restart it.
    assert.match(compose, /\/ready/);
  });

  it("pins the k8s image to the registry and repository release.yml publishes", () => {
    const release = read(".github/workflows/release.yml");
    assert.match(release, /images: ghcr\.io\/\$\{\{ github\.repository \}\}/);

    // `github.repository` is `Hilbras/Keystone`, which GHCR lowercases.
    const expected = "ghcr.io/hilbras/keystone";
    const deployment = read("k8s/base/deployment.yaml");
    const kustomization = read("k8s/base/kustomization.yaml");
    assert.ok(
      deployment.includes(expected),
      `k8s deployment must reference ${expected}, not a stale organization`
    );
    assert.ok(
      kustomization.includes(expected),
      `k8s kustomization must reference ${expected}, not a stale organization`
    );
  });

  it("runs the container without root or added capabilities", () => {
    const deployment = read("k8s/base/deployment.yaml");
    assert.match(deployment, /runAsNonRoot: true/);
    assert.match(deployment, /readOnlyRootFilesystem: true/);

    const compose = read("docker-compose.yml");
    assert.match(compose, /user: "1000:1000"/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /no-new-privileges:true/);
  });
});
