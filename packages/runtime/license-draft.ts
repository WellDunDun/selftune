import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export interface LicenseDraftTerms {
  copyrightHolder: string;
  licensedOrganization: string;
  year: number;
}

export interface LicenseDraftPreview {
  previewId: string;
  skillPath: string;
  licenseExpression: string;
  files: ReadonlyArray<{ path: "SKILL.md" | "LICENSE"; patch: string }>;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (/\r|\n/.test(normalized)) throw new Error(`${label} must be one line.`);
  return normalized;
}

function licenseRef(organization: string): string {
  const slug = organization
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Licensed organization must contain letters or numbers.");
  return `LicenseRef-${slug}-Proprietary`;
}

function addLicenseFrontmatter(content: string, expression: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---")
    throw new Error("SKILL.md needs YAML frontmatter before a license can be drafted.");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("SKILL.md has unterminated YAML frontmatter.");
  if (lines.slice(1, end).some((line) => /^license\s*:/.test(line))) {
    throw new Error("SKILL.md already declares a license.");
  }
  lines.splice(end, 0, `license: ${expression}`);
  return lines.join("\n");
}

function draftTerms(terms: LicenseDraftTerms): string {
  const holder = required(terms.copyrightHolder, "Copyright holder");
  const organization = required(terms.licensedOrganization, "Licensed organization");
  if (!Number.isInteger(terms.year) || terms.year < 1900 || terms.year > 2200) {
    throw new Error("Copyright year is invalid.");
  }
  return `PROPRIETARY LICENSE\n\nCopyright (c) ${terms.year} ${holder}. All rights reserved.\n\nPermission is granted exclusively to ${organization} and its authorized personnel to use, copy, and modify this skill for the organization's internal operations. Private distribution within ${organization} is permitted only to authorized personnel.\n\nExternal redistribution, sublicensing, publication, sale, or disclosure to third parties is prohibited without prior written permission from ${holder}.\n\nThis license covers the skill instructions, scripts, templates, and bundled assets only. It does not grant permission to disclose participant, client, session, or other confidential data processed with the skill.\n\nTHE SKILL IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.\n`;
}

function unifiedPatch(path: string, before: string | null, after: string): string {
  const oldLines = before?.split("\n") ?? [];
  const newLines = after.split("\n");
  const oldPath = before === null ? "/dev/null" : `a/${path}`;
  return [
    `diff --git a/${path} b/${path}`,
    `--- ${oldPath}`,
    `+++ b/${path}`,
    `@@ -${before === null ? "0,0" : `1,${oldLines.length}`} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

export function previewLicenseDraft(
  skillPath: string,
  terms: LicenseDraftTerms,
): LicenseDraftPreview {
  const resolvedSkillPath = resolve(skillPath);
  const skillFile = join(resolvedSkillPath, "SKILL.md");
  const licenseFile = join(resolvedSkillPath, "LICENSE");
  if (!existsSync(skillFile)) throw new Error(`SKILL.md was not found for ${basename(skillPath)}.`);
  if (existsSync(licenseFile)) throw new Error("This skill already bundles a LICENSE file.");
  const before = readFileSync(skillFile, "utf8");
  const expression = licenseRef(required(terms.licensedOrganization, "Licensed organization"));
  const skillAfter = addLicenseFrontmatter(before, expression);
  const licenseAfter = draftTerms(terms);
  const previewId = createHash("sha256")
    .update(resolvedSkillPath)
    .update("\0")
    .update(before)
    .update("\0")
    .update(skillAfter)
    .update("\0")
    .update(licenseAfter)
    .digest("hex");
  return {
    previewId,
    skillPath: resolvedSkillPath,
    licenseExpression: expression,
    files: [
      { path: "SKILL.md", patch: unifiedPatch("SKILL.md", before, skillAfter) },
      { path: "LICENSE", patch: unifiedPatch("LICENSE", null, licenseAfter) },
    ],
  };
}

export function applyLicenseDraft(input: {
  skillPath: string;
  previewId: string;
  terms: LicenseDraftTerms;
}): LicenseDraftPreview {
  const preview = previewLicenseDraft(input.skillPath, input.terms);
  if (preview.previewId !== input.previewId) {
    throw new Error(
      "The skill changed after this draft was reviewed. Preview it again before applying.",
    );
  }
  const skillFile = join(preview.skillPath, "SKILL.md");
  const licenseFile = join(preview.skillPath, "LICENSE");
  const originalSkill = readFileSync(skillFile, "utf8");
  const nextSkill = addLicenseFrontmatter(originalSkill, preview.licenseExpression);
  const nextLicense = draftTerms(input.terms);
  const nonce = `${process.pid}-${Date.now()}`;
  const skillTemp = join(dirname(skillFile), `.SKILL.md.${nonce}.tmp`);
  const licenseTemp = join(dirname(licenseFile), `.LICENSE.${nonce}.tmp`);
  try {
    writeFileSync(skillTemp, nextSkill, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(licenseTemp, nextLicense, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(licenseTemp, licenseFile);
    try {
      renameSync(skillTemp, skillFile);
    } catch (cause) {
      rmSync(licenseFile, { force: true });
      throw cause;
    }
    return preview;
  } finally {
    rmSync(skillTemp, { force: true });
    rmSync(licenseTemp, { force: true });
  }
}
