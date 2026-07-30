import { describe, expect, it } from "bun:test";

import { detectDesktopInstallerAgents } from "./desktop-agent-detection";

describe("Desktop installer agent detection", () => {
  it("reports read-only evidence without selecting an agent", () => {
    const existing = new Set(["/home/user/.codex", "/home/user/.config/opencode"]);
    expect(detectDesktopInstallerAgents("/home/user", (path) => existing.has(path))).toEqual([
      { agent: "codex", evidence: ["Codex configuration detected"] },
      { agent: "claude_code", evidence: [] },
      { agent: "opencode", evidence: ["OpenCode configuration detected"] },
      { agent: "openclaw", evidence: [] },
      { agent: "pi", evidence: [] },
    ]);
  });
});
