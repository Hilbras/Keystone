/**
 * Re-exported from `src/lib/paths.ts`.
 *
 * The helpers moved out of the test tree because they are not test-specific, and
 * because `src/tests` is excluded from the Docker build. The benchmark
 * (`src/bench/hotPaths.ts`) needed `migrationsFolder()` and `fromRoot()`, and
 * importing them from here made the image fail to compile:
 *
 *     src/bench/hotPaths.ts(42,44): error TS2307:
 *       Cannot find module '../tests/helpers/paths.js'
 *
 * A production source file depending on a test helper is the actual defect here;
 * the test tree being absent from the image is only how it was noticed. This file
 * stays so the five test suites that import from `helpers/paths.js` are unchanged.
 */
export {
  projectRoot,
  fromRoot,
  fixture,
  migrationsFolder,
  testFilesIn,
} from "../../lib/paths.js";
