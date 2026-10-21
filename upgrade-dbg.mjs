const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const run = promisify(execFile);
const postgres = (await import("postgres")).default;
const DATABASE_URL = "postgresql://hilbras:hilbras@127.0.0.1:5433/hilbras";
const name = "keystone_rc_upgrade_dbg";
const admin = postgres(DATABASE_URL, { max: 1 });
await admin.unsafe(`drop database if exists ${name}`);
await admin.unsafe(`create database ${name}`);
await admin.end();
const url = new URL(DATABASE_URL); url.pathname = `/${name}`;
const target = url.toString();
try {
  const scratch = "/tmp/rc-upgrade-dbg";
  await run("rm", ["-rf", scratch]);
  await run("mkdir", ["-p", scratch]);
  await run("npm", ["init", "-y"], { cwd: scratch });
  console.log("installing 3.13.0…");
  await run("npm", ["install", "@hilbras/keystone@3.13.0", "--no-audit", "--no-fund"], { cwd: scratch, maxBuffer: 16*1024*1024, timeout: 600000 });
  console.log("migrating 3.13.0…");
  await run("node", [`${scratch}/node_modules/@hilbras/keystone/dist/cli.js`, "migrate"], { cwd: scratch, env: { ...process.env, DATABASE_URL: target }, maxBuffer: 16*1024*1024 });
  console.log("3.13.0 migrated OK");
  const client = postgres(target, { max: 1 });
  const cols = await client`select column_name from information_schema.columns where table_name='organizations' and table_schema='public' order by ordinal_position`;
  console.log("organizations columns:", cols.map(c=>c.column_name).join(","));
  await client.unsafe(`insert into organizations (id, name, slug, plan, created_at, updated_at) values ('44444444-4444-4444-4444-444444444444', 'Before the upgrade', 'before-upgrade', 'free', now(), now())`);
  console.log("row inserted");
  await client.end();
} catch (e) {
  console.log("FAILED:", e.message?.slice(0, 600));
  console.log("stdout:", String(e.stdout).slice(0, 400));
  console.log("stderr:", String(e.stderr).slice(0, 800));
}
