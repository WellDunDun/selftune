import { basename, dirname, resolve } from "node:path";

import {
  captureSkillSetFromProject,
  createSkillSet,
  deriveSkillSetFromProject,
  exportPortableSkillSet,
  importPortableSkillSet,
  LibraryError,
  listSkillSetReceipts,
  listSkillSetRevisions,
  listSkillSets,
  planSkillSet,
  rollbackSkillSet,
  updateSkillSet,
} from "@selftune/library";
import type { SkillSetSuggestion } from "@selftune/skill-intelligence";
import * as Effect from "effect/Effect";

import { applySkillSetWithRemoteDependencies } from "../skill-set-remote-apply.js";
import { loadSkillIntelligence } from "../skill-intelligence/index.js";
import { CLIError } from "../utils/cli-error.js";

export type SkillSetsProgramInput =
  | { readonly operation: "list" }
  | {
      readonly operation: "suggest";
      readonly minOccurrences: number;
      readonly minAffinity: number;
      readonly holdoutRatio: number;
      readonly minValidationOccurrences: number;
      readonly minEvidenceScore?: number;
      readonly maxSuggestions: number;
    }
  | { readonly operation: "outcomes" }
  | {
      readonly operation: "create";
      readonly name?: string;
      readonly description?: string;
      readonly harnesses: ReadonlyArray<string>;
      readonly skillPaths: ReadonlyArray<string>;
    }
  | {
      readonly operation: "update";
      readonly setId?: string;
      readonly parentRevision?: string;
      readonly name?: string;
      readonly description?: string;
      readonly harnesses: ReadonlyArray<string>;
      readonly skillPaths: ReadonlyArray<string>;
    }
  | {
      readonly operation: "derive";
      readonly name?: string;
      readonly description?: string;
      readonly project?: string;
      readonly harnesses: ReadonlyArray<string>;
    }
  | {
      readonly operation: "capture";
      readonly name?: string;
      readonly description?: string;
      readonly project?: string;
      readonly harnesses: ReadonlyArray<string>;
    }
  | { readonly operation: "history"; readonly setId?: string }
  | {
      readonly operation: "export";
      readonly setId?: string;
      readonly project?: string;
      readonly output?: string;
    }
  | { readonly operation: "import"; readonly manifest?: string }
  | { readonly operation: "plan"; readonly setId?: string; readonly project?: string }
  | { readonly operation: "apply"; readonly setId?: string; readonly project?: string }
  | { readonly operation: "receipts" }
  | { readonly operation: "rollback"; readonly receiptId?: string };

export interface SkillSetsProgramResult {
  readonly operation: SkillSetsProgramInput["operation"];
  readonly value: unknown;
  readonly text: string;
  readonly pathOnly?: boolean;
}

function requireString(value: string | undefined, flag: string, nextCommand: string): string {
  if (!value?.trim()) {
    throw new CLIError(`${flag} is required.`, "MISSING_FLAG", nextCommand);
  }
  return value.trim();
}

function packagePathFromInput(value: string): string {
  const path = resolve(value);
  return basename(path).toUpperCase() === "SKILL.MD" ? dirname(path) : path;
}

function skillsFromPaths(values: ReadonlyArray<string>) {
  return values.map((inputPath) => {
    const packagePath = packagePathFromInput(inputPath);
    return { name: basename(packagePath), package_path: packagePath };
  });
}

function suggestionKind(suggestion: SkillSetSuggestion): string {
  if (suggestion.pattern === "co_usage" && suggestion.skills.length === 2) {
    return "observed pairing";
  }
  if (suggestion.pattern === "workflow") return "observed workflow";
  if (suggestion.pattern === "project" && suggestion.skills.length === 2) {
    return "project pairing";
  }
  return "suggested set";
}

function formatSuggestions(report: ReturnType<typeof loadSkillIntelligence>): string {
  const validation = report.validation.ready
    ? `Validation: ${report.validation.discovery_sessions} discovery + ${report.validation.held_out_sessions} held-out sessions`
    : `Validation: exploratory (${report.validation.discovery_sessions} discovery sessions; awaiting a held-out window)`;
  const calibration =
    report.feedback.calibration.status === "calibrated"
      ? `Calibration: ${report.feedback.calibration.labeled_reviews} labels, ${Math.round(report.feedback.calibration.applied_min_evidence_score * 100)}% evidence floor`
      : `Calibration: ${report.feedback.calibration.labeled_reviews}/${report.feedback.calibration.minimum_labeled_reviews} usable labels`;
  const suggestions =
    report.suggestions.length === 0
      ? [validation, calibration, "No new skill relationships or sets meet the evidence threshold."]
      : [
          validation,
          calibration,
          "",
          "Skill Intelligence Suggestions",
          ...report.suggestions.flatMap((suggestion) => [
            `${suggestion.suggestion_id}: ${suggestion.name}`,
            `  ${suggestion.skills.map((skill) => skill.name).join(" + ")} | ${suggestionKind(suggestion)} | ${suggestion.evidence_state} | ${suggestion.discovery_occurrence_count} discovery + ${suggestion.held_out_occurrence_count} held-out | ${Math.round(suggestion.confidence * 100)}% evidence`,
          ]),
        ];
  return [
    ...suggestions,
    "",
    `Classified Skills (${report.classifications.length})`,
    ...report.classifications.map(
      (classification) =>
        `${classification.skill_name}: ${classification.category_label} (${Math.round(classification.confidence * 100)}%)`,
    ),
  ].join("\n");
}

function formatOutcomes(report: ReturnType<typeof loadSkillIntelligence>): string {
  if (report.outcomes.length === 0) {
    return "No accepted Skill Set activation has a measured window.";
  }
  return [
    "Measured Skill Set Outcomes",
    ...report.outcomes.flatMap((outcome) => [
      `${outcome.set_id}: ${outcome.status}`,
      `  ${outcome.before_session_count} before + ${outcome.after_session_count} after | completion ${outcome.metrics.completion_quality.before ?? "n/a"} -> ${outcome.metrics.completion_quality.after ?? "n/a"} | errors ${outcome.metrics.error_rate.before ?? "n/a"} -> ${outcome.metrics.error_rate.after ?? "n/a"} | coverage ${outcome.metrics.trigger_coverage.before ?? "n/a"} -> ${outcome.metrics.trigger_coverage.after ?? "n/a"} | tokens ${outcome.metrics.token_cost.before ?? "n/a"} -> ${outcome.metrics.token_cost.after ?? "n/a"} | grading ${outcome.metrics.grading.before ?? "n/a"} -> ${outcome.metrics.grading.after ?? "n/a"}`,
      `  ${outcome.reason}`,
    ]),
  ].join("\n");
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toProgramError(operation: string, cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  if (cause instanceof LibraryError) {
    return new CLIError(
      cause.message,
      cause.code,
      cause.suggestion,
      cause.exitCode,
      cause.retryable,
    );
  }
  return new CLIError(
    `Skill Sets ${operation} failed: ${failureMessage(cause)}`,
    "OPERATION_FAILED",
    `selftune sets ${operation} --help`,
  );
}

type SynchronousSkillSetsProgramInput = Exclude<
  SkillSetsProgramInput,
  { readonly operation: "apply" }
>;

function runSynchronousSkillSetsProgram(
  input: SynchronousSkillSetsProgramInput,
): SkillSetsProgramResult {
  switch (input.operation) {
    case "list": {
      const value = listSkillSets();
      return {
        operation: input.operation,
        value,
        text:
          value.length === 0
            ? "No Skill Sets found."
            : value
                .map((entry) => `${entry.set_id}: ${entry.name} (${entry.skills.length} skills)`)
                .join("\n"),
      };
    }
    case "receipts": {
      const value = listSkillSetReceipts();
      return {
        operation: input.operation,
        value,
        text:
          value.length === 0
            ? "No Skill Set receipts found."
            : value
                .map((entry) => `${entry.receipt_id}: ${entry.set_name} (${entry.status})`)
                .join("\n"),
      };
    }
    case "suggest": {
      const value = loadSkillIntelligence({
        minOccurrences: input.minOccurrences,
        minAffinity: input.minAffinity,
        holdoutRatio: input.holdoutRatio,
        minValidationOccurrences: input.minValidationOccurrences,
        minEvidenceScore: input.minEvidenceScore,
        maxSuggestions: input.maxSuggestions,
      });
      return { operation: input.operation, value, text: formatSuggestions(value) };
    }
    case "outcomes": {
      const report = loadSkillIntelligence();
      return { operation: input.operation, value: report.outcomes, text: formatOutcomes(report) };
    }
    case "create": {
      const value = createSkillSet({
        name: requireString(input.name, "--name", "selftune sets create --help"),
        description: input.description,
        harnesses: input.harnesses,
        skills: skillsFromPaths(input.skillPaths),
      });
      return {
        operation: input.operation,
        value,
        text: `Created Skill Set "${value.name}" with ${value.skills.length} pinned skill${value.skills.length === 1 ? "" : "s"}.`,
      };
    }
    case "update": {
      const setId = requireString(input.setId, "--set", "selftune sets update --help");
      const parentRevision = requireString(
        input.parentRevision,
        "--parent-revision",
        "selftune sets history --set <id> --json",
      );
      const value = updateSkillSet(setId, {
        name: input.name,
        description: input.description,
        harnesses: input.harnesses,
        skills: skillsFromPaths(input.skillPaths),
        parent_revision_hash: parentRevision,
      });
      return {
        operation: input.operation,
        value,
        text: `Updated Skill Set "${value.name}" to v${value.revision}.`,
      };
    }
    case "derive": {
      const value = deriveSkillSetFromProject({
        name: requireString(input.name, "--name", "selftune sets derive --help"),
        description: input.description,
        project_root: requireString(input.project, "--project", "selftune sets derive --help"),
        harnesses: input.harnesses,
      });
      return {
        operation: input.operation,
        value,
        text: `Captured ${value.skills.length} project skills in "${value.name}".`,
      };
    }
    case "capture": {
      const value = captureSkillSetFromProject({
        name: input.name,
        description: input.description,
        project_root: input.project?.trim() || process.cwd(),
        harnesses: input.harnesses.length > 0 ? input.harnesses : undefined,
      });
      return {
        operation: input.operation,
        value,
        text: `Captured ${value.skills.length} project skill${value.skills.length === 1 ? "" : "s"} in "${value.name}".`,
      };
    }
    case "history": {
      const value = listSkillSetRevisions(
        requireString(input.setId, "--set", "selftune sets history --help"),
      );
      return {
        operation: input.operation,
        value,
        text: value
          .map((revision) => `v${revision.revision} ${revision.revision_hash.slice(0, 12)}`)
          .join("\n"),
      };
    }
    case "export": {
      const value = exportPortableSkillSet(
        requireString(input.setId, "--set", "selftune sets export --help"),
        requireString(input.project, "--project", "selftune sets export --help"),
        { outputPath: input.output },
      );
      return { operation: input.operation, value, text: value, pathOnly: true };
    }
    case "import": {
      const value = importPortableSkillSet(
        requireString(input.manifest, "--manifest", "selftune sets import --help"),
      );
      return {
        operation: input.operation,
        value,
        text: `Imported Skill Set "${value.name}".`,
      };
    }
    case "plan": {
      const value = planSkillSet({
        set_id: requireString(input.setId, "--set", "selftune sets plan --help"),
        project_root: requireString(input.project, "--project", "selftune sets plan --help"),
      });
      return {
        operation: input.operation,
        value,
        text: `${value.set_name}: ${value.creates} create, ${value.unchanged} unchanged, ${value.conflicts} conflict${value.conflicts === 1 ? "" : "s"}, ${value.missing_dependencies} download${value.missing_dependencies === 1 ? "" : "s"}.`,
      };
    }
    case "rollback": {
      const value = rollbackSkillSet(
        requireString(input.receiptId, "--receipt", "selftune sets rollback --help"),
      );
      return {
        operation: input.operation,
        value,
        text: `Rolled back Skill Set "${value.set_name}" from ${value.project_root}.`,
      };
    }
  }
}

export const runSkillSetsProgram = Effect.fn("selftune.runtime.skillSets.run")(function* (
  input: SkillSetsProgramInput,
) {
  if (input.operation !== "apply") {
    return yield* Effect.try({
      try: () => runSynchronousSkillSetsProgram(input),
      catch: (cause) => toProgramError(input.operation, cause),
    });
  }

  return yield* Effect.tryPromise({
    try: async () => {
      const value = await applySkillSetWithRemoteDependencies({
        set_id: requireString(input.setId, "--set", "selftune sets apply --help"),
        project_root: requireString(input.project, "--project", "selftune sets apply --help"),
      });
      const text =
        value.dependencies_downloaded > 0
          ? `Downloaded ${value.dependencies_downloaded} missing skill${value.dependencies_downloaded === 1 ? "" : "s"}${value.status === "unchanged" ? `; Skill Set "${value.set_name}" was already applied.` : ` and applied Skill Set "${value.set_name}". Receipt: ${value.receipt_id}`}`
          : value.status === "unchanged"
            ? `Skill Set "${value.set_name}" is already applied.`
            : `Applied Skill Set "${value.set_name}". Receipt: ${value.receipt_id}`;
      return { operation: input.operation, value, text };
    },
    catch: (cause) => toProgramError(input.operation, cause),
  });
});

export function formatSkillSetsResult(result: SkillSetsProgramResult, jsonMode: boolean): string {
  if (result.pathOnly) return result.text;
  return jsonMode ? JSON.stringify(result.value, null, 2) : result.text;
}
