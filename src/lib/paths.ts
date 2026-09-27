import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path inside the project, independent of how deep the caller sits.
 *
 * Test files reach for fixtures and migrations by counting `../` segments, which
 * silently breaks whenever a suite is moved: the count is right for `src` and
 * wrong for the compiled output in `dist`, or the reverse. `authorization.test.ts`
 * carried exactly that — a fixture path that resolved correctly at one directory
 * depth and not the other, and only surfaced when the suite moved.
 *
 * Anchoring on the nearest `package.json` removes the arithmetic. Both `src` and
 * `dist` sit one or two levels below the project root, so the answer is stable
 * wherever the file lives.
 */
let cachedRoot: string | undefined;

export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the project root from " + import.meta.url);
}

/** Absolute path to a file or directory inside the project. */
export function fromRoot(...segments: string[]): string {
  return path.join(projectRoot(), ...segments);
}

/** Absolute path to a shared test fixture. */
export function fixture(...segments: string[]): string {
  return fromRoot("src", "tests", "fixtures", ...segments);
}

/** Absolute path to the Drizzle migrations folder. */
export function migrationsFolder(): string {
  return fromRoot("src", "db", "migrations");
}

/** Every `.test.ts` under a directory relative to `src/tests`. */
export function testFilesIn(relativeDir: string): string[] {
  const dir = fromRoot("src", "tests", relativeDir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}
