import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, cpSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * The manifest gate must be able to see an Ingress, and must reject one that
 * publishes /metrics.
 *
 * This is SEC-073. `verify-k8s-manifests.mjs` rendered every resource in
 * `k8s/` — and only ever looked at `kind: Deployment`. So it printed
 * "Kubernetes manifests OK" while the repository shipped an Ingress at
 * `path: /`, which matches the unauthenticated /metrics endpoint. The prose in
 * docs/security/monitoring.md that claimed the shipped manifests keep /metrics
 * internal was false, and it was false *because* a gate that could not see the
 * file said nothing about it.
 *
 * The interesting half is the second assertion. A test that only asserts the
 * base has no Ingress would keep passing if the check were deleted outright, so
 * the gate is exercised against a real Ingress in a scratch copy of `k8s/`: the
 * behaviour that must be gone is restored, and the gate is required to fail.
 */
const gate = () =>
  execFileSync(
    process.execPath,
    [path.join(projectRoot, "scripts", "verify-k8s-manifests.mjs")],
    { cwd: projectRoot, encoding: "utf8" }
  );

describe("Kubernetes manifest gate — SEC-073", () => {
  it("passes on the shipped manifests", () => {
    const stdout = gate();
    assert.match(stdout, /Kubernetes manifests OK/);
  });

  it("the base ships no Ingress, so the ClusterIP Service keeps /metrics internal", () => {
    // The control is the *absence* of a resource, so it is asserted structurally
    // rather than by reading the gate's opinion of it.
    const base = readFileSync(
      path.join(projectRoot, "k8s", "base", "kustomization.yaml"),
      "utf8"
    );
    const resources = base
      .split(/^resources:/m)[1]
      ?.split(/^\w/m)[0]
      .split("\n")
      .map((line) => line.trim().replace(/^-\s*/, ""))
      .filter((line) => line && !line.startsWith("#")) ?? [];
    assert.deepEqual(
      resources.filter((r) => r.includes("ingress")),
      [],
      "an Ingress in the base publishes the unauthenticated /metrics endpoint"
    );
  });

  it("the opt-in ingress overlay excludes /metrics", () => {
    const doc = readFileSync(
      path.join(projectRoot, "k8s", "overlays", "ingress", "ingress.yaml"),
      "utf8"
    );
    assert.match(doc, /server-snippet/);
    // The exclusion has to name the path, not merely exist: an annotation that
    // says something else is present and does nothing.
    assert.match(doc, /location \/metrics \{ deny all; return 404; \}/);
  });

  it("fails when an Ingress publishes /metrics, and names the file", () => {
    // Rebuild the defect the way it shipped — an Ingress at `path: /` in the
    // base — in a scratch tree, so the repository is never left broken. The gate
    // reads k8s/ relative to the repository root, so the scratch tree needs the
    // script, package.json and src/config.ts beside it.
    const scratch = mkdtempSync(path.join(tmpdir(), "keystone-k8s-"));
    try {
      cpSync(path.join(projectRoot, "k8s"), path.join(scratch, "k8s"), { recursive: true });
      cpSync(path.join(projectRoot, "scripts"), path.join(scratch, "scripts"), {
        recursive: true,
      });
      cpSync(path.join(projectRoot, "package.json"), path.join(scratch, "package.json"));
      mkdirSync(path.join(scratch, "src"), { recursive: true });
      cpSync(path.join(projectRoot, "src", "config.ts"), path.join(scratch, "src", "config.ts"));

      writeFileSync(
        path.join(scratch, "k8s", "base", "ingress.yaml"),
        [
          "apiVersion: networking.k8s.io/v1",
          "kind: Ingress",
          "metadata:",
          "  name: keystone",
          "  annotations:",
          '    nginx.ingress.kubernetes.io/ssl-redirect: "true"',
          "spec:",
          "  ingressClassName: nginx",
          "  rules:",
          "    - host: keystone.example.com",
          "      http:",
          "        paths:",
          "          - path: /",
          "            pathType: Prefix",
          "            backend:",
          "              service:",
          "                name: keystone",
          "                port:",
          "                  number: 80",
          "",
        ].join("\n")
      );

      const kustomization = path.join(scratch, "k8s", "base", "kustomization.yaml");
      const text = readFileSync(kustomization, "utf8");
      writeFileSync(kustomization, text.replace("  - service.yaml", "  - service.yaml\n  - ingress.yaml"));

      let stdout = "";
      let failed = false;
      try {
        stdout = execFileSync(
          process.execPath,
          [path.join(scratch, "scripts", "verify-k8s-manifests.mjs")],
          { cwd: scratch, encoding: "utf8", stdio: "pipe" }
        );
      } catch (error) {
        failed = true;
        const err = error as { stdout?: string; stderr?: string };
        stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }

      assert.ok(failed, "the gate must exit non-zero on an Ingress that publishes /metrics");
      assert.match(stdout, /k8s\/base\/ingress\.yaml/);
      assert.match(stdout, /\/metrics/);
      // Once, not once per overlay: a base resource is rendered four times over.
      assert.equal(
        stdout.split("k8s/base/ingress.yaml").length - 1,
        1,
        "one bad manifest must be reported once, not once per overlay that inherits it"
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
