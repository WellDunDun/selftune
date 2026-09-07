import {
  recommendLibraryConsolidation,
  type LibraryConsolidationRecommendation,
} from "@selftune/control-plane/library-consolidation";
import { CatalogMemory } from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import { dirname, resolve } from "node:path";

import {
  decideSkillConsolidation,
  listSkillConsolidationDecisions,
  prepareSkillConsolidationDecision,
  rollbackSkillConsolidationDecision,
  type SkillConsolidationDecision,
  type SkillConsolidationDecisionOptions,
} from "../consolidation-decisions.js";
import { loadLibraryCatalogEffect, type LibraryCatalogOptions } from "../library/catalog.js";
import { CLIError } from "../utils/cli-error.js";

export interface RunSkillsConsolidateOptions {
  readonly skill?: string;
  readonly allSafe?: boolean;
  readonly searchDirs?: ReadonlyArray<string>;
  readonly approved?: boolean;
  readonly dryRun?: boolean;
}

export interface SkillsConsolidationProgramOptions {
  readonly catalog?: LibraryCatalogOptions;
  readonly decisions?: SkillConsolidationDecisionOptions;
}

export interface RunSkillsConsolidationRollbackOptions {
  readonly id?: string;
  readonly approved?: boolean;
  readonly dryRun?: boolean;
}

export interface SkillsConsolidationRollbackResult {
  readonly success: true;
  readonly operation: "rollback_skill_consolidation";
  readonly dry_run: boolean;
  readonly decision_id: string;
  readonly skill_name: string;
  readonly status: "planned" | "rolled_back" | "already_rolled_back";
  readonly receipt_id: string;
  readonly restored_paths: ReadonlyArray<string>;
  readonly removed_links: ReadonlyArray<string>;
  readonly rolled_back_at: string | null;
}

export interface SkillsConsolidationTargetResult {
  readonly action: "replace_with_link" | "archive_copy";
  readonly package_path: string;
  readonly skill_path: string;
  readonly content_hash: string;
  readonly project_root: string | null;
  readonly connection: string | null;
  readonly archive_id: string | null;
  readonly archive_destination: string | null;
}

export interface SkillsConsolidationItemResult {
  readonly skill_name: string;
  readonly status: "planned" | "applied" | "review_required" | "failed";
  readonly confidence: "source_current" | "review_required";
  readonly reason: string;
  readonly canonical: {
    readonly content_hash: string;
    readonly package_path: string;
    readonly skill_path: string;
    readonly library_package_path: string | null;
  };
  readonly targets: ReadonlyArray<SkillsConsolidationTargetResult>;
  readonly decision_id: string | null;
  readonly receipt_id: string | null;
  readonly applied_at: string | null;
  readonly rollback_behavior: string | null;
  readonly undo_command: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface SkillsConsolidationResult {
  readonly success: boolean;
  readonly operation: "consolidate_skill_installations";
  readonly dry_run: boolean;
  readonly mode: "single" | "all_safe";
  readonly requested_skill: string | null;
  readonly already_consolidated: boolean;
  readonly counts: {
    readonly recommended: number;
    readonly selected: number;
    readonly planned: number;
    readonly applied: number;
    readonly review_required: number;
    readonly failed: number;
  };
  readonly items: ReadonlyArray<SkillsConsolidationItemResult>;
}

function requireMode(options: RunSkillsConsolidateOptions): "single" | "all_safe" {
  if (options.searchDirs?.some((path) => !path.trim())) {
    throw new CLIError(
      "--search-dir must not be empty.",
      "INVALID_FLAG",
      "selftune skills consolidate --skill NAME --search-dir PATH --dry-run --json",
    );
  }
  const hasSkill = Boolean(options.skill?.trim());
  if (hasSkill === Boolean(options.allSafe)) {
    throw new CLIError(
      "Choose exactly one consolidation mode: --skill NAME or --all-safe.",
      "MISSING_FLAG",
      "selftune skills consolidate --skill NAME --dry-run --json",
    );
  }
  return hasSkill ? "single" : "all_safe";
}

function requireApproval(options: RunSkillsConsolidateOptions): void {
  if (!options.approved && !options.dryRun) {
    throw new CLIError(
      "Consolidation requires a dry-run preview or explicit approval through --yes.",
      "GUARD_BLOCKED",
      options.allSafe
        ? "selftune skills consolidate --all-safe --dry-run --json"
        : `selftune skills consolidate --skill ${options.skill ?? "NAME"} --dry-run --json`,
      2,
    );
  }
}

function targetResults(
  recommendation: LibraryConsolidationRecommendation,
): SkillsConsolidationTargetResult[] {
  return recommendation.locations.flatMap((candidate) =>
    candidate.action === "replace_with_link" || candidate.action === "archive_copy"
      ? [
          {
            action: candidate.action,
            package_path: candidate.location.packagePath,
            skill_path: candidate.location.skillPath,
            content_hash: candidate.contentHash,
            project_root: candidate.location.projectRoot,
            connection: candidate.location.harness,
            archive_id: null,
            archive_destination: null,
          },
        ]
      : [],
  );
}

function plannedItem(
  recommendation: LibraryConsolidationRecommendation,
  status: "planned" | "review_required",
): SkillsConsolidationItemResult {
  return {
    skill_name: recommendation.skillName,
    status,
    confidence: recommendation.canonical.confidence,
    reason: recommendation.canonical.reason,
    canonical: {
      content_hash: recommendation.canonical.contentHash,
      package_path: recommendation.canonical.installedLocation.packagePath,
      skill_path: recommendation.canonical.installedLocation.skillPath,
      library_package_path:
        recommendation.canonical.sourceLocation.sourceKind === "cached"
          ? recommendation.canonical.sourceLocation.packagePath
          : null,
    },
    targets: targetResults(recommendation),
    decision_id: null,
    receipt_id: null,
    applied_at: null,
    rollback_behavior: null,
    undo_command: null,
    error: null,
  };
}

function decisionOptions(
  recommendation: LibraryConsolidationRecommendation,
  searchDirs: ReadonlyArray<string>,
  runtime: SkillsConsolidationProgramOptions,
): SkillConsolidationDecisionOptions {
  return {
    ...runtime.decisions,
    searchDirs: [
      ...new Set(
        [
          ...(runtime.decisions?.searchDirs ?? []),
          ...searchDirs,
          ...recommendation.locations.map((candidate) => dirname(candidate.location.packagePath)),
        ].map((path) => resolve(path)),
      ),
    ],
  };
}

function failedItem(
  recommendation: LibraryConsolidationRecommendation,
  error: CLIError,
): SkillsConsolidationItemResult {
  return {
    ...plannedItem(recommendation, "planned"),
    status: "failed",
    error: { code: error.code, message: error.message },
  };
}

function applyRecommendation(
  recommendation: LibraryConsolidationRecommendation,
  searchDirs: ReadonlyArray<string>,
  runtime: SkillsConsolidationProgramOptions,
): Effect.Effect<SkillsConsolidationItemResult> {
  return Effect.tryPromise({
    try: async () => {
      const options = decisionOptions(recommendation, searchDirs, runtime);
      const prepared = prepareSkillConsolidationDecision(
        {
          skillName: recommendation.skillName,
          canonicalSkillPath: recommendation.canonical.installedLocation.skillPath,
          targetSkillPaths: targetResults(recommendation).map((target) => target.skill_path),
        },
        options,
      );
      const decided = await decideSkillConsolidation(prepared.approval_id, "approve", options);
      if (decided.status !== "approved" || !decided.receipt) {
        return {
          ...plannedItem(recommendation, "planned"),
          status: "failed",
          decision_id: decided.approval_id,
          error: {
            code: decided.failure?.code ?? "CONSOLIDATION_APPLY_FAILED",
            message: decided.failure?.message ?? "The consolidation decision was not applied.",
          },
        } satisfies SkillsConsolidationItemResult;
      }
      const applied: SkillsConsolidationItemResult = {
        ...plannedItem(recommendation, "planned"),
        status: "applied",
        canonical: {
          content_hash: decided.canonical.content_hash,
          package_path: decided.canonical.source_package_path,
          skill_path: decided.canonical.source_skill_path,
          library_package_path: decided.canonical.library_package_path,
        },
        decision_id: decided.approval_id,
        receipt_id: decided.receipt.receipt_id,
        applied_at: decided.receipt.applied_at,
        rollback_behavior: decided.receipt.rollback_behavior,
        targets: decided.targets.map((target) => ({
          action: target.action,
          package_path: target.original_package_path,
          skill_path: target.original_skill_path,
          content_hash: target.original_content_hash,
          project_root: target.project_root,
          connection: target.harness,
          archive_id: target.quarantine_id,
          archive_destination: target.archive_destination,
        })),
        undo_command: `selftune skills consolidation-rollback --id ${decided.approval_id} --yes --json`,
      };
      return applied;
    },
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(
            cause instanceof Error ? cause.message : "Consolidation could not be applied.",
            "OPERATION_FAILED",
            `selftune skills consolidate --skill ${recommendation.skillName} --dry-run --json`,
          ),
  }).pipe(Effect.catch((error) => Effect.succeed(failedItem(recommendation, error))));
}

function counts(items: ReadonlyArray<SkillsConsolidationItemResult>, recommended: number) {
  return {
    recommended,
    selected: items.filter((item) => item.status !== "review_required").length,
    planned: items.filter((item) => item.status === "planned").length,
    applied: items.filter((item) => item.status === "applied").length,
    review_required: items.filter((item) => item.status === "review_required").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

export const runSkillsConsolidateProgram = Effect.fn("selftune.runtime.skillPortfolio.consolidate")(
  function* (
    options: RunSkillsConsolidateOptions,
    runtime: SkillsConsolidationProgramOptions = {},
  ) {
    const mode = yield* Effect.try({
      try: () => {
        const selectedMode = requireMode(options);
        requireApproval(options);
        return selectedMode;
      },
      catch: (cause) =>
        cause instanceof CLIError
          ? cause
          : new CLIError(String(cause), "INVALID_FLAG", "selftune skills consolidate --help"),
    });
    const additionalSearchDirs = (options.searchDirs ?? []).map((path) => resolve(path));
    const catalogOptions: LibraryCatalogOptions = {
      ...runtime.catalog,
      additionalSearchDirs,
    };
    if (options.dryRun) {
      catalogOptions.sourceMetadata = {
        ...runtime.catalog?.sourceMetadata,
        updateMode: "cache-first",
      };
    }
    const snapshot = yield* loadLibraryCatalogEffect(catalogOptions).pipe(
      Effect.provide(CatalogMemory),
      Effect.mapError(
        (cause) =>
          new CLIError(
            `Unable to inspect installed skills: ${cause.message}`,
            "OPERATION_FAILED",
            "Check the configured skill search directories and retry.",
          ),
      ),
    );
    const recommendations = snapshot.skills.flatMap((skill) => {
      const recommendation = recommendLibraryConsolidation(skill);
      return recommendation ? [recommendation] : [];
    });
    const requestedSkill = options.skill?.trim() ?? null;
    const matching =
      mode === "single"
        ? recommendations.filter(
            (item) => item.skillName.toLowerCase() === requestedSkill?.toLowerCase(),
          )
        : recommendations;
    if (mode === "single" && matching.length === 0) {
      const alreadyConsolidated = snapshot.skills.some(
        (skill) => skill.name.toLowerCase() === requestedSkill?.toLowerCase(),
      );
      if (alreadyConsolidated) {
        return {
          success: true,
          operation: "consolidate_skill_installations",
          dry_run: Boolean(options.dryRun),
          mode,
          requested_skill: requestedSkill,
          already_consolidated: true,
          counts: counts([], 0),
          items: [],
        } satisfies SkillsConsolidationResult;
      }
      return yield* Effect.fail(
        new CLIError(
          `No duplicate-install recommendation exists for ${requestedSkill ?? "the requested skill"}.`,
          "MISSING_DATA",
          "selftune library list",
          3,
        ),
      );
    }
    const plannedItems = matching.map((recommendation) =>
      mode === "all_safe" && recommendation.canonical.confidence === "review_required"
        ? plannedItem(recommendation, "review_required")
        : plannedItem(recommendation, "planned"),
    );
    const items = options.dryRun
      ? plannedItems
      : yield* Effect.forEach(
          matching,
          (recommendation) =>
            mode === "all_safe" && recommendation.canonical.confidence === "review_required"
              ? Effect.succeed(plannedItem(recommendation, "review_required"))
              : applyRecommendation(recommendation, additionalSearchDirs, runtime),
          { concurrency: 1 },
        );
    const result: SkillsConsolidationResult = {
      success: items.every((item) => item.status !== "failed"),
      operation: "consolidate_skill_installations",
      dry_run: Boolean(options.dryRun),
      mode,
      requested_skill: requestedSkill,
      already_consolidated: false,
      counts: counts(items, matching.length),
      items,
    };
    return result;
  },
);

function requireRollbackInput(options: RunSkillsConsolidationRollbackOptions): string {
  const id = options.id?.trim();
  if (!id) {
    throw new CLIError(
      "Rollback requires a consolidation decision ID through --id.",
      "MISSING_FLAG",
      "selftune skills consolidation-rollback --id ID --dry-run --json",
    );
  }
  if (!options.approved && !options.dryRun) {
    throw new CLIError(
      "Consolidation rollback requires a dry-run preview or explicit approval through --yes.",
      "GUARD_BLOCKED",
      `selftune skills consolidation-rollback --id ${id} --dry-run --json`,
      2,
    );
  }
  return id;
}

function rollbackResult(
  decision: SkillConsolidationDecision,
  dryRun: boolean,
  wasAlreadyRolledBack: boolean,
): SkillsConsolidationRollbackResult {
  if (!decision.receipt) {
    throw new CLIError(
      "Only an applied consolidation can be rolled back.",
      "GUARD_BLOCKED",
      `selftune skills consolidate --skill ${decision.skill_name} --dry-run --json`,
      2,
    );
  }
  return {
    success: true,
    operation: "rollback_skill_consolidation",
    dry_run: dryRun,
    decision_id: decision.approval_id,
    skill_name: decision.skill_name,
    status: dryRun
      ? decision.receipt.status === "rolled_back"
        ? "already_rolled_back"
        : "planned"
      : wasAlreadyRolledBack
        ? "already_rolled_back"
        : "rolled_back",
    receipt_id: decision.receipt.receipt_id,
    restored_paths: decision.targets.map((target) => target.original_package_path),
    removed_links: decision.receipt.linked_paths,
    rolled_back_at: decision.receipt.rolled_back_at,
  };
}

export const runSkillsConsolidationRollbackProgram = Effect.fn(
  "selftune.runtime.skillPortfolio.consolidationRollback",
)(function* (
  options: RunSkillsConsolidationRollbackOptions,
  runtime: SkillsConsolidationProgramOptions = {},
) {
  const id = yield* Effect.try({
    try: () => requireRollbackInput(options),
    catch: (cause) =>
      cause instanceof CLIError
        ? cause
        : new CLIError(String(cause), "INVALID_FLAG", "selftune skills --help"),
  });
  const decision = yield* Effect.try({
    try: () =>
      listSkillConsolidationDecisions(runtime.decisions).find(
        (candidate) => candidate.approval_id === id,
      ),
    catch: (cause) =>
      new CLIError(
        cause instanceof Error ? cause.message : "Unable to load the consolidation receipt.",
        "OPERATION_FAILED",
        "Check the SelfTune decisions directory and retry.",
      ),
  });
  if (!decision) {
    return yield* Effect.fail(
      new CLIError(
        `Consolidation decision was not found: ${id}`,
        "NOT_FOUND",
        "Use the decision_id returned by `selftune skills consolidate --yes --json`.",
        3,
      ),
    );
  }
  if (options.dryRun) {
    return yield* Effect.try({
      try: () => rollbackResult(decision, true, false),
      catch: (cause) =>
        cause instanceof CLIError
          ? cause
          : new CLIError(String(cause), "OPERATION_FAILED", "Refresh the consolidation receipt."),
    });
  }
  const alreadyRolledBack = decision.receipt?.status === "rolled_back";
  const rolledBack = yield* Effect.try({
    try: () => rollbackSkillConsolidationDecision(id, runtime.decisions),
    catch: (cause) =>
      new CLIError(
        cause instanceof Error ? cause.message : "Consolidation rollback failed.",
        "OPERATION_FAILED",
        `selftune skills consolidation-rollback --id ${id} --dry-run --json`,
      ),
  });
  return rollbackResult(rolledBack, false, alreadyRolledBack);
});

export function formatSkillsConsolidation(
  result: SkillsConsolidationResult,
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.already_consolidated) {
    return `${result.requested_skill ?? "Skill"} is already consolidated; no changes were needed.`;
  }
  const lines = [
    `Skill consolidation ${result.dry_run ? "preview" : "result"}: ${result.counts.selected} selected, ${result.counts.review_required} require review, ${result.counts.failed} failed.`,
  ];
  for (const item of result.items) {
    lines.push(`- ${item.skill_name} [${item.status}]`);
    lines.push(`  Canonical: ${item.canonical.package_path}`);
    for (const target of item.targets) {
      lines.push(`  ${target.action}: ${target.package_path}`);
    }
    if (item.decision_id) lines.push(`  Decision: ${item.decision_id}`);
    if (item.undo_command) lines.push(`  Undo: ${item.undo_command}`);
    if (item.error) lines.push(`  Error (${item.error.code}): ${item.error.message}`);
  }
  if (result.dry_run && result.counts.selected > 0) {
    lines.push("");
    lines.push(
      result.mode === "all_safe"
        ? "Apply: selftune skills consolidate --all-safe --yes"
        : `Apply: selftune skills consolidate --skill ${result.requested_skill ?? "NAME"} --yes`,
    );
  }
  return lines.join("\n");
}

export function formatSkillsConsolidationRollback(
  result: SkillsConsolidationRollbackResult,
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2);
  return `Consolidation rollback ${result.status}: ${result.skill_name} (${result.decision_id}).`;
}
