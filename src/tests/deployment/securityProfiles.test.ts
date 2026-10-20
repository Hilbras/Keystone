import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isKnownProfile,
  knownProfiles,
  resolveProfile,
  securityDefaults,
} from "../../config/profiles.js";

/**
 * §6.2. `NODE_ENV` used to be compared with `=== "production"` at every point of
 * use, which meant `staging` silently ran with development defaults. These tests
 * pin the mapping so a new environment cannot be added by typing it.
 */
describe("security profiles", () => {
  it("maps the four documented environments", () => {
    for (const profile of knownProfiles()) {
      assert.equal(resolveProfile(profile), profile);
      assert.equal(isKnownProfile(profile), true);
    }
  });

  it("treats staging as production-like but allows the in-process queue", () => {
    const staging = securityDefaults("staging");
    const production = securityDefaults("production");
    assert.equal(staging.productionLike, true);
    assert.equal(staging.strict, true);
    assert.equal(staging.cookieSecure, true);
    assert.equal(staging.inProcessQueueAllowed, true);
    assert.equal(production.inProcessQueueAllowed, false);
  });

  it("does not relax because an operator typed a different case or a synonym", () => {
    // The dangerous direction is guessing production when the deployment is not
    // (a test that cannot boot), so an unknown value resolves to development —
    // and the validator reports the unknown value rather than hiding it.
    for (const unknown of ["Production", "prod", "PRODUCTION", "staging2", ""]) {
      assert.equal(resolveProfile(unknown), "development");
      assert.equal(isKnownProfile(unknown), false);
    }
    assert.equal(resolveProfile(undefined), "development");
  });

  it("keeps test quiet", () => {
    const test = securityDefaults("test");
    assert.equal(test.productionLike, false);
    assert.equal(test.strict, false);
  });
});
