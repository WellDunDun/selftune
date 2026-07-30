import { loadConfigSync } from "@selftune/config";

import { getAlphaGuidance } from "./agent-guidance.js";
import {
  resolveCloudCredential,
  type CloudCredentialDependencies,
} from "./auth/cloud-credential.js";
import type { AgentCommandGuidance } from "./types.js";

export { installAgentFiles } from "./claude-agents.js";
export {
  checkClaudeCodeHooks,
  derivePackageRootFromCommand,
  installClaudeCodeHooks,
  updateExistingSelftuneHooks,
} from "./init/claude-hooks.js";
export { detectAgentType, determineCliPath, determineLlmMode } from "./init/environment.js";
export { detectWorkspaceType } from "./init/workspace.js";
export type { WorkspaceInfo } from "./init/workspace.js";

export function checkAlphaReadiness(
  configPath: string,
  deps: CloudCredentialDependencies = {},
): {
  ready: boolean;
  missing: string[];
  guidance: AgentCommandGuidance;
} {
  const config = loadConfigSync(configPath);
  const identity = config?.alpha ?? null;
  const missing: string[] = [];
  if (!identity) {
    missing.push("alpha identity not configured");
    return { ready: false, missing, guidance: getAlphaGuidance(identity) };
  }
  if (!identity.enrolled) missing.push("not enrolled");
  const apiKey = resolveCloudCredential(config, { ...deps, configPath });
  if (!apiKey) missing.push("api_key not set");
  else if (!apiKey.startsWith("st_live_") && !apiKey.startsWith("st_test_"))
    missing.push("api_key has invalid format (expected st_live_* or st_test_*)");
  return {
    ready: missing.length === 0,
    missing,
    guidance: getAlphaGuidance(identity, Boolean(apiKey)),
  };
}
