import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import {
  runAlphaRelinkActionWithDependencies,
  type AlphaActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/alpha.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";
import {
  getLegacyCommandGroup,
  LEGACY_COMMAND_GROUPS,
} from "../../apps/cli/src/commands/router.js";
import {
  runAlphaRelinkProgram,
  type AlphaRelinkDependencies,
} from "../../packages/runtime/alpha-program.js";
import type { AlphaIdentity } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const OPERATIONS_SOURCE = fileURLToPath(
  new URL("../../apps/cli/src/commands/operations.ts", import.meta.url),
);
const temporaryHomes: string[] = [];

function makeIdentity(overrides: Partial<AlphaIdentity> = {}): AlphaIdentity {
  return {
    enrolled: true,
    user_id: "local-user",
    cloud_user_id: "cloud-user-old",
    cloud_org_id: "org-old",
    email: "user@example.com",
    display_name: "User",
    consent_timestamp: "2026-01-01T00:00:00.000Z",
    api_key: "st_test_old",
    ...overrides,
  };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-alpha-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runAlphaCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "alpha", ...args], {
    env: {
      ...process.env,
      HOME: home,
      SELFTUNE_HOME: home,
      SELFTUNE_CLAUDE_DIR: join(home, ".claude"),
      SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function expectCliError(
  result: ReturnType<typeof runAlphaCli>,
  expected: { message: string; suggestion: string },
): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`[ERROR] ${expected.message}\n  \u2192 ${expected.suggestion}\n`);
}

function makeRelinkDependencies(
  overrides: Partial<AlphaRelinkDependencies> = {},
): AlphaRelinkDependencies {
  return {
    readIdentity: () => makeIdentity(),
    requestDeviceCode: async () => ({
      device_code: "device-code",
      user_code: "ABCD-1234",
      verification_url: "https://app.selftune.dev/auth/device",
      expires_in: 900,
      interval: 5,
    }),
    buildVerificationUrl: (_url, code) => `https://app.selftune.dev/auth/device?code=${code}`,
    openVerificationUrl: () => true,
    pollDeviceCode: async () => ({
      api_key: "st_test_new",
      cloud_user_id: "cloud-user-new",
      org_id: "org-new",
    }),
    generateUserId: () => "generated-user",
    now: () => "2026-07-17T00:00:00.000Z",
    persistIdentity: (identity) => identity,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    ...overrides,
  };
}

async function expectTypedFailure(
  effect: Effect.Effect<unknown, CLIError>,
  message: string,
): Promise<void> {
  const error = await Effect.runPromise(effect).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(CLIError);
  expect(error).toMatchObject({ code: "OPERATION_FAILED", message });
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("alpha relink core program", () => {
  test("runs device approval and atomically replaces cloud credentials", async () => {
    const persisted: AlphaIdentity[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const polls: unknown[] = [];
    const persistedKeys: string[] = [];
    const result = await Effect.runPromise(
      runAlphaRelinkProgram(
        makeRelinkDependencies({
          pollDeviceCode: async (...args) => {
            polls.push(args);
            return {
              api_key: "st_test_new",
              cloud_user_id: "cloud-user-new",
              org_id: "org-new",
            };
          },
          persistIdentity: (identity, apiKey) => {
            persisted.push(identity);
            persistedKeys.push(apiKey);
            return identity;
          },
          writeStdout: (value) => stdout.push(value),
          writeStderr: (value) => stderr.push(value),
        }),
      ),
    );

    expect(polls).toEqual([["device-code", 5, 900]]);
    expect(persisted).toEqual([
      {
        enrolled: true,
        user_id: "local-user",
        cloud_user_id: "cloud-user-new",
        cloud_org_id: "org-new",
        email: "user@example.com",
        display_name: "User",
        consent_timestamp: "2026-07-17T00:00:00.000Z",
      },
    ]);
    expect(persistedKeys).toEqual(["st_test_new"]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      code: "device_code_issued",
      user_code: "ABCD-1234",
      verification_url_with_code: "https://app.selftune.dev/auth/device?code=ABCD-1234",
    });
    expect(JSON.parse(stdout[1]!)).toEqual(result);
    expect(result).toMatchObject({
      code: "alpha_relinked",
      replaced_existing_key: true,
      cloud_user_id: "cloud-user-new",
    });
    expect(stderr.join("")).toContain("Browser opened. Waiting for approval");
    expect(stderr.join("")).toContain("Polling");
    expect(stderr.join("")).toContain("Approved!");
  });

  test("generates a local identity and prints manual approval guidance when needed", async () => {
    const persisted: AlphaIdentity[] = [];
    const stderr: string[] = [];
    const result = await Effect.runPromise(
      runAlphaRelinkProgram(
        makeRelinkDependencies({
          readIdentity: () => null,
          openVerificationUrl: () => false,
          persistIdentity: (identity) => {
            persisted.push(identity);
            return identity;
          },
          writeStderr: (value) => stderr.push(value),
        }),
      ),
    );

    expect(persisted[0]?.user_id).toBe("generated-user");
    expect(result.replaced_existing_key).toBe(false);
    expect(stderr.join("")).toContain("Could not open browser");
    expect(stderr.join("")).toContain("ABCD-1234");
  });

  test("does not persist or report success when device polling fails", async () => {
    let persisted = false;
    const stdout: string[] = [];
    await expect(
      Effect.runPromise(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            pollDeviceCode: async () => {
              throw new Error("Device code denied by user.");
            },
            persistIdentity: (identity) => {
              persisted = true;
              return identity;
            },
            writeStdout: (value) => stdout.push(value),
          }),
        ),
      ),
    ).rejects.toThrow("Device code denied by user");
    expect(persisted).toBe(false);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ code: "device_code_issued" });
  });

  test("keeps synchronous URL, browser, persistence, and output failures typed", async () => {
    await Promise.all([
      expectTypedFailure(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            buildVerificationUrl: () => {
              throw new Error("verification URL failed");
            },
          }),
        ),
        "verification URL failed",
      ),
      expectTypedFailure(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            openVerificationUrl: () => {
              throw new Error("browser launch failed");
            },
          }),
        ),
        "browser launch failed",
      ),
      expectTypedFailure(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            persistIdentity: () => {
              throw new Error("identity persistence failed");
            },
          }),
        ),
        "identity persistence failed",
      ),
      expectTypedFailure(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            writeStdout: () => {
              throw new Error("stdout failed");
            },
          }),
        ),
        "stdout failed",
      ),
      expectTypedFailure(
        runAlphaRelinkProgram(
          makeRelinkDependencies({
            writeStderr: () => {
              throw new Error("stderr failed");
            },
          }),
        ),
        "stderr failed",
      ),
    ]);
  });
});

describe("alpha Effect CLI ownership", () => {
  test("dispatches relink through the command-owned action", async () => {
    let relinks = 0;
    await Effect.runPromise(
      makeEffectCliTestProgram(["alpha", "relink"], {
        alphaActions: {
          relink: () =>
            Effect.sync(() => {
              relinks += 1;
            }),
        },
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(relinks).toBe(1);
  });

  test("the shared test root fails closed for live authentication", async () => {
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["alpha", "relink"]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live alpha relink is disabled in the Effect CLI test program.",
    });
  });

  test("loads authentication support only when the action executes", async () => {
    let loads = 0;
    let relinks = 0;
    const dependencies: AlphaActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runAlphaRelinkProgram: () =>
            Effect.sync(() => {
              relinks += 1;
            }),
        };
      },
    };
    const action = runAlphaRelinkActionWithDependencies(dependencies);
    expect(loads).toBe(0);
    await Effect.runPromise(action);
    expect(loads).toBe(1);
    expect(relinks).toBe(1);
  });

  test("maps import failures to actionable internal errors", async () => {
    const error = await Effect.runPromise(
      runAlphaRelinkActionWithDependencies({
        loadModule: async () => {
          throw new Error("module missing");
        },
      }).pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load alpha relink support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
  });

  test("preserves typed authentication failures", async () => {
    const failure = new CLIError(
      "Device approval expired.",
      "OPERATION_FAILED",
      "selftune alpha relink",
      7,
      true,
    );
    const error = await Effect.runPromise(
      runAlphaRelinkActionWithDependencies({
        loadModule: async () => ({ runAlphaRelinkProgram: () => Effect.fail(failure) }),
      }).pipe(Effect.flip),
    );
    expect(error).toBe(failure);
    expect(error).toMatchObject({ exitCode: 7, retryable: true });
  });
});

describe("alpha Effect CLI compatibility", () => {
  test("owns the complete alpha command family", () => {
    expect(isEffectCliInvocation("alpha", [])).toBe(true);
    expect(isEffectCliInvocation("alpha", ["--help"])).toBe(true);
    expect(isEffectCliInvocation("alpha", ["upload"])).toBe(true);
    expect(isEffectCliInvocation("alpha", ["relink"])).toBe(true);
    expect(getLegacyCommandGroup("alpha")).toBeUndefined();
    expect(LEGACY_COMMAND_GROUPS.operations).not.toContain("alpha");
    expect(isEffectCliInvocation("registry", [])).toBe(true);
  });

  test("documents cloud authentication without a telemetry upload command", () => {
    const home = makeHome();
    const rootHelp = runAlphaCli(home, "--help");
    expect(rootHelp.exitCode, rootHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toContain("SUBCOMMANDS");
    expect(rootHelp.stdout).not.toContain("upload");
    expect(rootHelp.stdout).toContain("relink");

    const relinkHelp = runAlphaCli(home, "relink", "--help");
    expect(relinkHelp.exitCode, relinkHelp.stderr).toBe(0);
    expect(relinkHelp.stdout).toContain("device-code approval");
    expect(relinkHelp.stdout).not.toContain("ARGUMENTS");
    expect(relinkHelp.stdout).not.toContain("__none__");
    expect(relinkHelp.stdout).not.toContain("[<");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("rejects the retired upload command before opening local state", () => {
    const home = makeHome();
    for (const args of [["upload"], ["upload", "--dry-run"], ["upload", "--help"]]) {
      expectCliError(runAlphaCli(home, ...args), {
        message: "Unknown alpha subcommand: upload",
        suggestion: "selftune alpha --help",
      });
    }
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("returns typed guidance for invalid relink arguments and unknown subcommands", () => {
    const home = makeHome();
    expectCliError(runAlphaCli(home, "relink", "--unknown"), {
      message: "Invalid arguments: Unknown option '--unknown'",
      suggestion: "selftune alpha relink --help",
    });
    expectCliError(runAlphaCli(home, "relink", "extra"), {
      message:
        "Invalid arguments: Unexpected argument 'extra'. This command does not take positional arguments",
      suggestion: "selftune alpha relink --help",
    });
    expectCliError(runAlphaCli(home, "relink", "--help", "extra"), {
      message:
        "Invalid arguments: Unexpected argument 'extra'. This command does not take positional arguments",
      suggestion: "selftune alpha relink --help",
    });
    expectCliError(runAlphaCli(home, "missing"), {
      message: "Unknown alpha subcommand: missing",
      suggestion: "selftune alpha --help",
    });
  });

  test("removes alpha product behavior from the legacy operations router", () => {
    const source = readFileSync(OPERATIONS_SOURCE, "utf8");
    expect(source).not.toContain('case "alpha"');
    expect(source).not.toContain('case "registry"');
    expect(source).toContain('case "cron"');
  });
});
