import type { AgentDetectionObservation, AgentSuggestion, InstallerAgent } from "./types.js";

export const INSTALLER_AGENTS: ReadonlyArray<InstallerAgent> = [
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
];

export const AGENT_REGISTRY_SEGMENTS: Readonly<Record<InstallerAgent, ReadonlyArray<string>>> = {
  codex: [".agents", "skills"],
  claude_code: [".claude", "skills"],
  opencode: [".opencode", "skills"],
  openclaw: [".openclaw", "skills"],
  pi: [".pi", "agent", "skills"],
};

/** Detection is advisory. Suggestions are never converted into a selected target. */
export function suggestInstallerAgents(
  observations: ReadonlyArray<AgentDetectionObservation>,
): ReadonlyArray<AgentSuggestion> {
  return observations
    .filter((observation) => observation.evidence.length > 0)
    .toSorted(
      (left, right) => INSTALLER_AGENTS.indexOf(left.agent) - INSTALLER_AGENTS.indexOf(right.agent),
    )
    .map((observation) => ({ ...observation, selected: false as const }));
}
