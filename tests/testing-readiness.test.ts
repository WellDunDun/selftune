import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { _setTestDb, openDb } from "../packages/runtime/localdb/db.js";
import { computeCreatePackageFingerprint } from "../packages/runtime/create/package-fingerprint.js";

let db: Database;
let tempRoot: string;
let originalConfigDir: string | undefined;

async function loadTestingReadinessModule(): Promise<
  typeof import("../packages/runtime/testing-readiness.js")
> {
  return import(`../packages/runtime/testing-readiness.js?test=${Date.now()}`);
}

beforeEach(() => {
  db = openDb(":memory:");
  _setTestDb(db);
  tempRoot = mkdtempSync(join(tmpdir(), "selftune-readiness-"));
  originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = join(tempRoot, ".selftune");
});

afterEach(() => {
  _setTestDb(null);
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("listSkillTestingReadiness", () => {
  it("advances a skill from evals to replay dry-run once canonical evals and unit tests exist", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");

    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "2026-04-13T00:00:00Z", "codex", "codex"],
    );

    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-1",
        "sess-1",
        "2026-04-13T00:00:00Z",
        "Research",
        1,
        "Research this company",
        join(skillDir, "SKILL.md"),
      ],
    );
    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-2", "2026-04-13T00:01:00Z", "codex", "codex"],
    );
    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-3", "2026-04-13T00:02:00Z", "codex", "codex"],
    );
    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-2",
        "sess-2",
        "2026-04-13T00:01:00Z",
        "Research",
        1,
        "Research the competitor landscape",
        join(skillDir, "SKILL.md"),
      ],
    );
    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-3",
        "sess-3",
        "2026-04-13T00:02:00Z",
        "Research",
        1,
        "Investigate this company in depth",
        join(skillDir, "SKILL.md"),
      ],
    );

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);

    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });

    const readiness = mod.listSkillTestingReadiness(db, [skillRoot]);
    const row = readiness.find((entry) => entry.skill_name === "Research");

    expect(row).toBeDefined();
    expect(row?.eval_readiness).toBe("log_ready");
    expect(row?.eval_set_entries).toBe(2);
    expect(row?.unit_test_cases).toBe(1);
    expect(row?.unit_test_pass_rate).toBe(1);
    expect(row?.next_step).toBe("run_replay_dry_run");
    expect(row?.recommended_command).toContain("--validation-mode replay");
    expect(row?.deployment_readiness).toBe("blocked");
  });

  it("keeps installed skills in cold-start when only meta skill-maintenance triggers exist", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "SelfTuneBlog");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# SelfTuneBlog\n");

    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "2026-04-13T00:00:00Z", "codex", "codex"],
    );

    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-1",
        "sess-1",
        "2026-04-13T00:00:00Z",
        "SelfTuneBlog",
        1,
        "grade the selftune blog skill",
        join(skillDir, "SKILL.md"),
      ],
    );

    const row = mod.getSkillTestingReadiness(db, "SelfTuneBlog", [skillRoot]);

    expect(row).toBeDefined();
    expect(row?.eval_readiness).toBe("cold_start_ready");
    expect(row?.trusted_trigger_count).toBe(0);
    expect(row?.next_step).toBe("generate_evals");
    expect(row?.recommended_command).toContain("--auto-synthetic");
  });

  it("recommends create replay, create baseline, and create publish for draft packages", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);
    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });

    let row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);
    expect(row?.next_step).toBe("run_replay_dry_run");
    expect(row?.recommended_command).toBe(
      `selftune create replay --skill-path ${row?.skill_path} --mode package`,
    );
    expect(row?.summary).toContain("package replay validation");

    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "proposal-1", "Research", "host_replay", "current_package", "q1", 1, 1, 1, null],
    );

    row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);
    expect(row?.next_step).toBe("measure_baseline");
    expect(row?.recommended_command).toBe(
      `selftune create baseline --skill-path ${row?.skill_path} --mode package`,
    );
    expect(row?.summary).toContain("measured package baseline");

    db.run(
      `INSERT INTO grading_baselines
        (id, skill_name, proposal_id, measured_at, pass_rate, mean_score, sample_size, grading_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "Research", null, "2026-04-13T00:06:00Z", 0.75, 0.9, 12, null],
    );

    row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);
    expect(row?.next_step).toBe("deploy_candidate");
    expect(row?.recommended_command).toBe(
      `selftune create publish --skill-path ${row?.skill_path}`,
    );
    expect(row?.deployment_command).toBe(`selftune create publish --skill-path ${row?.skill_path}`);
    expect(row?.deployment_summary).toContain("Run create publish");
  });

  it("keeps draft packages blocked on the latest failed package evaluation", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);
    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });
    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "proposal-1", "Research", "host_replay", "current_package", "q1", 1, 1, 1, null],
    );
    db.run(
      `INSERT INTO grading_baselines
        (id, skill_name, proposal_id, measured_at, pass_rate, mean_score, sample_size, grading_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "Research", null, "2026-04-13T00:06:00Z", 0.75, 0.9, 12, null],
    );
    mod.writeCanonicalPackageEvaluation("Research", {
      skill_name: "Research",
      skill_path: join(skillDir, "SKILL.md"),
      mode: "package",
      package_fingerprint: computeCreatePackageFingerprint(join(skillDir, "SKILL.md")) ?? undefined,
      status: "baseline_failed",
      evaluation_passed: false,
      next_command: `selftune create baseline --skill-path ${join(skillDir, "SKILL.md")} --mode package`,
      replay: {
        mode: "package",
        validation_mode: "host_replay",
        agent: "claude",
        proposal_id: "proposal-1",
        fixture_id: "fixture-1",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
      },
      baseline: {
        mode: "package",
        baseline_pass_rate: 0.8,
        with_skill_pass_rate: 0.6,
        lift: -0.2,
        adds_value: false,
        measured_at: "2026-04-13T00:07:00Z",
        sample_size: 12,
      },
    });

    const row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);

    expect(row?.next_step).toBe("measure_baseline");
    expect(row?.recommended_command).toBe(
      `selftune create baseline --skill-path ${row?.skill_path} --mode package`,
    );
    expect(row?.package_evaluation_status).toBe("baseline_failed");
    expect(row?.summary).toContain("failed the package baseline gate");
  });

  it("ignores stale package evaluations when the draft package has changed", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n", "utf-8");
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);
    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });
    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "proposal-1", "Research", "host_replay", "current_package", "q1", 1, 1, 1, null],
    );
    db.run(
      `INSERT INTO grading_baselines
        (id, skill_name, proposal_id, measured_at, pass_rate, mean_score, sample_size, grading_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "Research", null, "2026-04-13T00:06:00Z", 0.75, 0.9, 12, null],
    );
    mod.writeCanonicalPackageEvaluation("Research", {
      skill_name: "Research",
      skill_path: join(skillDir, "SKILL.md"),
      mode: "package",
      package_fingerprint: "pkg_sha256_stale12345678",
      status: "baseline_failed",
      evaluation_passed: false,
      next_command: `selftune create baseline --skill-path ${join(skillDir, "SKILL.md")} --mode package`,
      replay: {
        mode: "package",
        validation_mode: "host_replay",
        agent: "claude",
        proposal_id: "proposal-1",
        fixture_id: "fixture-1",
        total: 2,
        passed: 2,
        failed: 0,
        pass_rate: 1,
      },
      baseline: {
        mode: "package",
        baseline_pass_rate: 0.8,
        with_skill_pass_rate: 0.6,
        lift: -0.2,
        adds_value: false,
        measured_at: "2026-04-13T00:07:00Z",
        sample_size: 12,
      },
    });

    const row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);

    expect(row?.next_step).toBe("deploy_candidate");
    expect(row?.package_evaluation_status).toBeNull();
  });

  it("keeps readiness blocked on the latest failed deterministic unit-test run", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);
    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
      { id: "research-2", skill_name: "Research", query: "Cite sources", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 2,
      passed: 1,
      failed: 1,
      pass_rate: 0.5,
      results: [
        {
          test_id: "research-2",
          passed: false,
          assertion_results: [],
          duration_ms: 40,
          error: "Failed deterministic citation assertion",
        },
      ],
    });

    const row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);

    expect(row?.next_step).toBe("run_unit_tests");
    expect(row?.recommended_command).toBe(
      `selftune eval unit-test --skill Research --generate --skill-path ${row?.skill_path}`,
    );
    expect(row?.unit_test_pass_rate).toBe(0.5);
    expect(row?.summary).toContain("latest run only passed 50%");
  });

  it("marks installed skills with no telemetry as cold-start eval candidates", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "sc-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# sc-search\n");

    const readiness = mod.listSkillTestingReadiness(db, [skillRoot]);
    const row = readiness.find((entry) => entry.skill_name === "sc-search");

    expect(row).toBeDefined();
    expect(row?.eval_readiness).toBe("cold_start_ready");
    expect(row?.next_step).toBe("generate_evals");
    expect(row?.recommended_command).toContain("--auto-synthetic");
    expect(row?.deployment_readiness).toBe("blocked");
  });

  it("returns a single-skill readiness row without enumerating the full list", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");

    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "2026-04-13T00:00:00Z", "codex", "codex"],
    );

    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-1",
        "sess-1",
        "2026-04-13T00:00:00Z",
        "Research",
        1,
        "Research this company",
        join(skillDir, "SKILL.md"),
      ],
    );

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);

    const single = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);
    const listed = mod
      .listSkillTestingReadiness(db, [skillRoot])
      .find((entry) => entry.skill_name === "Research");

    expect(listed).toBeDefined();
    expect(single).toEqual(listed ?? null);
  });

  it("prefers SQLite-stored creator-loop artifacts even when mirrored files are missing", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);
    mod.writeCanonicalUnitTests("Research", [
      { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("Research", {
      skill_name: "Research",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });

    unlinkSync(mod.getCanonicalEvalSetPath("Research"));
    unlinkSync(mod.getUnitTestPath("Research"));
    unlinkSync(mod.getUnitTestResultPath("Research"));

    const row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);

    expect(row).toBeDefined();
    expect(row?.eval_set_entries).toBe(2);
    expect(row?.unit_test_cases).toBe(1);
    expect(row?.unit_test_pass_rate).toBe(1);
  });

  it("marks fully tested deployed skills as watch-ready and surfaces the watch command", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "deploy-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# deploy-skill\n");

    db.run(
      `INSERT INTO sessions
        (session_id, started_at, platform, agent_cli)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "2026-04-13T00:00:00Z", "codex", "codex"],
    );

    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query, skill_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inv-1",
        "sess-1",
        "2026-04-13T00:00:00Z",
        "deploy-skill",
        1,
        "Deploy this safely",
        join(skillDir, "SKILL.md"),
      ],
    );

    mod.writeCanonicalEvalSet("deploy-skill", [
      { query: "Deploy this safely", should_trigger: true },
    ]);
    mod.writeCanonicalUnitTests("deploy-skill", [
      { id: "deploy-1", skill_name: "deploy-skill", query: "Deploy this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("deploy-skill", {
      skill_name: "deploy-skill",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });

    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        "proposal-1",
        "deploy-skill",
        "host_replay",
        "candidate",
        "Deploy this safely",
        1,
        1,
        1,
        null,
      ],
    );
    db.run(
      `INSERT INTO grading_baselines
        (id, skill_name, proposal_id, measured_at, pass_rate, mean_score, sample_size, grading_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "deploy-skill", "proposal-1", "2026-04-13T00:06:00Z", 0.72, 0.9, 12, null],
    );
    db.run(
      `INSERT INTO evolution_audit
        (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-04-13T00:07:00Z", "proposal-1", "deploy-skill", "deployed", "Shipped"],
    );

    const readiness = mod.listSkillTestingReadiness(db, [skillRoot]);
    const row = readiness.find((entry) => entry.skill_name === "deploy-skill");

    expect(row).toBeDefined();
    expect(row?.next_step).toBe("watch_deployment");
    expect(row?.recommended_command).toBe("selftune watch --skill deploy-skill");
    expect(row?.deployment_readiness).toBe("watching");
    expect(row?.deployment_command).toBe("selftune watch --skill deploy-skill");
  });

  it("uses watch with skill-path for published draft packages", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "deploy-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# deploy-skill\n");
    writeFileSync(join(skillDir, "selftune.create.json"), JSON.stringify({ version: 1 }), "utf-8");

    mod.writeCanonicalEvalSet("deploy-skill", [
      { query: "Deploy this safely", should_trigger: true },
    ]);
    mod.writeCanonicalUnitTests("deploy-skill", [
      { id: "deploy-1", skill_name: "deploy-skill", query: "Deploy this", assertions: [] },
    ]);
    mod.writeUnitTestRunResult("deploy-skill", {
      skill_name: "deploy-skill",
      run_at: "2026-04-13T00:05:00Z",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [],
    });
    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "proposal-1", "deploy-skill", "host_replay", "current_package", "q1", 1, 1, 1, null],
    );
    db.run(
      `INSERT INTO grading_baselines
        (id, skill_name, proposal_id, measured_at, pass_rate, mean_score, sample_size, grading_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "deploy-skill", null, "2026-04-13T00:06:00Z", 0.72, 0.9, 12, null],
    );
    db.run(
      `INSERT INTO evolution_audit
        (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-04-13T00:07:00Z", "proposal-1", "deploy-skill", "deployed", "Shipped"],
    );

    const row = mod.getSkillTestingReadiness(db, "deploy-skill", [skillRoot]);

    expect(row?.next_step).toBe("watch_deployment");
    expect(row?.recommended_command).toBe(
      `selftune watch --skill deploy-skill --skill-path ${row?.skill_path}`,
    );
    expect(row?.deployment_command).toBe(
      `selftune watch --skill deploy-skill --skill-path ${row?.skill_path}`,
    );
    expect(row?.deployment_summary).toContain("draft package is already published");
  });

  it("aggregates replay checks across validation modes while preserving the latest mode", async () => {
    const mod = await loadTestingReadinessModule();
    const skillRoot = join(tempRoot, "skills");
    const skillDir = join(skillRoot, "Research");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Research\n");

    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, "proposal-1", "Research", "host_replay", "candidate", "q1", 1, 1, 1, null],
    );
    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [2, "proposal-1", "Research", "host_replay", "candidate", "q2", 1, 1, 1, null],
    );
    db.run(
      `INSERT INTO replay_entry_results
        (id, proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [3, "proposal-1", "Research", "llm_judge", "candidate", "q3", 1, 1, 1, null],
    );

    const row = mod.getSkillTestingReadiness(db, "Research", [skillRoot]);

    expect(row).toBeDefined();
    expect(row?.replay_check_count).toBe(3);
    expect(row?.latest_validation_mode).toBe("llm_judge");
  });
});

describe("buildCreatorTestingOverview", () => {
  it("uses draft-package create checks before later creator-loop steps", async () => {
    const mod = await loadTestingReadinessModule();

    const overview = mod.buildCreatorTestingOverview([
      {
        skill_name: "draft-writer",
        skill_scope: "project",
        total_checks: 0,
        triggered_count: 0,
        pass_rate: 0,
        unique_sessions: 0,
        last_seen: null,
        has_evidence: false,
        routing_confidence: null,
        confidence_coverage: 0,
        testing_readiness: {
          skill_name: "draft-writer",
          eval_readiness: "log_ready",
          next_step: "deploy_candidate",
          summary:
            "Evals, unit tests, package replay, and a package baseline are all present. Ready to run create publish and hand the draft into watch.",
          recommended_command: "selftune create publish --skill-path /tmp/draft-writer/SKILL.md",
          skill_path: "/tmp/draft-writer/SKILL.md",
          trusted_trigger_count: 0,
          trusted_session_count: 0,
          eval_set_entries: 10,
          latest_eval_at: null,
          unit_test_cases: 2,
          unit_test_pass_rate: 1,
          unit_test_ran_at: null,
          replay_check_count: 10,
          latest_validation_mode: "host_replay",
          baseline_sample_size: 10,
          baseline_pass_rate: 0.8,
          latest_baseline_at: null,
          deployment_readiness: "ready_to_deploy",
          deployment_summary: "Ready to publish.",
          deployment_command: "selftune create publish --skill-path /tmp/draft-writer/SKILL.md",
          latest_evolution_action: null,
          latest_evolution_at: null,
        },
        create_readiness: {
          ok: false,
          state: "needs_spec_validation",
          summary:
            "Local package checks pass, but Agent Skills spec validation has not run yet. Run create check before publishing.",
          next_command: "selftune create check --skill-path /tmp/draft-writer/SKILL.md",
          skill_name: "draft-writer",
          skill_dir: "/tmp/draft-writer",
          skill_path: "/tmp/draft-writer/SKILL.md",
          entry_workflow: "workflows/default.md",
          manifest_present: true,
          description_quality: {
            composite: 0.88,
            criteria: {
              length: 1,
              trigger_context: 1,
              vagueness: 0.8,
              specificity: 0.8,
              not_just_name: 0.8,
            },
          },
          checks: {
            skill_md: true,
            frontmatter_present: true,
            skill_name_matches_dir: true,
            description_present: true,
            description_within_budget: true,
            skill_md_within_line_budget: true,
            manifest_present: true,
            workflow_entry: true,
            references_present: true,
            scripts_present: false,
            assets_present: false,
            evals_present: true,
            unit_tests_present: true,
            routing_replay_ready: true,
            routing_replay_recorded: true,
            package_replay_ready: true,
            baseline_present: true,
          },
        },
      },
    ]);

    expect(overview.counts.run_create_check).toBe(1);
    expect(overview.counts.deploy_candidate).toBe(0);
    expect(overview.priorities[0]).toMatchObject({
      skill_name: "draft-writer",
      step: "run_create_check",
      recommended_command: "selftune create check --skill-path /tmp/draft-writer/SKILL.md",
    });
  });

  it("treats published draft packages as watch-only priorities", async () => {
    const mod = await loadTestingReadinessModule();

    const overview = mod.buildCreatorTestingOverview([
      {
        skill_name: "draft-writer",
        skill_scope: "project",
        total_checks: 4,
        triggered_count: 4,
        pass_rate: 1,
        unique_sessions: 2,
        last_seen: "2026-04-13T00:07:00Z",
        has_evidence: true,
        routing_confidence: 0.92,
        confidence_coverage: 1,
        testing_readiness: {
          skill_name: "draft-writer",
          eval_readiness: "log_ready",
          next_step: "watch_deployment",
          summary:
            "This draft package has already been published. Keep watching live traffic and measured package lift before making another mutation.",
          recommended_command:
            "selftune watch --skill draft-writer --skill-path /tmp/draft-writer/SKILL.md",
          skill_path: "/tmp/draft-writer/SKILL.md",
          trusted_trigger_count: 4,
          trusted_session_count: 2,
          eval_set_entries: 10,
          latest_eval_at: null,
          unit_test_cases: 2,
          unit_test_pass_rate: 1,
          unit_test_ran_at: null,
          replay_check_count: 10,
          latest_validation_mode: "host_replay",
          baseline_sample_size: 10,
          baseline_pass_rate: 0.8,
          latest_baseline_at: null,
          deployment_readiness: "watching",
          deployment_summary: "Watching live traffic.",
          deployment_command:
            "selftune watch --skill draft-writer --skill-path /tmp/draft-writer/SKILL.md",
          latest_evolution_action: "deployed",
          latest_evolution_at: "2026-04-13T00:07:00Z",
        },
        create_readiness: {
          ok: true,
          state: "ready_to_publish",
          summary:
            "Spec validation, package structure, evals, unit tests, replay, and baseline are all present. The draft is ready for the deploy step.",
          next_command: "selftune create publish --skill-path /tmp/draft-writer/SKILL.md",
          skill_name: "draft-writer",
          skill_dir: "/tmp/draft-writer",
          skill_path: "/tmp/draft-writer/SKILL.md",
          entry_workflow: "workflows/default.md",
          manifest_present: true,
          description_quality: {
            composite: 0.9,
            criteria: {
              length: 1,
              trigger_context: 1,
              vagueness: 0.8,
              specificity: 0.9,
              not_just_name: 0.9,
            },
          },
          checks: {
            skill_md: true,
            frontmatter_present: true,
            skill_name_matches_dir: true,
            description_present: true,
            description_within_budget: true,
            skill_md_within_line_budget: true,
            manifest_present: true,
            workflow_entry: true,
            references_present: true,
            scripts_present: false,
            assets_present: false,
            evals_present: true,
            unit_tests_present: true,
            routing_replay_ready: true,
            routing_replay_recorded: true,
            package_replay_ready: true,
            baseline_present: true,
          },
        },
      },
    ]);

    expect(overview.counts.watch_deployment).toBe(1);
    expect(overview.priorities).toHaveLength(0);
  });
});
