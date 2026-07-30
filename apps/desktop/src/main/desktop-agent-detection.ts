import { join } from "node:path";

import type { AgentDetectionObservation } from "@selftune/runtime/installer";

export function detectDesktopInstallerAgents(
  homeDirectory: string,
  exists: (path: string) => boolean,
): ReadonlyArray<AgentDetectionObservation> {
  const candidates = [
    {
      agent: "codex" as const,
      path: join(homeDirectory, ".codex"),
      evidence: "Codex configuration detected",
    },
    {
      agent: "claude_code" as const,
      path: join(homeDirectory, ".claude"),
      evidence: "Claude Code configuration detected",
    },
    {
      agent: "opencode" as const,
      path: join(homeDirectory, ".config", "opencode"),
      evidence: "OpenCode configuration detected",
    },
    {
      agent: "openclaw" as const,
      path: join(homeDirectory, ".openclaw"),
      evidence: "OpenClaw configuration detected",
    },
    {
      agent: "pi" as const,
      path: join(homeDirectory, ".pi", "agent"),
      evidence: "Pi configuration detected",
    },
  ];
  return candidates.map((candidate) => ({
    agent: candidate.agent,
    evidence: exists(candidate.path) ? [candidate.evidence] : [],
  }));
}
