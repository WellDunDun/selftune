import type { ProjectConnectionId } from "../../models";

export const CONNECTIONS = [
  ["codex", "Codex"],
  ["claude_code", "Claude Code"],
  ["opencode", "OpenCode"],
  ["openclaw", "OpenClaw"],
  ["pi", "Pi"],
] satisfies Array<[ProjectConnectionId, string]>;

export const CONNECTION_LABELS = Object.fromEntries(CONNECTIONS);

export type SkillSetEditorMode = "create" | "edit" | "derive";
