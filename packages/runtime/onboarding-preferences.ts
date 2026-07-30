import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SelftunePreferences } from "@selftune/config";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  HarnessId,
  OnboardingFeatureId,
  OnboardingPreferences,
} from "./dashboard-contract.js";

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
const HARNESS_ID_SET = new Set<string>(HARNESS_IDS);
const HOOK_HARNESS_ID_SET = new Set<string>(HOOK_HARNESS_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && HARNESS_ID_SET.has(value);
}

function isHookHarnessId(value: unknown): value is Exclude<HarnessId, "openclaw"> {
  return typeof value === "string" && HOOK_HARNESS_ID_SET.has(value);
}

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
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.preferences)) return fallback;
    const preferences = parsed.preferences;
    if (isRecord(preferences.import_sources)) {
      for (const id of HARNESS_IDS) {
        if (typeof preferences.import_sources[id] === "boolean") {
          fallback.import_sources[id] = preferences.import_sources[id];
        }
      }
    }
    if (isRecord(preferences.features)) {
      for (const id of FEATURE_IDS) {
        if (typeof preferences.features[id] === "boolean") {
          fallback.features[id] = preferences.features[id];
        }
      }
    }
    fallback.completed = true;
    return fallback;
  } catch {
    return fallback;
  }
}

export function normalizeOnboardingRequest(input: unknown): OnboardingPreferences {
  if (!isRecord(input) || !Array.isArray(input.import_sources)) {
    throw new Error("Onboarding must include import_sources.");
  }
  if (!Array.isArray(input.hook_harnesses) || !isRecord(input.features)) {
    throw new Error("Onboarding must include hook_harnesses and features.");
  }

  const importSources = new Set<HarnessId>();
  for (const value of input.import_sources) {
    if (!isHarnessId(value)) {
      throw new Error("Onboarding includes an unknown import source.");
    }
    importSources.add(value);
  }

  const hookHarnesses = new Set<Exclude<HarnessId, "openclaw">>();
  for (const value of input.hook_harnesses) {
    if (!isHookHarnessId(value)) {
      throw new Error("Onboarding includes a harness that does not support hooks.");
    }
    hookHarnesses.add(value);
  }

  for (const id of FEATURE_IDS) {
    if (typeof input.features[id] !== "boolean") {
      throw new Error(`Onboarding feature ${id} must be true or false.`);
    }
  }

  const normalized = defaultOnboardingPreferences();
  normalized.completed = true;
  for (const id of HARNESS_IDS) normalized.import_sources[id] = importSources.has(id);
  for (const id of HOOK_HARNESS_IDS) normalized.hook_harnesses[id] = hookHarnesses.has(id);
  for (const id of FEATURE_IDS) normalized.features[id] = input.features[id] === true;
  return normalized;
}

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

export function decodeLegacyOnboardingPreferences(input: unknown): SelftunePreferences | null {
  if (!isRecord(input) || input.version !== 1) return null;
  const normalized = defaultOnboardingPreferences();
  if (isRecord(input.import_sources)) {
    for (const id of HARNESS_IDS) {
      if (typeof input.import_sources[id] === "boolean") {
        normalized.import_sources[id] = input.import_sources[id];
      }
    }
  }
  if (isRecord(input.features)) {
    for (const id of FEATURE_IDS) {
      if (typeof input.features[id] === "boolean") normalized.features[id] = input.features[id];
    }
  }
  return persistedPreferences(normalized);
}
