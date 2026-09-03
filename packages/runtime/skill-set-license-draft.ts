import { CLIError } from "./utils/cli-error";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSkillVersionHash,
  getSkillSet,
  updateSkillSet,
  type SkillSetServiceOptions,
} from "@selftune/library";
import { applyLicenseDraft, previewLicenseDraft, type LicenseDraftTerms } from "./license-draft";

function resolveDraft(setId: string, skillId: string, options: SkillSetServiceOptions) {
  const manifest = getSkillSet(setId, options);
  const skill = manifest.skills.find((candidate) => candidate.name === skillId);
  if (!skill)
    throw new CLIError(
      "This skill is no longer in the Skill Set. Refresh and try again.",
      "GUARD_BLOCKED",
    );
  for (const component of manifest.skills) {
    if (
      computeSkillVersionHash(join(component.library_package_path, "SKILL.md")) !==
      component.content_hash
    ) {
      throw new CLIError(
        `The cached package for ${component.name} changed. Restore it before drafting a license.`,
        "GUARD_BLOCKED",
      );
    }
  }
  return { manifest, skill };
}

export function previewSkillSetLicenseDraft(
  setId: string,
  skillId: string,
  terms: LicenseDraftTerms,
  options: SkillSetServiceOptions = {},
) {
  const { manifest, skill } = resolveDraft(setId, skillId, options);
  const preview = previewLicenseDraft(skill.library_package_path, terms);
  return {
    ...preview,
    previewId: createHash("sha256")
      .update(manifest.set_id)
      .update("\0")
      .update(manifest.revision_hash)
      .update("\0")
      .update(preview.previewId)
      .digest("hex"),
  };
}

export function applySkillSetLicenseDraft(
  setId: string,
  skillId: string,
  previewId: string,
  terms: LicenseDraftTerms,
  options: SkillSetServiceOptions = {},
) {
  const preview = previewSkillSetLicenseDraft(setId, skillId, terms, options);
  if (preview.previewId !== previewId) {
    throw new CLIError(
      "The Skill Set or license terms changed. Review the draft again before applying.",
      "GUARD_BLOCKED",
    );
  }
  const { manifest, skill } = resolveDraft(setId, skillId, options);
  const staging = mkdtempSync(join(tmpdir(), "selftune-set-license-"));
  try {
    const packagePath = join(staging, skill.name);
    cpSync(skill.library_package_path, packagePath, { recursive: true });
    if (computeSkillVersionHash(join(packagePath, "SKILL.md")) !== skill.content_hash) {
      throw new CLIError(
        "The package changed while preparing the license. Review the draft again.",
        "GUARD_BLOCKED",
      );
    }
    const stagedPreview = previewLicenseDraft(packagePath, terms);
    applyLicenseDraft({ skillPath: packagePath, previewId: stagedPreview.previewId, terms });
    updateSkillSet(
      setId,
      {
        parent_revision_hash: manifest.revision_hash,
        harnesses: manifest.harnesses,
        skills: manifest.skills.map((component) => ({
          name: component.name,
          package_path: component.name === skillId ? packagePath : component.library_package_path,
        })),
      },
      options,
    );
    return preview;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
