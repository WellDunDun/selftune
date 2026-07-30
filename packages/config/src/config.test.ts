import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigParseError, loadConfig, loadConfigSync } from "./load.js";
import { resolveSelftunePaths } from "./paths.js";
import { SelftuneFileConfig } from "./schema.js";
import { ConfigWriteError, writeConfig, writeConfigSync } from "./write.js";

const validConfig: SelftuneFileConfig = {
  agent_type: "codex",
  cli_path: "/usr/local/bin/selftune",
  llm_mode: "agent",
  agent_cli: "codex",
  hooks_installed: true,
  initialized_at: "2026-07-17T00:00:00.000Z",
};

const withTemporaryDirectory = <A, E>(
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "selftune-config-test-" });
    return yield* use(directory);
  }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer));

describe("SelftuneFileConfig", () => {
  it("decodes the full persisted contract", () => {
    const decode = Schema.decodeUnknownSync(SelftuneFileConfig);
    const config = decode({
      ...validConfig,
      analytics_disabled: true,
      alpha: {
        enrolled: true,
        cloud_user_id: "user_123",
        cloud_org_id: "org_123",
        cloud_api_url: "https://api.selftune.dev",
        email: "developer@example.com",
        display_name: "SelfTune Developer",
        user_id: "local_123",
        consent_timestamp: "2026-07-17T00:00:00.000Z",
        credential: { provider: "file", account: "alpha:user_123" },
        api_key: "secret",
      },
      preferences: {
        import_sources: {
          claude_code: true,
          cline: false,
          codex: true,
          opencode: true,
          openclaw: true,
          pi: true,
        },
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      },
    });

    expect(config.agent_type).toBe("codex");
    expect(config.alpha?.cloud_org_id).toBe("org_123");
    expect(config.alpha?.credential?.account).toBe("alpha:user_123");
    expect(config.preferences?.import_sources.codex).toBe(true);
  });

  it("keeps preferences optional for existing config files", () => {
    const decode = Schema.decodeUnknownSync(SelftuneFileConfig);
    expect(decode(validConfig).preferences).toBeUndefined();
  });

  it("rejects unsupported agents and missing required fields", () => {
    const decode = Schema.decodeUnknownSync(SelftuneFileConfig);
    expect(() => decode({ ...validConfig, agent_type: "cursor" })).toThrow();
    expect(() => decode({ agent_type: "codex" })).toThrow();
  });

  it("preserves the mutable legacy config contract", () => {
    const decode = Schema.decodeUnknownSync(SelftuneFileConfig);
    const config = decode(validConfig);
    config.hooks_installed = false;
    config.alpha = {
      enrolled: false,
      user_id: "local_123",
      consent_timestamp: "2026-07-17T00:00:00.000Z",
    };
    config.alpha.api_key = "secret";

    expect(config.hooks_installed).toBe(false);
    expect(config.alpha.api_key).toBe("secret");
  });
});

describe("resolveSelftunePaths", () => {
  it("prefers SELFTUNE_CONFIG_DIR over every other source", () => {
    expect(
      resolveSelftunePaths({
        environment: {
          SELFTUNE_CONFIG_DIR: "/override/config",
          SELFTUNE_HOME: "/override/home",
        },
        homeDirectory: "/users/default",
      }),
    ).toEqual({
      configDir: "/override/config",
      configPath: "/override/config/config.json",
      localDatabasePath: "/override/config/selftune.db",
      localAnalyticsPath: "/override/config/observability.duckdb",
    });
  });

  it("uses SELFTUNE_HOME before the operating-system home", () => {
    expect(
      resolveSelftunePaths({
        environment: { SELFTUNE_HOME: "/isolated/home" },
        homeDirectory: "/users/default",
      }),
    ).toEqual({
      configDir: "/isolated/home/.selftune",
      configPath: "/isolated/home/.selftune/config.json",
      localDatabasePath: "/isolated/home/.selftune/selftune.db",
      localAnalyticsPath: "/isolated/home/.selftune/observability.duckdb",
    });
  });

  it("falls back to the operating-system home and ignores empty overrides", () => {
    expect(
      resolveSelftunePaths({
        environment: { SELFTUNE_CONFIG_DIR: "", SELFTUNE_HOME: "" },
        homeDirectory: "/users/default",
      }),
    ).toEqual({
      configDir: "/users/default/.selftune",
      configPath: "/users/default/.selftune/config.json",
      localDatabasePath: "/users/default/.selftune/selftune.db",
      localAnalyticsPath: "/users/default/.selftune/observability.duckdb",
    });
  });
});

describe("loadConfig", () => {
  it.effect("returns null when the config does not exist", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        expect(yield* loadConfig(join(directory, "config.json"))).toBeNull();
      }),
    ),
  );

  it.effect("loads and validates a config", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(directory, "config.json");
        yield* fs.writeFileString(path, JSON.stringify(validConfig));

        expect(yield* loadConfig(path)).toEqual(validConfig);
      }),
    ),
  );

  it.effect("maps malformed JSON and invalid schema to ConfigParseError", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const malformedPath = join(directory, "malformed.json");
        const invalidPath = join(directory, "invalid.json");
        yield* fs.writeFileString(malformedPath, "{not-json}");
        yield* fs.writeFileString(invalidPath, JSON.stringify({ agent_type: "cursor" }));

        const malformed = yield* Effect.flip(loadConfig(malformedPath));
        const invalid = yield* Effect.flip(loadConfig(invalidPath));
        expect(malformed).toBeInstanceOf(ConfigParseError);
        expect(invalid).toBeInstanceOf(ConfigParseError);
        if (malformed instanceof ConfigParseError) expect(malformed.path).toBe(malformedPath);
        if (invalid instanceof ConfigParseError) expect(invalid.path).toBe(invalidPath);
      }),
    ),
  );
});

describe("writeConfig", () => {
  it.effect("atomically writes newline-terminated config with private modes", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDirectory = join(directory, "nested", ".selftune");
        const path = join(configDirectory, "config.json");

        yield* writeConfig(path, validConfig);

        expect(yield* fs.readFileString(path)).toBe(`${JSON.stringify(validConfig, null, 2)}\n`);
        expect((yield* fs.stat(configDirectory)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
        expect(yield* fs.readDirectory(configDirectory)).toEqual(["config.json"]);
      }),
    ),
  );

  it.effect("tightens an existing config directory to a private mode", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDirectory = join(directory, ".selftune");
        const path = join(configDirectory, "config.json");
        yield* fs.makeDirectory(configDirectory);
        yield* fs.chmod(configDirectory, 0o755);

        yield* writeConfig(path, validConfig);

        expect((yield* fs.stat(configDirectory)).mode & 0o777).toBe(0o700);
      }),
    ),
  );

  it.effect("replaces an existing config without leaving temporary files", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(directory, "config.json");
        yield* fs.writeFileString(path, "old contents");

        const updated: SelftuneFileConfig = {
          ...validConfig,
          agent_type: "claude_code",
          agent_cli: "claude",
        };
        yield* writeConfig(path, updated);

        expect(yield* loadConfig(path)).toEqual(updated);
        expect(yield* fs.readDirectory(directory)).toEqual(["config.json"]);
      }),
    ),
  );

  it.effect("removes the temporary file when atomic replacement fails", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const destinationDirectory = join(directory, "config.json");
        yield* fs.makeDirectory(destinationDirectory);

        const failure = yield* Effect.flip(writeConfig(destinationDirectory, validConfig));
        expect(failure).toBeInstanceOf(ConfigWriteError);
        expect(yield* fs.readDirectory(directory)).toEqual(["config.json"]);
        expect(yield* fs.readDirectory(destinationDirectory)).toEqual([]);
      }),
    ),
  );
});

describe("synchronous config compatibility", () => {
  it("uses the same validated atomic private writer", () => {
    const directory = mkdtempSync(join(tmpdir(), "selftune-config-sync-"));
    const path = join(directory, "nested", "config.json");
    try {
      writeConfigSync(path, validConfig);
      expect(loadConfigSync(path)).toEqual(validConfig);
      expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(validConfig, null, 2)}\n`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(directory, "nested"))).toEqual(["config.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
