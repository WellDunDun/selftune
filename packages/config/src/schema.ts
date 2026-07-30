import { Schema } from "effect";

export const AgentType = Schema.Literals([
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "pi",
  "unknown",
]);
export type AgentType = typeof AgentType.Type;

export const CredentialProvider = Schema.Literals([
  "macos-keychain",
  "linux-secret-service",
  "windows-credential-manager",
  "file",
]);
export type CredentialProvider = typeof CredentialProvider.Type;

export const CredentialReference = Schema.Struct({
  provider: CredentialProvider,
  account: Schema.String,
});
export type CredentialReference = typeof CredentialReference.Type;

export const AlphaIdentity = Schema.Struct({
  enrolled: Schema.mutableKey(Schema.Boolean),
  cloud_user_id: Schema.mutableKey(Schema.optional(Schema.String)),
  cloud_org_id: Schema.mutableKey(Schema.optional(Schema.String)),
  cloud_api_url: Schema.mutableKey(Schema.optional(Schema.String)),
  email: Schema.mutableKey(Schema.optional(Schema.String)),
  display_name: Schema.mutableKey(Schema.optional(Schema.String)),
  user_id: Schema.mutableKey(Schema.String),
  consent_timestamp: Schema.mutableKey(Schema.String),
  credential: Schema.mutableKey(Schema.optional(CredentialReference)),
  api_key: Schema.mutableKey(Schema.optional(Schema.String)),
});
export type AlphaIdentity = typeof AlphaIdentity.Type;

export const HarnessId = Schema.Literals([
  "claude_code",
  "cline",
  "codex",
  "opencode",
  "openclaw",
  "pi",
]);
export type HarnessId = typeof HarnessId.Type;

export const SelftunePreferences = Schema.Struct({
  import_sources: Schema.Record(HarnessId, Schema.Boolean),
  features: Schema.Struct({
    observability: Schema.Boolean,
    health_recommendations: Schema.Boolean,
    autonomous_improvement: Schema.Boolean,
  }),
});
export type SelftunePreferences = typeof SelftunePreferences.Type;

export const SelftuneFileConfig = Schema.Struct({
  agent_type: Schema.mutableKey(AgentType),
  cli_path: Schema.mutableKey(Schema.String),
  llm_mode: Schema.mutableKey(Schema.Literal("agent")),
  agent_cli: Schema.mutableKey(Schema.NullOr(Schema.String)),
  hooks_installed: Schema.mutableKey(Schema.Boolean),
  initialized_at: Schema.mutableKey(Schema.String),
  analytics_disabled: Schema.mutableKey(Schema.optional(Schema.Boolean)),
  alpha: Schema.mutableKey(Schema.optional(AlphaIdentity)),
  preferences: Schema.mutableKey(Schema.optional(SelftunePreferences)),
});
export type SelftuneFileConfig = typeof SelftuneFileConfig.Type;
export type SelftuneConfig = SelftuneFileConfig;
