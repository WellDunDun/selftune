import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSelftuneCliEntrypoint } from "../package-root.js";
import type { SelftuneConfig } from "../types.js";

// Agent type detection
// ---------------------------------------------------------------------------

/**
 * Detect which coding agent environment we are running inside.
 *
 * Detection order:
 *   1. Claude Code — ~/.claude/ directory exists AND (`which claude` OR env signals)
 *   2. Codex — $CODEX_HOME set OR `which codex`
 *   3. OpenCode — ~/.local/share/opencode/opencode.db exists OR `which opencode`
 *   4. OpenClaw — ~/.openclaw/agents/ exists OR `which openclaw`
 *   5. Pi — ~/.pi/agent/ exists OR `which pi`
 *   6. "unknown" fallback
 */
const VALID_AGENT_TYPES: SelftuneConfig["agent_type"][] = [
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "pi",
  "unknown",
];

const AGENT_TYPE_CLI_MAP: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  openclaw: "openclaw",
  pi: "pi",
};

export function agentTypeToCli(agentType: string): string | null {
  return AGENT_TYPE_CLI_MAP[agentType] ?? null;
}

export function detectAgentType(
  override?: string,
  homeOverride?: string,
): SelftuneConfig["agent_type"] {
  if (override) {
    if (VALID_AGENT_TYPES.includes(override as SelftuneConfig["agent_type"])) {
      return override as SelftuneConfig["agent_type"];
    }
    console.error(`[WARN] Unknown agent type "${override}", falling back to detection`);
  }

  const home = homeOverride ?? homedir();

  // Claude Code: .claude directory + claude binary
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    if (Bun.which("claude") || process.env.CLAUDE_CODE_ENTRYPOINT) {
      return "claude_code";
    }
  }

  // Codex: env var or binary
  if (process.env.CODEX_HOME || Bun.which("codex")) {
    return "codex";
  }

  // OpenCode: db file or binary
  const opencodeDb = join(home, ".local", "share", "opencode", "opencode.db");
  if (existsSync(opencodeDb) || Bun.which("opencode")) {
    return "opencode";
  }

  // OpenClaw: agents directory or binary
  const openclawDir = join(home, ".openclaw", "agents");
  if (existsSync(openclawDir) || Bun.which("openclaw")) {
    return "openclaw";
  }

  // Pi: .pi directory or binary
  const piDir = join(home, ".pi", "agent");
  if (existsSync(piDir) || Bun.which("pi")) {
    return "pi";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the SelfTune CLI composition root.
 */
export function determineCliPath(override?: string): string {
  if (override) return override;
  return resolveSelftuneCliEntrypoint();
}

// ---------------------------------------------------------------------------
// LLM mode determination
// ---------------------------------------------------------------------------

/**
 * Determine LLM mode and agent CLI based on available signals.
 */
export function determineLlmMode(agentCli: string | null): {
  llm_mode: "agent";
  agent_cli: string | null;
} {
  return { llm_mode: "agent", agent_cli: agentCli };
}
