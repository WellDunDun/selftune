import { join } from "node:path";

import type { SkillSetHarnessId } from "./types.js";

export function targetRegistryPath(projectRoot: string, harness: SkillSetHarnessId): string {
  const relativeRegistry: Record<SkillSetHarnessId, string[]> = {
    codex: [".agents", "skills"],
    claude_code: [".claude", "skills"],
    opencode: [".opencode", "skills"],
    openclaw: [".openclaw", "skills"],
    pi: [".pi", "agent", "skills"],
  };
  return join(projectRoot, ...relativeRegistry[harness]);
}
