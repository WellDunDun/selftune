import type { getDb } from "@selftune/local-store";
import type { HarnessSourceRegistry } from "@selftune/harness-core/source-adapter";
import type { SyncPhaseTiming, SyncResult, SyncStepResult } from "@selftune/source-management/sync";

export type { SyncPhaseTiming, SyncResult, SyncStepResult };

export interface SyncImportSources {
  readonly claude_code: boolean;
  readonly codex: boolean;
  readonly opencode: boolean;
  readonly openclaw: boolean;
  readonly pi: boolean;
}

export interface SyncOptions {
  readonly projectsDir: string;
  readonly codexHome: string;
  readonly opencodeDataDir: string;
  readonly openclawAgentsDir: string;
  readonly piSessionsDir: string;
  readonly skillLogPath: string;
  readonly repairedSkillLogPath: string;
  readonly repairedSessionsPath: string;
  readonly since?: Date;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly syncClaude: boolean;
  readonly syncCodex: boolean;
  readonly syncOpenCode: boolean;
  readonly syncOpenClaw: boolean;
  readonly syncPi: boolean;
  readonly rebuildSkillUsage: boolean;
}

export type SyncProgressCallback = (message: string) => void;

export interface SyncDeps<R = never> {
  readonly sourceRegistry?: HarnessSourceRegistry<R>;
  readonly rebuildSkillUsage?: (options: SyncOptions) => {
    readonly repairedSessions: number;
    readonly repairedRecords: number;
    readonly codexRepairedRecords: number;
  };
  readonly stageCreatorContributions?: (
    db: ReturnType<typeof getDb>,
    options: { readonly dryRun: boolean },
  ) => {
    readonly eligible_skills: number;
    readonly built_signals: number;
    readonly staged_signals: number;
  };
}

export interface SyncProgramInput {
  readonly projectsDir?: string;
  readonly codexHome?: string;
  readonly opencodeDataDir?: string;
  readonly openclawAgentsDir?: string;
  readonly piSessionsDir?: string;
  readonly skillLogPath?: string;
  readonly repairedSkillLogPath?: string;
  readonly repairedSessionsPath?: string;
  readonly since?: Date;
  readonly sinceArgument?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly skipClaude: boolean;
  readonly skipCodex: boolean;
  readonly skipOpenCode: boolean;
  readonly skipOpenClaw: boolean;
  readonly skipPi: boolean;
  readonly skipRepair: boolean;
  readonly jsonOutput: boolean;
}

export interface SyncProgramResult {
  readonly sync: SyncResult;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly exitCode: 0;
}

export interface SyncAuditSuccess {
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly result: SyncResult;
}

export interface SyncAuditError {
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly message: string;
}

export interface SyncDefaults {
  readonly projectsDir: string;
  readonly codexHome: string;
  readonly opencodeDataDir: string;
  readonly openclawAgentsDir: string;
  readonly piSessionsDir: string;
  readonly skillLogPath: string;
  readonly repairedSkillLogPath: string;
  readonly repairedSessionsPath: string;
}

export interface FileListCache {
  readonly authoritativeFiles: Record<string, ReadonlyArray<string> | undefined>;
}
