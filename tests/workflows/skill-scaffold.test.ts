import { describe, expect, it } from "bun:test";

import type { DiscoveredWorkflow } from "../../cli/selftune/types.js";
import {
  buildWorkflowSkillDescription,
  buildWorkflowSkillDraft,
  formatWorkflowSkillDraft,
  getDefaultWorkflowSkillOutputDir,
  slugifyWorkflowSkillName,
} from "../../cli/selftune/workflows/skill-scaffold.js";

function makeWorkflow(overrides: Partial<DiscoveredWorkflow> = {}): DiscoveredWorkflow {
  return {
    workflow_id: "Copywriting→MarketingAutomation→SelfTuneBlog",
    skills: ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
    occurrence_count: 12,
    avg_errors: 0.5,
    avg_errors_individual: 1.2,
    synergy_score: 0.72,
    representative_query: "write and publish a blog post",
    sequence_consistency: 0.92,
    completion_rate: 0.83,
    first_seen: "2025-01-01T00:00:00Z",
    last_seen: "2025-01-03T00:00:00Z",
    session_ids: ["s1", "s2", "s3"],
    ...overrides,
  };
}

describe("workflow skill scaffolding", () => {
  it("slugifies workflow skill names for filesystem-safe paths", () => {
    expect(slugifyWorkflowSkillName("Write Publish Blog Post")).toBe("write-publish-blog-post");
    expect(slugifyWorkflowSkillName("Marketing / Launch!")).toBe("marketing-launch");
  });

  it("derives a workflow-aware description when none is provided", () => {
    const description = buildWorkflowSkillDescription(makeWorkflow());
    expect(description).toContain("write and publish a blog post");
    expect(description).toContain("Copywriting, MarketingAutomation, and SelfTuneBlog");
  });

  it("uses the repository skill registry root by default", () => {
    const outputDir = getDefaultWorkflowSkillOutputDir("/tmp/example-repo");
    expect(outputDir).toBe("/tmp/example-repo/.agents/skills");
  });

  it("builds a draft with provenance and a SKILL.md path", () => {
    const draft = buildWorkflowSkillDraft(makeWorkflow(), {
      outputDir: "/tmp/repo/.agents/skills",
    });

    expect(draft.skill_name).toBe("write-publish-blog-post");
    expect(draft.skill_path).toBe("/tmp/repo/.agents/skills/write-publish-blog-post/SKILL.md");
    expect(draft.content).toContain("generated_by: selftune workflows scaffold");
    expect(draft.content).toContain(
      "source_workflow_id: Copywriting→MarketingAutomation→SelfTuneBlog",
    );
    expect(draft.content).toContain(
      "- **Skills:** Copywriting → MarketingAutomation → SelfTuneBlog",
    );
    expect(draft.content).toContain("- **Source:** Discovered from 12 sessions (synergy: 0.72)");
  });

  it("respects explicit skill name and description overrides", () => {
    const draft = buildWorkflowSkillDraft(makeWorkflow(), {
      outputDir: "/tmp/repo/.agents/skills",
      skillName: "Blog Publisher",
      description: "Use when publishing polished blog content end-to-end.",
    });

    expect(draft.skill_name).toBe("blog-publisher");
    expect(draft.title).toBe("Blog Publisher");
    expect(draft.description).toBe("Use when publishing polished blog content end-to-end.");
    expect(draft.content).toContain("name: blog-publisher");
    expect(draft.content).toContain("Use when publishing polished blog content end-to-end.");
  });

  it("formats the preview with metadata and full content", () => {
    const draft = buildWorkflowSkillDraft(makeWorkflow(), {
      outputDir: "/tmp/repo/.agents/skills",
    });
    const formatted = formatWorkflowSkillDraft(draft);

    expect(formatted).toContain("Draft workflow skill: Write Publish Blog Post");
    expect(formatted).toContain("Source workflow: Copywriting→MarketingAutomation→SelfTuneBlog");
    expect(formatted).toContain('Representative query: "write and publish a blog post"');
    expect(formatted).toContain("## Execution Plan");
  });
});
