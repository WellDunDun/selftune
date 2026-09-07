import { readFileSync, statSync } from "node:fs";
import type { LibraryObservation, SkillDiscoveryMetadata } from "@selftune/control-plane";
import type { QuarantineRecord } from "../dashboard-contract.js";
import { Effect, Option, Schema } from "effect";

const DiscoveryFrontmatter = Schema.Struct({
  description: Schema.String,
  when_to_use: Schema.optionalKey(
    Schema.String.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some("")))),
  ),
  "disable-model-invocation": Schema.optionalKey(
    Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(false)))),
  ),
});

function metadata(
  path: string,
  name: string,
  originalSkillPath: string,
): SkillDiscoveryMetadata | undefined {
  try {
    if (statSync(path).size > 256 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return undefined;
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) return undefined;
    const data = Schema.decodeUnknownSync(DiscoveryFrontmatter)(
      Bun.YAML.parse(lines.slice(1, end).join("\n")),
    );
    return {
      name,
      description: data.description,
      whenToUse: data.when_to_use ?? "",
      disableModelInvocation: data["disable-model-invocation"] ?? false,
      originalSkillPath,
    };
  } catch {
    return undefined;
  }
}

export function addDiscoveryMetadata(
  observations: LibraryObservation[],
  archives: readonly QuarantineRecord[],
): LibraryObservation[] {
  return observations.map((observation) => {
    if (observation.sourceKind !== "installed" && observation.sourceKind !== "archived")
      return observation;
    const archived = archives.find(
      (item) => item.quarantined_package_path === observation.packagePath,
    );
    const path =
      observation.sourceKind === "archived" ? archived?.original_skill_path : observation.skillPath;
    if (!path) return observation;
    const cached = observations.find(
      (item) => item.sourceKind === "cached" && item.contentHash === observation.contentHash,
    );
    const discovery =
      metadata(observation.skillPath, observation.skillName, path) ??
      (cached ? metadata(cached.skillPath, observation.skillName, path) : undefined);
    return discovery ? { ...observation, discovery } : observation;
  });
}
