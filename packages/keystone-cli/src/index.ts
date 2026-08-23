#!/usr/bin/env node
/**
 * keystone-cli — manage a Hilbras Keystone instance from the terminal.
 *
 * Config is stored in ~/.keystonerc (JSON: { url, email, accessToken }).
 * Access tokens expire; run `keystone login` again when you get 401s.
 */
import { createInterface } from "node:readline";
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".keystonerc");

interface CliConfig {
  url: string;
  email: string;
  accessToken: string;
}

// ---------- args ----------

interface ParsedArgs {
  command: string;
  flags: Record<string, string | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const inlineVal = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = rest[i + 1];
    const value = inlineVal ?? (next !== undefined && !next.startsWith("--") ? (i++, next) : "true");
    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else flags[key] = [existing, value];
  }
  return { command, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : v.split(",")).filter(Boolean);
}

// ---------- config ----------

async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as CliConfig;
    if (!cfg.url || !cfg.accessToken) throw new Error("incomplete");
    return cfg;
  } catch {
    fail("Not logged in. Run: keystone login --url <server> --email <email>");
  }
}

async function saveConfig(cfg: CliConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
}

// ---------- http ----------

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function request<T = unknown>(
  cfg: Pick<CliConfig, "url">,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    fail(`HTTP ${res.status}: non-JSON response from ${path}`);
  }
  if (!res.ok) {
    const err = (data as { error?: string; message?: string }) ?? {};
    if (res.status === 401 && token) fail("Unauthorized (401). Your token may have expired — run `keystone login` again.");
    fail(`HTTP ${res.status} ${method} ${path}: ${err.error ?? err.message ?? text}`);
  }
  return data as T;
}

// ---------- output ----------

function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---------- commands ----------

async function cmdLogin(args: ParsedArgs): Promise<void> {
  const url = flag(args, "url") ?? process.env.KEYSTONE_URL ?? "http://localhost:4001";
  const email = flag(args, "email") ?? fail("--email is required");
  const password = flag(args, "password") ?? (await promptSecret("Password: "));
  const res = await request<{ accessToken: string; user: { id: string; email: string } }>(
    { url },
    "POST",
    "/auth/token-login",
    { email, password },
  );
  await saveConfig({ url, email, accessToken: res.accessToken });
  console.log(`Logged in as ${res.user.email} (${url})`);
  console.log(`Config saved to ${CONFIG_PATH}`);
}

async function cmdLogout(): Promise<void> {
  await unlink(CONFIG_PATH).catch(() => {});
  console.log("Logged out.");
}

async function cmdStatus(): Promise<void> {
  const cfg = await loadConfig();
  const res = await request<{ valid: boolean; user: { id: string; email: string } }>(
    cfg,
    "GET",
    "/auth/validate",
    undefined,
    cfg.accessToken,
  );
  console.log(`Server : ${cfg.url}`);
  console.log(`User   : ${res.user.email} (${res.user.id})`);
  console.log(`Token  : valid`);
}

async function cmdUsersList(): Promise<void> {
  const cfg = await loadConfig();
  const res = await request<{ users: Record<string, unknown>[] }>(cfg, "GET", "/v1/admin/platform/users", undefined, cfg.accessToken);
  printTable(
    (res.users ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      username: u.username,
      createdAt: String(u.createdAt ?? "").slice(0, 10),
    })),
  );
}

async function cmdUsersCreate(args: ParsedArgs): Promise<void> {
  const cfg = await loadConfig();
  const email = flag(args, "email") ?? fail("--email is required");
  const username = flag(args, "username") ?? email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "_");
  const password = flag(args, "password") ?? fail("--password is required (min 8 chars)");
  const name = flag(args, "name");
  const res = await request<{ user: Record<string, unknown> }>(
    cfg,
    "POST",
    "/auth/register",
    { username, email, password, ...(name ? { name } : {}) },
  );
  console.log(`User created: ${res.user?.email ?? email} (id: ${res.user?.id ?? "?"})`);
}

async function cmdOrgsList(): Promise<void> {
  const cfg = await loadConfig();
  const res = await request<{ organizations: Record<string, unknown>[] }>(cfg, "GET", "/v1/admin/organizations", undefined, cfg.accessToken);
  printTable(
    (res.organizations ?? []).map((o) => ({ id: o.id, name: o.name, slug: o.slug, plan: o.plan })),
  );
}

async function cmdOrgsCreate(args: ParsedArgs): Promise<void> {
  const cfg = await loadConfig();
  const name = flag(args, "name") ?? fail("--name is required");
  const res = await request<Record<string, unknown>>(
    cfg,
    "POST",
    "/v1/admin/organizations",
    { name, ...(flag(args, "slug") ? { slug: flag(args, "slug") } : {}), ...(flag(args, "plan") ? { plan: flag(args, "plan") } : {}) },
    cfg.accessToken,
  );
  console.log(`Organization created: ${res.name} (id: ${res.id})`);
}

async function cmdAppsList(): Promise<void> {
  const cfg = await loadConfig();
  const res = await request<{ applications: Record<string, unknown>[] }>(cfg, "GET", "/v1/admin/platform/applications", undefined, cfg.accessToken);
  printTable(
    (res.applications ?? []).map((a) => ({ id: a.id, name: a.name, clientId: a.clientId, orgId: a.orgId })),
  );
}

async function cmdAppsCreate(args: ParsedArgs): Promise<void> {
  const cfg = await loadConfig();
  const org = flag(args, "org") ?? fail("--org <orgId> is required");
  const name = flag(args, "name") ?? fail("--name is required");
  const redirectUris = flagList(args, "redirect-uri");
  const allowedOrigins = flagList(args, "origin");
  const res = await request<Record<string, unknown>>(
    cfg,
    "POST",
    `/v1/admin/organizations/${encodeURIComponent(org)}/applications`,
    { name, ...(redirectUris.length ? { redirectUris } : {}), ...(allowedOrigins.length ? { allowedOrigins } : {}) },
    cfg.accessToken,
  );
  console.log(`Application created: ${res.name}`);
  console.log(`  id:           ${res.id}`);
  console.log(`  clientId:     ${res.clientId}`);
  console.log(`  clientSecret: ${res.clientSecret}`);
  console.log("Store the clientSecret now — it will not be shown again.");
}

async function cmdKeysList(): Promise<void> {
  const cfg = await loadConfig();
  const res = await request<{ keys: Record<string, unknown>[] }>(cfg, "GET", "/auth/api-keys", undefined, cfg.accessToken);
  printTable(
    (res.keys ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: Array.isArray(k.scopes) ? (k.scopes as string[]).join(",") : k.scopes,
      revoked: k.revokedAt ? "yes" : "no",
    })),
  );
}

async function cmdKeysCreate(args: ParsedArgs): Promise<void> {
  const cfg = await loadConfig();
  const name = flag(args, "name") ?? fail("--name is required");
  const scopes = flagList(args, "scopes");
  const res = await request<{ key: string }>(
    cfg,
    "POST",
    "/auth/api-keys",
    { name, ...(scopes.length ? { scopes } : {}) },
    cfg.accessToken,
  );
  console.log(`API key created: ${res.key}`);
  console.log("Store it now — it will not be shown again.");
}

function printHelp(): void {
  console.log(`keystone-cli — manage a Hilbras Keystone instance

Usage: keystone <command> [flags]

Auth:
  login --url <url> --email <email> [--password <pw>]   Log in (saves ~/.keystonerc)
  logout                                                Remove saved credentials
  status                                                Show current session

Users:
  users:list                                            List all users (owner)
  users:create --email <e> --password <pw> [--username <u>] [--name <n>]

Organizations:
  orgs:list                                             List your organizations
  orgs:create --name <n> [--slug <s>] [--plan <p>]

Applications:
  apps:list                                             List all applications (owner)
  apps:create --org <orgId> --name <n> [--redirect-uri <u>]... [--origin <o>]...

API keys:
  keys:list                                             List your API keys
  keys:create --name <n> [--scopes a,b]

Flags can also be given as --flag=value. KEYSTONE_URL env var sets the default server.
`);
}

// ---------- main ----------

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void> | void> = {
  login: cmdLogin,
  logout: cmdLogout,
  status: cmdStatus,
  "users:list": cmdUsersList,
  "users:create": cmdUsersCreate,
  "orgs:list": cmdOrgsList,
  "orgs:create": cmdOrgsCreate,
  "apps:list": cmdAppsList,
  "apps:create": cmdAppsCreate,
  "keys:list": cmdKeysList,
  "keys:create": cmdKeysCreate,
  help: printHelp,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handler = COMMANDS[args.command];
  if (!handler) {
    console.error(`Unknown command: ${args.command}\n`);
    printHelp();
    process.exit(1);
  }
  await handler(args);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
