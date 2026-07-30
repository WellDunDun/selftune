import { describe, expect, test } from "bun:test";

import {
  buildStudyDraft,
  type StudyDraftBuildInput,
} from "@selftune/skill-intelligence/study-drafts";

const sha = (character: string) => character.repeat(64);

const explicitInput: StudyDraftBuildInput = {
  hypothesis: {
    hypothesis_id: "hypothesis-1",
    kind: "explicit_correction",
    skill_ids: ["release-checklist"],
    task: "Confirm whether the selected portal image was actually uploaded.",
    observed_failure: "The agent said selected means uploaded.",
    correction_intent: "Require confirmed portal status before claiming upload success.",
    pre_edit_revision: sha("a"),
    post_edit_revision: sha("b"),
    current_revision: null,
    mutation_surface: "body",
    ambiguous: false,
    privacy_disposition: "safe",
  },
  calibration_evidence: [
    {
      evidence_id: "calibration-1",
      source_reference: "trace:one",
      summary: "Portal status was absent.",
      excerpt: "Selected file has no upload confirmation.",
    },
  ],
  hidden_references: [
    {
      evidence_id: "selection-1",
      partition: "selection",
      source_reference: "trace:two",
      content_fingerprint: `sha256:${sha("c")}`,
    },
    {
      evidence_id: "audit-1",
      partition: "audit",
      source_reference: "trace:three",
      content_fingerprint: `sha256:${sha("d")}`,
    },
  ],
};

describe("study draft builder", () => {
  test("builds a bounded redacted explicit-correction capsule without claiming qualification or replay", () => {
    const draft = buildStudyDraft({
      ...explicitInput,
      hypothesis: {
        ...explicitInput.hypothesis,
        task: "Use token=super-secret-value at /Users/alice/project.",
      },
    });

    expect(draft).toMatchObject({
      disposition: "ready_for_verifier",
      revision_evidence_status: "exact_pre_post",
      privacy_disposition: "safe",
      verifier_qualification: "not_attempted",
      replay_status: "not_attempted",
      defer_reasons: [],
    });
    expect(draft.task_capsule.task).toContain("[redacted]");
    expect(draft.task_capsule.task).toContain("[local-path]");
    expect(draft.hidden_references).toEqual(explicitInput.hidden_references);
    expect(JSON.stringify(draft.hidden_references)).not.toContain("Selected file has no upload");
  });

  test("redacts every typed private-key block and handles a long near miss in one pass", () => {
    const firstKey =
      "-----begin rsa private key-----\nfirst private material\n-----end rsa private key-----";
    const secondKey =
      "-----BEGIN PRIVATE KEY-----\nsecond private material\n-----END PRIVATE KEY-----";
    const redacted = buildStudyDraft({
      ...explicitInput,
      hypothesis: {
        ...explicitInput.hypothesis,
        task: `before ${firstKey} between ${secondKey} after`,
      },
    });

    expect(redacted.task_capsule.task).toBe(
      "before [redacted-private-key] between [redacted-private-key] after",
    );

    const nearMiss = `-----BEGIN ${"PRIVATE KEY ".repeat(500)}!`;
    const preserved = buildStudyDraft({
      ...explicitInput,
      hypothesis: { ...explicitInput.hypothesis, task: nearMiss },
    });
    expect(preserved.task_capsule.task).toBe(nearMiss);
  });

  test("supports a pinned missed-opportunity hypothesis without inventing a pre/post pair", () => {
    const draft = buildStudyDraft({
      ...explicitInput,
      hypothesis: {
        ...explicitInput.hypothesis,
        hypothesis_id: "hypothesis-2",
        kind: "missed_opportunity",
        correction_intent: null,
        pre_edit_revision: null,
        post_edit_revision: null,
        current_revision: sha("e"),
        mutation_surface: "routing",
      },
    });

    expect(draft).toMatchObject({
      disposition: "ready_for_verifier",
      revision_evidence_status: "exact_current",
      verifier_qualification: "not_attempted",
      replay_status: "not_attempted",
    });
  });

  test("defers ambiguous, multi-skill, unsupported-surface, and unredactable-secret hypotheses", () => {
    const draft = buildStudyDraft({
      ...explicitInput,
      hypothesis: {
        ...explicitInput.hypothesis,
        ambiguous: true,
        skill_ids: ["release-checklist", "deploy"],
        mutation_surface: "executable",
        privacy_disposition: "secret_unredactable",
      },
    });

    expect(draft).toMatchObject({ disposition: "deferred" });
    expect(draft.defer_reasons).toEqual([
      "ambiguous_hypothesis",
      "multi_skill_hypothesis",
      "unsupported_mutation_surface",
      "secret_unredactable",
    ]);

    const frontmatter = buildStudyDraft({
      ...explicitInput,
      hypothesis: { ...explicitInput.hypothesis, mutation_surface: "frontmatter" },
    });
    const crossFile = buildStudyDraft({
      ...explicitInput,
      hypothesis: { ...explicitInput.hypothesis, mutation_surface: "cross_file" },
    });
    expect(frontmatter.defer_reasons).toContain("unsupported_mutation_surface");
    expect(crossFile.defer_reasons).toContain("unsupported_mutation_surface");
  });

  test("defers invalid revision evidence and never leaks hidden partition content into the capsule", () => {
    const draft = buildStudyDraft({
      ...explicitInput,
      hypothesis: { ...explicitInput.hypothesis, post_edit_revision: sha("A") },
    });

    expect(draft).toMatchObject({
      disposition: "deferred",
      revision_evidence_status: "missing_or_invalid",
      defer_reasons: ["invalid_revision_evidence"],
    });
    expect(Object.keys(draft.task_capsule)).not.toContain("hidden_references");
  });

  test("is idempotent across evidence ordering", () => {
    const first = buildStudyDraft(explicitInput);
    const second = buildStudyDraft({
      ...explicitInput,
      hidden_references: explicitInput.hidden_references.toReversed(),
    });

    expect(second.draft_id).toBe(first.draft_id);
    expect(second.manifest_id).toBe(first.manifest_id);
  });
});
