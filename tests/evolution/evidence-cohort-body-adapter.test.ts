import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CohortBodyEvolutionDeps,
  evolveBodyFromEvidenceCohort,
} from "../../packages/runtime/evolution/evidence-cohort-body-adapter.js";
import {
  type EvidenceCohort,
  materializeEvidenceCohort,
} from "@selftune/observability/evidence-cohort";
import * as Effect from "effect/Effect";
import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import type { BodyValidationResult } from "../../packages/runtime/types.js";
import { computeSkillVersionHash } from "../../packages/runtime/utils/skill-discovery.js";

let tempDirs: string[] = [];

function createSkill(): { skillPath: string; revision: string } {
  const skillDir = join(tmpdir(), `selftune-cohort-adapter-${Date.now()}-${Math.random()}`);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillPath,
    "---\nname: test-skill\n---\n\n# Test Skill\n\nUse this skill.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |\n",
  );
  tempDirs.push(skillDir);
  const revision = computeSkillVersionHash(skillPath);
  if (!revision) throw new Error("Expected skill revision");
  return { skillPath, revision };
}

const makeCandidate = (index: number, error_count: number) => ({
  trace_id: index.toString(16).padStart(32, "0"),
  span_id: (index + 100).toString(16).padStart(16, "0"),
  skill_invocation_id: `invocation-${index}`,
  source_id: "rollout",
  source_revision: `source-${index}`,
  duration_ms: 100,
  input_tokens: 10,
  output_tokens: 5,
  error_count,
  tool_call_count: 1,
  source_excerpt: error_count > 0 ? "observed failure" : "comparable success",
});

async function cohort(skillPath: string, revision: string): Promise<EvidenceCohort> {
  return Effect.runPromise(
    materializeEvidenceCohort({
      schema_version: "1.0.0",
      selector_version: "test-selector-v1",
      pattern: {
        pattern_id: "execution-pattern-test-skill",
        kind: "repeated_correlated_errors",
        skill_id: "test-skill",
        skill_name: "test-skill",
      },
      target_skill: {
        skill_id: "test-skill",
        skill_name: "test-skill",
        skill_path: skillPath,
        revision,
      },
      source_allowlist: ["rollout"],
      excerpt_limit_bytes: 120,
      request_limit_bytes: 4_096,
      candidates: [
        makeCandidate(1, 1),
        makeCandidate(2, 1),
        makeCandidate(3, 0),
        makeCandidate(4, 0),
      ],
    }),
  );
}

function resolvedEvidence(input: EvidenceCohort) {
  return input.entries.map((entry) => ({
    ...entry.source,
    skill_revision: input.target_skill.revision,
    query: entry.role.startsWith("heldout")
      ? "private holdout query"
      : `query ${entry.source.trace_id}`,
    should_trigger: true,
  }));
}

const validation: BodyValidationResult = {
  proposal_id: "unused",
  gates_passed: 3,
  gates_total: 3,
  gate_results: [
    { gate: "structural", passed: true, reason: "valid" },
    { gate: "trigger_accuracy", passed: true, reason: "improved" },
    { gate: "quality", passed: true, reason: "clear" },
  ],
  improved: true,
  regressions: [],
};

function deps(): CohortBodyEvolutionDeps {
  return {
    validateBodyProposal: async (proposal) => ({
      ...validation,
      proposal_id: proposal.proposal_id,
    }),
    appendAuditEntry: () => {},
    appendEvidenceEntry: () => {},
  };
}

beforeEach(() => _setTestDb(openDb(":memory:")));
afterEach(() => {
  _setTestDb(null);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("evolveBodyFromEvidenceCohort", () => {
  test("uses calibration only, returns a stable existing-skill body candidate, and never deploys", async () => {
    const { skillPath, revision } = createSkill();
    const seenInputs: unknown[] = [];
    const input = await cohort(skillPath, revision);
    const teacher = async (teacherInput: unknown) => {
      seenInputs.push(teacherInput);
      return {
        schema_version: 1,
        proposed_body:
          "Use this skill.\n\nWhen a user asks to run tests, follow the test workflow.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |",
        rationale: "Adds the observed test-running trigger.",
        confidence: 0.9,
        target_section: "Instructions",
        scope: "section_local",
        mutation_operation: "refine",
        principle: "Run the requested test workflow.",
        applicability: "When the invoked skill is asked to run tests.",
        failure_mode: "The workflow omitted the test command.",
        preserved_constraints: ["Keep the routing table valid."],
        superseded_guidance: [],
        uncertainty: ["The pattern remains correlational."],
      };
    };

    const first = await evolveBodyFromEvidenceCohort(
      { cohort: input, resolved_evidence: resolvedEvidence(input), teacher },
      deps(),
    );
    const second = await evolveBodyFromEvidenceCohort(
      { cohort: input, resolved_evidence: resolvedEvidence(input), teacher },
      deps(),
    );

    expect(first.status).toBe("review_ready");
    expect(first.deployed).toBe(false);
    expect(first.candidate?.candidate_kind).toBe("existing_skill_body_mutation");
    expect(first.candidate?.target_revision).toBe(revision);
    expect(first.candidate?.generator_contract_version).toBe("evidence-body-proposal/v1");
    expect(first.candidate?.scope).toBe("section_local");
    expect(first.candidate?.proposal_id).toBe(second.candidate?.proposal_id);
    expect(JSON.stringify(seenInputs)).not.toContain("private holdout query");
    expect(first.heldout_references).toHaveLength(2);
    expect(first.heldout_references.every((reference) => reference.startsWith("trace://"))).toBe(
      true,
    );
  });

  test("blocks a stale target revision before calling the teacher", async () => {
    const { skillPath } = createSkill();
    let teacherCalls = 0;

    const input = await cohort(skillPath, "stale-revision");
    const result = await evolveBodyFromEvidenceCohort({
      cohort: input,
      resolved_evidence: resolvedEvidence(input),
      teacher: async () => {
        teacherCalls++;
        return { schema_version: 1, proposed_body: "", rationale: "", confidence: 0 };
      },
    });

    expect(result.status).toBe("stale_target");
    expect(teacherCalls).toBe(0);
  });

  test("stays diagnostic when source evidence resolves to another skill revision", async () => {
    const { skillPath, revision } = createSkill();
    const input = await cohort(skillPath, revision);
    let teacherCalls = 0;
    const result = await evolveBodyFromEvidenceCohort({
      cohort: input,
      resolved_evidence: resolvedEvidence(input).map((entry) => ({
        ...entry,
        skill_revision: "another-revision",
      })),
      teacher: async () => {
        teacherCalls++;
        return { schema_version: 1, proposed_body: "", rationale: "", confidence: 0 };
      },
    });

    expect(result.status).toBe("insufficient_evidence");
    expect(result.deployed).toBe(false);
    expect(teacherCalls).toBe(0);
  });
});
