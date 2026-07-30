import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectLocalHarnessConnections,
  localHarnessRegistry,
  resolveSourceMergeInvocation,
} from "../src/harness-registry.js";

describe("local harness registry", () => {
  test("composes package-owned detection and presentation", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "selftune-harness-registry-"));
    try {
      const sessions = join(homeDir, ".codex", "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "rollout.jsonl"), "");

      const connections = detectLocalHarnessConnections({ homeDir, which: () => null });
      const codex = connections.find((connection) => connection.id === "codex");
      const openclaw = connections.find((connection) => connection.id === "openclaw");

      expect(localHarnessRegistry.clientDescriptors().map((descriptor) => descriptor.id)).toEqual([
        "claude_code",
        "codex",
        "cline",
        "opencode",
        "openclaw",
        "pi",
      ]);
      expect(codex).toMatchObject({
        name: "Codex",
        status: "connected",
        source_merge: { model_override: true },
      });
      expect(openclaw?.source_merge).toBeNull();
      expect(JSON.stringify(connections)).not.toContain(homeDir);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("detects Cline from its package-owned hooks contribution", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "selftune-cline-registry-"));
    try {
      const hooks = join(homeDir, "Documents", "Cline", "Hooks");
      mkdirSync(hooks, { recursive: true });
      for (const hook of ["PostToolUse", "TaskComplete", "TaskCancel"]) {
        writeFileSync(join(hooks, hook), "# selftune-managed\n");
      }

      const cline = detectLocalHarnessConnections({ homeDir, which: () => null }).find(
        (connection) => connection.id === "cline",
      );

      expect(cline).toMatchObject({
        name: "Cline",
        status: "connected",
        hooks_supported: true,
        hooks_installed: true,
        import_available: false,
        source_merge: null,
      });
      expect(cline?.icon.src).toStartWith("data:image/svg+xml,");
      expect(JSON.stringify(cline)).not.toContain(homeDir);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("resolves source-merge invocation from the registered implementation", () => {
    expect(resolveSourceMergeInvocation("claude_code", "opus")).toEqual({
      agent: "claude",
      model: "opus",
    });
    expect(() => resolveSourceMergeInvocation("openclaw", null)).toThrow(
      "OpenClaw does not support agent-assisted source merging",
    );
  });
});
