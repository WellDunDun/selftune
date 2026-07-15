import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { SkillTestingReadiness } from "../dashboard-contract.js";
import { emitDashboardStepProgress } from "../dashboard-action-instrumentation.js";
import { scoreDescription } from "../evolution/description-quality.js";
import { getDb } from "../localdb/db.js";
import { getSkillTestingReadiness } from "../testing-readiness.js";
import type { CreateCheckReadiness, CreateCheckResult, CreateCheckState } from "../types.js";
import { parseFrontmatter, type SkillFrontmatter } from "../utils/frontmatter.js";
import { CLIError } from "../utils/cli-error.js";
import {
  buildCreateSkillManifest,
  slugifyCreateSkillName,
  type CreateSkillManifest,
} from "./templates.js";
import { validateAgentSkill, type ValidateAgentSkillDeps } from "./skills-ref-adapter.js";

const SKILL_MD_LINE_BUDGET = 500;
const DESCRIPTION_CHAR_BUDGET = 1024;

export interface ComputeCreateCheckDeps {
  validateAgentSkill?: (
    skillDir: string,
    deps?: ValidateAgentSkillDeps,
  ) => Promise<CreateCheckResult["spec_validation"]>;
  getTestingReadiness?: (skillName: string, searchDirs: string[]) => SkillTestingReadiness | null;
}

export interface ResolvedCreateSkillPath {
  skill_dir: string;
  skill_path: string;
}

export interface LoadedCreateManifest {
  manifest: CreateSkillManifest;
  present: boolean;
}

export interface CreateSkillContext {
  skill_name: string;
  skill_dir: string;
  skill_path: string;
  skill_content: string;
  frontmatter: SkillFrontmatter;
  manifest: CreateSkillManifest;
  manifest_present: boolean;
  testing_readiness: SkillTestingReadiness | null;
}

export function resolveCreateSkillPath(skillPathArg: string): ResolvedCreateSkillPath {
  const trimmed = skillPathArg.trim();
  if (!trimmed) {
    throw new CLIError(
      "--skill-path <path> is required",
      "MISSING_FLAG",
      "selftune create check --skill-path /path/to/SKILL.md",
    );
  }

  const absolute = resolve(trimmed);
  const stat = existsSync(absolute) ? statSync(absolute) : null;

  if (stat?.isDirectory()) {
    const skillPath = join(absolute, "SKILL.md");
    if (!existsSync(skillPath)) {
      throw new CLIError(
        `SKILL.md not found under ${absolute}`,
        "FILE_NOT_FOUND",
        "Pass a skill directory or a direct path to SKILL.md.",
      );
    }
    return { skill_dir: absolute, skill_path: skillPath };
  }

  if (!existsSync(absolute)) {
    throw new CLIError(
      `Skill path not found at ${absolute}`,
      "FILE_NOT_FOUND",
      "Pass a skill directory or a direct path to SKILL.md.",
    );
  }

  if (basename(absolute) !== "SKILL.md") {
    throw new CLIError(
      `Expected a skill directory or SKILL.md, received ${absolute}`,
      "INVALID_FLAG",
      "Pass --skill-path /path/to/skill-dir or /path/to/skill-dir/SKILL.md",
    );
  }

  return { skill_dir: dirname(absolute), skill_path: absolute };
}

export function loadCreateManifest(skillDir: string): LoadedCreateManifest {
  const manifestPath = join(skillDir, "selftune.create.json");
  const fallback = buildCreateSkillManifest();

  if (!existsSync(manifestPath)) {
    return { manifest: fallback, present: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<CreateSkillManifest>;
    return {
      manifest: {
        version: 1,
        entry_workflow:
          typeof parsed.entry_workflow === "string" && parsed.entry_workflow.trim().length > 0
            ? parsed.entry_workflow
            : fallback.entry_workflow,
        supports_package_replay:
          typeof parsed.supports_package_replay === "boolean"
            ? parsed.supports_package_replay
            : fallback.supports_package_replay,
        expected_resources: {
          workflows:
            typeof parsed.expected_resources?.workflows === "boolean"
              ? parsed.expected_resources.workflows
              : fallback.expected_resources.workflows,
          references:
            typeof parsed.expected_resources?.references === "boolean"
              ? parsed.expected_resources.references
              : fallback.expected_resources.references,
          scripts:
            typeof parsed.expected_resources?.scripts === "boolean"
              ? parsed.expected_resources.scripts
              : fallback.expected_resources.scripts,
          assets:
            typeof parsed.expected_resources?.assets === "boolean"
              ? parsed.expected_resources.assets
              : fallback.expected_resources.assets,
        },
      },
      present: true,
    };
  } catch {
    return { manifest: fallback, present: false };
  }
}

function hasDirectoryEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export function isCreateSkillDraft(skillPath: string): boolean {
  return existsSync(join(dirname(skillPath), "selftune.create.json"));
}

function readTestingReadiness(
  skillName: string,
  skillDir: string,
  deps: ComputeCreateCheckDeps,
): SkillTestingReadiness | null {
  if (deps.getTestingReadiness) {
    return deps.getTestingReadiness(skillName, [dirname(skillDir)]);
  }

  try {
    return getSkillTestingReadiness(getDb(), skillName, [dirname(skillDir)]);
  } catch {
    return null;
  }
}

export function readCreateSkillContext(
  skillPathArg: string,
  deps: ComputeCreateCheckDeps = {},
): CreateSkillContext {
  const { skill_dir, skill_path } = resolveCreateSkillPath(skillPathArg);
  const skill_content = readFileSync(skill_path, "utf-8");
  const frontmatter = parseFrontmatter(skill_content);
  const { manifest, present: manifest_present } = loadCreateManifest(skill_dir);
  const skill_name = frontmatter.name.trim() || slugifyCreateSkillName(basename(skill_dir));
  const testing_readiness = readTestingReadiness(skill_name, skill_dir, deps);

  return {
    skill_name,
    skill_dir,
    skill_path,
    skill_content,
    frontmatter,
    manifest,
    manifest_present,
    testing_readiness,
  };
}

function derivePackageResourcesReady(
  manifest: CreateSkillManifest,
  checks: CreateCheckResult["readiness"]["checks"],
): boolean {
  if (!checks.skill_md) return false;
  if (!checks.frontmatter_present) return false;
  if (!checks.skill_name_matches_dir) return false;
  if (!checks.description_present) return false;
  if (!checks.description_within_budget) return false;
  if (!checks.skill_md_within_line_budget) return false;
  if (!checks.workflow_entry) return false;
  if (manifest.expected_resources.references && !checks.references_present) return false;
  if (manifest.expected_resources.scripts && !checks.scripts_present) return false;
  if (manifest.expected_resources.assets && !checks.assets_present) return false;
  return true;
}

function recommendNextCommand(
  state: CreateCheckState,
  skillName: string,
  skillPath: string,
  skillDir: string,
  specCommand: string | null,
): string | null {
  switch (state) {
    case "blocked_spec_validation":
      return specCommand ?? `uvx skills-ref validate ${skillDir}`;
    case "needs_spec_validation":
      return `selftune create check --skill-path ${skillPath}`;
    case "needs_package_resources":
      return `selftune create check --skill-path ${skillPath}`;
    case "needs_evals":
      return `selftune eval generate --skill ${skillName} --skill-path ${skillPath} --auto-synthetic`;
    case "needs_unit_tests":
      return `selftune eval unit-test --skill ${skillName} --generate --skill-path ${skillPath}`;
    case "needs_routing_replay":
      return `selftune create replay --skill-path ${skillPath} --mode package`;
    case "needs_baseline":
      return `selftune create baseline --skill-path ${skillPath} --mode package`;
    case "ready_to_publish":
      return `selftune create publish --skill-path ${skillPath}`;
  }
}

function summarizeState(
  state: CreateCheckState,
  manifestPresent: boolean,
  testingReadiness: SkillTestingReadiness | null,
): string {
  switch (state) {
    case "blocked_spec_validation":
      return "Agent Skills spec validation is blocking this draft. Fix validator issues before treating the package as publishable.";
    case "needs_spec_validation":
      return "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.";
    case "needs_package_resources":
      return manifestPresent
        ? "Package structure is incomplete for the declared manifest. Fill the missing routing or resource files and rerun the check."
        : "Package structure is incomplete. selftune inferred manifest defaults because selftune.create.json is missing or invalid.";
    case "needs_evals":
      return "Package structure is valid enough to continue, but there is no canonical eval set for this skill yet.";
    case "needs_unit_tests":
      return "Routing evals exist, but deterministic unit tests are still missing.";
    case "needs_routing_replay":
      return testingReadiness?.replay_check_count
        ? "Replay validation data exists, but selftune could not confirm the routing dry-run state."
        : "Evals and unit tests exist, but the creator-loop replay dry-run has not been recorded yet.";
    case "needs_baseline":
      return "Replay validation is recorded, but no no-skill baseline measurement exists yet.";
    case "ready_to_publish":
      return "Spec validation, package structure, evals, unit tests, replay, and baseline are all present. The draft is ready for the deploy step.";
  }
}

export function computeCreateReadiness(
  context: CreateSkillContext,
  options: { specValidationOk?: boolean; specCommand?: string | null } = {},
): CreateCheckReadiness {
  const descriptionQuality = scoreDescription(
    context.frontmatter.description.trim(),
    context.skill_name,
  );
  const skillLineCount = context.skill_content.split(/\r?\n/).length;
  const workflowEntryPath = join(context.skill_dir, context.manifest.entry_workflow);

  const checks: CreateCheckReadiness["checks"] = {
    skill_md: existsSync(context.skill_path),
    frontmatter_present:
      context.skill_content.startsWith("---\n") || context.skill_content === "---",
    skill_name_matches_dir: context.frontmatter.name.trim() === basename(context.skill_dir),
    description_present: context.frontmatter.description.trim().length > 0,
    description_within_budget:
      context.frontmatter.description.trim().length > 0 &&
      context.frontmatter.description.trim().length <= DESCRIPTION_CHAR_BUDGET,
    skill_md_within_line_budget: skillLineCount <= SKILL_MD_LINE_BUDGET,
    manifest_present: context.manifest_present,
    workflow_entry: existsSync(workflowEntryPath),
    references_present:
      existsSync(join(context.skill_dir, "references")) &&
      (existsSync(join(context.skill_dir, "references", "overview.md")) ||
        hasDirectoryEntries(join(context.skill_dir, "references"))),
    scripts_present:
      existsSync(join(context.skill_dir, "scripts")) &&
      hasDirectoryEntries(join(context.skill_dir, "scripts")),
    assets_present:
      existsSync(join(context.skill_dir, "assets")) &&
      hasDirectoryEntries(join(context.skill_dir, "assets")),
    evals_present: (context.testing_readiness?.eval_set_entries ?? 0) > 0,
    unit_tests_present: (context.testing_readiness?.unit_test_cases ?? 0) > 0,
    routing_replay_ready:
      existsSync(context.skill_path) &&
      context.frontmatter.name.trim().length > 0 &&
      context.frontmatter.description.trim().length > 0,
    routing_replay_recorded: (context.testing_readiness?.replay_check_count ?? 0) > 0,
    package_replay_ready: false,
    baseline_present: (context.testing_readiness?.baseline_sample_size ?? 0) > 0,
  };

  const packageResourcesReady = derivePackageResourcesReady(context.manifest, checks);
  checks.package_replay_ready =
    context.manifest.supports_package_replay &&
    packageResourcesReady &&
    (!context.manifest.expected_resources.references || checks.references_present) &&
    (!context.manifest.expected_resources.scripts || checks.scripts_present) &&
    (!context.manifest.expected_resources.assets || checks.assets_present);

  let state: CreateCheckState;
  if (options.specValidationOk === false) {
    state = "blocked_spec_validation";
  } else if (!packageResourcesReady) {
    state = "needs_package_resources";
  } else if (!checks.evals_present) {
    state = "needs_evals";
  } else if (
    context.testing_readiness?.next_step === "run_unit_tests" &&
    checks.unit_tests_present
  ) {
    state = "needs_unit_tests";
  } else if (!checks.unit_tests_present) {
    state = "needs_unit_tests";
  } else if (
    context.testing_readiness?.next_step === "run_replay_dry_run" &&
    checks.routing_replay_recorded
  ) {
    state = "needs_routing_replay";
  } else if (!checks.routing_replay_recorded) {
    state = "needs_routing_replay";
  } else if (
    context.testing_readiness?.next_step === "measure_baseline" &&
    checks.baseline_present
  ) {
    state = "needs_baseline";
  } else if (!checks.baseline_present) {
    state = "needs_baseline";
  } else if (options.specValidationOk !== true) {
    state = "needs_spec_validation";
  } else {
    state = "ready_to_publish";
  }

  const nextCommand = recommendNextCommand(
    state,
    context.skill_name,
    context.skill_path,
    context.skill_dir,
    options.specCommand ?? null,
  );

  return {
    ok: state === "ready_to_publish",
    state,
    summary: summarizeState(state, context.manifest_present, context.testing_readiness),
    next_command: nextCommand,
    checks,
    skill_name: context.skill_name,
    skill_dir: context.skill_dir,
    skill_path: context.skill_path,
    entry_workflow: context.manifest.entry_workflow,
    manifest_present: context.manifest_present,
    description_quality: descriptionQuality,
  };
}

export function computeCreateDashboardReadiness(
  skillPathArg: string,
  deps: ComputeCreateCheckDeps = {},
): CreateCheckReadiness {
  const context = readCreateSkillContext(skillPathArg, deps);
  return computeCreateReadiness(context, {
    specCommand: `selftune create check --skill-path ${context.skill_path}`,
  });
}

export async function computeCreateCheckResult(
  skillPathArg: string,
  deps: ComputeCreateCheckDeps = {},
): Promise<CreateCheckResult> {
  emitDashboardStepProgress({
    current: 1,
    total: 3,
    status: "started",
    phase: "load_draft_package",
    label: "Load draft package",
  });
  const context = readCreateSkillContext(skillPathArg, deps);
  emitDashboardStepProgress({
    current: 1,
    total: 3,
    status: "finished",
    phase: "load_draft_package",
    label: "Load draft package",
    passed: true,
    evidence: context.skill_name,
  });

  emitDashboardStepProgress({
    current: 2,
    total: 3,
    status: "started",
    phase: "spec_validation",
    label: "Run Agent Skills validation",
  });
  const specValidation = await (deps.validateAgentSkill ?? validateAgentSkill)(context.skill_dir);
  emitDashboardStepProgress({
    current: 2,
    total: 3,
    status: "finished",
    phase: "spec_validation",
    label: "Run Agent Skills validation",
    passed: specValidation.ok,
    evidence: specValidation.command ?? specValidation.validator,
  });

  emitDashboardStepProgress({
    current: 3,
    total: 3,
    status: "started",
    phase: "compute_create_readiness",
    label: "Compute selftune readiness",
  });
  const readiness = computeCreateReadiness(context, {
    specValidationOk: specValidation.ok,
    specCommand: specValidation.command,
  });
  emitDashboardStepProgress({
    current: 3,
    total: 3,
    status: "finished",
    phase: "compute_create_readiness",
    label: "Compute selftune readiness",
    passed: readiness.ok && specValidation.ok,
    evidence: readiness.summary,
  });

  return {
    skill: context.skill_name,
    skill_dir: context.skill_dir,
    skill_path: context.skill_path,
    ok: readiness.ok && specValidation.ok,
    state: readiness.state,
    next_command: readiness.next_command,
    spec_validation: specValidation,
    readiness,
  };
}

function formatBooleanCheck(name: string, value: boolean): string {
  return `${value ? "PASS" : "FAIL"} ${name}`;
}

export function formatCreateCheckResult(result: CreateCheckResult): string {
  const checks = result.readiness.checks;

  return [
    `Skill: ${result.skill}`,
    `Directory: ${result.skill_dir}`,
    `State: ${result.state}`,
    `Spec validation: ${result.spec_validation.ok ? "pass" : "blocked"}${result.spec_validation.command ? ` (${result.spec_validation.command})` : ""}`,
    "",
    "Checks:",
    `  ${formatBooleanCheck("skill_md", checks.skill_md)}`,
    `  ${formatBooleanCheck("frontmatter_present", checks.frontmatter_present)}`,
    `  ${formatBooleanCheck("skill_name_matches_dir", checks.skill_name_matches_dir)}`,
    `  ${formatBooleanCheck("description_present", checks.description_present)}`,
    `  ${formatBooleanCheck("description_within_budget", checks.description_within_budget)}`,
    `  ${formatBooleanCheck("skill_md_within_line_budget", checks.skill_md_within_line_budget)}`,
    `  ${formatBooleanCheck("manifest_present", checks.manifest_present)}`,
    `  ${formatBooleanCheck("workflow_entry", checks.workflow_entry)}`,
    `  ${formatBooleanCheck("references_present", checks.references_present)}`,
    `  ${formatBooleanCheck("scripts_present", checks.scripts_present)}`,
    `  ${formatBooleanCheck("assets_present", checks.assets_present)}`,
    `  ${formatBooleanCheck("evals_present", checks.evals_present)}`,
    `  ${formatBooleanCheck("unit_tests_present", checks.unit_tests_present)}`,
    `  ${formatBooleanCheck("routing_replay_ready", checks.routing_replay_ready)}`,
    `  ${formatBooleanCheck("routing_replay_recorded", checks.routing_replay_recorded)}`,
    `  ${formatBooleanCheck("package_replay_ready", checks.package_replay_ready)}`,
    `  ${formatBooleanCheck("baseline_present", checks.baseline_present)}`,
    "",
    `Description quality: ${Math.round(result.readiness.description_quality.composite * 100)}%`,
    `Summary: ${result.readiness.summary}`,
    result.next_command ? `Next command: ${result.next_command}` : "Next command: none",
  ].join("\n");
}
