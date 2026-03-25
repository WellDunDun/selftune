import { describe, expect, test } from "bun:test";

import type { CodifiedWorkflow } from "../../cli/selftune/types.js";
import {
  appendWorkflow,
  parseWorkflowsSection,
  removeWorkflow,
} from "../../cli/selftune/workflows/skill-md-writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_MD_WITH_WORKFLOWS = `---
name: selftune
description: Skill observability
---

# selftune

Body content here.

## Workflows

### Blog Publishing
- **Skills:** Copywriting \u2192 MarketingAutomation \u2192 SelfTuneBlog
- **Trigger:** User asks to write and publish a blog post
- **Source:** Discovered from 12 sessions (synergy: 0.72)

### Code Review
- **Skills:** Linting \u2192 Testing \u2192 Review
- **Trigger:** User asks for a code review
- **Source:** authored

## Another Section

More content here.
`;

const SKILL_MD_WITHOUT_WORKFLOWS = `---
name: selftune
description: Skill observability
---

# selftune

Body content here.
`;

const DISCOVERED_WORKFLOW: CodifiedWorkflow = {
  name: "Blog Publishing",
  skills: ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
  description: "User asks to write and publish a blog post",
  source: "discovered",
  discovered_from: {
    workflow_id: "Copywriting\u2192MarketingAutomation\u2192SelfTuneBlog",
    occurrence_count: 12,
    synergy_score: 0.72,
  },
};

const AUTHORED_WORKFLOW: CodifiedWorkflow = {
  name: "Deploy Pipeline",
  skills: ["Build", "Test", "Deploy"],
  description: "User asks to deploy to production",
  source: "authored",
};

// ---------------------------------------------------------------------------
// parseWorkflowsSection
// ---------------------------------------------------------------------------

describe("parseWorkflowsSection", () => {
  test("empty content returns []", () => {
    expect(parseWorkflowsSection("")).toEqual([]);
  });

  test("content without ## Workflows section returns []", () => {
    expect(parseWorkflowsSection(SKILL_MD_WITHOUT_WORKFLOWS)).toEqual([]);
  });

  test("parses existing workflows correctly", () => {
    const workflows = parseWorkflowsSection(SKILL_MD_WITH_WORKFLOWS);
    expect(workflows).toHaveLength(2);

    expect(workflows[0].name).toBe("Blog Publishing");
    expect(workflows[0].skills).toEqual(["Copywriting", "MarketingAutomation", "SelfTuneBlog"]);
    expect(workflows[0].description).toBe("User asks to write and publish a blog post");
    expect(workflows[0].source).toBe("discovered");
    expect(workflows[0].discovered_from?.occurrence_count).toBe(12);
    expect(workflows[0].discovered_from?.synergy_score).toBe(0.72);
  });

  test("multiple workflows parsed in order", () => {
    const workflows = parseWorkflowsSection(SKILL_MD_WITH_WORKFLOWS);
    expect(workflows[0].name).toBe("Blog Publishing");
    expect(workflows[1].name).toBe("Code Review");
  });

  test("authored source parsed correctly", () => {
    const workflows = parseWorkflowsSection(SKILL_MD_WITH_WORKFLOWS);
    expect(workflows[1].source).toBe("authored");
    expect(workflows[1].discovered_from).toBeUndefined();
  });

  test("parses discovered workflows with negative synergy", () => {
    const negativeSynergy = `## Workflows

### Incident Review
- **Skills:** Debugging \u2192 Postmortem
- **Source:** Discovered from 4 sessions (synergy: -0.45)
`;
    const workflows = parseWorkflowsSection(negativeSynergy);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].source).toBe("discovered");
    expect(workflows[0].discovered_from?.synergy_score).toBe(-0.45);
  });

  test("malformed content handled gracefully", () => {
    const malformed = `## Workflows

### Broken
- **Skills:**
- not a valid line
some random text

### Valid
- **Skills:** A \u2192 B
- **Trigger:** Do things
- **Source:** authored
`;
    const workflows = parseWorkflowsSection(malformed);
    expect(workflows).toHaveLength(2);
    expect(workflows[0].name).toBe("Broken");
    expect(workflows[0].skills).toEqual([]);
    expect(workflows[1].name).toBe("Valid");
    expect(workflows[1].skills).toEqual(["A", "B"]);
  });

  test("stops parsing at next ## heading", () => {
    const content = `## Workflows

### W1
- **Skills:** A \u2192 B
- **Trigger:** Do A then B
- **Source:** authored

## Not Workflows

### NotAWorkflow
- **Skills:** C \u2192 D
- **Trigger:** Something else
- **Source:** authored
`;
    const workflows = parseWorkflowsSection(content);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe("W1");
  });
});

// ---------------------------------------------------------------------------
// appendWorkflow
// ---------------------------------------------------------------------------

describe("appendWorkflow", () => {
  test("append to empty file (no ## Workflows section)", () => {
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, AUTHORED_WORKFLOW);
    expect(result).toContain("## Workflows");
    expect(result).toContain("### Deploy Pipeline");
    expect(result).toContain("- **Skills:** Build \u2192 Test \u2192 Deploy");
    expect(result).toContain("- **Trigger:** User asks to deploy to production");
    expect(result).toContain("- **Source:** authored");
  });

  test("append to file with existing ## Workflows section", () => {
    const result = appendWorkflow(SKILL_MD_WITH_WORKFLOWS, AUTHORED_WORKFLOW);
    expect(result).toContain("### Deploy Pipeline");
    expect(result).toContain("### Blog Publishing");
    expect(result).toContain("### Code Review");
    // Should still have the section after workflows
    expect(result).toContain("## Another Section");
  });

  test("append to file with existing workflows (adds after last)", () => {
    const result = appendWorkflow(SKILL_MD_WITH_WORKFLOWS, AUTHORED_WORKFLOW);
    const lines = result.split("\n");
    const deployIdx = lines.findIndex((l) => l.includes("### Deploy Pipeline"));
    const anotherIdx = lines.findIndex((l) => l.includes("## Another Section"));
    expect(deployIdx).toBeGreaterThan(0);
    expect(anotherIdx).toBeGreaterThan(deployIdx);
  });

  test("duplicate name detection - returns unchanged", () => {
    const result = appendWorkflow(SKILL_MD_WITH_WORKFLOWS, {
      ...AUTHORED_WORKFLOW,
      name: "Blog Publishing", // already exists
    });
    expect(result).toBe(SKILL_MD_WITH_WORKFLOWS);
  });

  test("format verification - discovered source format", () => {
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, DISCOVERED_WORKFLOW);
    expect(result).toContain("- **Source:** Discovered from 12 sessions (synergy: 0.72)");
  });

  test("format verification - authored source format", () => {
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, AUTHORED_WORKFLOW);
    expect(result).toContain("- **Source:** authored");
  });

  test("format verification - output matches expected markdown format", () => {
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, DISCOVERED_WORKFLOW);
    // Should contain the full formatted subsection
    expect(result).toContain("### Blog Publishing");
    expect(result).toContain(
      "- **Skills:** Copywriting \u2192 MarketingAutomation \u2192 SelfTuneBlog",
    );
    expect(result).toContain("- **Trigger:** User asks to write and publish a blog post");
  });

  test("workflow without description omits trigger line", () => {
    const noDesc: CodifiedWorkflow = {
      name: "Minimal",
      skills: ["A", "B"],
      source: "authored",
    };
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, noDesc);
    expect(result).toContain("### Minimal");
    expect(result).toContain("- **Skills:** A \u2192 B");
    expect(result).not.toContain("- **Trigger:**");
    expect(result).toContain("- **Source:** authored");
  });
});

// ---------------------------------------------------------------------------
// removeWorkflow
// ---------------------------------------------------------------------------

describe("removeWorkflow", () => {
  test("removes existing workflow", () => {
    const result = removeWorkflow(SKILL_MD_WITH_WORKFLOWS, "Blog Publishing");
    expect(result).not.toContain("### Blog Publishing");
    expect(result).not.toContain("Copywriting");
    // Other workflow should remain
    expect(result).toContain("### Code Review");
    expect(result).toContain("## Workflows");
  });

  test("returns unchanged if workflow not found", () => {
    const result = removeWorkflow(SKILL_MD_WITH_WORKFLOWS, "Nonexistent");
    expect(result).toBe(SKILL_MD_WITH_WORKFLOWS);
  });

  test("removes section heading if last workflow removed", () => {
    // First remove Blog Publishing, then remove Code Review
    const afterFirst = removeWorkflow(SKILL_MD_WITH_WORKFLOWS, "Blog Publishing");
    const afterSecond = removeWorkflow(afterFirst, "Code Review");
    expect(afterSecond).not.toContain("## Workflows");
    // Rest of document preserved
    expect(afterSecond).toContain("# selftune");
    expect(afterSecond).toContain("## Another Section");
  });

  test("returns unchanged if no ## Workflows section", () => {
    const result = removeWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, "Anything");
    expect(result).toBe(SKILL_MD_WITHOUT_WORKFLOWS);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("append then parse returns same data", () => {
    const result = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, DISCOVERED_WORKFLOW);
    const parsed = parseWorkflowsSection(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe(DISCOVERED_WORKFLOW.name);
    expect(parsed[0].skills).toEqual(DISCOVERED_WORKFLOW.skills);
    expect(parsed[0].description).toBe(DISCOVERED_WORKFLOW.description);
    expect(parsed[0].source).toBe("discovered");
    expect(parsed[0].discovered_from?.occurrence_count).toBe(12);
    expect(parsed[0].discovered_from?.synergy_score).toBe(0.72);
  });

  test("append multiple then parse returns all in order", () => {
    let content = SKILL_MD_WITHOUT_WORKFLOWS;
    content = appendWorkflow(content, DISCOVERED_WORKFLOW);
    content = appendWorkflow(content, AUTHORED_WORKFLOW);

    const parsed = parseWorkflowsSection(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Blog Publishing");
    expect(parsed[1].name).toBe("Deploy Pipeline");
  });

  test("append then remove then parse returns empty", () => {
    let content = appendWorkflow(SKILL_MD_WITHOUT_WORKFLOWS, AUTHORED_WORKFLOW);
    content = removeWorkflow(content, "Deploy Pipeline");
    const parsed = parseWorkflowsSection(content);
    expect(parsed).toEqual([]);
  });
});
