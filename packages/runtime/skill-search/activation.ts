import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  applySkillManifest,
  cacheSkillPackage,
  getSkillSet,
  listSkillSetReceipts,
  planSkillManifest,
  planSkillSetRollback,
  rollbackSkillSet,
  type SkillSetHarnessId,
  type SkillSetManifest,
} from "@selftune/library";
import { computeSkillVersionHash } from "@selftune/library/hash";
import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { CLIError } from "../utils/cli-error.js";
import { loadLocalSkillCatalog } from "./search.js";

export type SkillSelection = { readonly ids: readonly string[] } | { readonly setId: string };

export function loadSkill(
  id: string,
  options: { configRoot?: string; searchDirs?: readonly string[] } = {},
) {
  const hit = loadLocalSkillCatalog(options).documents.get(id);
  if (!hit)
    throw new CLIError(
      `Skill ID is missing or stale: ${id}`,
      "NOT_FOUND",
      "Run `selftune skills search` again.",
    );
  const content = readFileSync(hit.skill_path, "utf8");
  if (computeSkillVersionHash(hit.skill_path) !== hit.revision)
    blocked("Skill changed while loading. Search again.");
  const { text: _text, ...metadata } = hit;
  return { ...metadata, content };
}
export interface ActivationOptions {
  readonly selection: SkillSelection;
  readonly project: string;
  readonly task: string;
  readonly harness: SkillSetHarnessId;
  readonly configRoot?: string;
  readonly searchDirs?: readonly string[];
}

function blocked(message: string): never {
  throw new CLIError(
    message,
    "GUARD_BLOCKED",
    "Inspect `selftune skills active --json`; clean up this task before retrying.",
    2,
  );
}
function projectPath(project: string) {
  if (!project.trim() || !existsSync(resolve(project))) {
    throw new CLIError("An existing project directory is required.", "FILE_NOT_FOUND");
  }
  return realpathSync(resolve(project));
}
function prepare(options: ActivationOptions) {
  if (!options.task.trim() || options.task.length > 200) {
    throw new CLIError("--task must contain 1–200 characters.", "INVALID_ARGUMENT");
  }
  if (!["codex", "claude_code", "opencode", "openclaw", "pi"].includes(options.harness)) {
    throw new CLIError("Select a supported --harness.", "INVALID_ARGUMENT");
  }
  const service = { configRoot: resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR) };
  const project = projectPath(options.project);
  const selection = options.selection;
  const skills =
    "setId" in selection
      ? getSkillSet(selection.setId, service).skills
      : (() => {
          const catalog = loadLocalSkillCatalog({ ...service, searchDirs: options.searchDirs });
          return [...new Set(selection.ids)].map((id) => {
            const hit = catalog.documents.get(id);
            if (!hit)
              throw new CLIError(
                `Skill ID is missing or stale: ${id}`,
                "NOT_FOUND",
                "Run `selftune skills search` again and select a returned ID.",
              );
            return {
              name: basename(hit.package_path),
              content_hash: hit.revision,
              library_package_path: hit.package_path,
            };
          });
        })();
  if (!skills.length || skills.length > 100)
    throw new CLIError("Select 1–100 skills.", "INVALID_ARGUMENT");
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name))
      blocked(`Selection contains duplicate destination name "${skill.name}".`);
    names.add(skill.name);
    if (
      computeSkillVersionHash(join(skill.library_package_path, "SKILL.md")) !== skill.content_hash
    ) {
      blocked(
        `Selected revision "${skill.name}" is unavailable or changed. Re-import it before activation.`,
      );
    }
  }
  const identity = createHash("sha256")
    .update(JSON.stringify([project, options.task, options.harness]))
    .digest("hex");
  const revision = createHash("sha256")
    .update(JSON.stringify(skills.map((skill) => [skill.name, skill.content_hash]).sort()))
    .digest("hex");
  const manifest: SkillSetManifest = {
    schema_version: 1,
    set_id: `temporary-${identity}`,
    name: `Task: ${options.task}`,
    description: "Local task-scoped selection",
    harnesses: [options.harness],
    skills,
    revision: 1,
    revision_hash: revision,
    parent_revision_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { service, project, manifest };
}

export function previewActivation(options: ActivationOptions) {
  const { project, manifest } = prepare(options);
  return planSkillManifest({ project_root: project }, manifest);
}

export function activateSkills(options: ActivationOptions) {
  const { service, project, manifest } = prepare(options);
  const plan = planSkillManifest({ project_root: project }, manifest);
  const existing = listSkillSetReceipts(service).find(
    (receipt) =>
      receipt.set_id === manifest.set_id &&
      receipt.temporary_task === options.task &&
      receipt.status !== "rolled_back",
  );
  if (existing) {
    if (existing.status === "applying")
      blocked(
        `Task activation was interrupted; clean up receipt ${existing.receipt_id} before retrying.`,
      );
    if (existing.set_revision_hash !== manifest.revision_hash || plan.creates || plan.conflicts) {
      blocked(
        `Task selection or project changed; clean up receipt ${existing.receipt_id} before changing the selection.`,
      );
    }
    planSkillSetRollback(existing.receipt_id, service);
    return existing;
  }
  if (plan.conflicts)
    blocked(
      `Activation has ${plan.conflicts} destination conflicts. No project files were changed.`,
    );
  const skills = manifest.skills.map((skill) => {
    const cached = cacheSkillPackage(
      { name: skill.name, package_path: skill.library_package_path },
      service,
    );
    if (cached.content_hash !== skill.content_hash)
      blocked(`Source changed while caching "${skill.name}". Search again.`);
    return cached;
  });
  return applySkillManifest(
    { project_root: project, temporary_task: options.task },
    { ...manifest, skills },
    service,
  );
}

export function activeSkills(options: { project: string; task?: string; configRoot?: string }) {
  const project = projectPath(options.project);
  return listSkillSetReceipts({ configRoot: options.configRoot ?? SELFTUNE_CONFIG_DIR }).filter(
    (receipt) =>
      receipt.temporary_task &&
      receipt.status !== "rolled_back" &&
      receipt.project_root === project &&
      (options.task === undefined || receipt.temporary_task === options.task),
  );
}

export interface DeactivationOptions {
  readonly project: string;
  readonly owner: { readonly task: string } | { readonly receipt: string };
  readonly configRoot?: string;
}
export function previewDeactivation(options: DeactivationOptions) {
  const service = { configRoot: options.configRoot ?? SELFTUNE_CONFIG_DIR };
  const project = projectPath(options.project);
  const owner = options.owner;
  if ("task" in owner && !owner.task.trim())
    throw new CLIError("--task must not be empty.", "INVALID_ARGUMENT");
  const receipts =
    "task" in owner
      ? activeSkills({ ...service, project, task: owner.task })
      : [planSkillSetRollback(owner.receipt, service).receipt];
  return receipts.map((receipt) => {
    if (!receipt.temporary_task || receipt.project_root !== project)
      blocked("Receipt does not belong to a temporary activation in this project.");
    return planSkillSetRollback(receipt.receipt_id, service);
  });
}
export function deactivateSkills(options: DeactivationOptions) {
  // Validate all selected receipts before removing any task-owned path.
  const plans = previewDeactivation(options);
  return plans.map(({ receipt }) =>
    rollbackSkillSet(receipt.receipt_id, { configRoot: options.configRoot ?? SELFTUNE_CONFIG_DIR }),
  );
}
