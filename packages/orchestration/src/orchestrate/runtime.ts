import { homedir } from "node:os";
import { join } from "node:path";

import { readAlphaIdentity } from "@selftune/runtime/alpha-identity";
import { SELFTUNE_CONFIG_PATH } from "@selftune/runtime/constants";
import { readGradingResultsForSkill } from "@selftune/runtime/grading/results";
import { getDb } from "@selftune/runtime/localdb/db";
import {
  queryEvolutionAudit,
  queryQueryLog,
  querySessionTelemetry,
  querySkillUsageRecords,
} from "@selftune/runtime/localdb/queries";
import { doctor } from "@selftune/runtime/observability";
import { computeStatus } from "@selftune/runtime/status";
import { syncSources } from "../sync.js";
import type {
  AlphaIdentity,
  EvolutionAuditEntry,
  ImprovementSignalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "@selftune/runtime/types";
import { detectLlmAgent, type LlmBackedAgent } from "@selftune/runtime/utils/llm-call";
import {
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "@selftune/runtime/utils/skill-discovery";
import {
  discoverWorkflowSkillProposals,
  persistWorkflowSkillProposal,
} from "@selftune/runtime/workflows/proposals";
import type { OrchestrateDeps } from "../orchestrate.js";
import { buildReplayValidationOptions } from "./execute.js";

export interface ResolvedOrchestrateRuntime {
  syncSources: typeof syncSources;
  computeStatus: typeof computeStatus;
  evolve: typeof import("@selftune/runtime/evolution/evolve").evolve;
  watch: typeof import("@selftune/runtime/monitoring/watch").watch;
  detectAgent: () => LlmBackedAgent | null;
  doctor: typeof doctor;
  readTelemetry: () => SessionTelemetryRecord[];
  readSkillRecords: () => SkillUsageRecord[];
  readQueryRecords: () => QueryLogRecord[];
  readAuditEntries: () => EvolutionAuditEntry[];
  resolveSkillPath: (skillName: string) => string | undefined;
  readGradingResults: (skillName: string) => ReturnType<typeof readGradingResultsForSkill>;
  readSignals?: () => ImprovementSignalRecord[];
  readAlphaIdentity: () => AlphaIdentity | null;
  discoverWorkflowSkillProposals: typeof discoverWorkflowSkillProposals;
  persistWorkflowSkillProposal: typeof persistWorkflowSkillProposal;
  buildReplayOptions: typeof buildReplayValidationOptions;
}

export function getSkillSearchDirs(): string[] {
  const home = homedir();
  const cwd = process.cwd();
  return [
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".codex", "skills"),
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
  ];
}

export function defaultResolveSkillPath(skillName: string): string | undefined {
  return findInstalledSkillPath(skillName, getSkillSearchDirs());
}

export async function resolveOrchestrateRuntime(
  deps: OrchestrateDeps = {},
): Promise<ResolvedOrchestrateRuntime> {
  const evolve = deps.evolve ?? (await import("@selftune/runtime/evolution/evolve")).evolve;
  const watch = deps.watch ?? (await import("@selftune/runtime/monitoring/watch")).watch;

  return {
    syncSources: deps.syncSources ?? syncSources,
    computeStatus: deps.computeStatus ?? computeStatus,
    evolve,
    watch,
    detectAgent: deps.detectAgent ?? detectLlmAgent,
    doctor: deps.doctor ?? doctor,
    readTelemetry:
      deps.readTelemetry ??
      (() => {
        const db = getDb();
        return querySessionTelemetry(db) as SessionTelemetryRecord[];
      }),
    readSkillRecords:
      deps.readSkillRecords ??
      (() => {
        const db = getDb();
        return querySkillUsageRecords(db) as SkillUsageRecord[];
      }),
    readQueryRecords:
      deps.readQueryRecords ??
      (() => {
        const db = getDb();
        return queryQueryLog(db) as QueryLogRecord[];
      }),
    readAuditEntries:
      deps.readAuditEntries ??
      (() => {
        const db = getDb();
        return queryEvolutionAudit(db) as EvolutionAuditEntry[];
      }),
    resolveSkillPath: deps.resolveSkillPath ?? defaultResolveSkillPath,
    readGradingResults: deps.readGradingResults ?? readGradingResultsForSkill,
    readSignals: deps.readSignals,
    readAlphaIdentity: deps.readAlphaIdentity ?? (() => readAlphaIdentity(SELFTUNE_CONFIG_PATH)),
    discoverWorkflowSkillProposals:
      deps.discoverWorkflowSkillProposals ?? discoverWorkflowSkillProposals,
    persistWorkflowSkillProposal: deps.persistWorkflowSkillProposal ?? persistWorkflowSkillProposal,
    buildReplayOptions: deps.buildReplayOptions ?? buildReplayValidationOptions,
  };
}
