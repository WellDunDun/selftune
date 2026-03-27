/**
 * Tests for evolution deploy-proposal SKILL.md manipulation utilities.
 *
 * Verifies description replacement, structured section parsing,
 * section replacement, and full body replacement.
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

const {
  replaceDescription,
  parseSkillSections,
  replaceSection,
  replaceBody,
} = await import("../../cli/selftune/evolution/deploy-proposal.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `# My Skill

This is the original skill description that explains
what the skill does and when it should be triggered.

## Configuration

Some config details here.

## Examples

- Example 1
- Example 2
`;

const SAMPLE_SKILL_MD_NO_H2 = `# My Skill

This is the entire file description with no sub-headings.
`;

const SAMPLE_WITH_FRONTMATTER = `---
name: test-skill
version: 1.0
---

# My Skill

This is the skill description.

## Workflow Routing

Route to this skill when...

## Examples

- Example 1
- Example 2
`;

// ---------------------------------------------------------------------------
// replaceDescription
// ---------------------------------------------------------------------------

describe("replaceDescription", () => {
  test("replaces description between first heading and first ## heading", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "New improved description.");

    expect(result).toContain("# My Skill");
    expect(result).toContain("New improved description.");
    expect(result).toContain("## Configuration");
    expect(result).toContain("## Examples");
    expect(result).not.toContain("original skill description");
  });

  test("preserves the first heading exactly", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "Updated desc.");
    const lines = result.split("\n");
    expect(lines[0]).toBe("# My Skill");
  });

  test("preserves everything after the first ## heading", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "New desc.");

    // Everything from ## Configuration onward should be unchanged
    const configIndex = result.indexOf("## Configuration");
    expect(configIndex).toBeGreaterThan(0);
    const afterConfig = result.slice(configIndex);
    const originalAfterConfig = SAMPLE_SKILL_MD.slice(SAMPLE_SKILL_MD.indexOf("## Configuration"));
    expect(afterConfig).toBe(originalAfterConfig);
  });

  test("handles SKILL.md with no ## sub-headings (replaces entire body)", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD_NO_H2, "Replaced everything.");

    expect(result).toContain("# My Skill");
    expect(result).toContain("Replaced everything.");
    expect(result).not.toContain("entire file description");
  });

  test("handles empty description replacement", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "");

    expect(result).toContain("# My Skill");
    expect(result).toContain("## Configuration");
  });
});

// ---------------------------------------------------------------------------
// parseSkillSections
// ---------------------------------------------------------------------------

describe("parseSkillSections", () => {
  test("parses title from SKILL.md", () => {
    const result = parseSkillSections(SAMPLE_SKILL_MD);
    expect(result.title).toBe("# My Skill");
  });

  test("parses description between title and first ## heading", () => {
    const result = parseSkillSections(SAMPLE_SKILL_MD);
    expect(result.description).toContain("original skill description");
  });

  test("parses named sections", () => {
    const result = parseSkillSections(SAMPLE_SKILL_MD);
    expect(result.sections).toHaveProperty("Configuration");
    expect(result.sections).toHaveProperty("Examples");
    expect(result.sections.Configuration).toContain("Some config details");
  });

  test("parses frontmatter when present", () => {
    const result = parseSkillSections(SAMPLE_WITH_FRONTMATTER);
    expect(result.frontmatter).toContain("name: test-skill");
    expect(result.frontmatter).toContain("---");
  });

  test("has empty frontmatter when not present", () => {
    const result = parseSkillSections(SAMPLE_SKILL_MD);
    expect(result.frontmatter).toBe("");
  });

  test("handles file with no ## sub-headings", () => {
    const result = parseSkillSections(SAMPLE_SKILL_MD_NO_H2);
    expect(result.title).toBe("# My Skill");
    expect(result.description).toContain("entire file description");
    expect(Object.keys(result.sections)).toHaveLength(0);
  });

  test("handles file with frontmatter and multiple sections", () => {
    const result = parseSkillSections(SAMPLE_WITH_FRONTMATTER);
    expect(result.title).toBe("# My Skill");
    expect(result.description).toBe("This is the skill description.");
    expect(result.sections).toHaveProperty("Workflow Routing");
    expect(result.sections).toHaveProperty("Examples");
  });
});

// ---------------------------------------------------------------------------
// replaceSection
// ---------------------------------------------------------------------------

describe("replaceSection", () => {
  test("replaces an existing section by name", () => {
    const result = replaceSection(SAMPLE_SKILL_MD, "Configuration", "New config content.");
    expect(result).toContain("## Configuration");
    expect(result).toContain("New config content.");
    expect(result).not.toContain("Some config details here.");
  });

  test("preserves other sections when replacing one", () => {
    const result = replaceSection(SAMPLE_SKILL_MD, "Configuration", "New config.");
    expect(result).toContain("## Examples");
    expect(result).toContain("Example 1");
  });

  test("appends section if it does not exist", () => {
    const result = replaceSection(SAMPLE_SKILL_MD, "New Section", "Brand new content.");
    expect(result).toContain("## New Section");
    expect(result).toContain("Brand new content.");
    // Original content preserved
    expect(result).toContain("## Configuration");
    expect(result).toContain("## Examples");
  });

  test("preserves the title and description", () => {
    const result = replaceSection(SAMPLE_SKILL_MD, "Configuration", "Updated.");
    expect(result).toContain("# My Skill");
    expect(result).toContain("original skill description");
  });
});

// ---------------------------------------------------------------------------
// replaceBody
// ---------------------------------------------------------------------------

describe("replaceBody", () => {
  test("replaces body while preserving title", () => {
    const result = replaceBody(
      SAMPLE_SKILL_MD,
      "Completely new body content.\n\n## New Section\n\nDetails here.",
    );
    expect(result).toContain("# My Skill");
    expect(result).toContain("Completely new body content.");
    expect(result).not.toContain("original skill description");
    expect(result).not.toContain("## Configuration");
  });

  test("preserves frontmatter when present", () => {
    const result = replaceBody(SAMPLE_WITH_FRONTMATTER, "New body.");
    expect(result).toContain("---");
    expect(result).toContain("name: test-skill");
    expect(result).toContain("# My Skill");
    expect(result).toContain("New body.");
    expect(result).not.toContain("## Workflow Routing");
  });

  test("result ends with single newline", () => {
    const result = replaceBody(SAMPLE_SKILL_MD, "Simple body.");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });
});
