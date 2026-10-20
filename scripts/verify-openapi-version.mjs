#!/usr/bin/env node
/**
 * The published OpenAPI document must describe the server that is running.
 *
 * §7.1. It described neither: `info.version` was the literal `"3.0.1"` against a
 * package at 3.11.0, only eight of ~185 routes had any schema, and there was no
 * `GET /openapi.json` at all — the document existed only as a side effect of the
 * documentation UI. A client generator therefore produced code for a version that
 * never existed, against a document that knew nothing about most of the API.
 *
 * The version is now read from `package.json`, so it cannot disagree by
 * construction. This gate exists for the other half: the mechanism that makes it
 * true (`new URL("../../package.json", import.meta.url)` from `src/lib` and
 * `dist/lib`) is a fact about the build layout, and the next person to move the
 * file will break it silently. It also keeps the document *usable* — every
 * operation tagged, every tag declared, the credential schemes present — because
 * a contract that parses but groups nothing is a contract nobody can generate
 * from.
 *
 * The app is booted for real and queried through `inject`, so this checks what a
 * client would receive rather than what the source appears to say. No database is
 * reached: route registration does not query, and `DATABASE_URL` is set to a
 * deliberately unreachable address so a regression that starts querying during
 * registration fails here instead of hanging CI.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.KEYSTONE_QUEUE_PROVIDER ||= "in-process";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "openapi-verify-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const problems = [];
const fail = (message) => problems.push(message);

const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const entry = path.join(root, "dist", "index.js");
if (!existsSync(entry)) {
  console.error("dist/index.js is missing. Run `npm run build` before this gate.");
  process.exit(1);
}

const source = await readFile(path.join(root, "src", "index.ts"), "utf8");
const hardcoded = /version:\s*["']\d+\.\d+\.\d+["']/.exec(source);
if (hardcoded) {
  fail(
    `src/index.ts still hard-codes an OpenAPI version (${hardcoded[0]}); ` +
      "read it from package.json instead."
  );
}

const { buildApp } = await import(pathToFileURL(entry).href);
const app = await buildApp();
await app.ready();

let spec;
try {
  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  if (response.statusCode !== 200) {
    fail(`GET /openapi.json returned ${response.statusCode}: ${response.body.slice(0, 200)}`);
  } else {
    const contentType = String(response.headers["content-type"] ?? "");
    if (!contentType.includes("application/json")) {
      fail(`GET /openapi.json served ${contentType || "no content type"}, expected JSON`);
    }
    try {
      spec = JSON.parse(response.body);
    } catch (error) {
      fail(`GET /openapi.json did not return valid JSON: ${error.message}`);
    }
  }
} finally {
  await app.close().catch(() => {});
}

if (spec) {
  if (spec.info?.version !== manifest.version) {
    fail(
      `OpenAPI info.version is ${JSON.stringify(spec.info?.version)} but package.json is ` +
        `${JSON.stringify(manifest.version)}`
    );
  }

  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    fail(`OpenAPI document declares ${JSON.stringify(spec.openapi)}, expected an OpenAPI 3.x version`);
  }

  const schemes = spec.components?.securitySchemes ?? {};
  for (const scheme of ["bearerAuth", "apiKey"]) {
    if (!schemes[scheme]) fail(`components.securitySchemes.${scheme} is missing`);
  }

  const declaredTags = new Set((spec.tags ?? []).map((tag) => tag.name));
  const paths = spec.paths ?? {};
  const operations = [];
  for (const [url, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
        operations.push({ url, method, operation });
      }
    }
  }

  const pathCount = Object.keys(paths).length;
  if (pathCount < 100) {
    fail(`the document lists ${pathCount} paths, which is below the 100-route floor`);
  }

  for (const { url, method, operation } of operations) {
    const tags = operation.tags ?? [];
    if (!Array.isArray(tags) || tags.length === 0) {
      fail(`${method.toUpperCase()} ${url} has no tag`);
      continue;
    }
    for (const tag of tags) {
      if (!declaredTags.has(tag)) {
        fail(`${method.toUpperCase()} ${url} uses undeclared tag ${JSON.stringify(tag)}`);
      }
    }
  }

  for (const required of [
    "/auth/login",
    "/auth/register",
    "/oauth2/token",
    "/.well-known/jwks.json",
    "/health",
    "/ready",
  ]) {
    if (!paths[required]) fail(`the document does not describe ${required}`);
  }
}

if (problems.length > 0) {
  console.error("The OpenAPI contract does not match the server:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(
  `OpenAPI contract OK: version ${manifest.version}, ${Object.keys(spec.paths ?? {}).length} paths, ` +
    `${Object.keys(spec.components?.securitySchemes ?? {}).length} security schemes.`
);
process.exit(0);
