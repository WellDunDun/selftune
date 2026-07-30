import type {
  WatchDiagnostic,
  WatchEvaluationOptions,
  WatchResult,
} from "@selftune/runtime/monitoring/watch";
import type { MonitoringSnapshot } from "@selftune/runtime/types";

export interface WatchProgramInput {
  readonly skillName: string;
  readonly skillPath: string;
  readonly windowSessions: number;
  readonly regressionThreshold: number;
  readonly gradeRegressionThreshold: number;
  readonly enableGradeWatch: boolean;
  readonly autoRollback: boolean;
  readonly syncFirst: boolean;
  readonly syncForce: boolean;
}

export interface WatchProgramResult {
  readonly watch: WatchResult;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly exitCode: 0 | 1;
}

export interface WatchRollbackRequest {
  readonly skillName: string;
  readonly skillPath: string;
  readonly proposalId?: string;
}

export interface WatchRollbackResult {
  readonly rolledBack: boolean;
  readonly restoredDescription: string;
  readonly reason: string;
}

export interface WatchMemoryUpdate {
  readonly skillName: string;
  readonly snapshot: MonitoringSnapshot;
}

export type WatchProgramDiagnostic =
  | WatchDiagnostic
  | {
      readonly code: "memory_write_failed";
      readonly message: string;
    };

export function toWatchEvaluationOptions(input: WatchProgramInput): WatchEvaluationOptions {
  return {
    skillName: input.skillName,
    skillPath: input.skillPath,
    windowSessions: input.windowSessions,
    regressionThreshold: input.regressionThreshold,
    gradeRegressionThreshold: input.gradeRegressionThreshold,
    enableGradeWatch: input.enableGradeWatch,
  };
}
