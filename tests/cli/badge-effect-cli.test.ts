import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import type { BadgeInput } from "../../packages/runtime/badge/badge.js";
import { runBadgeProgram, type BadgeDependencies } from "../../packages/runtime/badge/badge.js";
import type { BadgeData } from "../../packages/runtime/badge/badge-data.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";
import { prepareEffectCliArguments } from "../../apps/cli/src/effect-cli/argument-compatibility.js";
import {
  BADGE_HELP,
  makeBadgeCommand,
  toBadgeCliError,
  type BadgeAction,
} from "../../apps/cli/src/effect-cli/commands/badge.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";
import { isEffectCliInvocation } from "../../apps/cli/src/effect-cli/selection.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const SELF_TUNE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const temporaryHomes: string[] = [];
const BADGE_DATA: BadgeData = {
  label: "Skill Health",
  passRate: 0.9,
  trend: "up",
  status: "HEALTHY",
  color: "#4c1",
  message: "90% \u2191",
};

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-badge-effect-cli-"));
  temporaryHomes.push(home);
  return home;
}

function runBadgeCli(home: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, "badge", ...args], {
    env: {
      ...process.env,
      HOME: home,
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

function runBadgeCommand(args: ReadonlyArray<string>, action: BadgeAction) {
  const run = Command.runWith(makeBadgeCommand(action), { version: "test" });
  return Effect.gen(function* () {
    const prepared = yield* prepareEffectCliArguments(["badge", ...args]);
    yield* run(prepared.slice(1));
  }).pipe(Effect.provide(BunServices.layer));
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("badge core program", () => {
  test("prints formatted output when no output path is provided", async () => {
    const printed: string[] = [];
    const dependencies: BadgeDependencies = {
      loadBadgeData: async () => BADGE_DATA,
      formatOutput: (_data, skill, format) => `${skill}:${format}`,
      writeOutput: () => {
        throw new Error("unexpected write");
      },
      print: (message) => printed.push(message),
    };

    const result = await runBadgeProgram({ skill: "research", format: "svg" }, dependencies);

    expect(result).toEqual({ output: "research:svg", outputPath: null });
    expect(printed).toEqual(["research:svg"]);
  });

  test("writes output and prints confirmation when output path is provided", async () => {
    const writes: Array<{ path: string; output: string }> = [];
    const printed: string[] = [];
    const dependencies: BadgeDependencies = {
      loadBadgeData: async () => BADGE_DATA,
      formatOutput: (_data, skill, format) => `${skill}:${format}`,
      writeOutput: (path, output) => writes.push({ path, output }),
      print: (message) => printed.push(message),
    };

    const result = await runBadgeProgram(
      { skill: "research", format: "markdown", output: "/tmp/research.md" },
      dependencies,
    );

    expect(result.outputPath).toBe("/tmp/research.md");
    expect(writes).toEqual([{ path: "/tmp/research.md", output: "research:markdown" }]);
    expect(printed).toEqual(["Badge written to /tmp/research.md"]);
  });

  test("preserves the legacy overwrite behavior for an existing output file", async () => {
    const home = makeHome();
    const outputPath = join(home, "badge.svg");
    writeFileSync(outputPath, "existing badge content", "utf8");
    const dependencies: BadgeDependencies = {
      loadBadgeData: async () => BADGE_DATA,
      formatOutput: () => "replacement",
      writeOutput: (path, output) => writeFileSync(path, output, "utf8"),
      print: () => undefined,
    };

    await runBadgeProgram({ skill: "research", format: "svg", output: outputPath }, dependencies);

    expect(readFileSync(outputPath, "utf8")).toBe("replacement");
  });

  test("preserves the skill-not-found CLIError guidance", async () => {
    const dependencies: BadgeDependencies = {
      loadBadgeData: async () => null,
      formatOutput: () => "unused",
      writeOutput: () => undefined,
      print: () => undefined,
    };

    expect(runBadgeProgram({ skill: "missing", format: "url" }, dependencies)).rejects.toThrow(
      "Skill not found: missing",
    );
  });

  test("rejects an empty skill before loading badge data", async () => {
    let loaded = false;
    const dependencies: BadgeDependencies = {
      loadBadgeData: async () => {
        loaded = true;
        return BADGE_DATA;
      },
      formatOutput: () => "unused",
      writeOutput: () => undefined,
      print: () => undefined,
    };

    expect(runBadgeProgram({ skill: "   ", format: "svg" }, dependencies)).rejects.toThrow(
      "--skill is required",
    );
    expect(loaded).toBe(false);
  });
});

describe("badge Effect CLI compatibility", () => {
  test("owns badge and preserves exact legacy help without Effect globals", () => {
    const home = makeHome();
    expect(isEffectCliInvocation("badge", [])).toBe(true);
    expect(isEffectCliInvocation("badge", ["--help"])).toBe(true);
    const help = runBadgeCli(home, "--help");
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toBe(`${BADGE_HELP}\n`);
    expect(help.stdout).not.toContain("GLOBAL FLAGS");
    expect(help.stdout).not.toContain("--version");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("parses the default and every explicit format with optional output", async () => {
    const badges: BadgeInput[] = [];
    const action: BadgeAction = (input) => Effect.sync(() => badges.push(input));
    await Promise.all(
      [
        ["--skill", "research"],
        ["--skill", "research", "--format", "svg"],
        ["--skill", "research", "--format", "markdown"],
        ["--skill", "research", "--format", "url", "--output", "/tmp/badge.txt"],
      ].map((args) => Effect.runPromise(runBadgeCommand(args, action))),
    );

    expect(badges).toEqual([
      { skill: "research", format: "svg", output: undefined },
      { skill: "research", format: "svg", output: undefined },
      { skill: "research", format: "markdown", output: undefined },
      { skill: "research", format: "url", output: "/tmp/badge.txt" },
    ]);
  });

  test("preserves empty, attached, multi-equals, dash, and last-wins values", async () => {
    const badges = await Promise.all(
      [
        ["--skill==leading-equals", "--format="],
        ["--skill=-dash-skill", "--format", "url", "--output=-dash-output"],
        [
          "--skill",
          "first",
          "--skill",
          "second",
          "--format",
          "url",
          "--format",
          "markdown",
          "--output",
          "first.svg",
          "--output",
          "second.md",
        ],
        ["--skill", "research", "--output="],
      ].map(async (args) => {
        let badge: BadgeInput | undefined;
        await Effect.runPromise(
          runBadgeCommand(args, (input) =>
            Effect.sync(() => {
              badge = input;
            }),
          ),
        );
        if (badge === undefined) throw new Error("Badge action was not invoked");
        return badge;
      }),
    );

    expect(badges).toEqual([
      { skill: "=leading-equals", format: "svg", output: undefined },
      { skill: "-dash-skill", format: "url", output: "-dash-output" },
      { skill: "second", format: "markdown", output: "second.md" },
      { skill: "research", format: "svg", output: undefined },
    ]);
  });

  test("rejects a missing skill and an invalid format before loading badge data", () => {
    const home = makeHome();
    const missingSkill = runBadgeCli(home);
    expect(missingSkill.exitCode).toBe(1);
    expect(missingSkill.stderr).toContain("--skill is required");

    const invalidFormat = runBadgeCli(home, "--skill", "research", "--format", "png");
    expect(invalidFormat.exitCode).toBe(1);
    expect(invalidFormat.stderr).toContain("png");
    expect(invalidFormat.stderr).toContain("svg");
    expect(invalidFormat.stderr).toContain("markdown");
    expect(invalidFormat.stderr).toContain("url");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("rejects extra positional operands", () => {
    const home = makeHome();
    const result = runBadgeCli(home, "extra", "--skill", "research");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extra");
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("help and parser failures never invoke the injected action", async () => {
    const badges: BadgeInput[] = [];
    const action: BadgeAction = (input) => Effect.sync(() => badges.push(input));

    await Effect.runPromise(runBadgeCommand(["--help", "--format", "png"], action));
    const errors = await Promise.all(
      [
        [],
        ["--skill="],
        ["--skill", "research", "--format", "png"],
        ["extra", "--skill", "research"],
        ["--skill"],
        ["--skill", "research", "--output"],
        ["-h"],
        ["-hh"],
        ["--help", "unexpected"],
        ["--help", "--unknown"],
        ["--version"],
        ["--log-level", "info"],
        ["--completions", "bash"],
      ].map((args) => Effect.runPromise(runBadgeCommand(args, action).pipe(Effect.flip))),
    );

    expect(errors).toHaveLength(13);
    expect(badges).toEqual([]);
  });

  test("legacy-invalid forms do not create local state or touch an output sentinel", () => {
    const invalidForms = [
      ["-h"],
      ["--help", "unexpected"],
      ["--help", "--unknown"],
      ["--skill="],
      ["--skill", "research", "--format", "png"],
      ["--version"],
      ["--log-level", "info"],
      ["--completions", "bash"],
    ];

    for (const args of invalidForms) {
      const home = makeHome();
      const sentinel = join(home, "badge.svg");
      writeFileSync(sentinel, "sentinel", "utf8");
      const result = runBadgeCli(home, ...args, "--output", sentinel);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("shared Effect test root fails closed instead of reading data or writing output", async () => {
    const home = makeHome();
    const output = join(home, "badge.svg");
    const error = await Effect.runPromise(
      makeEffectCliTestProgram(["badge", "--skill", "research", "--output", output]).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Live badge generation is disabled in the Effect CLI test program.",
    });
    expect(existsSync(output)).toBe(false);
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("preserves typed badge failures and maps unexpected asynchronous failures", () => {
    const validation = new CLIError("Skill not found: missing", "NOT_FOUND", "selftune status");

    expect(toBadgeCliError(validation)).toBe(validation);
    expect(toBadgeCliError(new Error("output path is read-only"))).toMatchObject({
      code: "OPERATION_FAILED",
      message: "Badge generation failed: output path is read-only",
      suggestion: "selftune badge --help",
    });
  });

  test("owns its lazy live adapter without a global badge handler", () => {
    const commandSource = readFileSync(
      join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/badge.ts"),
      "utf8",
    );
    expect(commandSource).toContain('import("@selftune/runtime/badge/badge")');
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/commands/contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(join(SELF_TUNE_ROOT, "apps/cli/src/effect-cli/handlers/live.ts"))).toBe(
      false,
    );
  });
});
