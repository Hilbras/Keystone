#!/usr/bin/env node
/**
 * §9.1 — the contract freeze.
 *
 * A freeze is not a promise; it is a mechanism that makes a change *visible*.
 * The seven contracts below are the ones a caller can depend on:
 *
 *   - the REST API (which paths, which methods, which tags)
 *   - the OAuth behaviour (the discovery metadata and the error codes)
 *   - the token format (the claims, the algorithm, the audience)
 *   - the database contracts (the tables, the columns, the migrations)
 *   - the webhook format (the headers, the body)
 *   - the SDK interfaces (what each package publishes)
 *   - the configuration (which environment variables are read)
 *
 * Each is read from the running code, not from a document, and compared with a
 * committed snapshot. A change to any of them makes this gate fail with the
 * exact difference, and the only way past it is to update the snapshot — which
 * puts the change in the diff, where a reviewer sees it.
 *
 * That is the whole point. A contract that "must not change" and fails only
 * when somebody remembers to check is a contract that changes. One that fails
 * on every change, and is updated deliberately, is a contract that is *managed*.
 *
 * `--update` rewrites the snapshot. It is meant to be run on purpose, in the
 * same commit as the change, so the two are reviewed together.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(ROOT, "docs", "contract-freeze.json");
const UPDATE = process.argv.includes("--update");

function fail(message) {
  console.error(`  - ${message}`);
}

/** The contract sections, in the order they are reported. */
const SECTIONS = [
  "restApi",
  "oauth",
  "tokenFormat",
  "database",
  "webhookFormat",
  "sdkInterfaces",
  "configuration",
];

// ---------------------------------------------------------------------------
// Reading the contracts
// ---------------------------------------------------------------------------

/**
 * The REST API, from the OpenAPI document the server serves.
 *
 * The document is generated from the route registrations, so it is the
 * authoritative list of what the server actually answers — not a list someone
 * maintained. The tags are part of it because a generated client groups by
 * them, so a retag is a change to a published contract.
 */
async function readRestApi() {
  const { buildApp } = await import(pathToFileURL(path.join(ROOT, "dist", "index.js")).href);
  const app = await buildApp();
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  const spec = response.json();

  const operations = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      operations.push(`${method.toUpperCase()} ${path} [${(operation.tags ?? []).join(",")}]`);
    }
  }
  operations.sort();

  // The discovery document is the OAuth contract's public face, and it is
  // served by the same app, so it is read here rather than parsed.
  const discovery = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
  await app.close();

  return {
    operations,
    discovery: discovery.statusCode === 200 ? discovery.json() : { error: discovery.statusCode },
  };
}

/**
 * The OAuth error codes a client can receive.
 *
 * Read from the two places that define them: the routes that send them, and
 * the allowlist that keeps RFC-shaped envelopes intact. Both are source
 * because neither is exported as a runtime value — the codes are literals in
 * a `send()` call, and the allowlist is a module-private set.
 */
function readOAuthErrorCodes() {
  const routeSource = readFileSync(path.join(ROOT, "src", "routes", "oauth2.ts"), "utf8");
  const sent = new Set();
  for (const match of routeSource.matchAll(/error:\s*"([a-z_]+)"/g)) sent.add(match[1]);

  const typesSource = readFileSync(path.join(ROOT, "src", "lib", "errors.ts"), "utf8");
  const union = /export type OAuthErrorCode =([\s\S]*?);/.exec(typesSource);
  const declared = new Set();
  if (union) {
    for (const match of union[1].matchAll(/"([a-z_]+)"/g)) declared.add(match[1]);
  }

  const contractSource = readFileSync(path.join(ROOT, "src", "plugins", "errorContract.ts"), "utf8");
  const allowlist = /const OAUTH_ERROR_CODES = \[([\s\S]*?)\];/.exec(contractSource);
  const preserved = new Set();
  if (allowlist) {
    for (const match of allowlist[1].matchAll(/"([a-z_]+)"/g)) preserved.add(match[1]);
  }

  return {
    sentByRoutes: [...sent].sort(),
    declaredType: [...declared].sort(),
    preservedEnvelopes: [...preserved].sort(),
  };
}

/**
 * The token format, read from a token the server actually mints.
 *
 * Decoding a real token is the only way to be sure the contract is the one a
 * client will see. A list of claim names written by hand drifts from the
 * signer; a decoded token cannot.
 */
async function readTokenFormat() {
  const tokens = await import(pathToFileURL(path.join(ROOT, "dist", "services", "tokens.js")).href);
  await tokens.loadSigningKeys();

  const user = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "contract@example.test",
    username: "contract",
    name: "Contract",
    plan: "free",
    role: "owner",
    provider: "local",
    isActive: true,
    totpEnabled: false,
  };

  const access = await tokens.createAccessToken(user, { orgId: "org-1", clientId: "client-1" });
  const [header, payload] = access.split(".").slice(0, 2).map((part) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  );

  const idToken = await tokens.createIdToken(
    user,
    { clientId: "client-1", name: "App" },
    "nonce-1"
  );
  const [, idPayload] = idToken.split(".").slice(0, 2).map((part) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  );

  return {
    algorithm: header.alg,
    typ: header.typ,
    hasKid: typeof header.kid === "string" && header.kid.length > 0,
    accessTokenClaims: Object.keys(payload).sort(),
    accessTokenAudience: payload.aud,
    accessTokenIssuer: payload.iss,
    idTokenClaims: Object.keys(idPayload).sort(),
  };
}

/**
 * The database contracts: the tables, their columns, and the migrations.
 *
 * Read from the compiled schema, so the snapshot is the schema the application
 * will run against — not a list of what someone remembered to write down. A
 * column that is not-null, has no default, or has a particular type is part
 * of the contract: a migration that changes one of those changes what an
 * upgrade does.
 */
async function readDatabase() {
  const schema = await import(pathToFileURL(path.join(ROOT, "dist", "db", "schema.js")).href);
  const { getTableName, isTable } = await import("drizzle-orm");

  const tables = {};
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const name = getTableName(value);
    const columns = {};
    for (const [columnName, column] of Object.entries(value)) {
      if (!column || typeof column !== "object") continue;
      if (typeof column.getSQLType !== "function") continue;
      columns[columnName] = {
        type: column.getSQLType(),
        notNull: Boolean(column.notNull),
        hasDefault: Boolean(column.hasDefault),
      };
    }
    tables[name] = Object.fromEntries(
      Object.entries(columns).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
  }

  const journal = JSON.parse(
    readFileSync(path.join(ROOT, "dist", "db", "migrations", "meta", "_journal.json"), "utf8")
  );

  return {
    tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : 1))),
    migrations: journal.entries.map((entry) => entry.tag),
  };
}

/**
 * The webhook format: the headers a delivery carries, and the body's keys.
 *
 * Read from the source because that is where they are written, and both live
 * in one function in one file — a narrow enough place that reading it is
 * safer than inventing a runtime seam for it.
 */
function readWebhookFormat() {
  const source = readFileSync(path.join(ROOT, "src", "services", "webhooks.ts"), "utf8");

  const headers = new Set();
  for (const match of source.matchAll(/"(X-Keystone-[A-Za-z-]+)"/g)) headers.add(match[1]);

  const bodyBlock = /const body = \{([\s\S]*?)\n {4}\};/.exec(source);
  const bodyKeys = [];
  if (bodyBlock) {
    for (const match of bodyBlock[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*[:,]/gm)) {
      bodyKeys.push(match[1]);
    }
  }

  return { headers: [...headers].sort(), bodyKeys: bodyKeys.sort() };
}

/**
 * The source entry point of a package.
 *
 * Not always `index.ts`: the React package's entry is `index.tsx`, because
 * it contains JSX. A gate that assumes one filename and finds nothing reports
 * "this package exports nothing", which is a wrong answer rather than a
 * missing one.
 */
function sourceEntry(packageDirectory) {
  for (const name of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
    const candidate = path.join(packageDirectory, "src", name);
    // Readable rather than present: a file that exists but cannot be read is
    // not an entry point either, and the difference only shows up later.
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The SDK interfaces: what each package publishes.
 *
 * The manifest is the published contract — the name, the entry points, the
 * files that ship. The exported names are read from the package's **source**
 * entry point, following `export … from` so a re-exported name is still a name
 * the package publishes.
 *
 * The source, not the built declaration: the declaration file is a faithful
 * rendering of the source, but it only exists once the package has been
 * built, and a gate that needs another gate's side effect is a gate whose
 * result depends on the order the steps run in.
 */
function readSdkInterfaces() {
  const packagesDir = path.join(ROOT, "packages");
  const packages = {};

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(path.join(packagesDir, entry.name, "package.json"), "utf8")
      );
    } catch {
      continue;
    }
    const entryPoint = sourceEntry(path.join(packagesDir, entry.name));

    packages[entry.name] = {
      name: manifest.name,
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports ?? null,
      bin: manifest.bin ?? null,
      files: manifest.files ?? null,
      dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
      peerDependencies: Object.keys(manifest.peerDependencies ?? {}).sort(),
      exported: entryPoint ? exportedNames(entryPoint, ".ts") : [],
    };
  }

  return Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The names a module publishes, following its re-exports.
 *
 * `extension` is what a re-exported path resolves to: the source tree
 * resolves `./types.js` to `types.ts`, and a built declaration tree resolves it
 * to `types.d.ts`.
 */
function exportedNames(entryPath, extension, seen = new Set()) {
  if (seen.has(entryPath)) return [];
  // Read first, and treat a missing file as "no exports". Checking that the
  // file exists and then reading it is a race: the file can be gone between
  // the two, and the failure is then "the file is missing" rather than
  // "there is nothing there" — which reads like a broken package.
  let source;
  try {
    source = readFileSync(entryPath, "utf8");
  } catch {
    return [];
  }
  seen.add(entryPath);
  const names = new Set();

  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|class|function|const|let|var|type|enum|namespace)\s+([A-Za-z0-9_$]+)/gm
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name.replace(/^type\s+/, ""));
    }
  }
  for (const match of source.matchAll(/^export\s+\*\s+from\s+"([^"]+)"/gm)) {
    const target = path.resolve(
      path.dirname(entryPath),
      match[1].replace(/\.js$/, extension)
    );
    for (const name of exportedNames(target, extension, seen)) names.add(name);
  }

  return [...names].sort();
}

/**
 * The configuration: the environment variables the server reads.
 *
 * Every one the application reads, from the configuration module and from
 * anywhere else that reaches for `process.env` directly. A variable the
 * server reads is part of how it is configured, and renaming one is a breaking
 * change for whoever set it.
 *
 * The test suite is excluded. A test that raises a rate-limit budget for
 * itself is not the product's configuration, and including it would mean the
 * contract could not tell "the server stopped reading this" from "a test
 * still sets it" — the first is a breaking change, the second is a test that
 * needs updating.
 */
function readConfiguration() {
  const variables = new Set();

  const configSource = readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
  for (const match of configSource.matchAll(/getEnv\(\s*"([A-Z0-9_]+)"/g)) variables.add(match[1]);
  for (const match of configSource.matchAll(/requireEnv\(\s*"([A-Z0-9_]+)"/g)) variables.add(match[1]);

  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    if (file.endsWith("config.ts")) continue;
    if (file.includes(`${path.sep}tests${path.sep}`)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) variables.add(match[1]);
  }

  return [...variables].sort();
}

/** Every `.ts` file under a directory, except the test tree. */
function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") continue;
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** The difference between two contract readings, in words. */
function describeDifference(before, after, section = "contract") {
  const differences = [];

  const beforeText = JSON.stringify(before);
  const afterText = JSON.stringify(after);
  if (beforeText === afterText) return differences;

  const walk = (a, b, pathParts) => {
    if (a === b) return;
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);

    if (aIsArray && bIsArray) {
      const aSet = new Set(a.map((item) => JSON.stringify(item)));
      const bSet = new Set(b.map((item) => JSON.stringify(item)));
      for (const item of aSet) {
        if (!bSet.has(item)) differences.push(`removed ${pathParts.join(".")}: ${item}`);
      }
      for (const item of bSet) {
        if (!aSet.has(item)) differences.push(`added ${pathParts.join(".")}: ${item}`);
      }
      return;
    }

    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], [...pathParts, key]);
      }
      return;
    }

    differences.push(`changed ${pathParts.join(".")}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  };

  walk(before, after, [section]);
  return differences;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

try {
  readFileSync(path.join(ROOT, "dist", "index.js"), "utf8");
} catch {
  console.error("verify:contract needs a build. Run `npm run build` first.");
  process.exit(2);
}

// The token reader needs its key material in the environment before the
// configuration is read, which is why it is set here rather than inside the
// reader: the configuration module caches the environment on its first import,
// and by then the key would be too late. Without a key the signing service
// falls back to the database-backed secrets provider, and this gate would
// need a database it deliberately does not have.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
process.env.KEYSTONE_QUEUE_PROVIDER = process.env.KEYSTONE_QUEUE_PROVIDER ?? "in-process";
process.env.KEYSTONE_INTERNAL_API_KEY = process.env.KEYSTONE_INTERNAL_API_KEY ?? "contract-freeze";
process.env.KEYSTONE_ENCRYPTION_KEY =
  process.env.KEYSTONE_ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef";
// The gate reads the application, so the application logs. Nobody is watching
// a request log here, and it buries the one line that matters.
process.env.KEYSTONE_LOG_LEVEL = process.env.KEYSTONE_LOG_LEVEL ?? "error";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const current = {
  restApi: await readRestApi(),
  oauth: readOAuthErrorCodes(),
  tokenFormat: await readTokenFormat(),
  database: await readDatabase(),
  webhookFormat: readWebhookFormat(),
  sdkInterfaces: readSdkInterfaces(),
  configuration: readConfiguration(),
};

if (UPDATE) {
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    existing = {};
  }
  const merged = { ...existing, ...current, frozenAt: new Date().toISOString().slice(0, 10) };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`Contract snapshot written to ${path.relative(ROOT, SNAPSHOT_PATH)}.`);
  console.log("Review the diff: a contract changed, and the snapshot says so.");
  process.exit(0);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  console.error(`No contract snapshot at ${path.relative(ROOT, SNAPSHOT_PATH)}.`);
  console.error("Run `npm run verify:contract -- --update` to create it, and review the result.");
  process.exit(1);
}
let failures = 0;

for (const section of SECTIONS) {
  const before = snapshot[section];
  const after = current[section];
  if (before === undefined) {
    console.error(`The snapshot has no "${section}" section.`);
    failures += 1;
    continue;
  }
  const differences = describeDifference(before, after, section);
  if (differences.length === 0) continue;
  failures += 1;
  console.error(`\nThe ${section} contract changed:`);
  for (const difference of differences.slice(0, 20)) fail(difference);
  if (differences.length > 20) {
    fail(`... and ${differences.length - 20} more`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} contract(s) changed. A frozen contract may only change on purpose:`
  );
  console.error("  npm run verify:contract -- --update");
  console.error("and put the snapshot change in the same commit as the code change,");
  console.error("so a reviewer sees both. See docs/CONTRACTS.md.");
  process.exit(1);
}

console.log("Contract freeze OK.");
for (const section of SECTIONS) {
  console.log(`  ${section}: unchanged`);
}

// An explicit exit, because the gate read the application and the application
// holds a Redis socket. A gate that waits for a socket to drain is a gate that
// hangs on a machine with a busy event loop — and a hanging gate is a gate
// people learn to ignore.
process.exit(0);
