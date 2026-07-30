export {
  AgentType,
  AlphaIdentity,
  CredentialProvider,
  CredentialReference,
  HarnessId,
  SelftuneFileConfig,
  SelftunePreferences,
} from "./schema.js";
export type { SelftuneConfig } from "./schema.js";

export {
  resolveSelftunePaths,
  SELFTUNE_CONFIG_DIR,
  SELFTUNE_CONFIG_PATH,
  SELFTUNE_LOCAL_DATABASE_PATH,
  SELFTUNE_LOCAL_ANALYTICS_PATH,
} from "./paths.js";
export type { ResolveSelftunePathsInput, SelftunePathEnvironment, SelftunePaths } from "./paths.js";

export { ConfigParseError, loadConfig, loadConfigSync } from "./load.js";
export { ConfigWriteError, writeConfig, writeConfigSync } from "./write.js";
