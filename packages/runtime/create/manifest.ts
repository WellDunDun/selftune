import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";

import { optionalEvidence } from "../utils/transcript-contract.js";
import { buildCreateSkillManifest, type CreateSkillManifest } from "./templates.js";

export interface LoadedCreateManifest {
  manifest: CreateSkillManifest;
  present: boolean;
}

const SavedManifest = Schema.Struct({
  entry_workflow: optionalEvidence(Schema.String),
  supports_package_replay: optionalEvidence(Schema.Boolean),
  expected_resources: optionalEvidence(
    Schema.Struct({
      workflows: optionalEvidence(Schema.Boolean),
      references: optionalEvidence(Schema.Boolean),
      scripts: optionalEvidence(Schema.Boolean),
      assets: optionalEvidence(Schema.Boolean),
    }),
  ),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(SavedManifest));

export function loadCreateManifest(skillDir: string): LoadedCreateManifest {
  const fallback = buildCreateSkillManifest();
  try {
    const parsed = decodeManifest(readFileSync(join(skillDir, "selftune.create.json"), "utf-8"));
    return {
      manifest: {
        version: 1,
        entry_workflow: parsed.entry_workflow?.trim()
          ? parsed.entry_workflow
          : fallback.entry_workflow,
        supports_package_replay: parsed.supports_package_replay ?? fallback.supports_package_replay,
        expected_resources: {
          workflows: parsed.expected_resources?.workflows ?? fallback.expected_resources.workflows,
          references:
            parsed.expected_resources?.references ?? fallback.expected_resources.references,
          scripts: parsed.expected_resources?.scripts ?? fallback.expected_resources.scripts,
          assets: parsed.expected_resources?.assets ?? fallback.expected_resources.assets,
        },
      },
      present: true,
    };
  } catch {
    return { manifest: fallback, present: false };
  }
}
