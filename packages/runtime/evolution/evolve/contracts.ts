import type { BaselineMeasurement } from "../../eval/baseline.js";
import type { SourceSyncRunner, SyncResult } from "@selftune/source-management/sync";
import type {
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionProposal,
  FailurePattern,
  GradingResult,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../types.js";
import type { EffortLevel } from "../../utils/llm-call.js";
import type { ReplayValidationOptions } from "../engines/replay-engine.js";
import type { ValidationStrategy } from "../validation-contract.js";
import type { ValidationResult } from "../validate-proposal.js";

export interface EvolveOptions {
  skillName: string;
  skillPath: string;
  evalSetPath?: string;
  agent: string;
  dryRun: boolean;
  confidenceThreshold: number;
  maxIterations: number;
  gradingResults?: GradingResult[];
  paretoEnabled?: boolean;
  candidateCount?: number;
  tokenEfficiencyEnabled?: boolean;
  telemetryRecords?: SessionTelemetryRecord[];
  withBaseline?: boolean;
  validationModel?: string;
  cheapLoop?: boolean;
  gateModel?: string;
  gateEffort?: EffortLevel;
  proposalModel?: string;
  adaptiveGate?: boolean;
  syncFirst?: boolean;
  syncForce?: boolean;
  validationMode?: ValidationStrategy;
  replayOptions?: ReplayValidationOptions;
}

export interface EvolveResult {
  proposal: EvolutionProposal | null;
  validation: ValidationResult | null;
  deployed: boolean;
  auditEntries: EvolutionAuditEntry[];
  reason: string;
  skillVersion?: string;
  llmCallCount: number;
  elapsedMs: number;
  baselineResult?: BaselineMeasurement;
  gateValidation?: ValidationResult;
  sync_result?: SyncResult;
  descriptionQualityBefore?: number;
  descriptionQualityAfter?: number;
}

export interface EvolveDeps {
  extractFailurePatterns?: (
    evalEntries: EvalEntry[],
    skillUsage: SkillUsageRecord[],
    skillName: string,
    gradingResults?: GradingResult[],
  ) => FailurePattern[];
  generateProposal?: typeof import("../propose-description.js").generateProposal;
  validateProposal?: typeof import("../validate-proposal.js").validateProposal;
  gateValidateProposal?: typeof import("../validate-proposal.js").validateProposal;
  appendAuditEntry?: typeof import("../audit.js").appendAuditEntry;
  appendEvidenceEntry?: typeof import("../evidence.js").appendEvidenceEntry;
  buildEvalSet?: typeof import("../../eval/hooks-to-evals.js").buildEvalSet;
  updateContextAfterEvolve?: typeof import("../../memory/writer.js").updateContextAfterEvolve;
  measureBaseline?: typeof import("../../eval/baseline.js").measureBaseline;
  readSkillUsageLog?: () => SkillUsageRecord[];
  syncSources?: SourceSyncRunner;
}
