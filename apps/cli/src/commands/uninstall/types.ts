export interface ServiceRemovalResult {
  removed: boolean;
  details: string;
}

export interface CredentialRemovalResult {
  removed: boolean;
  details: string;
}

export interface ScheduleRemovalResult {
  removed: boolean;
  details: string;
}

export interface HookRemovalResult {
  removed: number;
  details: string;
}

export interface AgentRemovalResult {
  removed: number;
  files: string[];
}

export interface FileRemovalResult {
  removed: number;
  files: string[];
}

export interface ConfigRemovalResult {
  removed: boolean;
  path: string;
}

export interface NpmRemovalResult {
  uninstalled: boolean;
}

export interface UninstallResult {
  dryRun: boolean;
  service: ServiceRemovalResult;
  credential: CredentialRemovalResult;
  schedule: ScheduleRemovalResult;
  hooks: HookRemovalResult;
  agents: AgentRemovalResult;
  logs: FileRemovalResult & { skipped: boolean };
  config: ConfigRemovalResult;
  markers: FileRemovalResult;
  npm: NpmRemovalResult & { skipped: boolean };
}

export interface UninstallOptions {
  dryRun: boolean;
  keepLogs: boolean;
  npmUninstall: boolean;
  settingsPath?: string;
}

export type UninstallStepId =
  | "service"
  | "credential"
  | "schedule"
  | "hooks"
  | "agents"
  | "logs"
  | "config"
  | "markers"
  | "npm";

export interface UninstallStepPlan {
  readonly id: UninstallStepId;
  readonly disposition: "run" | "skip";
}

export interface UninstallPlan {
  readonly dryRun: boolean;
  readonly settingsPath: string | undefined;
  readonly steps: ReadonlyArray<UninstallStepPlan>;
}
