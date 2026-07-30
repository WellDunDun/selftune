import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { loadConfig, writeConfig, type SelftunePreferences } from "@selftune/config";
import {
  decodeLegacyOnboardingPreferences,
  onboardingPreferencesPath,
} from "@selftune/runtime/onboarding-preferences";
import { Effect, FileSystem } from "effect";
import { dirname } from "node:path";

import { resolveSetupConfigPath, type SetupEnvironment } from "./inspect.js";

export interface OnboardingMigrationResult {
  readonly legacyFound: boolean;
  readonly migrated: boolean;
  readonly preferences?: SelftunePreferences;
}

function parseJson(source: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed;
  } catch {
    return null;
  }
}

const migrateLegacyPreferences = Effect.fn("Setup.migrateLegacyOnboardingPreferences")(function* (
  configPath: string,
  legacyPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(legacyPath))) {
    return { legacyFound: false, migrated: false } satisfies OnboardingMigrationResult;
  }

  const source = yield* fs.readFileString(legacyPath);
  const legacy = parseJson(source);
  const preferences = decodeLegacyOnboardingPreferences(legacy);
  if (!preferences) {
    return { legacyFound: true, migrated: false } satisfies OnboardingMigrationResult;
  }

  const config = yield* loadConfig(configPath);
  if (!config) {
    return {
      legacyFound: true,
      migrated: false,
      preferences,
    } satisfies OnboardingMigrationResult;
  }

  const desiredPreferences = config.preferences ?? preferences;
  if (!config.preferences) {
    yield* writeConfig(configPath, { ...config, preferences: desiredPreferences });
  }
  yield* fs.remove(legacyPath, { force: true });
  return {
    legacyFound: true,
    migrated: true,
    preferences: desiredPreferences,
  } satisfies OnboardingMigrationResult;
});

export async function migrateLegacyOnboardingPreferences(
  env: SetupEnvironment = {},
): Promise<OnboardingMigrationResult> {
  const configPath = resolveSetupConfigPath(env);
  const legacyPath = onboardingPreferencesPath(env.configDir ?? dirname(configPath));
  return Effect.runPromise(
    migrateLegacyPreferences(configPath, legacyPath).pipe(Effect.provide(BunFileSystem.layer)),
  );
}
