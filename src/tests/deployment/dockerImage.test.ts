import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

/**
 * An image on the registry is not the same as an image anyone can pull.
 *
 * GHCR creates every container package private, and the release path pushed
 * the image and stopped there: `docker pull ghcr.io/hilbras/keystone:4.0.0`
 * answered 403, and the k8s manifests in this repository reference the image
 * with no imagePullSecret, so a cluster pulling it landed in
 * ImagePullBackOff. Every check said the image was published, because none of
 * them asked the registry the question a user's `docker pull` asks.
 */
describe("the published image is pullable without credentials", () => {
  const release = read(".github/workflows/release.yml");

  it("publishes the container package publicly", () => {
    assert.match(release, /visibility=public/);
  });

  it("publishes it after the vulnerability gate, not before", () => {
    // Publishing first and scanning after would expose the very image the
    // scan exists to reject. The scan can still read the image while the
    // package is private and the job is logged in.
    const scan = release.indexOf("verify-image-vulnerabilities");
    const publish = release.indexOf("visibility=public");
    assert.ok(scan > 0, "the release must scan the image it pushed");
    assert.ok(publish > scan, "the package must be published after the scan");
  });

  it("gates the image on an anonymous pull, which is what a stranger does", () => {
    // The same request an unauthenticated `docker pull` makes. A public
    // package answers 200 with a token; a private one answers 401.
    assert.match(release, /ghcr\.io\/token\?scope=repository:/);
    assert.match(release, /401/);
  });

  it("has a manual path to finish a release that stopped halfway", () => {
    // A tag push is not guaranteed to dispatch, and an unchanged tag cannot
    // be re-pushed, so a release that pushed the image and then failed before
    // the visibility step has no other way back.
    const workflow = read(".github/workflows/publish-container-package.yml");
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /packages: write/);
  });

  it("treats a private image as a failed release artifact", () => {
    // The old check could not tell a private image from one it could not
    // reach, and treated "could not look" as "fine" — which is how a private
    // image passed as published.
    const script = read("scripts/verify-release-artifacts.mjs");
    assert.match(script, /status === 401/);
    assert.match(script, /is not publicly pullable/);
  });

  it("has no context expression in a workflow_dispatch input default", () => {
    // The `github` context is not available in a `workflow_dispatch` input
    // default. The workflow file does not parse, and GitHub cannot read the
    // `on:` section either — so the workflow runs on *every* push and fails
    // each time, filling the run list with failures nobody started.
    //
    // That is what the first version of this workflow did, and it was
    // merged before anyone dispatched it.
    const workflows = path.join(root, ".github", "workflows");
    for (const file of readdirSync(workflows).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(path.join(workflows, file), "utf8");
      const offending = text
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /^\s*default:\s*\$\{\{/.test(line));
      assert.deepEqual(
        offending,
        [],
        `${file} must not use a context expression in an input default: ` +
          offending.map((o) => `line ${o.number}: ${o.line.trim()}`).join("; ")
      );
    }
  });
});
