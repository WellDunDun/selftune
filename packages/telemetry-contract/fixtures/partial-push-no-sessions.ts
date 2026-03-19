import type { PushPayloadV2 } from "../src/schemas.js";

/**
 * A valid PushPayloadV2 with zero sessions but non-empty evolution_evidence.
 * Tests that partial pushes (no sessions) pass validation.
 */
export const partialPushNoSessions: PushPayloadV2 = {
  schema_version: "2.0",
  client_version: "0.9.0",
  push_id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  normalizer_version: "0.2.1",
  canonical: {
    sessions: [],
    prompts: [],
    skill_invocations: [],
    execution_facts: [],
    normalization_runs: [],
    evolution_evidence: [
      {
        evidence_id: "ev_nosess_deploy_001",
        skill_name: "deploy-helper",
        proposal_id: "prop-nosess-001",
        target: "description",
        stage: "validated",
        rationale: "Expanded trigger coverage for deploy-related queries",
        confidence: 0.88,
        original_text: "Help with deployments",
        proposed_text: "Assist with deployment pipelines, rollbacks, and infrastructure provisioning",
      },
      {
        evidence_id: "ev_nosess_codereview_002",
        skill_name: "code-review",
        target: "body",
        stage: "proposed",
        rationale: "Body rewrite for clearer instructions",
      },
    ],
  },
};
