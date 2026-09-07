import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";

const PreferencesMarker = Schema.Struct({ preferences: Schema.Record(Schema.String, Schema.Json) });
const LegacyOnboarding = Schema.Struct({ completed: Schema.Boolean });

export function resolveInitialDashboardPath(options: {
  configDir?: string;
  homeDir?: string;
  testPath?: string;
}): string {
  if (options.testPath) return options.testPath;
  const configDir = options.configDir ?? join(options.homeDir ?? homedir(), ".selftune");
  try {
    Schema.decodeUnknownSync(Schema.fromJsonString(PreferencesMarker))(
      readFileSync(join(configDir, "config.json"), "utf8"),
    );
    return "/";
  } catch {
    // No config yet; check the legacy marker below.
  }
  try {
    // Legacy installs recorded completion in onboarding.json; the daemon
    // migrates it into config.json.preferences on first settings load.
    const legacy = Schema.decodeUnknownSync(Schema.fromJsonString(LegacyOnboarding))(
      readFileSync(join(configDir, "onboarding.json"), "utf8"),
    );
    return legacy.completed ? "/" : "/settings";
  } catch {
    // No legacy marker either.
  }
  return "/settings";
}
