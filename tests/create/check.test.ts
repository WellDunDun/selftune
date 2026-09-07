import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSkillValidationResult } from "../../packages/runtime/types.js";
import { computeCreateCheckResult } from "../../packages/runtime/create/readiness.js";

function passingSpecValidation(skillDir: string): Promise<AgentSkillValidationResult> {
  return Promise.resolve({
    ok: true,
    issues: [],
    raw_stdout: "",
    raw_stderr: "",
    exit_code: 0,
    validator: "skills-ref",
    command: `uvx skills-ref validate ${skillDir}`,
  });
}

describe("selftune create check", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing evals after spec and package checks pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "research-assistant");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    mkdirSync(join(skillDir, "assets"), { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: research-assistant
description: >
  Use when the user needs structured research help and evidence-backed synthesis.
metadata:
  version: 0.1.0
---

# Research Assistant
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(
      join(skillDir, "selftune.create.json"),
      JSON.stringify(
        {
          version: 1,
          entry_workflow: "workflows/default.md",
          supports_package_replay: true,
          expected_resources: {
            workflows: true,
            references: false,
            scripts: false,
            assets: false,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "research-assistant",
        eval_readiness: "cold_start_ready",
        next_step: "generate_evals",
        summary: "No evals yet.",
        recommended_command: "selftune eval generate --skill research-assistant",
        skill_path: join(skillDir, "SKILL.md"),
        trusted_trigger_count: 0,
        trusted_session_count: 0,
        eval_set_entries: 0,
        latest_eval_at: null,
        unit_test_cases: 0,
        unit_test_pass_rate: null,
        unit_test_ran_at: null,
        replay_check_count: 0,
        latest_validation_mode: null,
        baseline_sample_size: 0,
        baseline_pass_rate: null,
        latest_baseline_at: null,
        deployment_readiness: "blocked",
        deployment_summary: "blocked",
        deployment_command: null,
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(result.state).toBe("needs_evals");
    expect(result.ok).toBe(false);
    expect(result.readiness.checks.workflow_entry).toBe(true);
    expect(result.readiness.checks.package_replay_ready).toBe(true);
    expect(result.next_command).toContain("selftune eval generate --skill research-assistant");
  });

  it("blocks on spec validation before the creator-loop readiness steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "docs-helper");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Missing frontmatter\n", "utf-8");
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");

    const result = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: async () => ({
        ok: false,
        issues: [
          {
            level: "error",
            code: "invalid_frontmatter",
            message: "Missing YAML frontmatter.",
          },
        ],
        raw_stdout: "",
        raw_stderr: "Missing YAML frontmatter.",
        exit_code: 1,
        validator: "skills-ref",
        command: `uvx skills-ref validate ${skillDir}`,
      }),
      getTestingReadiness: () => null,
    });

    expect(result.state).toBe("blocked_spec_validation");
    expect(result.ok).toBe(false);
    expect(result.next_command).toBe(`uvx skills-ref validate ${skillDir}`);
  });

  it("marks a draft ready to publish once the creator-loop artifacts exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "release-note-writer");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: release-note-writer
description: >
  Use when the user needs changelog-ready release notes from commits, PRs, and shipped features.
---

# Release Note Writer
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");

    const result = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "release-note-writer",
        eval_readiness: "log_ready",
        next_step: "deploy_candidate",
        summary: "Ready to deploy.",
        recommended_command: "selftune evolve --skill release-note-writer",
        skill_path: join(skillDir, "SKILL.md"),
        trusted_trigger_count: 3,
        trusted_session_count: 3,
        eval_set_entries: 24,
        latest_eval_at: "2026-04-14T10:00:00Z",
        unit_test_cases: 8,
        unit_test_pass_rate: 1,
        unit_test_ran_at: "2026-04-14T10:05:00Z",
        replay_check_count: 1,
        latest_validation_mode: "host_replay",
        baseline_sample_size: 24,
        baseline_pass_rate: 0.75,
        latest_baseline_at: "2026-04-14T10:10:00Z",
        deployment_readiness: "ready_to_deploy",
        deployment_summary: "ready",
        deployment_command: "selftune evolve --skill release-note-writer --with-baseline",
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(result.state).toBe("ready_to_publish");
    expect(result.ok).toBe(true);
    expect(result.readiness.checks.evals_present).toBe(true);
    expect(result.readiness.checks.unit_tests_present).toBe(true);
    expect(result.readiness.checks.routing_replay_recorded).toBe(true);
    expect(result.readiness.checks.baseline_present).toBe(true);
    expect(result.next_command).toBe(
      `selftune create publish --skill-path ${join(skillDir, "SKILL.md")}`,
    );
  });

  it("recommends create replay and create baseline for draft-package readiness gaps", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "qa-helper");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: qa-helper
description: >
  Use when the user needs QA-oriented test planning and validation help.
---

# QA Helper
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");

    const skillPath = join(skillDir, "SKILL.md");
    const replayMissing = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "qa-helper",
        eval_readiness: "cold_start_ready",
        next_step: "run_replay_dry_run",
        summary: "Replay missing.",
        recommended_command: "ignored",
        skill_path: skillPath,
        trusted_trigger_count: 1,
        trusted_session_count: 1,
        eval_set_entries: 8,
        latest_eval_at: "2026-04-14T10:00:00Z",
        unit_test_cases: 4,
        unit_test_pass_rate: 1,
        unit_test_ran_at: "2026-04-14T10:05:00Z",
        replay_check_count: 0,
        latest_validation_mode: null,
        baseline_sample_size: 0,
        baseline_pass_rate: null,
        latest_baseline_at: null,
        deployment_readiness: "blocked",
        deployment_summary: "blocked",
        deployment_command: null,
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(replayMissing.state).toBe("needs_routing_replay");
    expect(replayMissing.next_command).toBe(
      `selftune create replay --skill-path ${skillPath} --mode package`,
    );

    const baselineMissing = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "qa-helper",
        eval_readiness: "cold_start_ready",
        next_step: "measure_baseline",
        summary: "Baseline missing.",
        recommended_command: "ignored",
        skill_path: skillPath,
        trusted_trigger_count: 1,
        trusted_session_count: 1,
        eval_set_entries: 8,
        latest_eval_at: "2026-04-14T10:00:00Z",
        unit_test_cases: 4,
        unit_test_pass_rate: 1,
        unit_test_ran_at: "2026-04-14T10:05:00Z",
        replay_check_count: 2,
        latest_validation_mode: "host_replay",
        baseline_sample_size: 0,
        baseline_pass_rate: null,
        latest_baseline_at: null,
        deployment_readiness: "blocked",
        deployment_summary: "blocked",
        deployment_command: null,
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(baselineMissing.state).toBe("needs_baseline");
    expect(baselineMissing.next_command).toBe(
      `selftune create baseline --skill-path ${skillPath} --mode package`,
    );
  });

  it("keeps create check blocked when the latest cached package evaluation failed baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "qa-helper");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: qa-helper
description: >
  Use when the user needs QA-oriented test planning and validation help.
---

# QA Helper
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");

    const skillPath = join(skillDir, "SKILL.md");
    const result = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "qa-helper",
        eval_readiness: "log_ready",
        next_step: "measure_baseline",
        summary:
          "A measured package evaluation already failed the package baseline gate, so the draft is not publishable yet.",
        recommended_command: `selftune create baseline --skill-path ${skillPath} --mode package`,
        skill_path: skillPath,
        trusted_trigger_count: 1,
        trusted_session_count: 1,
        eval_set_entries: 8,
        latest_eval_at: "2026-04-14T10:00:00Z",
        unit_test_cases: 4,
        unit_test_pass_rate: 1,
        unit_test_ran_at: "2026-04-14T10:05:00Z",
        replay_check_count: 8,
        latest_validation_mode: "host_replay",
        baseline_sample_size: 8,
        baseline_pass_rate: 0.55,
        latest_baseline_at: "2026-04-14T10:10:00Z",
        package_evaluation_status: "baseline_failed",
        package_evaluation_passed: false,
        latest_package_evaluation_at: "2026-04-14T10:12:00Z",
        deployment_readiness: "blocked",
        deployment_summary: "blocked",
        deployment_command: null,
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(result.state).toBe("needs_baseline");
    expect(result.ok).toBe(false);
    expect(result.readiness.checks.baseline_present).toBe(true);
    expect(result.next_command).toBe(
      `selftune create baseline --skill-path ${skillPath} --mode package`,
    );
  });

  it("keeps create check blocked when the latest deterministic unit-test run failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-create-check-"));
    tempDirs.push(root);

    const skillDir = join(root, "qa-helper");
    mkdirSync(join(skillDir, "workflows"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: qa-helper
description: >
  Use when the user needs QA-oriented test planning and validation help.
---

# QA Helper
`,
      "utf-8",
    );
    writeFileSync(join(skillDir, "workflows", "default.md"), "# Default\n", "utf-8");
    writeFileSync(join(skillDir, "references", "overview.md"), "# Overview\n", "utf-8");

    const skillPath = join(skillDir, "SKILL.md");
    const result = await computeCreateCheckResult(skillDir, {
      validateAgentSkill: passingSpecValidation,
      getTestingReadiness: () => ({
        skill_name: "qa-helper",
        eval_readiness: "log_ready",
        next_step: "run_unit_tests",
        summary: "Deterministic unit tests exist (4 cases), but the latest run only passed 50%.",
        recommended_command: `selftune eval unit-test --skill qa-helper --generate --skill-path ${skillPath}`,
        skill_path: skillPath,
        trusted_trigger_count: 1,
        trusted_session_count: 1,
        eval_set_entries: 8,
        latest_eval_at: "2026-04-14T10:00:00Z",
        unit_test_cases: 4,
        unit_test_pass_rate: 0.5,
        unit_test_ran_at: "2026-04-14T10:05:00Z",
        replay_check_count: 8,
        latest_validation_mode: "host_replay",
        baseline_sample_size: 8,
        baseline_pass_rate: 0.55,
        latest_baseline_at: "2026-04-14T10:10:00Z",
        deployment_readiness: "blocked",
        deployment_summary: "blocked",
        deployment_command: null,
        latest_evolution_action: null,
        latest_evolution_at: null,
      }),
    });

    expect(result.state).toBe("needs_unit_tests");
    expect(result.ok).toBe(false);
    expect(result.readiness.checks.unit_tests_present).toBe(true);
    expect(result.next_command).toBe(
      `selftune eval unit-test --skill qa-helper --generate --skill-path ${skillPath}`,
    );
  });
});
