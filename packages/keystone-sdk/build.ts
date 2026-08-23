import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, "src/index.ts");
const dist = path.resolve(__dirname, "dist");

async function build() {
  await fs.mkdir(dist, { recursive: true });

  // ESM build for bundlers
  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    outfile: path.join(dist, "keystone-sdk.mjs"),
    platform: "browser",
    target: "es2020",
  });

  // CommonJS build for Node.js tooling
  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    format: "cjs",
    outfile: path.join(dist, "keystone-sdk.cjs"),
    platform: "browser",
    target: "es2020",
  });

  // IIFE build for CDN / script tag
  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    format: "iife",
    globalName: "KeystoneSdkGlobal",
    outfile: path.join(dist, "keystone-sdk.iife.js"),
    platform: "browser",
    target: "es2020",
  });

  // Copy IIFE as dropin.js for convenience
  await fs.copyFile(path.join(dist, "keystone-sdk.iife.js"), path.join(dist, "keystone-dropin.js"));

  console.log("SDK built successfully:");
  for (const file of await fs.readdir(dist)) {
    const stat = await fs.stat(path.join(dist, file));
    console.log(`  ${file} — ${(stat.size / 1024).toFixed(2)} KB`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
