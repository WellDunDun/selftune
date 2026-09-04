import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  handleSkillRegistryRequest,
  LocalSkillRegistry,
  parseSkillFrontmatter,
} from "../../packages/runtime/mcp/skill-registry.js";

const root = join(import.meta.dir, ".tmp-skill-registry");

describe("MCP skill registry", () => {
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "research", "references"), { recursive: true });
    writeFileSync(
      join(root, "research", "SKILL.md"),
      `---\nname: research\ndescription: >\n  Investigate questions against primary sources.\nversion: 1.2.3\nmetadata:\n  owner: selftune\n---\n# Research\n\nUse primary sources.\n`,
    );
    writeFileSync(join(root, "research", "references", "quality.md"), "Check evidence.\n");
    writeFileSync(join(root, "research", ".env"), "SECRET=never-serve-this\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("parses all top-level frontmatter entries", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: demo\ndescription: hello\nversion: 2\nenabled: true\n---\n",
      ),
    ).toEqual({ name: "demo", description: "hello", version: 2, enabled: true });
  });

  test("serves the OpenAI Skills-over-MCP subset", () => {
    const registry = new LocalSkillRegistry({ searchDirs: [root], pageSize: 1 });
    const initialize = handleSkillRegistryRequest(registry, { id: 1, method: "initialize" });
    expect(initialize?.result).toMatchObject({
      capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } },
    });
    const listed = handleSkillRegistryRequest(registry, {
      id: 2,
      method: "skills/list",
      params: {},
    });
    const result = listed?.result as { skills: McpListedSkill[] };
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0];
    expect(skill.uri).toMatch(/^skill:\/\/selftune\/[a-f0-9]{64}\/research\/SKILL\.md$/);
    expect(skill.frontmatter).toMatchObject({
      name: "research",
      description: "Investigate questions against primary sources.",
      version: "1.2.3",
      metadata: { owner: "selftune" },
    });
    expect(skill.resources).toHaveLength(2);
    expect(skill.resources.every((resource) => /^sha256:[a-f0-9]{64}$/.test(resource.digest))).toBe(
      true,
    );
    expect(
      handleSkillRegistryRequest(registry, {
        id: 3,
        method: "skills/get",
        params: { uri: skill.uri },
      })?.result,
    ).toEqual({ skill });
    expect(
      handleSkillRegistryRequest(registry, {
        id: 4,
        method: "resources/read",
        params: { uri: skill.uri },
      })?.result,
    ).toMatchObject({
      contents: [{ uri: skill.uri, text: expect.stringContaining("Use primary sources") }],
    });

    writeFileSync(join(root, "research", "SKILL.md"), "changed after indexing");
    expect(
      handleSkillRegistryRequest(registry, {
        id: 5,
        method: "resources/read",
        params: { uri: skill.uri },
      })?.result,
    ).toMatchObject({ contents: [{ text: expect.stringContaining("Use primary sources") }] });
  });

  test("searches metadata and loads an immutable revision", () => {
    const registry = new LocalSkillRegistry({ searchDirs: [root] });
    const search = handleSkillRegistryRequest(registry, {
      id: 1,
      method: "tools/call",
      params: { name: "search_skills", arguments: { query: "primary source investigation" } },
    });
    const found = search?.result as { structuredContent: { results: Array<{ uri: string }> } };
    expect(found.structuredContent.results).toHaveLength(1);
    const load = handleSkillRegistryRequest(registry, {
      id: 2,
      method: "tools/call",
      params: { name: "load_skill", arguments: { uri: found.structuredContent.results[0].uri } },
    });
    expect(load?.error).toBeUndefined();
    expect(load?.result).toMatchObject({
      structuredContent: { contents: [{ text: expect.stringContaining("Use primary sources") }] },
    });
  });

  test("skips packages that exceed the bounded resource manifest", () => {
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(root, "research", `resource-${index}.txt`), String(index));
    }
    const registry = new LocalSkillRegistry({ searchDirs: [root] });
    expect(registry.list().skills).toEqual([]);
  });
});

interface McpListedSkill {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string }>;
}
