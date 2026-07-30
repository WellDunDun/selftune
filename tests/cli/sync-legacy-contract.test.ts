import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../apps/cli/src/main.ts", import.meta.url));
const TTY_ENTRYPOINT = fileURLToPath(new URL("./fixtures/sync-cli-tty.ts", import.meta.url));
const CLAUDE_TRANSCRIPT_FIXTURE = fileURLToPath(
  new URL("../sandbox/fixtures/transcripts/session-001.jsonl", import.meta.url),
);
const temporaryRoots: string[] = [];

const SYNC_HELP = `selftune sync — Source-truth telemetry sync

Usage:
  selftune sync [options]

Options:
  --projects-dir <dir>             Claude transcript directory (default: ~/.claude/projects)
  --codex-home <dir>               Codex home directory (default: ~/.codex)
  --opencode-data-dir <dir>        OpenCode data directory
  --openclaw-agents-dir <dir>      OpenClaw agents directory
  --pi-sessions-dir <dir>          Pi sessions directory
  --skill-log <path>               Raw skill usage log path
  --repaired-skill-log <path>      Repaired overlay log path
  --repaired-sessions-marker <p>   Repaired session marker path
  --since <date>                   Only sync sessions modified on/after date
  --dry-run                        Show summary without writing files
  --force                          Ignore per-source markers and rescan everything
  --no-claude                      Skip Claude transcript replay
  --no-codex                       Skip Codex rollout ingest
  --no-opencode                    Skip OpenCode ingest
  --no-openclaw                    Skip OpenClaw ingest
  --no-pi                          Skip Pi ingest
  --no-repair                      Skip rebuilt skill-usage overlay
  --json                           Output raw JSON instead of human-readable summary
  -h, --help                       Show this help`;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SyncRunOptions {
  readonly tty?: boolean;
  readonly alphaEndpoint?: string;
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `selftune-sync-contract-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function runSync(
  home: string,
  args: ReadonlyArray<string>,
  options: SyncRunOptions = {},
): CliResult {
  const entrypoint = options.tty ? TTY_ENTRYPOINT : CLI_ENTRYPOINT;
  const result = Bun.spawnSync([process.execPath, "run", entrypoint, "sync", ...args], {
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
      SELFTUNE_ALPHA_ENDPOINT: options.alphaEndpoint,
      SELFTUNE_NO_ANALYTICS: "1",
      SELFTUNE_SKIP_UPDATE_CHECK: "1",
      CI: "1",
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

function sourcePaths(home: string) {
  return {
    projectsDir: join(home, "sources", "claude"),
    codexHome: join(home, "sources", "codex"),
    opencodeDataDir: join(home, "sources", "opencode"),
    openclawAgentsDir: join(home, "sources", "openclaw"),
    piSessionsDir: join(home, "sources", "pi"),
  };
}

function makeEmptySourcesAvailable(home: string): ReturnType<typeof sourcePaths> {
  const paths = sourcePaths(home);
  mkdirSync(paths.projectsDir, { recursive: true });
  mkdirSync(join(paths.codexHome, "sessions"), { recursive: true });
  mkdirSync(join(paths.opencodeDataDir, "storage"), { recursive: true });
  mkdirSync(paths.openclawAgentsDir, { recursive: true });
  mkdirSync(paths.piSessionsDir, { recursive: true });
  return paths;
}

function sourceArguments(paths: ReturnType<typeof sourcePaths>): string[] {
  return [
    "--projects-dir",
    paths.projectsDir,
    "--codex-home",
    paths.codexHome,
    "--opencode-data-dir",
    paths.opencodeDataDir,
    "--openclaw-agents-dir",
    paths.openclawAgentsDir,
    "--pi-sessions-dir",
    paths.piSessionsDir,
  ];
}

function writeOnboardingSources(home: string, enabled: boolean): void {
  const configDir = join(home, ".selftune");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      agent_type: "unknown",
      cli_path: process.execPath,
      llm_mode: "agent",
      agent_cli: null,
      hooks_installed: false,
      initialized_at: "2026-07-17T00:00:00.000Z",
      preferences: {
        import_sources: {
          claude_code: enabled,
          cline: false,
          codex: enabled,
          opencode: enabled,
          openclaw: enabled,
          pi: enabled,
        },
        features: {
          observability: true,
          health_recommendations: true,
          autonomous_improvement: false,
        },
      },
    }),
  );
}

function writeEnrolledIdentity(home: string): void {
  const configDir = join(home, ".selftune");
  const configPath = join(configDir, "config.json");
  const credentialAccount = "sync-contract-account";
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "credential-store.json"),
    JSON.stringify({ [credentialAccount]: "st_test_sync_contract" }),
    { mode: 0o600 },
  );
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  writeFileSync(
    configPath,
    JSON.stringify({
      ...existing,
      alpha: {
        enrolled: true,
        user_id: "sync-contract-user",
        consent_timestamp: "2026-07-17T00:00:00.000Z",
        credential: { provider: "file", account: credentialAccount },
      },
    }),
  );
}

function parseJsonOutput(result: CliResult): Record<string, unknown> {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy sync CLI contract", () => {
  test("prints exact leaf help before date validation without opening local state", () => {
    for (const args of [["--help"], ["-h"], ["--help", "--since", "not-a-date"]]) {
      const home = makeRoot("help");
      const result = runSync(home, args);
      expect(result).toEqual({ exitCode: 0, stdout: `${SYNC_HELP}\n`, stderr: "" });
      expect(existsSync(join(home, ".selftune"))).toBe(false);
      expect(existsSync(join(home, "logs"))).toBe(false);
    }
  });

  test("keeps strict parse failures ahead of help and state acquisition", () => {
    const cases = [
      {
        args: ["--help", "--unknown"],
        stderr: "[FATAL] Unknown option '--unknown'\n",
      },
      {
        args: ["--dry-run=true"],
        stderr: "[FATAL] Option '--dry-run' does not take an argument\n",
      },
      {
        args: ["--force", "false"],
        stderr:
          "[FATAL] Unexpected argument 'false'. This command does not take positional arguments\n",
      },
      {
        args: ["--no-claude=false"],
        stderr: "[FATAL] Option '--no-claude' does not take an argument\n",
      },
      { args: ["--no-force"], stderr: "[FATAL] Unknown option '--no-force'\n" },
      {
        args: ["unexpected"],
        stderr:
          "[FATAL] Unexpected argument 'unexpected'. This command does not take positional arguments\n",
      },
      {
        args: ["--", "unexpected"],
        stderr:
          "[FATAL] Unexpected argument 'unexpected'. This command does not take positional arguments\n",
      },
      {
        args: ["--since"],
        stderr: "[FATAL] Option '--since <value>' argument missing\n",
      },
      {
        args: ["--projects-dir", "--force"],
        stderr:
          "[FATAL] Option '--projects-dir' argument is ambiguous.\n" +
          "Did you forget to specify the option argument for '--projects-dir'?\n" +
          "To specify an option argument starting with a dash use '--projects-dir=-XYZ'.\n",
      },
      { args: ["--version"], stderr: "[FATAL] Unknown option '--version'\n" },
      {
        args: ["--log-level", "info"],
        stderr: "[FATAL] Unknown option '--log-level'\n",
      },
    ];

    for (const { args, stderr } of cases) {
      const home = makeRoot("parse-error");
      const result = runSync(home, args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(stderr);
      expect(existsSync(join(home, ".selftune"))).toBe(false);
    }
  });

  test("reports invalid dates as the exact typed CLI error before opening local state", () => {
    const home = makeRoot("invalid-date");
    const result = runSync(home, ["--since", "not-a-date"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "[ERROR] Invalid --since date: not-a-date\n  → selftune sync --since 2026-01-01\n",
    });
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("only makes parser failures structured when JSON was explicitly requested", () => {
    const home = makeRoot("json-parse-error");
    const result = runSync(home, ["--unknown", "--json"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unknown option '--unknown'",
          retryable: false,
        },
      })}\n`,
    });
    expect(existsSync(join(home, ".selftune"))).toBe(false);
  });

  test("maps every path and narrowing flag into piped JSON output", () => {
    const home = makeRoot("all-flags");
    const paths = makeEmptySourcesAvailable(home);
    writeOnboardingSources(home, true);
    const result = parseJsonOutput(
      runSync(home, [
        ...sourceArguments(paths),
        "--skill-log",
        join(home, "custom", "skill.jsonl"),
        "--repaired-skill-log",
        join(home, "custom", "repaired.jsonl"),
        "--repaired-sessions-marker",
        join(home, "custom", "repaired-sessions.json"),
        "--since=2026-01-02",
        "--dry-run",
        "--force",
        "--no-claude",
        "--no-codex",
        "--no-opencode",
        "--no-openclaw",
        "--no-pi",
        "--no-repair",
      ]),
    );

    expect(result).toMatchObject({
      since: "2026-01-02T00:00:00.000Z",
      dry_run: true,
      sources: {
        claude: { available: false, scanned: 0, synced: 0, skipped: 0 },
        codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
        opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
        openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
        pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
      },
      repair: {
        ran: false,
        repaired_sessions: 0,
        repaired_records: 0,
        codex_repaired_records: 0,
      },
      creator_contributions: {
        ran: true,
        eligible_skills: 0,
        built_signals: 0,
        staged_signals: 0,
      },
    });
    expect(result.timings).toEqual([
      { phase: "creator_contributions", elapsed_ms: expect.any(Number) },
    ]);
    expect(result.total_elapsed_ms).toEqual(expect.any(Number));
  });

  test("preserves attached empty and leading-dash values with last-option-wins semantics", () => {
    const home = makeRoot("value-quirks");
    mkdirSync(join(home, "-claude"));
    writeOnboardingSources(home, true);
    const result = parseJsonOutput(
      runSync(home, [
        "--projects-dir",
        join(home, "missing-claude"),
        "--projects-dir=-claude",
        "--since=2026-01-02",
        "--since=",
        "--dry-run",
        "--dry-run",
        "--no-codex",
        "--no-opencode",
        "--no-openclaw",
        "--no-pi",
        "--no-repair",
      ]),
    );

    expect(result).toMatchObject({
      since: null,
      dry_run: true,
      sources: {
        claude: { available: true, scanned: 0, synced: 0, skipped: 0 },
      },
    });
  });

  test("lets onboarding disable sources and only allows no-flags to narrow them further", () => {
    const enabledHome = makeRoot("onboarding-enabled");
    const enabledPaths = makeEmptySourcesAvailable(enabledHome);
    writeOnboardingSources(enabledHome, true);
    const enabled = parseJsonOutput(
      runSync(enabledHome, [
        ...sourceArguments(enabledPaths),
        "--dry-run",
        "--no-repair",
        "--json",
      ]),
    );
    expect(enabled.sources).toMatchObject({
      claude: { available: true },
      codex: { available: true },
      opencode: { available: true },
      openclaw: { available: true },
      pi: { available: true },
    });

    const disabledHome = makeRoot("onboarding-disabled");
    const disabledPaths = makeEmptySourcesAvailable(disabledHome);
    writeOnboardingSources(disabledHome, false);
    const disabled = parseJsonOutput(
      runSync(disabledHome, [...sourceArguments(disabledPaths), "--dry-run", "--no-repair"]),
    );
    expect(disabled.sources).toMatchObject({
      claude: { available: false },
      codex: { available: false },
      opencode: { available: false },
      openclaw: { available: false },
      pi: { available: false },
    });
  });

  test("keeps piped output machine-readable and TTY output entirely on stderr", () => {
    const pipeHome = makeRoot("pipe-output");
    const pipe = runSync(pipeHome, [
      "--dry-run",
      "--no-claude",
      "--no-codex",
      "--no-opencode",
      "--no-openclaw",
      "--no-pi",
      "--no-repair",
    ]);
    expect(pipe.exitCode, pipe.stderr).toBe(0);
    expect(pipe.stderr).toBe("");
    expect(JSON.parse(pipe.stdout)).toMatchObject({ dry_run: true });

    const ttyHome = makeRoot("tty-output");
    const tty = runSync(
      ttyHome,
      [
        "--dry-run",
        "--no-claude",
        "--no-codex",
        "--no-opencode",
        "--no-openclaw",
        "--no-pi",
        "--no-repair",
      ],
      { tty: true },
    );
    expect(tty.exitCode, tty.stderr).toBe(0);
    expect(tty.stdout).toBe("");
    expect(tty.stderr).toStartWith("selftune sync --dry-run\n  starting sync...\n\nSources:\n");
    for (const source of ["Claude", "Codex", "OpenCode", "OpenClaw", "Pi"]) {
      expect(tty.stderr).toContain(`  ${source}: not available\n`);
    }
    expect(tty.stderr).toMatch(/\nDone in (?:\d+ms|\d+\.\d+s)\n$/);
  });

  test("keeps non-empty dry-run previews inside the structured output boundary", () => {
    const home = makeRoot("non-empty-dry-run-json");
    const paths = makeEmptySourcesAvailable(home);
    const projectDirectory = join(paths.projectsDir, "fixture-project");
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(
      join(projectDirectory, "session-001.jsonl"),
      readFileSync(CLAUDE_TRANSCRIPT_FIXTURE),
    );
    writeOnboardingSources(home, true);

    const args = [
      ...sourceArguments(paths),
      "--dry-run",
      "--no-codex",
      "--no-opencode",
      "--no-openclaw",
      "--no-pi",
      "--no-repair",
    ];
    const result = runSync(home, [...args, "--json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("[DRY RUN]");
    expect(JSON.parse(result.stdout)).toMatchObject({
      dry_run: true,
      sources: { claude: { available: true, scanned: 1, synced: 1, skipped: 0 } },
    });

    const ttyResult = runSync(home, args, { tty: true });
    expect(ttyResult.exitCode, ttyResult.stderr).toBe(0);
    expect(ttyResult.stdout).toBe("");
    expect(ttyResult.stderr).toContain("[DRY RUN] Would ingest: session=session-001");
  });

  test("switches invalid-date errors between JSON and human-readable TTY forms", () => {
    const ttyHome = makeRoot("tty-error");
    const tty = runSync(ttyHome, ["--since", "bad"], { tty: true });
    expect(tty).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "[ERROR] Invalid --since date: bad\n  → selftune sync --since 2026-01-01\n",
    });

    const explicitJsonHome = makeRoot("tty-json-error");
    const explicitJson = runSync(explicitJsonHome, ["--since", "bad", "--json"], { tty: true });
    expect(explicitJson.exitCode).toBe(1);
    expect(JSON.parse(explicitJson.stderr)).toEqual({
      error: {
        code: "INVALID_FLAG",
        message: "Invalid --since date: bad",
        suggestion: "selftune sync --since 2026-01-01",
        retryable: false,
      },
    });
  });

  test("records a successful run without attempting remote compatibility export", () => {
    const home = makeRoot("alpha-fail-open");
    writeOnboardingSources(home, false);
    writeEnrolledIdentity(home);
    // The compatibility preparation path must not touch the credential store.
    // A daemon-owned worker resolves this later when it actually flushes.
    rmSync(join(home, ".selftune", "credential-store.json"), { force: true });

    const initialized = runSync(home, ["--dry-run", "--no-repair", "--json"]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);

    const databasePath = join(home, ".selftune", "selftune.db");
    const database = new Database(databasePath);
    const now = "2026-07-17T00:00:00.000Z";
    database.run(
      `INSERT INTO upload_queue
        (payload_type, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 4, ?, ?)`,
      ["push", JSON.stringify({ push_id: "sync-contract-push", records: [] }), now, now],
    );
    database.close();

    const result = runSync(home, ["--no-repair", "--json"], {
      alphaEndpoint: "http://127.0.0.1:1/api/v1/push",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");

    const outputLines = result.stdout.trimEnd().split("\n");
    const alphaLine = outputLines.pop();
    expect(alphaLine).toBeDefined();
    expect(JSON.parse(alphaLine ?? "null")).toEqual({
      code: "alpha_upload",
      enrolled: true,
      prepared: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    const syncResult = JSON.parse(outputLines.join("\n"));
    expect(syncResult).toMatchObject({ dry_run: false });

    const persisted = new Database(databasePath, { readonly: true });
    expect(persisted.query("SELECT status, attempts FROM upload_queue").get()).toEqual({
      status: "pending",
      attempts: 4,
    });
    const cronRuns = persisted
      .query("SELECT status, metrics_json, error FROM cron_runs WHERE job_name = 'sync'")
      .all();
    persisted.close();
    expect(cronRuns.length).toBe(2);
    expect(cronRuns.every((row) => row.status === "success" && row.error === null)).toBe(true);
    expect(readFileSync(join(home, ".selftune", "config.json"), "utf8")).toContain(
      "sync-contract-user",
    );
  });
});
