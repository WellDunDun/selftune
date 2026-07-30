import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { planSkillSet, type SkillSetPlan, type SkillSetServiceOptions } from "@selftune/library";

import { applySkillSetWithRemoteDependencies } from "./skill-set-remote-apply.js";
import { CLIError } from "./utils/cli-error.js";

export interface ProjectConfigurationInput {
  readonly projectRoot: string;
  readonly skillSetIds: ReadonlyArray<string>;
  readonly harnesses?: ReadonlyArray<string>;
}

export interface ProjectConfigurationPlan {
  readonly projectRoot: string;
  readonly skillSetPlans: ReadonlyArray<SkillSetPlan>;
  readonly creates: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly missingDependencies: number;
}

function uniqueSkillSetIds(skillSetIds: ReadonlyArray<string>): string[] {
  const unique = [...new Set(skillSetIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw new CLIError(
      "At least one Skill Set is required.",
      "MISSING_FLAG",
      "selftune project configure --set <skill-set> --project <folder>",
    );
  }
  return unique;
}

function validateOverlappingTargets(skillSetPlans: ReadonlyArray<SkillSetPlan>): void {
  const targets = new Map<string, { readonly setName: string; readonly contentHash: string }>();
  for (const plan of skillSetPlans) {
    for (const operation of plan.operations) {
      const existing = targets.get(operation.target_path);
      if (existing && existing.contentHash !== operation.content_hash) {
        throw new CLIError(
          `Selected Skill Sets disagree about ${operation.target_path}: "${existing.setName}" and "${plan.set_name}" pin different revisions.`,
          "GUARD_BLOCKED",
          "Choose one revision, or create a combined Skill Set with the intended skills.",
          2,
        );
      }
      targets.set(operation.target_path, {
        setName: plan.set_name,
        contentHash: operation.content_hash,
      });
    }
  }
}

export function planProjectConfiguration(
  input: ProjectConfigurationInput,
  options: SkillSetServiceOptions = {},
): ProjectConfigurationPlan {
  const skillSetPlans = uniqueSkillSetIds(input.skillSetIds).map((setId) =>
    planSkillSet(
      { set_id: setId, project_root: input.projectRoot, harnesses: input.harnesses },
      options,
    ),
  );
  validateOverlappingTargets(skillSetPlans);
  return {
    projectRoot: skillSetPlans[0]!.project_root,
    skillSetPlans,
    creates: skillSetPlans.reduce((total, plan) => total + plan.creates, 0),
    unchanged: skillSetPlans.reduce((total, plan) => total + plan.unchanged, 0),
    conflicts: skillSetPlans.reduce((total, plan) => total + plan.conflicts, 0),
    missingDependencies: skillSetPlans.reduce(
      (total, plan) => total + plan.missing_dependencies,
      0,
    ),
  };
}

export async function applyProjectConfiguration(
  input: ProjectConfigurationInput,
  options: SkillSetServiceOptions = {},
) {
  const plan = planProjectConfiguration(input, options);
  if (plan.conflicts > 0) {
    throw new CLIError(
      `Project configuration is blocked by ${plan.conflicts} destination conflict${plan.conflicts === 1 ? "" : "s"}.`,
      "GUARD_BLOCKED",
      "Review the plan, resolve the existing package, then retry.",
      2,
    );
  }
  const receipts = [];
  for (const skillSetPlan of plan.skillSetPlans) {
    receipts.push(
      await applySkillSetWithRemoteDependencies(
        { set_id: skillSetPlan.set_id, project_root: plan.projectRoot, harnesses: input.harnesses },
        options,
      ),
    );
  }
  return { plan, receipts };
}

export async function initializeReactProject(
  input: ProjectConfigurationInput,
  options: SkillSetServiceOptions = {},
) {
  const projectRoot = resolve(input.projectRoot);
  if (existsSync(projectRoot)) {
    throw new CLIError(
      `Project directory already exists: ${projectRoot}`,
      "GUARD_BLOCKED",
      "Use `selftune project configure` to add Skill Sets to that project instead.",
      2,
    );
  }
  const scaffold = Bun.spawn(
    ["npm", "create", "vite@latest", basename(projectRoot), "--", "--template", "react-ts"],
    { cwd: dirname(projectRoot), stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  if ((await scaffold.exited) !== 0) {
    throw new CLIError(
      `React project scaffold failed for ${projectRoot}.`,
      "OPERATION_FAILED",
      "Fix the scaffold error above, then run `selftune project configure` for the new folder.",
    );
  }
  return applyProjectConfiguration({ ...input, projectRoot }, options);
}
