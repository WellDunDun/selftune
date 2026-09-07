import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessId, type SelftunePreferences } from "@selftune/config";
import { flow, Option, Schema } from "effect";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type { OnboardingFeatureId, OnboardingPreferences } from "./dashboard-contract.js";
import { optionalEvidence } from "./utils/transcript-contract.js";

const ONBOARDING_FILENAME = "onboarding.json";
const HARNESS_IDS: HarnessId[] = ["claude_code", "cline", "codex", "opencode", "openclaw", "pi"];
const HOOK_HARNESS_IDS: Array<Exclude<HarnessId, "openclaw">> = [
  "claude_code",
  "cline",
  "codex",
  "opencode",
  "pi",
];
const FEATURE_IDS: OnboardingFeatureId[] = [
  "observability",
  "health_recommendations",
  "autonomous_improvement",
];
const SavedPreferences = Schema.Struct({
  import_sources: optionalEvidence(Schema.Record(HarnessId, optionalEvidence(Schema.Boolean))),
  features: optionalEvidence(
    Schema.Struct({
      observability: optionalEvidence(Schema.Boolean),
      health_recommendations: optionalEvidence(Schema.Boolean),
      autonomous_improvement: optionalEvidence(Schema.Boolean),
    }),
  ),
});
const SavedConfig = Schema.Struct({ preferences: SavedPreferences });
const LegacyPreferences = Schema.Struct({ version: Schema.Literal(1), ...SavedPreferences.fields });
const OnboardingRequest = Schema.Struct({
  import_sources: Schema.Array(
    HarnessId.annotate({
      message: "Onboarding includes an unknown import source.",
    }),
  ),
  hook_harnesses: Schema.Array(
    Schema.Literals(["claude_code", "cline", "codex", "opencode", "pi"]).annotate({
      message: "Onboarding includes a harness that does not support hooks.",
    }),
  ),
  features: Schema.Struct({
    observability: Schema.Boolean.annotate({
      message: "Onboarding feature observability must be true or false.",
    }),
    health_recommendations: Schema.Boolean.annotate({
      message: "Onboarding feature health_recommendations must be true or false.",
    }),
    autonomous_improvement: Schema.Boolean.annotate({
      message: "Onboarding feature autonomous_improvement must be true or false.",
    }),
  }),
});

function resolvedConfigDir(configDir?: string): string {
  return configDir ?? process.env.SELFTUNE_CONFIG_DIR ?? SELFTUNE_CONFIG_DIR;
}

export function onboardingPreferencesPath(configDir?: string): string {
  return join(resolvedConfigDir(configDir), ONBOARDING_FILENAME);
}

export function defaultOnboardingPreferences(): OnboardingPreferences {
  return {
    version: 1,
    completed: false,
    import_sources: {
      claude_code: true,
      cline: false,
      codex: true,
      opencode: true,
      openclaw: true,
      pi: true,
    },
    hook_harnesses: {
      claude_code: false,
      cline: false,
      codex: false,
      opencode: false,
      pi: false,
    },
    features: {
      observability: true,
      health_recommendations: true,
      autonomous_improvement: false,
    },
  };
}

export function loadOnboardingPreferences(configDir?: string): OnboardingPreferences {
  const fallback = defaultOnboardingPreferences();
  const path = join(resolvedConfigDir(configDir), "config.json");
  if (!existsSync(path)) return fallback;

  try {
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(SavedConfig))(
      readFileSync(path, "utf8"),
    );
    return resolveSavedPreferences(parsed.preferences);
  } catch {
    return fallback;
  }
}

function normalizeRequest(input: typeof OnboardingRequest.Type): OnboardingPreferences {
  const importSources = new Set(input.import_sources);
  const hookHarnesses = new Set(input.hook_harnesses);
  const normalized = defaultOnboardingPreferences();
  normalized.completed = true;
  for (const id of HARNESS_IDS) normalized.import_sources[id] = importSources.has(id);
  for (const id of HOOK_HARNESS_IDS) normalized.hook_harnesses[id] = hookHarnesses.has(id);
  for (const id of FEATURE_IDS) normalized.features[id] = input.features[id] === true;
  return normalized;
}

export const normalizeOnboardingRequest = flow(
  Schema.decodeUnknownSync(OnboardingRequest),
  normalizeRequest,
);

export function persistedPreferences(
  preferences: Pick<OnboardingPreferences, "import_sources" | "features">,
): SelftunePreferences {
  return {
    import_sources: {
      claude_code: preferences.import_sources.claude_code,
      cline: preferences.import_sources.cline,
      codex: preferences.import_sources.codex,
      opencode: preferences.import_sources.opencode,
      openclaw: preferences.import_sources.openclaw,
      pi: preferences.import_sources.pi,
    },
    features: {
      observability: preferences.features.observability,
      health_recommendations: preferences.features.health_recommendations,
      autonomous_improvement: preferences.features.autonomous_improvement,
    },
  };
}

function resolveSavedPreferences(input: typeof SavedPreferences.Type): OnboardingPreferences {
  const normalized = defaultOnboardingPreferences();
  normalized.completed = true;
  for (const id of HARNESS_IDS) {
    const enabled = input.import_sources?.[id];
    if (enabled !== undefined) normalized.import_sources[id] = enabled;
  }
  for (const id of FEATURE_IDS) {
    const enabled = input.features?.[id];
    if (enabled !== undefined) normalized.features[id] = enabled;
  }
  return normalized;
}

export const decodeLegacyOnboardingPreferences = flow(
  Schema.decodeUnknownOption(LegacyPreferences),
  Option.map((input) => persistedPreferences(resolveSavedPreferences(input))),
  Option.getOrNull,
);
