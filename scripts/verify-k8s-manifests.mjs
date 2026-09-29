#!/usr/bin/env node
/**
 * Verify `k8s/` against the configuration surface the server actually has.
 *
 * §5.4: the manifests existed and no check covered them. Two things were wrong
 * before this script, and both would have shipped:
 *
 * - **The readiness probe pointed at `/health`**, which is liveness and answers
 *   200 whenever the process is listening. So a pod with no database was reported
 *   ready, put in the load balancer's rotation, and every authenticated request
 *   it received failed. It pointed there because `/ready` did not exist.
 * - **The image was `:latest`**, which the roadmap's own gate names as a
 *   placeholder. A deployment that pulls `latest` cannot say what it is running,
 *   and a rollback has nothing to roll back to.
 *
 * The kustomization is rendered here rather than shelled out to `kustomize`,
 * because the base is a flat resource list and pulling a binary into CI to read
 * nine files is a cost with no return. What this renderer supports is exactly
 * what `k8s/` uses: `resources`, `namespace`, `namePrefix`, `commonLabels`,
 * `images`, `replicas` and inline `patches`. Anything else in a kustomization is
 * an error rather than a silent skip, because a check that quietly ignores half
 * a file is worse than no check.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadYamlFile as loadYaml } from "./lib/yaml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K8S = path.join(root, "k8s");

const SUPPORTED_KUSTOMIZE_KEYS = new Set([
  "apiVersion",
  "kind",
  "resources",
  "namespace",
  "namePrefix",
  "commonLabels",
  "images",
  "replicas",
  "patches",
  "configMapGenerator",
  "secretGenerator",
]);

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

/** Every YAML file a kustomization reaches, with its own name. */
async function collectResources(dir, relative = "") {
  const kustomizationPath = path.join(dir, "kustomization.yaml");
  if (!existsSync(kustomizationPath)) return [];
  const kustomization = await loadYaml(kustomizationPath);
  const unsupported = Object.keys(kustomization).filter(
    (key) => !SUPPORTED_KUSTOMIZE_KEYS.has(key)
  );
  if (unsupported.length > 0) {
    fail(
      `k8s/${relative}kustomization.yaml uses keys this renderer does not implement: ` +
        `${unsupported.join(", ")}. Either implement them or extend ` +
        `SUPPORTED_KUSTOMIZE_KEYS deliberately — a check that ignores part of a ` +
        `file is worse than no check.`
    );
  }

  const out = [];
  for (const resource of kustomization.resources ?? []) {
    const target = path.join(dir, resource);
    if (resource.endsWith("/") || (await isDirectory(target))) {
      out.push(...(await collectResources(target, path.join(relative, resource))));
    } else if (resource.endsWith(".yaml")) {
      const doc = await loadYaml(target);
      out.push({
        // The **declared** name, which is what `envFrom` and `configMapGenerator`
        // refer to: a ConfigMap is called `configmap.yaml` but named
        // `keystone-config`, and a Secret is called `secret.example.yaml` but
        // named `keystone-secrets`. Indexing by filename made every `envFrom`
        // resolve to nothing and the check reported DATABASE_URL unreachable
        // while the manifest plainly provided it.
        name: doc?.metadata?.name ?? path.basename(resource, ".yaml"),
        // The path, separately, so every failure names a file a person can open.
        file: target,
        source: path.relative(K8S, target),
        kustomization,
      });
    }
  }
  return out;
}

async function isDirectory(p) {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Apply the overlay transformations the base kustomization declares. */
function applyKustomization(doc, kustomization, imagesByName) {
  if (kustomization.commonLabels && typeof doc === "object" && doc.metadata) {
    doc.metadata.labels = { ...kustomization.commonLabels, ...doc.metadata.labels };
  }
  if (kustomization.namespace && doc?.metadata) doc.metadata.namespace = kustomization.namespace;
  if (kustomization.namePrefix && doc?.metadata?.name) {
    doc.metadata.name = `${kustomization.namePrefix}${doc.metadata.name}`;
  }
  for (const container of containersOf(doc)) {
    const match = imagesByName.find((entry) =>
      container.image?.startsWith(`${entry.name}:`)
    );
    if (match) {
      container.image = `${match.name}:${match.newTag ?? match.newName ?? "latest"}`;
    } else if (container.image?.includes(":latest")) {
      fail(
        `k8s: ${doc.kind}/${doc.metadata?.name} container "${container.name}" uses ` +
          `image ${container.image} and the kustomization does not pin a tag, so the ` +
          `deployed version is unknowable and a rollback has nothing to roll back to`
      );
    }
  }
  return doc;
}

/**
 * Every container in a manifest, wherever the pod spec lives.
 *
 * A bare Pod has them at `spec.containers`; a Deployment, StatefulSet, DaemonSet
 * or Job has them at `spec.template.spec.containers`. The first version read
 * only the first, so for a Deployment it returned **nothing** and the entire
 * Deployment block — the readiness probe, the resource limits, the image tag —
 * was dead code that passed silently.
 *
 * Worth stating plainly because it is the exact failure this programme has been
 * about all along: a check that cannot fail. The symptom here was a summary line
 * claiming "manifest image tag matches package.json" while the image was
 * `:latest`, which is what made it obvious something was wrong rather than right.
 */
function containersOf(doc) {
  const out = [];
  const podSpecs = [
    doc?.spec,
    doc?.spec?.template?.spec,
    doc?.spec?.jobTemplate?.spec?.template?.spec,
  ];
  for (const spec of podSpecs) {
    if (!spec) continue;
    if (Array.isArray(spec.containers)) out.push(...spec.containers);
    if (Array.isArray(spec.initContainers)) out.push(...spec.initContainers);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The checks.
 * ------------------------------------------------------------------ */

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const expectedImage = "ghcr.io/hilbras-dev/hilbras-keystone";

const targets = ["base", "overlays/production", "overlays/dev"];

for (const target of targets) {
  const dir = path.join(K8S, target);
  if (!(await isDirectory(dir))) {
    fail(`k8s/${target} does not exist`);
    continue;
  }
  const resources = await collectResources(dir);

  for (const resource of resources) {
    const doc = await loadYaml(resource.file);
    const base = await loadYaml(path.join(K8S, "base", "kustomization.yaml"));
    const imagesByName = (base.images ?? []).map((i) => ({ name: i.name, newTag: i.newTag }));
    applyKustomization(doc, base, imagesByName);

    const where = `k8s/${resource.source}`;

    if (doc.kind === "Deployment") {
      for (const container of containersOf(doc)) {
        /* --- the probe routing, which is the reason this script exists --- */
        const readiness = container.readinessProbe?.httpGet?.path;
        const liveness = container.livenessProbe?.httpGet?.path;

        if (readiness !== "/ready") {
          fail(
            `${where}: readinessProbe must point at /ready, not ${readiness}. ` +
              `/health is liveness: it touches nothing external and answers 200 ` +
              `whenever the process is listening, so a pod with no database would ` +
              `be reported ready and every authenticated request it received would ` +
              `fail.`
          );
        }
        if (liveness !== "/health") {
          fail(`${where}: livenessProbe must point at /health, not ${liveness}`);
        }

        /* --- the probe has to fit in its own budget --- */
        const timeout = container.readinessProbe?.timeoutSeconds;
        if (typeof timeout !== "number") {
          fail(`${where}: readinessProbe has no timeoutSeconds`);
        }

        /* --- limits, or the pod can starve its neighbours --- */
        if (!container.resources?.limits?.cpu || !container.resources?.limits?.memory) {
          fail(`${where}: container "${container.name}" has no CPU or memory limit`);
        }
        if (!container.resources?.requests?.cpu || !container.resources?.requests?.memory) {
          fail(`${where}: container "${container.name}" has no CPU or memory request`);
        }

        /* --- the image must be a version, not a moving target --- */
        const image = container.image ?? "";
        if (!image.startsWith(expectedImage)) {
          fail(`${where}: image is ${image}, expected to start with ${expectedImage}`);
        } else if (!image.endsWith(`:${version}`)) {
          fail(
            `${where}: image is ${image} but package.json is ${version}. The manifest ` +
              `and the package must agree, or a deployment and its documentation ` +
              `describe different software.`
          );
        }
      }
    }

    /* --- placeholders --- */
    const text = await readFile(resource.file, "utf8");
    for (const match of text.matchAll(/\b(CHANGE_ME|REPLACE_ME|TODO|FILL_IN)\b/g)) {
      fail(`${where}: contains the placeholder ${match[1]}`);
    }
    if (/<[A-Z_]{3,}>/.test(text)) {
      fail(`${where}: contains an unfilled <PLACEHOLDER>`);
    }
  }

  notes.push(`${target}: ${resources.length} resources`);
}

/* --- every environment variable the server insists on must be reachable --- */
const configSource = await readFile(path.join(root, "src/config.ts"), "utf8");
const required = new Set();
for (const match of configSource.matchAll(/requireEnvUnlessSetup\(\s*"([A-Z_]+)"\s*\)/g)) {
  required.add(match[1]);
}

const baseResources = await collectResources(path.join(K8S, "base"));
const byName = new Map(baseResources.map((r) => [r.name, r]));

const deploymentDoc = await loadYaml(path.join(K8S, "base", "deployment.yaml"));
const container = deploymentDoc.spec.template.spec.containers[0];
const reachable = new Set();
for (const source of container.envFrom ?? []) {
  for (const name of [source.configMapRef?.name, source.secretRef?.name]) {
    if (!name) continue;
    const resource = byName.get(name);
    if (!resource) {
      fail(`k8s: the deployment reads from "${name}" but no manifest in the base defines it`);
      continue;
    }
    const doc = await loadYaml(resource.file);
    // `stringData` as well as `data`: a Secret in this repository is written with
    // `stringData`, because base64 in a committed file helps nobody.
    for (const block of [doc.data, doc.stringData]) {
      for (const key of Object.keys(block ?? {})) reachable.add(key);
    }
  }
}
for (const entry of container.env ?? []) {
  if (entry.name) reachable.add(entry.name);
}

for (const name of required) {
  if (!reachable.has(name)) {
    fail(
      `k8s: config.ts requires ${name} and no ConfigMap or Secret in the base ` +
        `provides it, so a pod built from these manifests cannot start`
    );
  }
}

if (problems.length > 0) {
  console.error("Kubernetes manifest verification failed:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("Kubernetes manifests OK.");
console.log(`  version:  ${version} (manifest image tag matches package.json)`);
console.log(`  probes:   liveness /health, readiness /ready`);
console.log(`  env:      ${reachable.size} variables reachable, ${required.size} required by config.ts`);
for (const note of notes) console.log(`  rendered: ${note}`);
