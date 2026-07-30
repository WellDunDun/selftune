import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";

import {
  runAlphaRelinkActionWithDependencies,
  runAlphaUploadActionWithDependencies,
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
  runAlphaUploadProgram,
  type AlphaRelinkDependencies,
  type AlphaUploadDependencies,
  type AlphaUploadInput,
} from "../../packages/runtime/alpha-program.js";
import type { UploadCycleSummary } from "../../packages/runtime/alpha-upload/index.js";
import type { AlphaIdentity } from "../../packages/runtime/types.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const OPERATIONS_SOURCE = fileURLToPath(
  new URL("../../apps/cli/src/commands/operations.ts", import.meta.url),
);
const temporaryHomes: string[] = [];
const SUCCESS_SUMMARY: UploadCycleSummary = {
  enrolled: true,
  prepared: 1,
  sent: 1,
  failed: 0,
  skipped: 0,
};

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

function makeUploadDependencies(
  overrides: Partial<AlphaUploadDependencies> = {},
): AlphaUploadDependencies {
  return {
    readIdentity: () => makeIdentity(),
    readAgentType: () => "codex",
    getVersion: () => "1.2.3",
    upload: async () => SUCCESS_SUMMARY,
    resolveCredential: () => "st_test_old",
    print: () => undefined,
    setExitCode: () => undefined,
    ...overrides,
  };
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

describe("alpha upload core program", () => {
  test("rejects missing enrollment and credentials before opening upload state", async () => {
    let uploads = 0;
    const dependencies = makeUploadDependencies({
      upload: async () => {
        uploads += 1;
        return SUCCESS_SUMMARY;
      },
    });

    await Promise.all(
      [null, makeIdentity({ enrolled: false }), makeIdentity({ api_key: "" })].map((identity) =>
        expect(
          Effect.runPromise(
            runAlphaUploadProgram(
              { dryRun: false },
              {
                ...dependencies,
                readIdentity: () => identity,
                resolveCredential: () => identity?.api_key?.trim() || null,
              },
            ),
          ),
        ).rejects.toThrow("[alpha upload]"),
      ),
    );
    expect(uploads).toBe(0);
  });

  test("passes identity metadata and dry-run intent to the upload cycle", async () => {
    const uploadOptions: unknown[] = [];
    const output: string[] = [];
    const exitCodes: number[] = [];
    const result = await Effect.runPromise(
      runAlphaUploadProgram(
        { dryRun: true },
        makeUploadDependencies({
          upload: async (options) => {
            uploadOptions.push(options);
            return SUCCESS_SUMMARY;
          },
          print: (value) => output.push(value),
          setExitCode: (code) => exitCodes.push(code),
        }),
      ),
    );

    expect(result).toEqual(SUCCESS_SUMMARY);
    expect(uploadOptions).toEqual([
      {
        enrolled: true,
        userId: "local-user",
        agentType: "codex",
        selftuneVersion: "1.2.3",
        dryRun: true,
        apiKey: "st_test_old",
      },
    ]);
    expect(output).toEqual([JSON.stringify(SUCCESS_SUMMARY, null, 2)]);
    expect(exitCodes).toEqual([0]);
  });

  test("returns exit code one when the upload summary contains failures", async () => {
    const exitCodes: number[] = [];
    await Effect.runPromise(
      runAlphaUploadProgram(
        { dryRun: false },
        makeUploadDependencies({
          upload: async () => ({ ...SUCCESS_SUMMARY, failed: 2 }),
          setExitCode: (code) => exitCodes.push(code),
        }),
      ),
    );
    expect(exitCodes).toEqual([1]);
  });

  test("keeps synchronous metadata and output failures in the typed error channel", async () => {
    await Promise.all([
      expectTypedFailure(
        runAlphaUploadProgram(
          { dryRun: false },
          makeUploadDependencies({
            readAgentType: () => {
              throw new Error("agent metadata failed");
            },
          }),
        ),
        "agent metadata failed",
      ),
      expectTypedFailure(
        runAlphaUploadProgram(
          { dryRun: false },
          makeUploadDependencies({
            getVersion: () => {
              throw new Error("version lookup failed");
            },
          }),
        ),
        "version lookup failed",
      ),
      expectTypedFailure(
        runAlphaUploadProgram(
          { dryRun: false },
          makeUploadDependencies({
            print: () => {
              throw new Error("stdout failed");
            },
          }),
        ),
        "stdout failed",
      ),
      expectTypedFailure(
        runAlphaUploadProgram(
          { dryRun: false },
          makeUploadDependencies({
            setExitCode: () => {
              throw new Error("exit state failed");
            },
          }),
        ),
        "exit state failed",
      ),
    ]);
  });
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
            persistIdentity: () => {
              persisted = true;
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
  test("dispatches upload and relink through command-owned injected actions", async () => {
    const uploads: AlphaUploadInput[] = [];
    const relinks: string[] = [];

    await Effect.runPromise(
      Effect.all(
        [
          ["alpha", "upload"],
          ["alpha", "upload", "--dry-run"],
          ["alpha", "relink"],
        ].map((args) =>
          makeEffectCliTestProgram(args, {
            alphaActions: {
              upload: (input) => Effect.sync(() => uploads.push(input)),
              relink: () => Effect.sync(() => relinks.push("relink")),
            },
          }).pipe(Effect.provide(BunServices.layer)),
        ),
        { concurrency: 1, discard: true },
      ),
    );

    expect(uploads).toEqual([{ dryRun: false }, { dryRun: true }]);
    expect(relinks).toEqual(["relink"]);
  });

  test("the shared test root fails closed for both live alpha actions", async () => {
    const [uploadError, relinkError] = await Promise.all(
      [
        ["alpha", "upload"],
        ["alpha", "relink"],
      ].map((args) =>
        Effect.runPromise(
          makeEffectCliTestProgram(args).pipe(Effect.provide(BunServices.layer), Effect.flip),
        ),
      ),
    );

    expect(uploadError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live alpha upload is disabled in the Effect CLI test program.",
    });
    expect(relinkError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live alpha relink is disabled in the Effect CLI test program.",
    });
  });

  test("loads alpha support only when each live action effect executes", async () => {
    let loads = 0;
    const uploads: AlphaUploadInput[] = [];
    let relinks = 0;
    const dependencies: AlphaActionDependencies = {
      loadModule: async () => {
        loads += 1;
        return {
          runAlphaUploadProgram: (input) =>
            Effect.sync(() => {
              uploads.push(input);
              return SUCCESS_SUMMARY;
            }),
          runAlphaRelinkProgram: () =>
            Effect.sync(() => {
              relinks += 1;
              return { code: "alpha_relinked" };
            }),
        };
      },
    };

    const upload = runAlphaUploadActionWithDependencies({ dryRun: true }, dependencies);
    const relink = runAlphaRelinkActionWithDependencies(dependencies);
    expect(loads).toBe(0);

    await Promise.all([Effect.runPromise(upload), Effect.runPromise(relink)]);

    expect(loads).toBe(2);
    expect(uploads).toEqual([{ dryRun: true }]);
    expect(relinks).toBe(1);
  });

  test("maps upload and relink import failures to actionable internal errors", async () => {
    const dependencies: AlphaActionDependencies = {
      loadModule: async () => Promise.reject(new Error("module missing")),
    };
    const [uploadError, relinkError] = await Promise.all([
      Effect.runPromise(
        runAlphaUploadActionWithDependencies({ dryRun: false }, dependencies).pipe(Effect.flip),
      ),
      Effect.runPromise(runAlphaRelinkActionWithDependencies(dependencies).pipe(Effect.flip)),
    ]);

    expect(uploadError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load alpha upload support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
    expect(relinkError).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unable to load alpha relink support: module missing",
      suggestion: "Reinstall SelfTune with `npm install -g selftune@latest`, then retry.",
    });
  });

  test("preserves typed runtime failures from both alpha programs", async () => {
    const uploadFailure = new CLIError(
      "Upload identity is missing.",
      "CONFIG_MISSING",
      "selftune init --alpha",
      4,
    );
    const relinkFailure = new CLIError(
      "Device approval expired.",
      "OPERATION_FAILED",
      "selftune alpha relink",
      7,
      true,
    );
    const dependencies: AlphaActionDependencies = {
      loadModule: async () => ({
        runAlphaUploadProgram: () => Effect.fail(uploadFailure),
        runAlphaRelinkProgram: () => Effect.fail(relinkFailure),
      }),
    };

    const [actualUploadFailure, actualRelinkFailure] = await Promise.all([
      Effect.runPromise(
        runAlphaUploadActionWithDependencies({ dryRun: false }, dependencies).pipe(Effect.flip),
      ),
      Effect.runPromise(runAlphaRelinkActionWithDependencies(dependencies).pipe(Effect.flip)),
    ]);

    expect(actualUploadFailure).toBe(uploadFailure);
    expect(actualRelinkFailure).toBe(relinkFailure);
    expect(actualUploadFailure).toMatchObject({ exitCode: 4, retryable: false });
    expect(actualRelinkFailure).toMatchObject({ exitCode: 7, retryable: true });
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

  test("documents the migrated root, upload flag, and operand-free relink", () => {
    const home = makeHome();
    const rootHelp = runAlphaCli(home, "--help");
    expect(rootHelp.exitCode, rootHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toContain("SUBCOMMANDS");
    expect(rootHelp.stdout).toContain("upload");
    expect(rootHelp.stdout).toContain("relink");

    const uploadHelp = runAlphaCli(home, "upload", "--help");
    expect(uploadHelp.exitCode, uploadHelp.stderr).toBe(0);
    expect(uploadHelp.stdout).toContain("--dry-run");
    expect(uploadHelp.stdout).not.toContain("ARGUMENTS");
    expect(uploadHelp.stdout).not.toContain("__none__");
    expect(uploadHelp.stdout).not.toContain("[<");

    const relinkHelp = runAlphaCli(home, "relink", "--help");
    expect(relinkHelp.exitCode, relinkHelp.stderr).toBe(0);
    expect(relinkHelp.stdout).toContain("device-code approval");
    expect(relinkHelp.stdout).not.toContain("ARGUMENTS");
    expect(relinkHelp.stdout).not.toContain("__none__");
    expect(relinkHelp.stdout).not.toContain("[<");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("runs a live dry-run against an isolated enrolled identity", () => {
    const home = makeHome();
    const configDir = join(home, ".selftune");
    mkdirSync(configDir, { recursive: true });
    const identity = makeIdentity({
      api_key: undefined,
      credential: { provider: "file", account: "alpha-test" },
    });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        agent_type: "codex",
        cli_path: "/test/selftune",
        llm_mode: "agent",
        agent_cli: "codex",
        hooks_installed: false,
        initialized_at: "2026-07-18T00:00:00.000Z",
        alpha: identity,
      }),
    );
    writeFileSync(
      join(configDir, "credential-store.json"),
      JSON.stringify({ "alpha-test": "st_test_old" }),
    );

    const result = runAlphaCli(home, "upload", "--dry-run");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enrolled: true,
      failed: 0,
      sent: 0,
    });
  });

  test("preserves upload readiness error output and guidance", () => {
    const home = makeHome();
    const missingIdentity = runAlphaCli(home, "upload");
    expectCliError(missingIdentity, {
      message:
        "[alpha upload] Alpha upload is not linked. Run the init command with --alpha to authenticate via browser.",
      suggestion: "selftune init --alpha",
    });
  });

  test("rejects malformed upload arguments and bare option markers before opening state", () => {
    const home = makeHome();
    const cases = [
      {
        args: ["upload", "--dry-run=true"],
        message: "Invalid arguments: Option '--dry-run' does not take an argument",
      },
      {
        args: ["upload", "--dry-run", "false"],
        message:
          "Invalid arguments: Unexpected argument 'false'. This command does not take positional arguments",
      },
      {
        args: ["upload", "--no-dry-run"],
        message: "Invalid arguments: Unknown option '--no-dry-run'",
      },
      {
        args: ["upload", "--help", "extra"],
        message:
          "Invalid arguments: Unexpected argument 'extra'. This command does not take positional arguments",
      },
      {
        args: ["upload", "--unknown"],
        message: "Invalid arguments: Unknown option '--unknown'",
      },
      {
        args: ["upload", "extra"],
        message:
          "Invalid arguments: Unexpected argument 'extra'. This command does not take positional arguments",
      },
      {
        args: ["upload", "--"],
        message: "Invalid arguments: Unknown option '--'",
      },
      {
        args: ["upload", "--dry-run", "--"],
        message: "Invalid arguments: Unknown option '--'",
      },
    ];
    for (const testCase of cases) {
      expectCliError(runAlphaCli(home, ...testCase.args), {
        message: testCase.message,
        suggestion: "selftune alpha upload --help",
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
