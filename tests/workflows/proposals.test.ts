import { describe, expect, it } from "bun:test";

import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";
import {
  discoverWorkflowSkillProposals,
  persistWorkflowSkillProposal,
} from "../../cli/selftune/workflows/proposals.js";

function makeSession(
  id: string,
  skills: string[],
  errors: number,
  timestamp: string,
): SessionTelemetryRecord {
  return {
    timestamp,
    session_id: id,
    cwd: "/tmp",
    transcript_path: `/tmp/${id}.jsonl`,
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: skills,
    assistant_turns: 1,
    errors_encountered: errors,
    transcript_chars: 100,
    last_user_query: "test",
  };
}

function makeUsage(overrides: Partial<SkillUsageRecord>): SkillUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "s1",
    skill_name: "Copywriting",
    skill_path: "/skills/copywriting/SKILL.md",
    query: "write and publish a blog post",
    triggered: true,
    ...overrides,
  };
}

describe("workflow skill proposals", () => {
  const telemetry = [
    makeSession(
      "s1",
      ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      0,
      "2025-01-01T00:00:00Z",
    ),
    makeSession(
      "s2",
      ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      0,
      "2025-01-02T00:00:00Z",
    ),
    makeSession(
      "s3",
      ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      0,
      "2025-01-03T00:00:00Z",
    ),
  ];

  const usage = [
    makeUsage({ session_id: "s1", timestamp: "2025-01-01T00:00:00Z" }),
    makeUsage({
      session_id: "s1",
      skill_name: "MarketingAutomation",
      skill_path: "/skills/marketing/SKILL.md",
      timestamp: "2025-01-01T00:01:00Z",
    }),
    makeUsage({
      session_id: "s1",
      skill_name: "SelfTuneBlog",
      skill_path: "/skills/selftuneblog/SKILL.md",
      timestamp: "2025-01-01T00:02:00Z",
    }),
    makeUsage({ session_id: "s2", timestamp: "2025-01-02T00:00:00Z" }),
    makeUsage({
      session_id: "s2",
      skill_name: "MarketingAutomation",
      skill_path: "/skills/marketing/SKILL.md",
      timestamp: "2025-01-02T00:01:00Z",
    }),
    makeUsage({
      session_id: "s2",
      skill_name: "SelfTuneBlog",
      skill_path: "/skills/selftuneblog/SKILL.md",
      timestamp: "2025-01-02T00:02:00Z",
    }),
    makeUsage({ session_id: "s3", timestamp: "2025-01-03T00:00:00Z" }),
    makeUsage({
      session_id: "s3",
      skill_name: "MarketingAutomation",
      skill_path: "/skills/marketing/SKILL.md",
      timestamp: "2025-01-03T00:01:00Z",
    }),
    makeUsage({
      session_id: "s3",
      skill_name: "SelfTuneBlog",
      skill_path: "/skills/selftuneblog/SKILL.md",
      timestamp: "2025-01-03T00:02:00Z",
    }),
  ];

  it("discovers strong workflow-skill proposals from repeated workflows", () => {
    const proposals = discoverWorkflowSkillProposals(telemetry, usage, {
      cwd: "/tmp/repo",
      resolveSkillPath: () => undefined,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].source_skill_name).toBe("Copywriting");
    expect(proposals[0].draft.skill_name).toBe("write-publish-blog-post");
    expect(proposals[0].current_value).toContain("No dedicated workflow skill exists");
    expect(proposals[0].proposed_value).toContain("Create write-publish-blog-post");
    expect(proposals[0].confidence).toBeGreaterThan(0.7);
  });

  it("skips proposals that already exist or already have a skill path", () => {
    const first = discoverWorkflowSkillProposals(telemetry, usage, {
      cwd: "/tmp/repo",
      resolveSkillPath: () => undefined,
    })[0];
    const existingAuditEntries: EvolutionAuditEntry[] = [
      {
        timestamp: new Date().toISOString(),
        proposal_id: first.proposal_id,
        skill_name: first.source_skill_name,
        action: "created",
        details: first.summary,
      },
    ];

    expect(
      discoverWorkflowSkillProposals(telemetry, usage, {
        cwd: "/tmp/repo",
        resolveSkillPath: () => undefined,
        existingAuditEntries,
      }),
    ).toHaveLength(0);

    expect(
      discoverWorkflowSkillProposals(telemetry, usage, {
        cwd: "/tmp/repo",
        resolveSkillPath: (skillName) =>
          skillName === "write-publish-blog-post" ? "/skills/existing/SKILL.md" : undefined,
      }),
    ).toHaveLength(0);
  });

  it("persists audit and evidence entries for a proposal", () => {
    const proposal = discoverWorkflowSkillProposals(telemetry, usage, {
      cwd: "/tmp/repo",
      resolveSkillPath: () => undefined,
    })[0];

    const auditEntries: EvolutionAuditEntry[] = [];
    const evidenceEntries: EvolutionEvidenceEntry[] = [];

    persistWorkflowSkillProposal(proposal, {
      now: new Date("2026-01-01T00:00:00Z"),
      sourceSkillPath: "/skills/copywriting/SKILL.md",
      appendAudit: (entry) => auditEntries.push(entry),
      appendEvidence: (entry) => evidenceEntries.push(entry),
    });

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].action).toBe("created");
    expect(auditEntries[0].skill_name).toBe("Copywriting");

    expect(evidenceEntries).toHaveLength(1);
    expect(evidenceEntries[0].target).toBe("new_skill");
    expect(evidenceEntries[0].stage).toBe("proposed");
    expect(evidenceEntries[0].skill_name).toBe("Copywriting");
    expect(evidenceEntries[0].proposed_text).toBe(proposal.draft.content);
  });
});
