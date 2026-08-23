import { describe, it } from "node:test";
import assert from "node:assert";
import { getConfigurationProfile, listConfigurationProfiles } from "../services/configuration/profiles.js";

describe("Configuration profiles", () => {
  it("lists all predefined profiles", () => {
    const profiles = listConfigurationProfiles();
    assert.ok(profiles.some((p) => p.id === "development"));
    assert.ok(profiles.some((p) => p.id === "production"));
    assert.ok(profiles.some((p) => p.id === "docker"));
    assert.ok(profiles.some((p) => p.id === "docker-compose"));
    assert.ok(profiles.some((p) => p.id === "kubernetes"));
    assert.ok(profiles.some((p) => p.id === "high-availability"));
  });

  it("returns a profile with values", () => {
    const profile = getConfigurationProfile("development");
    assert.ok(profile);
    assert.strictEqual(profile.values.NODE_ENV, "development");
    assert.ok(profile.values.DATABASE_URL);
  });

  it("returns undefined for unknown profiles", () => {
    assert.strictEqual(getConfigurationProfile("unknown"), undefined);
  });
});
