import type { PushPayloadV2 } from "../src/types.js";

/**
 * A valid PushPayloadV2 with only evolution_evidence entries and
 * empty arrays for all other record types.
 */
export const evidenceOnlyPush: PushPayloadV2 = {
  schema_version: "2.0",
  client_version: "0.9.0",
  push_id: "d4e5f6a7-b8c9-8123-9efa-234567890123",
  normalizer_version: "0.2.1",
  canonical: {
    sessions: [],
    prompts: [],
    skill_invocations: [],
    execution_facts: [],
    normalization_runs: [],
    evolution_evidence: [
      {
        evidence_id: "ev_fixture_commit_001",
        skill_name: "commit",
        proposal_id: "evo-only-001",
        target: "description",
        stage: "deployed",
        rationale: "Broadened trigger to catch 'save my work' patterns",
        confidence: 0.91,
        original_text: "Create git commits with good messages",
        proposed_text:
          "Create git commits with descriptive messages when asked to commit, save work, or checkpoint progress",
        eval_set_json: {
          positives: ["commit this", "save my work", "checkpoint"],
          negatives: ["show git log", "what changed"],
        },
        validation_json: {
          pass_rate_before: 0.76,
          pass_rate_after: 0.92,
          improvement: 0.16,
        },
      },
      {
        evidence_id: "ev_fixture_testrunner_002",
        skill_name: "test-runner",
        target: "routing",
        stage: "proposed",
        rationale: "Missing trigger for 'run my specs'",
      },
      {
        evidence_id: "ev_fixture_deploy_003",
        skill_name: "deploy-helper",
        proposal_id: "evo-only-003",
        target: "body",
        stage: "validated",
        confidence: 0.85,
        raw_source_ref: { event_type: "evolution_evidence", raw_id: "evo-only-003" },
      },
    ],
  },
};
