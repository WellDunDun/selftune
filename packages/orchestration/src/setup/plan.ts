import type { SelftuneConfig, SelftunePreferences } from "@selftune/config";

export const SETUP_HARNESS_IDS = [
  "claude_code",
  "cline",
  "codex",
  "opencode",
  "openclaw",
  "pi",
] as const;

export type SetupHarnessId = (typeof SETUP_HARNESS_IDS)[number];
export type HookHarnessId = Exclude<SetupHarnessId, "openclaw">;

export interface SetupPlan {
  readonly agentOverride?: string;
  readonly cliPathOverride?: string;
  readonly config: {
    readonly enabled: boolean;
    readonly force: boolean;
    readonly value?: SelftuneConfig;
  };
  readonly preferences?: SelftunePreferences;
  readonly agentFiles: boolean;
  readonly hookHarnesses: ReadonlyArray<HookHarnessId>;
  readonly schedule: {
    readonly enabled: boolean;
    readonly format?: string;
  };
  readonly sourceSync: boolean;
}

export interface DefaultSetupPlanOptions {
  readonly agentOverride?: string;
  readonly cliPathOverride?: string;
  readonly config?: SelftuneConfig;
  readonly preferences?: SelftunePreferences;
  readonly writeConfig?: boolean;
  readonly force?: boolean;
  readonly agentFiles?: boolean;
  readonly hookHarnesses?: ReadonlyArray<HookHarnessId>;
  readonly scheduleEnabled?: boolean;
  readonly scheduleFormat?: string;
  readonly sourceSync?: boolean;
}

export function defaultSetupPlan(options: DefaultSetupPlanOptions = {}): SetupPlan {
  return {
    agentOverride: options.agentOverride,
    cliPathOverride: options.cliPathOverride,
    config: {
      enabled: options.writeConfig ?? true,
      force: options.force ?? false,
      value: options.config,
    },
    preferences: options.preferences,
    agentFiles: options.agentFiles ?? false,
    hookHarnesses: options.hookHarnesses ?? [],
    schedule: {
      enabled: options.scheduleEnabled ?? false,
      format: options.scheduleFormat,
    },
    sourceSync: options.sourceSync ?? false,
  };
}
