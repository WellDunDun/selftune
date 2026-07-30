import type { ProjectConnectionId } from "../../models";

export const CONNECTION_LABELS: Record<ProjectConnectionId, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  pi: "Pi",
};

export const CONNECTIONS = Object.entries(CONNECTION_LABELS) as Array<
  [ProjectConnectionId, string]
>;

export type SkillSetEditorMode = "create" | "edit" | "derive";
