import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { detectDesktopInstallerAgents } from "./desktop-agent-detection";

describe("Desktop installer agent detection", () => {
  it("reports read-only evidence without selecting an agent", () => {
    const homeDirectory = join("home", "user");
    const existing = new Set([
      join(homeDirectory, ".codex"),
      join(homeDirectory, ".config", "opencode"),
    ]);
    expect(detectDesktopInstallerAgents(homeDirectory, (path) => existing.has(path))).toEqual([
      { agent: "codex", evidence: ["Codex configuration detected"] },
      { agent: "claude_code", evidence: [] },
      { agent: "opencode", evidence: ["OpenCode configuration detected"] },
      { agent: "openclaw", evidence: [] },
      { agent: "pi", evidence: [] },
    ]);
  });
});
