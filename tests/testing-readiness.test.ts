import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { _setTestDb, openDb } from "../cli/selftune/localdb/db.js";

let db: Database;
let tempRoot: string;
let originalConfigDir: string | undefined;

async function loadTestingReadinessModule(): Promise<
  typeof import("../cli/selftune/testing-readiness.js")
> {
  return import(`../cli/selftune/testing-readiness.js?test=${Date.now()}`);
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

    mod.writeCanonicalEvalSet("Research", [
      { query: "Research this company", should_trigger: true },
      { query: "Tell me a joke", should_trigger: false },
    ]);

    mkdirSync(join(process.env.SELFTUNE_CONFIG_DIR!, "unit-tests"), { recursive: true });
    writeFileSync(
      mod.getUnitTestPath("Research"),
      JSON.stringify([
        { id: "research-1", skill_name: "Research", query: "Research this", assertions: [] },
      ]),
      "utf-8",
    );
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

    expect(single).toEqual(listed);
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
    mkdirSync(join(process.env.SELFTUNE_CONFIG_DIR!, "unit-tests"), { recursive: true });
    writeFileSync(
      mod.getUnitTestPath("deploy-skill"),
      JSON.stringify([
        { id: "deploy-1", skill_name: "deploy-skill", query: "Deploy this", assertions: [] },
      ]),
      "utf-8",
    );
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
