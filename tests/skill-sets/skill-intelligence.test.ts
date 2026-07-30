import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  analyzeSkillIntelligence,
  type SkillIntelligenceInstalledSkill,
} from "@selftune/skill-intelligence";
import type { SkillSetManifest } from "@selftune/library";
import type { SessionTelemetryRecord } from "../../packages/runtime/types.js";
import type { TrustedSkillObservationRow } from "../../packages/runtime/localdb/queries/trust.js";

function installed(
  name: string,
  description: string,
  harness: SkillIntelligenceInstalledSkill["harness"] = "codex",
  sourceId?: string,
): SkillIntelligenceInstalledSkill {
  const registry = join("/tmp", harness === "claude_code" ? ".claude" : ".codex", "skills");
  const packagePath = join(registry, name);
  return {
    name,
    skill_path: join(packagePath, "SKILL.md"),
    package_path: packagePath,
    registry_dir: registry,
    modified_at: "2026-01-01T00:00:00.000Z",
    skill_scope: "global",
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    harness,
    source_id: sourceId,
  };
}

function observation(
  name: string,
  sessionId: string,
  order: number,
  query = "",
): TrustedSkillObservationRow {
  return {
    skill_name: name,
    skill_path: join("/tmp/.codex/skills", name, "SKILL.md"),
    session_id: sessionId,
    occurred_at: `2026-01-0${order + 1}T00:00:00.000Z`,
    triggered: 1,
    matched_prompt_id: `prompt-${sessionId}-${name}`,
    confidence: 1,
    invocation_mode: "inferred",
    query_text: query,
  };
}

function session(
  id: string,
  cwd = "/tmp/projects/atlas",
  timestamp = "2026-01-10T00:00:00.000Z",
): SessionTelemetryRecord {
  return {
    timestamp,
    session_id: id,
    cwd,
    transcript_path: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 0,
    last_user_query: "",
  };
}

describe("skill intelligence", () => {
  test("classifies installed skills from package semantics without an LLM", () => {
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("paper-finder", "Research academic papers and collect citations."),
        installed("release-runner", "Automate deployment infrastructure and CI CD workflows."),
        installed("misc-helper", "Use this skill for bespoke tasks."),
        {
          ...installed("release-notes", "Write editorial release notes and changelog content."),
          active: false,
        },
      ],
      observations: [],
      sessions: [],
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(
      report.classifications.map(({ skill_name, category }) => [skill_name, category]),
    ).toEqual([
      ["misc-helper", "general"],
      ["paper-finder", "research"],
      ["release-notes", "writing_content"],
      ["release-runner", "operations_automation"],
    ]);
    expect(report.installed_skills).toBe(3);
    expect(report.classified_skills).toBe(4);
    expect(report.generated_at).toBe("2026-02-01T00:00:00.000Z");
    expect(
      report.classifications.every((classification) => classification.source === "inferred"),
    ).toBe(true);
  });

  test("uses a human category correction while retaining the inferred label", () => {
    const report = analyzeSkillIntelligence({
      installedSkills: [installed("paper-finder", "Write polished editorial content.")],
      observations: [],
      sessions: [],
      classificationOverrides: [
        {
          skill_id: "paper-finder",
          skill_name: "paper-finder",
          category: "research",
          inferred_category: "writing_content",
          reason: "Used for literature research.",
          algorithm_version: "skill-intelligence-v1",
          created_at: "2026-02-01T00:00:00.000Z",
          updated_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    expect(report.classifications[0]).toMatchObject({
      category: "research",
      inferred_category: "writing_content",
      category_label: "Research",
      source: "human",
      confidence: 1,
      override_reason: "Used for literature research.",
    });
    expect(report.feedback.classification_overrides).toBe(1);
  });

  test("suggests a set when trusted co-usage repeats in different orders", () => {
    const observations = [
      observation("research", "s1", 0, "Research the API"),
      observation("writing", "s1", 1, "Write the findings"),
      observation("selftune", "s1", 2, "Measure the workflow"),
      observation("writing", "s2", 0, "Draft a report"),
      observation("research", "s2", 1, "Verify sources"),
      observation("selftune", "s2", 2, "Measure the workflow"),
      observation("research", "s3", 0, "Find sources"),
      observation("writing", "s3", 1, "Publish the result"),
      observation("selftune", "s3", 2, "Measure the workflow"),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
        installed("selftune", "Observe and improve agent skills."),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      pattern: "co_usage",
      evidence_state: "exploratory",
      occurrence_count: 3,
      discovery_occurrence_count: 3,
      held_out_occurrence_count: 0,
      affinity: 1,
      harnesses: ["codex"],
    });
    expect(report.suggestions[0]?.skills.map((skill) => skill.name).toSorted()).toEqual([
      "research",
      "writing",
    ]);
  });

  test("does not present two skills from the same source as a standalone Skill Set", () => {
    const observations = ["s1", "s2", "s3"].flatMap((id, index) =>
      index % 2 === 0
        ? [observation("cloudflare", id, 0), observation("wrangler", id, 1)]
        : [observation("wrangler", id, 0), observation("cloudflare", id, 1)],
    );
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("cloudflare", "Build on the Cloudflare platform.", "codex", "cloudflare/skills"),
        installed("wrangler", "Operate the Wrangler CLI.", "codex", "cloudflare/skills"),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    });

    expect(report.suggestions).toEqual([]);
  });

  test("retains same-source skills inside a broader cross-source set", () => {
    const orders = [
      ["cloudflare", "wrangler", "shadcn"],
      ["shadcn", "cloudflare", "wrangler"],
      ["wrangler", "shadcn", "cloudflare"],
    ];
    const observations = orders.flatMap((names, sessionIndex) =>
      names.map((name, order) => observation(name, `s${sessionIndex + 1}`, order)),
    );
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("cloudflare", "Build on the Cloudflare platform.", "codex", "cloudflare/skills"),
        installed("wrangler", "Operate the Wrangler CLI.", "codex", "cloudflare/skills"),
        installed("shadcn", "Build React user interfaces.", "codex", "shadcn/ui"),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    });

    const coUsage = report.suggestions.filter((suggestion) => suggestion.pattern === "co_usage");
    expect(coUsage).toHaveLength(1);
    expect(coUsage[0]?.skills.map((skill) => skill.name).toSorted()).toEqual([
      "cloudflare",
      "shadcn",
      "wrangler",
    ]);
  });

  test("allows a core skill to participate in multiple overlapping sets", () => {
    const groups = [
      ["diagnose", "cloudflare", "shadcn"],
      ["diagnose", "flutter", "dart"],
    ];
    const observations = groups.flatMap((names, groupIndex) =>
      [0, 1, 2].flatMap((sessionIndex) => {
        const ordered = sessionIndex % 2 === 0 ? names : names.toReversed();
        return ordered.map((name, order) =>
          observation(name, `group-${groupIndex}-${sessionIndex}`, order),
        );
      }),
    );
    const sessions = groups.flatMap((_, groupIndex) =>
      [0, 1, 2].map((sessionIndex) => session(`group-${groupIndex}-${sessionIndex}`)),
    );
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed(
          "diagnose",
          "Diagnose difficult engineering failures.",
          "codex",
          "mattpocock/skills",
        ),
        installed("cloudflare", "Build on the Cloudflare platform.", "codex", "cloudflare/skills"),
        installed("shadcn", "Build React user interfaces.", "codex", "shadcn/ui"),
        installed(
          "flutter",
          "Build cross-platform Flutter applications.",
          "codex",
          "flutter/skills",
        ),
        installed("dart", "Develop and test Dart applications.", "codex", "dart-lang/skills"),
      ],
      observations,
      sessions,
      minOccurrences: 3,
      minValidationOccurrences: 10,
    });

    const coUsage = report.suggestions.filter(
      (suggestion) => suggestion.pattern === "co_usage" && suggestion.skills.length >= 3,
    );
    expect(
      coUsage.map((suggestion) => suggestion.skills.map((skill) => skill.name).toSorted()),
    ).toEqual([
      ["cloudflare", "diagnose", "shadcn"],
      ["dart", "diagnose", "flutter"],
    ]);
    expect(
      coUsage.filter((suggestion) => suggestion.skills.some((skill) => skill.name === "diagnose")),
    ).toHaveLength(2);
  });

  test("validates a multi-skill set from recurring held-out edges instead of exact-set sessions", () => {
    const discovery = Array.from({ length: 15 }, (_, index) => `s${index + 1}`);
    const heldOut = ["s16", "s17", "s18", "s19", "s20"];
    const observations = [
      ...discovery.flatMap((id, index) =>
        index < 6
          ? ["cloudflare", "shadcn", "diagnose"].map((name, order) =>
              observation(name, id, (order + index) % 3),
            )
          : [observation("unrelated", id, 0)],
      ),
      ...["s16", "s17"].flatMap((id) =>
        ["cloudflare", "shadcn", "diagnose"].map((name, order) => observation(name, id, order)),
      ),
      observation("cloudflare", "s18", 0),
      observation("shadcn", "s19", 0),
      observation("diagnose", "s20", 0),
    ];
    const sessionIds = [...discovery, ...heldOut];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("cloudflare", "Build on the Cloudflare platform.", "codex", "cloudflare/skills"),
        installed("shadcn", "Build React user interfaces.", "codex", "shadcn/ui"),
        installed(
          "diagnose",
          "Diagnose difficult engineering failures.",
          "codex",
          "mattpocock/skills",
        ),
        installed("unrelated", "Handle unrelated tasks.", "codex", "example/skills"),
      ],
      observations,
      sessions: sessionIds.map((id, index) =>
        session(
          id,
          "/tmp/projects/atlas",
          `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 3,
      minAffinity: 0.5,
    });

    const community = report.suggestions.find(
      (suggestion) => suggestion.pattern === "co_usage" && suggestion.skills.length === 3,
    );
    expect(community).toMatchObject({
      evidence_state: "validated",
      discovery_edge_coverage: 1,
      held_out_edge_coverage: 1,
      held_out_occurrence_count: 2,
      held_out_affinity: 0.5,
    });
  });

  test("suppresses reviewed evidence and only resurfaces temporary dismissals when evidence changes", () => {
    const baseObservations = ["s1", "s2", "s3"].flatMap((id) => [
      observation("research", id, 0, "Research the API"),
      observation("writing", id, 1, "Write the findings"),
    ]);
    const base = {
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
      ],
      observations: baseObservations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    };
    const initial = analyzeSkillIntelligence(base);
    const suggestion = initial.suggestions[0]!;
    const review = {
      review_id: "review-one",
      suggestion_id: suggestion.suggestion_id,
      evidence_fingerprint: suggestion.evidence_fingerprint,
      decision: "dismissed" as const,
      reason_code: "not_relevant_now" as const,
      reason: null,
      resulting_set_id: null,
      resulting_set_revision_hash: null,
      edited_fields: [],
      edit_distance: null,
      algorithm_version: initial.algorithm_version,
      reviewed_at: "2026-02-01T00:00:00.000Z",
    };

    expect(analyzeSkillIntelligence({ ...base, suggestionReviews: [review] }).suggestions).toEqual(
      [],
    );
    const strongerObservations = [
      ...baseObservations,
      observation("research", "s4", 0, "Research another API"),
      observation("writing", "s4", 1, "Write another report"),
    ];
    const stronger = analyzeSkillIntelligence({
      ...base,
      observations: strongerObservations,
      sessions: [...base.sessions, session("s4")],
      suggestionReviews: [review],
    });
    expect(stronger.suggestions).toHaveLength(1);
    expect(stronger.suggestions[0]?.evidence_fingerprint).not.toBe(suggestion.evidence_fingerprint);

    const permanentReview = { ...review, reason_code: "skills_should_remain_separate" as const };
    expect(
      analyzeSkillIntelligence({
        ...base,
        observations: strongerObservations,
        sessions: [...base.sessions, session("s4")],
        suggestionReviews: [permanentReview],
      }).suggestions,
    ).toEqual([]);
  });

  test("prefers an ordered workflow and suppresses a set that already exists", () => {
    const observations = ["s1", "s2", "s3"].flatMap((id) => [
      observation("test", id, 0, "Test the change"),
      observation("review", id, 1, "Review the result"),
    ]);
    const existingSet: SkillSetManifest = {
      schema_version: 1,
      set_id: "quality-loop",
      name: "Quality loop",
      description: "",
      harnesses: ["codex"],
      skills: [
        { name: "test", content_hash: "a", library_package_path: "/tmp/test" },
        { name: "review", content_hash: "b", library_package_path: "/tmp/review" },
      ],
      revision: 1,
      revision_hash: "revision",
      parent_revision_hash: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const baseInput = {
      installedSkills: [
        installed("test", "Run regression tests and verify quality."),
        installed("review", "Review code for quality problems."),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    };

    const suggested = analyzeSkillIntelligence(baseInput);
    expect(suggested.suggestions).toHaveLength(1);
    expect(suggested.suggestions[0]).toMatchObject({
      pattern: "workflow",
      evidence_state: "exploratory",
      occurrence_count: 3,
      sequence_consistency: 1,
    });

    const suppressed = analyzeSkillIntelligence({ ...baseInput, existingSets: [existingSet] });
    expect(suppressed.suggestions).toEqual([]);
  });

  test("infers a project toolkit from skills recurring across separate sessions", () => {
    const observations = [
      observation("frontend", "s1", 0),
      observation("frontend", "s2", 0),
      observation("frontend", "s3", 0),
      observation("database", "s4", 0),
      observation("database", "s5", 0),
      observation("database", "s6", 0),
      observation("frontend", "s7", 0),
      observation("database", "s7", 1),
      observation("frontend", "s8", 0),
      observation("database", "s8", 1),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("frontend", "Build React frontend interfaces."),
        installed("database", "Design SQL database schemas."),
      ],
      observations,
      sessions: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, index) =>
        session(
          id,
          "/tmp/projects/atlas",
          `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 3,
      minAffinity: 0.35,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      pattern: "project",
      name: "Atlas Toolkit",
      project_root: "/tmp/projects/atlas",
      evidence_state: "validated",
      occurrence_count: 5,
      discovery_occurrence_count: 3,
      held_out_occurrence_count: 2,
      held_out_support: 1,
      support: 0.5,
    });
  });

  test("suppresses a discovery pattern that does not recur in the held-out window", () => {
    const observations = [
      ...["s1", "s2", "s3", "s4", "s5", "s6"].flatMap((id) => [
        observation("research", id, 0),
        observation("writing", id, 1),
      ]),
      observation("unrelated", "s7", 0),
      observation("unrelated", "s8", 0),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
        installed("unrelated", "Deploy infrastructure."),
      ],
      observations,
      sessions: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, index) =>
        session(
          id,
          "/tmp/projects/atlas",
          `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 3,
    });

    expect(report.validation).toEqual({
      ready: true,
      discovery_sessions: 6,
      held_out_sessions: 2,
      cutoff_at: "2026-02-07T00:00:00.000Z",
    });
    expect(report.suggestions).toEqual([]);
  });

  test("marks a recurring pattern supported until it reaches the held-out floor", () => {
    const observations = [
      ...["s1", "s2", "s3", "s4", "s5", "s6", "s7"].flatMap((id) => [
        observation("research", id, 0),
        observation("writing", id, 1),
      ]),
      observation("unrelated", "s8", 0),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
        installed("unrelated", "Deploy infrastructure."),
      ],
      observations,
      sessions: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, index) =>
        session(
          id,
          "/tmp/projects/atlas",
          `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 3,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      pattern: "workflow",
      evidence_state: "supported",
      discovery_occurrence_count: 6,
      held_out_occurrence_count: 1,
      held_out_sequence_consistency: 1,
    });
  });

  test("keeps repeated held-out co-usage supported when recent affinity misses the quality floor", () => {
    const discoverySessions = ["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09"];
    const observations = [
      ...discoverySessions.flatMap((id, index) =>
        index % 2 === 0
          ? [observation("research", id, 0), observation("writing", id, 1)]
          : [observation("writing", id, 0), observation("research", id, 1)],
      ),
      observation("research", "s10", 0),
      observation("writing", "s10", 1),
      observation("writing", "s11", 0),
      observation("research", "s11", 1),
      observation("research", "s12", 0),
    ];
    const sessionIds = [...discoverySessions, "s10", "s11", "s12"];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
      ],
      observations,
      sessions: sessionIds.map((id, index) =>
        session(
          id,
          "/tmp/projects/atlas",
          `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 6,
      minAffinity: 0.8,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      pattern: "co_usage",
      evidence_state: "supported",
      held_out_occurrence_count: 2,
      held_out_affinity: 0.667,
    });
    expect(report.suggestions[0]?.reason).toContain("pattern-quality floor");
  });

  test("applies a feedback-calibrated evidence floor only when supplied", () => {
    const observations = [
      observation("research", "s1", 0),
      observation("writing", "s1", 1),
      observation("writing", "s2", 0),
      observation("research", "s2", 1),
      observation("research", "s3", 0),
      observation("writing", "s3", 1),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources and citations."),
        installed("writing", "Write documentation and editorial content."),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
      minEvidenceScore: 0.99,
    });

    expect(report.thresholds.min_evidence_score).toBe(0.99);
    expect(report.suggestions).toEqual([]);
  });

  test("discovers and validates a four-skill community when only its pair graph recurs", () => {
    const discoveryTriangles = [
      ["cloudflare", "domain-model", "cloud-improve-trace"],
      ["wrangler", "domain-model", "cloud-improve-trace"],
    ];
    const heldOutTriangles = discoveryTriangles;
    const observations = [
      ...discoveryTriangles.flatMap((names, triangleIndex) =>
        [0, 1, 2].flatMap((repeat) =>
          names.map((name, order) => observation(name, `d-${triangleIndex}-${repeat}`, order)),
        ),
      ),
      ...heldOutTriangles.flatMap((names, triangleIndex) =>
        [0, 1].flatMap((repeat) =>
          names.map((name, order) => observation(name, `h-${triangleIndex}-${repeat}`, order)),
        ),
      ),
    ];
    const discoveryIds = discoveryTriangles.flatMap((_, triangleIndex) =>
      [0, 1, 2].map((repeat) => `d-${triangleIndex}-${repeat}`),
    );
    const heldOutIds = heldOutTriangles.flatMap((_, triangleIndex) =>
      [0, 1].map((repeat) => `h-${triangleIndex}-${repeat}`),
    );
    const sessionIds = [...discoveryIds, ...heldOutIds];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("cloudflare", "Build on the Cloudflare platform.", "codex", "cloudflare/skills"),
        installed("wrangler", "Operate Wrangler and Workers.", "codex", "cloudflare/skills"),
        installed("domain-model", "Model software domains.", "codex", "mattpocock/skills"),
        installed(
          "cloud-improve-trace",
          "Trace cloud improvement failures.",
          "codex",
          "selftune-dev/selftune",
        ),
      ],
      observations,
      sessions: sessionIds.map((id, index) =>
        session(
          id,
          "/tmp/projects/cloud-app",
          `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
      minOccurrences: 3,
      minAffinity: 0.3,
      holdoutRatio: 0.4,
      minValidationOccurrences: 2,
    });

    const community = report.suggestions.find(
      (suggestion) => suggestion.pattern === "co_usage" && suggestion.skills.length === 4,
    );
    expect(community).toMatchObject({
      name: "Cloudflare Engineering",
      evidence_state: "validated",
      discovery_edge_coverage: 0.833,
      held_out_edge_coverage: 1,
      held_out_occurrence_count: 2,
    });
    expect(community?.reason).toContain("No single session needed to contain the full set");
    expect(community?.skills.every((skill) => skill.membership_score >= 0.5)).toBe(true);
    expect(community?.skills.every((skill) => skill.role.length > 0)).toBe(true);
    expect(community?.skills.map((skill) => skill.source_id)).toContain("cloudflare/skills");
    expect(community?.skills.find((skill) => skill.name === "cloudflare")?.role).toContain(
      "platform architecture",
    );
    expect(community?.skills.find((skill) => skill.name === "wrangler")?.role).toContain(
      "development and deployment operations",
    );
    expect(community?.skills.find((skill) => skill.name === "domain-model")?.role).toContain(
      "domain-boundary modeling",
    );
    expect(community?.skills.find((skill) => skill.name === "cloud-improve-trace")?.role).toContain(
      "failure analysis and debugging",
    );
  });

  test("allows one maximal same-source review community without nested duplicate sets", () => {
    const names = ["thermonuclear-review", "diagnose", "tdd", "codebase-design"];
    const orders = [names, names.toReversed(), [names[1]!, names[3]!, names[0]!, names[2]!]];
    const observations = orders.flatMap((order, orderIndex) =>
      [0, 1].flatMap((repeat) =>
        order.map((name, index) => observation(name, `review-${orderIndex}-${repeat}`, index)),
      ),
    );
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed(
          "thermonuclear-review",
          "Perform rigorous code review.",
          "codex",
          "mattpocock/skills",
        ),
        installed("diagnose", "Diagnose difficult failures.", "codex", "mattpocock/skills"),
        installed("tdd", "Use test driven development.", "codex", "mattpocock/skills"),
        installed("codebase-design", "Review codebase design.", "codex", "mattpocock/skills"),
      ],
      observations,
      sessions: orders.flatMap((_, orderIndex) =>
        [0, 1].map((repeat) => session(`review-${orderIndex}-${repeat}`)),
      ),
      minOccurrences: 3,
      minValidationOccurrences: 20,
    });

    const coUsage = report.suggestions.filter((suggestion) => suggestion.pattern === "co_usage");
    expect(coUsage).toHaveLength(1);
    expect(coUsage[0]).toMatchObject({ name: "High-Rigor Review" });
    expect(coUsage[0]?.skills).toHaveLength(4);
    expect(coUsage[0]?.skills.find((skill) => skill.name === "tdd")?.role).toContain(
      "regression testing",
    );
  });

  test("excludes a weak popular bridge from a strong community", () => {
    const coreIds = Array.from({ length: 6 }, (_, index) => `core-${index}`);
    const genericIds = Array.from({ length: 12 }, (_, index) => `generic-${index}`);
    const orders = [
      ["frontend", "database", "testing"],
      ["frontend", "testing", "database"],
      ["database", "frontend", "testing"],
      ["database", "testing", "frontend"],
      ["testing", "frontend", "database"],
      ["testing", "database", "frontend"],
    ];
    const observations = [
      ...coreIds.flatMap((id, index) => [
        ...orders[index]!.map((name, order) => observation(name, id, order)),
        ...(index < 3 ? [observation("general-helper", id, 3)] : []),
      ]),
      ...genericIds.map((id) => observation("general-helper", id, 0)),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("frontend", "Build frontend software."),
        installed("database", "Design application databases."),
        installed("testing", "Test software quality."),
        installed("general-helper", "Help with general tasks."),
      ],
      observations,
      sessions: [...coreIds, ...genericIds].map((id) => session(id)),
      minOccurrences: 3,
      minAffinity: 0.15,
      minValidationOccurrences: 100,
    });

    const communities = report.suggestions.filter(
      (suggestion) => suggestion.pattern === "co_usage" && suggestion.skills.length >= 3,
    );
    expect(communities).toHaveLength(1);
    expect(communities[0]?.skills.map((skill) => skill.name).toSorted()).toEqual([
      "database",
      "frontend",
      "testing",
    ]);
  });

  test("falls back to an observed pair when no dense community survives", () => {
    const observations = [
      observation("research", "s1", 0),
      observation("writing", "s1", 1),
      observation("writing", "s2", 0),
      observation("research", "s2", 1),
      observation("research", "s3", 0),
      observation("writing", "s3", 1),
    ];
    const report = analyzeSkillIntelligence({
      installedSkills: [
        installed("research", "Research sources."),
        installed("writing", "Write results."),
        installed("deploy", "Deploy software."),
      ],
      observations,
      sessions: [session("s1"), session("s2"), session("s3")],
      minOccurrences: 3,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      pattern: "co_usage",
      discovery_edge_coverage: 1,
    });
    expect(report.suggestions[0]?.skills).toHaveLength(2);
  });
});
