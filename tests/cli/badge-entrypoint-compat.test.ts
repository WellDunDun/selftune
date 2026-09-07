import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const selftuneRoot = fileURLToPath(new URL("../..", import.meta.url));
const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const BADGE_ENTRYPOINT = fileURLToPath(
  new URL("../../packages/runtime/badge/badge.ts", import.meta.url),
);
const temporaryHomes: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "selftune-badge-entrypoint-"));
  temporaryHomes.push(home);
  return home;
}

function makeEnvironment(home: string) {
  return {
    ...process.env,
    HOME: home,
    SELFTUNE_HOME: home,
    SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
    SELFTUNE_LOG_DIR: join(home, "logs"),
    CI: "1",
    SELFTUNE_NO_ANALYTICS: "1",
    SELFTUNE_SKIP_UPDATE_CHECK: "1",
  };
}

function runEntrypoint(home: string, entrypoint: string, args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, "run", entrypoint, ...args], {
    cwd: selftuneRoot,
    env: makeEnvironment(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

const runBadge = (home: string, ...args: string[]) =>
  runEntrypoint(home, CLI_ENTRYPOINT, ["badge", ...args]);

function seedSkill(home: string, skillName: string): void {
  const script = `
    const { writeSkillCheckToDb } = await import("./packages/runtime/localdb/direct-write.ts");
    const written = writeSkillCheckToDb({
      skill_invocation_id: "badge-check-1",
      session_id: "badge-session-1",
      occurred_at: "2026-01-01T00:00:00.000Z",
      skill_name: ${JSON.stringify(skillName)},
      invocation_mode: "contextual",
      triggered: true,
      confidence: 1,
      query: "deploy this application",
      skill_path: "/tmp/${skillName}/SKILL.md",
      skill_scope: "global",
      source: "compat-test",
    });
    if (!written) process.exit(1);
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: selftuneRoot,
    env: makeEnvironment(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, Buffer.from(result.stderr).toString("utf8")).toBe(0);
}

function expectNoBadgeState(home: string): void {
  expect(existsSync(join(home, ".selftune"))).toBe(false);
  expect(existsSync(join(home, "badge.svg"))).toBe(false);
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("badge Effect CLI entrypoint compatibility", () => {
  test("direct badge entrypoint retains canonical output for each supported format", () => {
    const home = makeHome();
    seedSkill(home, "demo-skill");
    for (const format of ["svg", "markdown", "url"]) {
      const args = ["--skill", "demo-skill", "--format", format];
      const canonical = runBadge(home, ...args);
      const direct = runEntrypoint(home, BADGE_ENTRYPOINT, args);
      expect(canonical.exitCode, canonical.stderr).toBe(0);
      expect(direct).toEqual(canonical);
    }
    const emptyFormat = runEntrypoint(home, BADGE_ENTRYPOINT, [
      "--skill",
      "demo-skill",
      "--format",
      "",
    ]);
    expect(emptyFormat.exitCode, emptyFormat.stderr).toBe(0);
    expect(emptyFormat.stdout).toBe(runBadge(home, "--skill", "demo-skill").stdout);
  });

  test("direct badge entrypoint rejects unknown format before database access", () => {
    const home = makeHome();
    const result = runEntrypoint(home, BADGE_ENTRYPOINT, ["--skill", "demo", "--format", "png"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid format 'png'");
    expectNoBadgeState(home);
  });

  test("help documents badge flags without opening the database", () => {
    const home = makeHome();
    const result = runBadge(home, "--help");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: selftune badge --skill <name> [options]");
    expect(result.stdout).toContain("--skill");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("--output");
    expectNoBadgeState(home);
  });

  test("missing skill fails before opening the database", () => {
    const home = makeHome();
    const result = runBadge(home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--skill is required");
    expectNoBadgeState(home);
  });

  test("missing string flag values fail before opening the database", () => {
    for (const args of [
      ["--skill"],
      ["--skill", "demo", "--format"],
      ["--skill", "demo", "--output"],
    ]) {
      const home = makeHome();
      const result = runBadge(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("argument missing");
      expectNoBadgeState(home);
    }
  });

  test("invalid format and unknown flags do not mutate badge state", () => {
    for (const args of [
      ["--skill", "demo", "--format", "png"],
      ["--skill", "demo", "--unknown"],
    ]) {
      const home = makeHome();
      const result = runBadge(home, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(args.includes("png") ? "png" : "Unknown option");
      expectNoBadgeState(home);
    }
  });

  test("missing badge data preserves skill-not-found guidance", () => {
    const home = makeHome();
    const result = runBadge(home, "--skill", "missing-skill", "--format", "url");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Skill not found: missing-skill");
    expect(result.stderr).toContain("selftune status --json");
  });

  test("renders svg, markdown, and url from isolated database data", () => {
    const home = makeHome();
    seedSkill(home, "demo-skill");

    const svg = runBadge(home, "--skill", "demo-skill", "--format", "svg");
    expect(svg.exitCode, svg.stderr).toBe(0);
    expect(svg.stdout).toContain("<svg");
    expect(svg.stdout).toContain("Skill Health");

    const markdown = runBadge(home, "--skill", "demo-skill", "--format", "markdown");
    expect(markdown.exitCode, markdown.stderr).toBe(0);
    expect(markdown.stdout).toStartWith("![Skill Health: demo-skill]");
    expect(markdown.stdout).toContain("https://img.shields.io/badge/");

    const url = runBadge(home, "--skill", "demo-skill", "--format", "url");
    expect(url.exitCode, url.stderr).toBe(0);
    expect(url.stdout).toStartWith("https://img.shields.io/badge/");
    expect(url.stdout).not.toContain("![");
  });

  test("writes requested output file and prints its location", () => {
    const home = makeHome();
    seedSkill(home, "demo-skill");
    const outputDir = join(home, "output");
    const outputPath = join(outputDir, "badge.svg");
    mkdirSync(outputDir, { recursive: true });

    const result = runBadge(home, "--skill", "demo-skill", "--output", outputPath);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Badge written to ${outputPath}`);
    expect(readFileSync(outputPath, "utf8")).toContain("<svg");
  });
});
