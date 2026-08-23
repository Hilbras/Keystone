import { describe, it } from "node:test";
import assert from "node:assert";
import {
  registerPlugin,
  unregisterPlugin,
  listRegisteredPlugins,
  listExtensionPoints,
  getConnectorFactory,
  getPluginWorkflowStep,
  getAuthenticationMethodFactory,
} from "../services/plugins/registry.js";
import type { KeystonePlugin } from "../services/plugins/types.js";
import type { IdentityConnector } from "../services/connectors/types.js";

describe("Plugin registry", () => {
  it("registers a plugin with metadata and extension points", () => {
    const plugin: KeystonePlugin = {
      metadata: { name: "test-plugin", version: "1.0.0", description: "Test" },
      connectors: {
        test: () =>
          ({
            id: "test",
            name: "Test",
            type: "test",
            getAuthorizeUrl: () => "",
            exchangeCode: async () => ({ sub: "1", email: "test@example.com" }),
          } satisfies IdentityConnector),
      },
      workflowSteps: {
        testStep: () => ({ output: { done: "true" } }),
      },
      authenticationMethods: {
        testAuth: () => ({
          id: "testAuth",
          name: "Test Auth",
          authenticate: async () => ({ success: false, error: { code: "test", message: "test" } }),
        }),
      },
    };

    registerPlugin(plugin);

    const plugins = listRegisteredPlugins();
    assert.ok(plugins.some((p) => p.metadata.name === "test-plugin"));
    assert.deepStrictEqual(plugins.find((p) => p.metadata.name === "test-plugin")?.extensionPoints.sort(), [
      "authenticationMethods",
      "connectors",
      "workflowSteps",
    ]);

    assert.ok(getConnectorFactory("test"));
    assert.ok(getPluginWorkflowStep("testStep"));
    assert.ok(getAuthenticationMethodFactory("testAuth"));
  });

  it("lists extension points with registered entries", () => {
    const points = listExtensionPoints();
    assert.ok(points.some((p) => p.name === "connectors" && p.registered.includes("test")));
    assert.ok(points.some((p) => p.name === "workflowSteps" && p.registered.includes("testStep")));
  });

  it("unregisters a plugin and removes its extension points", () => {
    const removed = unregisterPlugin("test-plugin");
    assert.strictEqual(removed, true);
    assert.strictEqual(getConnectorFactory("test"), undefined);
    assert.strictEqual(getPluginWorkflowStep("testStep"), undefined);
    assert.strictEqual(getAuthenticationMethodFactory("testAuth"), undefined);
  });

  it("returns false when unregistering an unknown plugin", () => {
    assert.strictEqual(unregisterPlugin("does-not-exist"), false);
  });
});
