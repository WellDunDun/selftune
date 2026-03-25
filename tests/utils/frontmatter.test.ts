import { describe, expect, test } from "bun:test";

import {
  parseFrontmatter,
  replaceFrontmatterDescription,
} from "../../cli/selftune/utils/frontmatter.js";

describe("parseFrontmatter", () => {
  test("single-line description", () => {
    const content = `---
name: seo-audit
description: When the user wants to audit SEO
---

# seo-audit

Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("seo-audit");
    expect(result.description).toBe("When the user wants to audit SEO");
    expect(result.version).toBe("");
    expect(result.body).toContain("# seo-audit");
    expect(result.body).toContain("Body content here.");
  });

  test("multi-line folded scalar description", () => {
    const content = `---
name: selftune
description: >
  Skill observability and continuous improvement. Use when the user wants to:
  grade a session, generate evals, check undertriggering, evolve a skill.
---

# selftune

Observe real agent sessions.`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("selftune");
    expect(result.description).toBe(
      "Skill observability and continuous improvement. Use when the user wants to: grade a session, generate evals, check undertriggering, evolve a skill.",
    );
    expect(result.body).toContain("# selftune");
  });

  test("nested metadata.version", () => {
    const content = `---
name: seo-audit
description: SEO auditing skill
metadata:
  version: 1.1.0
---

# seo-audit`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("seo-audit");
    expect(result.description).toBe("SEO auditing skill");
    expect(result.version).toBe("1.1.0");
  });

  test("top-level version", () => {
    const content = `---
name: test-skill
description: A test skill
version: 2.0.0
---

# test-skill`;

    const result = parseFrontmatter(content);
    expect(result.version).toBe("2.0.0");
  });

  test("no frontmatter returns full content as description", () => {
    const content = `# My Skill

This is a skill without frontmatter.`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("");
    expect(result.description).toBe(content);
    expect(result.version).toBe("");
    expect(result.body).toBe(content);
  });

  test("description stops before version/metadata lines", () => {
    const content = `---
name: mixed
description: >
  A skill that does things.
version: 3.0.0
metadata:
  version: 3.0.0
---

# mixed`;

    const result = parseFrontmatter(content);
    expect(result.description).toBe("A skill that does things.");
    // Top-level version takes precedence (parsed first)
    expect(result.version).toBe("3.0.0");
  });

  test("unclosed frontmatter returns full content", () => {
    const content = `---
name: broken
description: This frontmatter never closes

# broken`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("");
    expect(result.description).toBe(content);
  });

  test("literal scalar (pipe) description", () => {
    const content = `---
name: pipe-test
description: |
  Line one of the description.
  Line two of the description.
---

# pipe-test`;

    const result = parseFrontmatter(content);
    expect(result.description).toBe("Line one of the description. Line two of the description.");
  });

  test("real-world selftune SKILL.md frontmatter", () => {
    // This test also serves as a baseline for replaceFrontmatterDescription below
    const content = `---
name: selftune
description: >
  Skill observability and continuous improvement. Use when the user wants to:
  grade a session, generate evals, check undertriggering, evolve a skill
  description or full body, evolve routing tables, rollback an evolution,
  monitor post-deploy performance, check skill health status, view last
  session insight, open the dashboard, serve the live dashboard, run health
  checks, manage activation rules, ingest sessions from Codex/OpenCode/OpenClaw,
  replay Claude Code transcripts, contribute anonymized data to the community,
  set up autonomous cron jobs, manage evolution memory, configure auto-activation
  suggestions, diagnose underperforming skills, analyze cross-skill patterns,
  review evolution proposals, measure baseline lift, run skill unit tests,
  analyze skill composability, or import SkillsBench evaluation corpora.
---

# selftune

Observe real agent sessions.`;

    const result = parseFrontmatter(content);
    expect(result.name).toBe("selftune");
    expect(result.description).toContain("Skill observability");
    expect(result.description).toContain("SkillsBench evaluation corpora.");
    // Should NOT contain the full file content (~400 chars, not thousands)
    expect(result.description.length).toBeLessThan(1000);
    expect(result.body).toContain("# selftune");
  });
});

describe("replaceFrontmatterDescription", () => {
  test("replaces single-line description", () => {
    const content = `---
name: seo-audit
description: Old description
metadata:
  version: 1.0.0
---

# SEO Audit

Body content.`;

    const result = replaceFrontmatterDescription(content, "New improved description");
    expect(result).toContain("description: New improved description");
    expect(result).not.toContain("Old description");
    expect(result).toContain("name: seo-audit");
    expect(result).toContain("version: 1.0.0");
    expect(result).toContain("# SEO Audit");
    expect(result).toContain("Body content.");
  });

  test("replaces folded scalar description", () => {
    const content = `---
name: test
description: >
  This is a long folded
  description that spans multiple lines.
metadata:
  version: 2.0.0
---

# Test`;

    const result = replaceFrontmatterDescription(content, "Short new desc");
    expect(result).toContain("description: Short new desc");
    expect(result).not.toContain("long folded");
    expect(result).toContain("version: 2.0.0");
  });

  test("uses folded scalar for long descriptions", () => {
    const longDesc =
      "When the user wants to audit SEO issues including technical SEO, on-page optimization, core web vitals, crawl errors, indexing problems, and ranking drops.";
    const content = `---
name: seo-audit
description: Short
---

# SEO Audit`;

    const result = replaceFrontmatterDescription(content, longDesc);
    expect(result).toContain("description: >");
    expect(result).toContain("audit SEO issues");
  });

  test("preserves content when no frontmatter exists", () => {
    const content = `# No Frontmatter

Just body.`;
    const result = replaceFrontmatterDescription(content, "New desc");
    expect(result).toBe(content);
  });

  test("round-trips: parse after replace returns new description", () => {
    const content = `---
name: seo-audit
description: Original description here
metadata:
  version: 1.1.0
---

# SEO Audit

Body.`;

    const newDesc = "Updated trigger description for SEO auditing";
    const updated = replaceFrontmatterDescription(content, newDesc);
    const parsed = parseFrontmatter(updated);
    expect(parsed.description).toBe(newDesc);
    expect(parsed.name).toBe("seo-audit");
    expect(parsed.version).toBe("1.1.0");
  });
});
