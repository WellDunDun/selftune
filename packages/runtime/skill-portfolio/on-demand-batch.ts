import { resolve } from "node:path";
import type { PortfolioQuarantineBatchResult } from "../dashboard-contract.js";
import type { InstalledSkillPackage } from "../utils/skill-discovery.js";
import { quarantineSkill } from "./quarantine.js";

export interface PortfolioMoveInput {
  skillName: string;
  skillPath: string;
  keepSearchable?: boolean;
  expectedContentHash?: string;
}

export function quarantinePortfolioBatch(
  inputs: readonly PortfolioMoveInput[],
  options: {
    installedSkills: InstalledSkillPackage[];
    quarantineRoot?: string;
    configRoot?: string;
  },
): PortfolioQuarantineBatchResult {
  const result: PortfolioQuarantineBatchResult = { receipts: [], failures: [] };
  const installedPath = (input: PortfolioMoveInput) =>
    resolve(
      options.installedSkills.find(
        (skill) =>
          resolve(skill.skill_path) === resolve(input.skillPath) ||
          resolve(skill.package_path) === resolve(input.skillPath),
      )?.skill_path ?? input.skillPath,
    );
  const groups = new Map<string, PortfolioMoveInput[]>();
  for (const input of inputs) {
    const key = `${input.keepSearchable === true}:${input.skillName.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }
  for (const group of groups.values()) {
    const unique = [...new Map(group.map((input) => [installedPath(input), input])).values()];
    const args = (input: PortfolioMoveInput) => ({
      ...options,
      ...input,
      expectedPackageVersionHash: input.expectedContentHash,
    });
    try {
      if (unique[0]?.keepSearchable) {
        if (new Set(unique.map((input) => input.expectedContentHash)).size !== 1) {
          throw new Error("Different revisions need review before consolidation.");
        }
        const selected = new Set(unique.map(installedPath));
        const unreviewed = options.installedSkills.some(
          (skill) =>
            skill.name.toLowerCase() === unique[0]?.skillName.toLowerCase() &&
            !selected.has(resolve(skill.skill_path)),
        );
        if (unreviewed)
          throw new Error(
            "Installations changed. Refresh to review all copies before moving this skill.",
          );
        // Verify every copy before removing any. Links must move before their source.
        for (const input of unique) quarantineSkill({ ...args(input), dryRun: true });
      }
    } catch (cause) {
      for (const input of unique)
        result.failures.push({
          skill_name: input.skillName,
          skill_path: input.skillPath,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      continue;
    }
    const ordered = unique.toSorted((left, right) => {
      const linked = (input: PortfolioMoveInput) =>
        options.installedSkills.find((skill) => resolve(skill.skill_path) === installedPath(input))
          ?.linked_package_path
          ? 0
          : 1;
      return linked(left) - linked(right);
    });
    for (const input of ordered) {
      try {
        result.receipts.push(quarantineSkill(args(input)));
      } catch (cause) {
        result.failures.push({
          skill_name: input.skillName,
          skill_path: input.skillPath,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }
  return result;
}
