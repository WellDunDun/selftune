import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const TTY_ENTRYPOINT = fileURLToPath(new URL("./fixtures/watch-cli-tty.ts", import.meta.url));
const temporaryRoots: string[] = [];

const WATCH_HELP = `selftune watch — Monitor post-deploy skill health

Usage:
  selftune watch --skill <name> --skill-path <path> [options]

Options:
  --skill            Skill name (required)
  --skill-path       Path to SKILL.md (required)
  --window           Number of recent sessions to consider (default: 20)
  --threshold        Regression threshold below baseline (default: 0.1)
  --auto-rollback    Automatically rollback on regression detection
  --grade-threshold  Grade regression threshold (default: 0.15)
  --no-grade-watch   Disable grade-based regression watch (enabled by default)
  --sync-first       Refresh source-truth telemetry before reading watch inputs
  --sync-force       Force a full rescan during --sync-first
  --help             Show this help message`;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `selftune-watch-contract-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function runWatch(home: string, args: ReadonlyArray<string>, tty = false): CliResult {
  const result = Bun.spawnSync(
    [process.execPath, "run", tty ? TTY_ENTRYPOINT : CLI_ENTRYPOINT, "watch", ...args],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        SELFTUNE_HOME: home,
        CODEX_HOME: join(home, ".codex"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        SELFTUNE_CONFIG_DIR: join(home, ".selftune"),
        SELFTUNE_LOG_DIR: join(home, "logs"),
        SELFTUNE_CLAUDE_DIR: join(home, ".claude"),
        SELFTUNE_OPENCLAW_DIR: join(home, ".openclaw"),
        SELFTUNE_PI_DIR: join(home, ".pi"),
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
        SELFTUNE_DASHBOARD_STREAM_DISABLE: "1",
        CI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

function requiredArgs(skillName = "demo"): string[] {
  return ["--skill", skillName, "--skill-path", join("skills", skillName, "SKILL.md")];
}

function parseSuccess(result: CliResult): Record<string, unknown> {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function initializeDatabase(home: string): string {
  parseSuccess(runWatch(home, requiredArgs()));
  return join(home, ".selftune", "selftune.db");
}

function seedTriggerRegression(databasePath: string, skillName: string): void {
  const database = new Database(databasePath);
  for (let index = 0; index < 3; index += 1) {
    database.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
         triggered, confidence, query, skill_path, source)
       VALUES (?, ?, ?, ?, 'implicit', 0, 1, ?, ?, 'contract')`,
      [
        `watch-contract-${index}`,
        `session-${index}`,
        `2026-07-17T00:00:0${index}.000Z`,
        skillName,
        "deploy the application",
        join("skills", skillName, "SKILL.md"),
      ],
    );
  }
  database.close();
}

function seedGradeRegression(databasePath: string, skillName: string): void {
  const database = new Database(databasePath);
  database.run(
    `INSERT INTO grading_baselines
      (skill_name, proposal_id, measured_at, pass_rate, sample_size)
     VALUES (?, NULL, '2026-07-17T00:00:00.000Z', 0.8, 10)`,
    [skillName],
  );
  database.run(
    `INSERT INTO grading_results
      (grading_id, session_id, skill_name, graded_at, pass_rate)
     VALUES ('watch-grade-1', 'grade-session-1', ?, '2026-07-17T01:00:00.000Z', 0.5)`,
    [skillName],
  );
  database.close();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy watch CLI contract", () => {
  test("prints exact long help after parsing but before validation or state acquisition", () => {
    for (const args of [["--help"], ["--help", "--window", "not-a-number"]]) {
      const home = makeRoot("help");
      expect(runWatch(home, args)).toEqual({
        exitCode: 0,
        stdout: `${WATCH_HELP}\n`,
        stderr: "",
      });
      expect(existsSync(join(home, ".selftune"))).toBe(false);
      expect(existsSync(join(home, "logs"))).toBe(false);
    }
  });

  test("keeps strict parser failures ahead of help and does not support short help", () => {
    const cases = [
      { args: ["-h"], stderr: "[FATAL] Unknown option '-h'\n" },
      { args: ["--help", "--unknown"], stderr: "[FATAL] Unknown option '--unknown'\n" },
      {
        args: ["--auto-rollback=true"],
        stderr: "[FATAL] Option '--auto-rollback' does not take an argument\n",
      },
      {
        args: ["--sync-first", "false"],
        stderr:
          "[FATAL] Unexpected argument 'false'. This command does not take positional arguments\n",
      },
      {
        args: ["--skill", "--sync-force"],
        stderr:
          "[FATAL] Option '--skill' argument is ambiguous.\n" +
          "Did you forget to specify the option argument for '--skill'?\n" +
          "To specify an option argument starting with a dash use '--skill=-XYZ'.\n",
      },
      {
        args: ["--skill-path"],
        stderr: "[FATAL] Option '--skill-path <value>' argument missing\n",
      },
      {
        args: ["unexpected"],
        stderr:
          "[FATAL] Unexpected argument 'unexpected'. This command does not take positional arguments\n",
      },
      { args: ["--version"], stderr: "[FATAL] Unknown option '--version'\n" },
    ];

    for (const { args, stderr } of cases) {
      const home = makeRoot("parse");
      expect(runWatch(home, args)).toEqual({ exitCode: 1, stdout: "", stderr });
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("rejects explicit JSON while using it to select structured parser errors", () => {
    const home = makeRoot("json-rejection");
    expect(runWatch(home, ["--json", "--help"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unknown option '--json'",
          retryable: false,
        },
      })}\n`,
    });
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("preserves required, sync-force, and numeric validation order", () => {
    const cases = [
      {
        args: ["--sync-force", "--window", "bad"],
        stderr:
          "[ERROR] --skill and --skill-path are required.\n" +
          "  → Usage: selftune watch --skill <name> --skill-path <path>\n",
      },
      {
        args: [...requiredArgs(), "--sync-force", "--window", "bad"],
        stderr:
          "[ERROR] --sync-force requires --sync-first.\n" +
          "  → Add --sync-first when using --sync-force.\n",
      },
      {
        args: [...requiredArgs(), "--window", "0", "--threshold", "bad"],
        stderr:
          "[ERROR] --window must be a positive integer >= 1.\n" +
          "  → selftune watch --window 20\n",
      },
      {
        args: [...requiredArgs(), "--window", "1", "--threshold", ".1"],
        stderr:
          "[ERROR] --threshold must be a finite number between 0 and 1.\n" +
          "  → selftune watch --threshold 0.1\n",
      },
      {
        args: [...requiredArgs(), "--window", "1", "--threshold", "1", "--grade-threshold", "1.1"],
        stderr:
          "[ERROR] --grade-threshold must be a finite number between 0 and 1.\n" +
          "  → selftune watch --grade-threshold 0.15\n",
      },
    ];

    for (const { args, stderr } of cases) {
      const home = makeRoot("validation");
      expect(runWatch(home, args)).toEqual({ exitCode: 1, stdout: "", stderr });
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("keeps empty required values missing and uses the last duplicate value", () => {
    const emptyHome = makeRoot("empty");
    expect(runWatch(emptyHome, ["--skill=", "--skill-path=skill.md"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "[ERROR] --skill and --skill-path are required.\n" +
        "  → Usage: selftune watch --skill <name> --skill-path <path>\n",
    });

    const home = makeRoot("duplicates");
    const output = parseSuccess(
      runWatch(home, [
        "--skill",
        "first",
        "--skill=-dash",
        "--skill-path",
        "first.md",
        "--skill-path=-skill.md",
        "--window",
        "2",
        "--window=7",
        "--threshold",
        "1",
        "--threshold=0",
        "--auto-rollback",
        "--auto-rollback",
        "--grade-threshold",
        "1",
        "--grade-threshold=0",
        "--no-grade-watch",
        "--no-grade-watch",
        "--sync-first",
        "--sync-first",
        "--sync-force",
        "--sync-force",
      ]),
    );
    expect(output).toMatchObject({
      snapshot: {
        skill_name: "-dash",
        window_sessions: 7,
        skill_checks: 0,
        pass_rate: 0,
        regression_detected: false,
        baseline_pass_rate: 0.5,
      },
      alert: null,
      rolledBack: false,
      recommendation:
        'Skill "-dash" has only 0 actionable check(s) in the current window. Need at least 3 before calling it stable.',
      gradeAlert: null,
      gradeRegression: null,
      sync_result: {
        since: null,
        dry_run: false,
        sources: {
          claude: { available: false, scanned: 0, synced: 0, skipped: 0 },
          codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
          opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
          openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
          pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
        },
      },
    });
  });

  test("always writes pretty JSON success to stdout, including for a TTY", () => {
    for (const tty of [false, true]) {
      const home = makeRoot(tty ? "tty" : "pipe");
      const result = runWatch(home, requiredArgs(), tty);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toStartWith('{\n  "snapshot": {\n    "timestamp": ');
      expect(result.stdout).toEndWith("\n}\n");
      expect(JSON.parse(result.stdout)).toMatchObject({
        snapshot: { window_sessions: 20, baseline_pass_rate: 0.5 },
        alert: null,
      });
    }
  });

  test("exits one with pretty JSON when trigger monitoring detects a regression", () => {
    const home = makeRoot("trigger-regression");
    const databasePath = initializeDatabase(home);
    seedTriggerRegression(databasePath, "demo");

    const result = runWatch(home, requiredArgs());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toStartWith('{\n  "snapshot": {');
    expect(JSON.parse(result.stdout)).toMatchObject({
      snapshot: {
        skill_name: "demo",
        skill_checks: 3,
        pass_rate: 0,
        false_negative_rate: 1,
        regression_detected: true,
        baseline_pass_rate: 0.5,
      },
      alert:
        'regression detected for "demo": pass_rate=0.00 below baseline=0.50 minus threshold=0.10',
      rolledBack: false,
      recommendation:
        "Consider running: selftune rollback --skill demo --skill-path skills/demo/SKILL.md",
      recommended_command: "selftune rollback --skill demo --skill-path skills/demo/SKILL.md",
      gradeAlert: null,
      gradeRegression: null,
    });
  });

  test("enables grade monitoring by default and honors threshold and opt-out flags", () => {
    const home = makeRoot("grade-regression");
    const databasePath = initializeDatabase(home);
    seedGradeRegression(databasePath, "demo");

    const defaultResult = runWatch(home, requiredArgs());
    expect(defaultResult.exitCode).toBe(1);
    expect(defaultResult.stderr).toBe("");
    expect(JSON.parse(defaultResult.stdout)).toMatchObject({
      alert:
        'grade regression detected for "demo": baseline_grade_pass_rate=0.80, recent_avg=0.50, delta=0.30 exceeds threshold=0.15',
      gradeAlert:
        'grade regression detected for "demo": baseline_grade_pass_rate=0.80, recent_avg=0.50, delta=0.30 exceeds threshold=0.15',
      gradeRegression: { before: 0.8, after: 0.5, delta: 0.30000000000000004 },
    });

    const equalLookingThreshold = runWatch(home, [...requiredArgs(), "--grade-threshold=0.30"]);
    expect(equalLookingThreshold.exitCode).toBe(1);
    expect(JSON.parse(equalLookingThreshold.stdout)).toMatchObject({
      gradeRegression: { delta: 0.30000000000000004 },
    });

    const raisedThreshold = parseSuccess(
      runWatch(home, [...requiredArgs(), "--grade-threshold=0.31"]),
    );
    expect(raisedThreshold).toMatchObject({ alert: null, gradeAlert: null, gradeRegression: null });

    const disabled = parseSuccess(runWatch(home, [...requiredArgs(), "--no-grade-watch"]));
    expect(disabled).toMatchObject({ alert: null, gradeAlert: null, gradeRegression: null });
  });
});
