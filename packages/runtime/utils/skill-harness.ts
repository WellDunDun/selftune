import type { SkillSetHarnessId } from "@selftune/library";

function normalizedPath(path: string): string {
  return path.split("\\").join("/");
}

export function inferSkillHarness(path: string): SkillSetHarnessId | null {
  const normalized = normalizedPath(path);
  if (normalized.includes("/.claude/skills/")) return "claude_code";
  if (
    normalized.includes("/.opencode/skills/") ||
    normalized.includes("/.config/opencode/skills/")
  ) {
    return "opencode";
  }
  if (normalized.includes("/.openclaw/skills/")) return "openclaw";
  if (normalized.includes("/.pi/agent/skills/") || normalized.includes("/.pi/skills/")) return "pi";
  if (
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.codex/skills/") ||
    normalized.includes("/etc/codex/skills/")
  ) {
    return "codex";
  }
  return null;
}
