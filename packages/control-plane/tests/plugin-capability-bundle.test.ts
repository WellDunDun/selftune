import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makePluginCapabilityBundle,
  projectPluginCapabilityFiles,
} from "../src/domain/plugin-capability-bundle";

const revision = "a".repeat(64);

describe("plugin capability bundle", () => {
  it.effect("requires explicit acceptance for executable and credential risk", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makePluginCapabilityBundle({
          bundleId: "engineering-tools",
          skillSetId: "engineering",
          skillSetRevisionSha256: revision,
          mcpServers: {
            deploy: {
              _tag: "stdio",
              command: "npx",
              args: ["deploy-mcp", "--token", "${DEPLOY_TOKEN}"],
            },
          },
          review: {
            reviewedAt: "2026-08-08T00:00:00.000Z",
            reviewedBy: "user-1",
            acceptedRisks: ["executable_commands"],
          },
        }),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "missing_risk_acceptance");
      }
    }),
  );

  it.effect("projects reviewed MCP capabilities into the versioned Agent Plugins file", () =>
    Effect.gen(function* () {
      const bundle = yield* makePluginCapabilityBundle({
        bundleId: "engineering-tools",
        skillSetId: "engineering",
        skillSetRevisionSha256: revision,
        mcpServers: {
          docs: { _tag: "streamable-http", url: "https://example.com/mcp" },
        },
        review: {
          reviewedAt: "2026-08-08T00:00:00.000Z",
          reviewedBy: "user-1",
          acceptedRisks: ["remote_network"],
        },
      });
      const [file] = projectPluginCapabilityFiles(bundle, "agent-plugins-v1");
      assert.strictEqual(file?.relativePath, "mcp.json");
      assert.include(
        new TextDecoder().decode(file?.content),
        "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      );
      assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(file?.content)), {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          docs: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      });
    }),
  );

  it.effect("rejects insecure non-local remote MCP URLs", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makePluginCapabilityBundle({
          bundleId: "engineering-tools",
          skillSetId: "engineering",
          skillSetRevisionSha256: revision,
          mcpServers: { docs: { _tag: "sse", url: "http://example.com/mcp" } },
          review: {
            reviewedAt: "2026-08-08T00:00:00.000Z",
            reviewedBy: "user-1",
            acceptedRisks: ["remote_network"],
          },
        }),
      );
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("rejects plugin-relative working directories that traverse the package root", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makePluginCapabilityBundle({
          bundleId: "engineering-tools",
          skillSetId: "engineering",
          skillSetRevisionSha256: revision,
          mcpServers: { tools: { _tag: "stdio", command: "node", cwd: "./../outside" } },
          review: {
            reviewedAt: "2026-08-08T00:00:00.000Z",
            reviewedBy: "user-1",
            acceptedRisks: ["executable_commands"],
          },
        }),
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "invalid_working_directory");
      }
    }),
  );

  it.effect("does not misclassify portable plugin path variables as credentials", () =>
    Effect.gen(function* () {
      const bundle = yield* makePluginCapabilityBundle({
        bundleId: "engineering-tools",
        skillSetId: "engineering",
        skillSetRevisionSha256: revision,
        mcpServers: {
          tools: {
            _tag: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.js", "${PLUGIN_DATA}/cache.db"],
          },
        },
        review: {
          reviewedAt: "2026-08-08T00:00:00.000Z",
          reviewedBy: "user-1",
          acceptedRisks: ["executable_commands", "persistent_plugin_data"],
        },
      });
      assert.strictEqual(bundle.bundleId, "engineering-tools");
    }),
  );
});
