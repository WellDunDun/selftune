import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import type {
  ApplyOnboardingRequest,
  HarnessId,
  OnboardingFeatureId,
  OnboardingPreferences,
} from "./dashboard-contract.js";

const ONBOARDING_FILENAME = "onboarding.json";
const HARNESS_IDS: HarnessId[] = ["claude_code", "codex", "opencode", "openclaw", "pi"];
const HOOK_HARNESS_IDS: Array<Exclude<HarnessId, "openclaw">> = [
  "claude_code",
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
      codex: true,
      opencode: true,
      openclaw: true,
      pi: true,
    },
    hook_harnesses: {
      claude_code: false,
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
  const path = onboardingPreferencesPath(configDir);
  if (!existsSync(path)) return fallback;

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) return fallback;
    if (typeof parsed.completed === "boolean") fallback.completed = parsed.completed;
    if (isRecord(parsed.import_sources)) {
      for (const id of HARNESS_IDS) {
        if (typeof parsed.import_sources[id] === "boolean") {
          fallback.import_sources[id] = parsed.import_sources[id];
        }
      }
    }
    if (isRecord(parsed.hook_harnesses)) {
      for (const id of HOOK_HARNESS_IDS) {
        if (typeof parsed.hook_harnesses[id] === "boolean") {
          fallback.hook_harnesses[id] = parsed.hook_harnesses[id];
        }
      }
    }
    if (isRecord(parsed.features)) {
      for (const id of FEATURE_IDS) {
        if (typeof parsed.features[id] === "boolean") fallback.features[id] = parsed.features[id];
      }
    }
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

export function saveOnboardingPreferences(
  input: ApplyOnboardingRequest | unknown,
  configDir?: string,
): OnboardingPreferences {
  const preferences = normalizeOnboardingRequest(input);
  const path = onboardingPreferencesPath(configDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return preferences;
}
