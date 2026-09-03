import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import { collectCatalogObservations, listSkillSets } from "@selftune/library";
import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import {
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
  computeSkillVersionHash,
} from "../utils/skill-discovery.js";
import { inferSkillHarness } from "../utils/skill-harness.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { CLIError } from "../utils/cli-error.js";
import { BM25Index } from "./bm25.js";

export interface SkillSearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly searchDirs?: readonly string[];
  readonly configRoot?: string;
}

export interface SkillSearchHit {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly revision: string;
  readonly skill_path: string;
  readonly package_path: string;
  readonly collections: { set_id: string; name: string }[];
}

export function searchLocalSkills(options: SkillSearchOptions) {
  const limit = options.limit ?? 5;
  if (!options.query.trim() || options.query.length > 2000) {
    throw new CLIError(
      "Search query must contain 1–2000 characters.",
      "INVALID_ARGUMENT",
      "selftune skills search --help",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new CLIError(
      "--limit must be an integer from 1 to 20.",
      "INVALID_ARGUMENT",
      "selftune skills search --help",
    );
  }
  const { documents, warnings } = loadLocalSkillCatalog(options);
  const index = new BM25Index([...documents.values()]);
  const results = index.search(options.query, limit).flatMap(({ id, score }) => {
    const document = documents.get(id);
    if (!document) return [];
    const { text: _text, ...hit } = document;
    return [{ ...hit, score }];
  });
  return { query: options.query, indexed: documents.size, results, warnings };
}

export function loadLocalSkillCatalog(
  options: Pick<SkillSearchOptions, "configRoot" | "searchDirs"> = {},
) {
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const sets = listSkillSets({ configRoot });
  const observations = collectCatalogObservations({
    configRoot,
    installedPackages: findInstalledSkillPackages(
      options.searchDirs ? [...options.searchDirs] : getDefaultSkillSearchDirs(),
    ),
    installedMetadata: new Map(),
    usageRows: [],
    quarantinedSkills: [],
    findPackages: (dirs) => findInstalledSkillPackages(dirs),
    inferHarness: inferSkillHarness,
    versionHashLoader: computeSkillVersionHash,
  });
  const documents = new Map<string, SkillSearchHit & { text: string }>();
  const warnings: { path: string; message: string }[] = [];
  for (const observation of observations) {
    try {
      const stats = statSync(observation.skillPath);
      if (!stats.isFile() || stats.size > 256 * 1024) {
        warnings.push({
          path: observation.skillPath,
          message: "Skipped non-file or SKILL.md larger than 256 KiB.",
        });
        continue;
      }
      const text = readFileSync(observation.skillPath, "utf8");
      const parsed = parseFrontmatter(text);
      const name = parsed.name || observation.skillName;
      const revision = observation.contentHash;
      if (!revision) {
        warnings.push({
          path: observation.skillPath,
          message: "Skipped package without a readable revision.",
        });
        continue;
      }
      if (computeSkillVersionHash(observation.skillPath) !== revision) {
        warnings.push({
          path: observation.skillPath,
          message: "Skipped package whose bytes no longer match its catalog revision.",
        });
        continue;
      }
      const id = `${encodeURIComponent(name)}@${revision}`;
      const collections = sets
        .filter((set) =>
          set.skills.some(
            (skill) =>
              resolve(skill.library_package_path) === resolve(observation.packagePath) ||
              (skill.name === observation.skillName && skill.content_hash === revision),
          ),
        )
        .map((set) => ({ set_id: set.set_id, name: set.name }));
      const previous = documents.get(id);
      const merged = [
        ...new Map(
          [...(previous?.collections ?? []), ...collections].map((set) => [set.set_id, set]),
        ).values(),
      ];
      documents.set(id, {
        id,
        name,
        revision,
        description: parsed.description.replace(/\s+/g, " ").slice(0, 400),
        skill_path: observation.skillPath,
        package_path: observation.packagePath,
        collections: merged,
        text: `${name}\n${merged.map((set) => set.name).join("\n")}\n${text}`,
      });
    } catch (cause) {
      warnings.push({
        path: observation.skillPath,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { documents, warnings };
}

export const searchLocalSkillsEffect = Effect.fn("selftune.skills.search")(
  (options: SkillSearchOptions) =>
    Effect.try({
      try: () => searchLocalSkills(options),
      catch: (cause) =>
        cause instanceof CLIError
          ? cause
          : new CLIError(
              `Skill search failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              "OPERATION_FAILED",
              "selftune skills search --help",
            ),
    }),
);
