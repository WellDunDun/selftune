import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";

import { openDb } from "@selftune/local-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const RunReport = Schema.Struct({
  multiplier: Schema.Number,
  source_rows: Schema.Struct({
    sessions: Schema.Number,
    prompts: Schema.Number,
    skill_invocations: Schema.Number,
    execution_facts: Schema.Number,
  }),
  checks: Schema.Record(Schema.String, Schema.Boolean),
  steady_resume: Schema.Struct({ facts_visited: Schema.Number, response_bytes: Schema.Number }),
});
const Report = Schema.Struct({
  source: Schema.String,
  source_opened_read_only: Schema.Boolean,
  source_is_live_database: Schema.Boolean,
  one_x: Schema.optionalKey(RunReport),
  ten_x: Schema.optionalKey(RunReport),
  representative_ten_x: Schema.optionalKey(RunReport),
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "selftune-backfill-runner-test-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.db");
  const database = openDb(sourcePath);
  try {
    for (const platform of ["codex", "claude_code", "opencode", "pi", "openclaw"]) {
      database.run(
        `INSERT INTO sessions (session_id, platform, started_at, ended_at, capture_mode, raw_source_ref, workspace_path)
        VALUES (?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z', 'session', ?, ?)`,
        [platform, platform, `session:${platform}`, "PRIVATE_WORKSPACE_MUST_STAY_LOCAL"],
      );
      database.run(
        `INSERT INTO prompts (prompt_id, session_id, occurred_at, prompt_text)
        VALUES (?, ?, '2026-07-01T00:00:00.000Z', ?)`,
        [`${platform}-prompt`, platform, "PRIVATE_PROMPT_MUST_STAY_LOCAL"],
      );
      database.run(
        `INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name, occurred_at)
        VALUES (?, ?, 'diagnose', '2026-07-01T00:00:00.000Z')`,
        [`${platform}-skill`, platform],
      );
      database.run(
        `INSERT INTO execution_facts (execution_fact_id, session_id, occurred_at, duration_ms, input_tokens, raw_source_ref)
        VALUES (?, ?, '2026-07-01T00:00:00.000Z', 1000, 10, ?)`,
        [`${platform}-fact`, platform, `session:${platform}`],
      );
    }
  } finally {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
  }
  return { directory, sourcePath };
};

test.each([
  { name: "1x", args: ["--only", "1x"], expected: ["one_x"] },
  { name: "10x", args: ["--only", "10x"], expected: ["ten_x"] },
  {
    name: "representative 10x",
    args: ["--only", "representative-10x"],
    expected: ["representative_ten_x"],
  },
  { name: "default", args: [], expected: ["one_x", "representative_ten_x"] },
])(
  "runs $name acceptance against a disposable source without changing its bytes",
  async ({ args, expected }) => {
    const { directory, sourcePath } = fixture();
    const fingerprint = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const before = fingerprint();
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../scripts/verify-historical-backfill.ts"),
        "--sqlite-backup",
        sourcePath,
        ...args,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          SELFTUNE_CONFIG_DIR: join(directory, "config"),
          SELFTUNE_NO_ANALYTICS: "1",
          SELFTUNE_SKIP_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(fingerprint()).toBe(before);
    expect(stdout).not.toContain("PRIVATE_PROMPT_MUST_STAY_LOCAL");
    expect(stdout).not.toContain("PRIVATE_WORKSPACE_MUST_STAY_LOCAL");
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(stdout);
    expect(report.source).toBe(sourcePath);
    expect(report.source_opened_read_only).toBe(true);
    expect(report.source_is_live_database).toBe(false);
    const { one_x, ten_x, representative_ten_x } = report;
    const runs = Object.entries({ one_x, ten_x, representative_ten_x }).filter(
      ([, run]) => run !== undefined,
    );
    expect(runs.map(([name]) => name)).toEqual([...expected]);
    for (const [, run] of runs) {
      if (run === undefined) throw new Error("Expected an executed corpus");
      expect(run.source_rows).toEqual({
        sessions: 5,
        prompts: 5,
        skill_invocations: 5,
        execution_facts: 5 * run.multiplier,
      });
      expect(Object.keys(run.checks)).toHaveLength(11);
      expect(Object.values(run.checks).every(Boolean)).toBe(true);
      expect(run.steady_resume.facts_visited).toBe(0);
      expect(run.steady_resume.response_bytes).toBeGreaterThan(0);
    }
  },
  30_000,
);
