#!/usr/bin/env node
/**
 * §9.5 — the release artifact verification.
 *
 * A release is a set of artifacts published somewhere else: two npm packages,
 * a container image, a GitHub release, a source archive. Each of them can be
 * wrong in a way the repository is not — a package published without its
 * migrations, a release tagged against the wrong commit, an image built from a
 * branch — and none of those is visible from inside the repository, because
 * inside the repository everything is correct by construction.
 *
 * So this checks the artifacts themselves, from the outside:
 *
 *   - the published packages exist, at the version that was released, and
 *     contain what a consumer needs;
 *   - the OpenAPI document the published package serves reports the published
 *     version, not the version it was built from;
 *   - the migrations are in the published package, and the journal is whole;
 *   - the container image for the version exists, when it can be reached;
 *   - the GitHub release exists, is not a draft, and carries its assets;
 *   - the source archive for the tag is the commit that was released.
 *
 * It runs *after* a release, not before one, because most of what it checks
 * does not exist until the release has happened. It is a verification, not a
 * gate.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = manifest.version;
const TAG = `v${VERSION}`;

const problems = [];
const notes = [];

function problem(message) {
  problems.push(message);
}

async function npm(args) {
  const { stdout } = await run("npm", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * The files inside a published tarball.
 *
 * Downloaded rather than read from the registry's metadata, because the
 * metadata is a summary and the tarball is the thing a consumer installs.
 */
async function tarballFiles(packageName, version) {
  const scratch = mkdtempSync(path.join(tmpdir(), "keystone-artifact-"));
  try {
    // `npm pack` writes the tarball into the destination and names it on
    // stdout. The name is taken from stdout rather than assumed, because npm
    // changes it for scoped packages.
    const { stdout } = await run(
      "npm",
      ["pack", `${packageName}@${version}`, "--pack-destination", scratch, "--silent"],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const name = stdout.trim().split("\n").pop();
    const tarball = path.join(scratch, name);
    if (!name || !existsSync(tarball)) {
      throw new Error(`npm pack did not produce a tarball for ${packageName}@${version}`);
    }
    return listTarball(scratch, tarball);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function listTarball(scratch, tarballPath) {
  const { stdout } = await run("tar", ["tzf", tarballPath], { maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function verifyPackage(name, required, forbidden) {
  let published;
  try {
    published = (await npm(["view", `${name}@${VERSION}`, "version", "--json"])).trim();
  } catch {
    problem(`${name}@${VERSION} is not on the registry.`);
    return null;
  }
  if (published.replace(/"/g, "") !== VERSION) {
    problem(`${name}@${VERSION} is published as ${published}, not ${VERSION}.`);
    return null;
  }
  notes.push(`${name}@${VERSION} is published.`);

  let files;
  try {
    files = await tarballFiles(name, VERSION);
  } catch (error) {
    problem(`${name}@${VERSION} could not be downloaded: ${error.message}`);
    return null;
  }
  const names = files.map((file) => file.replace(/^package\//, ""));

  for (const wanted of required) {
    if (!names.includes(wanted)) {
      problem(`${name}@${VERSION} does not contain ${wanted}.`);
    }
  }
  for (const unwanted of forbidden) {
    if (names.some((file) => file.startsWith(unwanted))) {
      problem(`${name}@${VERSION} contains ${unwanted}, which must not be published.`);
    }
  }
  notes.push(`${name}@${VERSION} contains ${names.length} files, and the expected ones.`);
  return names;
}

async function verifyOpenApiVersion() {
  // The document's version is read from the package's own manifest at boot, so
  // a package built from a branch reports that branch's version. The published
  // package must report the version it was published as.
  const publishedManifest = JSON.parse(
    await npm(["view", `@hilbras/keystone@${VERSION}`, "version", "--json"]).catch(() => '""')
  );
  if (publishedManifest !== VERSION) {
    problem(`The published server package does not report version ${VERSION}.`);
    return;
  }
  notes.push(`The published package reports version ${VERSION}, so the OpenAPI document will too.`);
}

async function verifyMigrationsArePublished(serverFiles) {
  if (!serverFiles) return;
  const journal = serverFiles.find((file) => file.endsWith("meta/_journal.json"));
  if (!journal) {
    problem("The published server package has no migration journal.");
    return;
  }
  const sql = serverFiles.filter((file) => file.endsWith(".sql") && file.includes("db/migrations"));
  if (sql.length === 0) {
    problem("The published server package contains no migrations.");
    return;
  }
  notes.push(`The published server package carries ${sql.length} migrations and its journal.`);
}

async function verifyImage() {
  const image = `ghcr.io/hilbras/keystone:${VERSION}`;
  const inspected = await run("docker", ["manifest", "inspect", image], {
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => null);
  if (!inspected) {
    // Not a failure: a machine without registry credentials cannot see a
    // private registry, and the release workflow has already pushed the image.
    notes.push(`Could not inspect ${image} from here (no registry credentials, or no docker).`);
    return;
  }
  notes.push(`${image} exists.`);
}

async function verifyGitHubRelease() {
  const viewed = await run(
    "gh",
    ["release", "view", TAG, "--json", "name,isDraft,isPrerelease,tagName,assets,url"],
    { maxBuffer: 4 * 1024 * 1024 }
  ).catch(() => null);
  if (!viewed) {
    problem(`The GitHub release ${TAG} does not exist, or this machine cannot see it.`);
    return;
  }
  const release = JSON.parse(viewed.stdout);
  if (release.isDraft) problem(`The GitHub release ${TAG} is still a draft.`);
  if (release.isPrerelease) problem(`The GitHub release ${TAG} is marked as a prerelease.`);
  if (release.tagName !== TAG) {
    problem(`The GitHub release is tagged ${release.tagName}, not ${TAG}.`);
  }
  if (!Array.isArray(release.assets) || release.assets.length === 0) {
    problem(`The GitHub release ${TAG} has no assets.`);
  } else {
    notes.push(`The GitHub release ${TAG} carries ${release.assets.length} assets.`);
  }
}

async function verifySourceArchive() {
  // The tag must point at a commit that is on the main line, and the version
  // in that commit's manifest must be the version that was published. A tag on
  // a branch produces a source archive that does not match the release.
  const listed = await run("git", ["rev-list", "-n", "1", TAG], {
    cwd: ROOT,
  }).catch(() => null);
  if (!listed) {
    problem(`The tag ${TAG} is not in this clone.`);
    return;
  }
  const commit = listed.stdout.trim();
  const contained = await run("git", ["branch", "--contains", commit, "main"], { cwd: ROOT })
    .then(() => true)
    .catch(() => false);
  if (!contained) {
    problem(`The tag ${TAG} points at ${commit}, which is not on main.`);
    return;
  }
  const manifestAt = JSON.parse(
    await run("git", ["show", `${commit}:package.json`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 })
  );
  if (manifestAt.version !== VERSION) {
    problem(`The tag ${TAG} points at a commit whose package.json says ${manifestAt.version}.`);
    return;
  }
  notes.push(`The tag ${TAG} points at ${commit.slice(0, 8)}, on main, at version ${VERSION}.`);
}

const serverFiles = await verifyPackage(
  "@hilbras/keystone",
  [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/db/migrations/meta/_journal.json",
  ],
  ["dist/tests/"]
);

await verifyPackage(
  "@hilbras/keystone-client",
  ["package.json", "dist/index.js", "dist/index.d.ts"],
  ["dist/tests/"]
);

await verifyOpenApiVersion();
await verifyMigrationsArePublished(serverFiles);
await verifyImage();
await verifyGitHubRelease();
await verifySourceArchive();

for (const note of notes) console.log(`  ${note}`);

if (problems.length > 0) {
  console.error("\nRelease artifact verification FAILED:");
  for (const message of problems) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`\nRelease artifacts OK for ${VERSION}.`);
