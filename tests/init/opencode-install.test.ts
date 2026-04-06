import { describe, expect, test } from "bun:test";

import { buildAgentEntries } from "../../cli/selftune/adapters/opencode/install.js";

describe("OpenCode install", () => {
  test("buildAgentEntries discovers bundled agents", () => {
    const entries = buildAgentEntries();
    const names = Object.keys(entries);
    expect(names.length).toBeGreaterThan(0);

    // All entries should have the [selftune] prefix in description
    for (const entry of Object.values(entries)) {
      expect(entry.description).toMatch(/^\[selftune\]/);
      expect(entry.mode).toBe("subagent");
      expect(entry.prompt).toBeDefined();
      expect(typeof entry.prompt).toBe("string");
      expect(entry.prompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("buildAgentEntries returns empty for nonexistent directory", () => {
    const entries = buildAgentEntries("/nonexistent/path");
    expect(Object.keys(entries)).toHaveLength(0);
  });

  test("agent entries do not contain _selftune or other non-standard keys", () => {
    const entries = buildAgentEntries();
    const validKeys = new Set(["description", "name", "mode", "model", "prompt", "tools"]);

    for (const entry of Object.values(entries)) {
      for (const key of Object.keys(entry)) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  test("agent entries use provider/model format for model", () => {
    const entries = buildAgentEntries();
    for (const entry of Object.values(entries)) {
      if (entry.model) {
        expect(entry.model).toContain("/");
      }
    }
  });
});
