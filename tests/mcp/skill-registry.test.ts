import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import {
  handleSkillRegistryRequest,
  handleSkillRegistryLine,
  LocalSkillRegistry,
  McpSkillEntry,
  parseSkillFrontmatter,
} from "../../packages/runtime/mcp/skill-registry.js";

let root: string;
const decodeList = Schema.decodeUnknownSync(Schema.Struct({ skills: Schema.Array(McpSkillEntry) }));
const decodeSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    structuredContent: Schema.Struct({
      results: Schema.Array(Schema.Struct({ uri: Schema.String })),
    }),
  }),
);

describe("MCP skill registry", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "selftune-mcp-registry-"));
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
    const result = decodeList(listed?.result);
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
    const found = decodeSearch(search?.result);
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

  test("distinguishes invalid JSON, invalid envelopes, and notifications", () => {
    const registry = new LocalSkillRegistry({ searchDirs: [root] });
    expect(handleSkillRegistryLine(registry, "{broken")?.error?.code).toBe(-32700);
    for (const line of [
      "null",
      "[]",
      "42",
      '{"id":1}',
      '{"id":{},"method":"ping"}',
      '{"jsonrpc":"1.0","id":1,"method":"ping"}',
    ]) {
      expect(handleSkillRegistryLine(registry, line)?.error?.code).toBe(-32600);
    }
    expect(
      handleSkillRegistryLine(registry, '{"method":"notifications/initialized"}'),
    ).toBeUndefined();
    expect(handleSkillRegistryLine(registry, '{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  test("rejects malformed search arguments without crashing the request stream", () => {
    const registry = new LocalSkillRegistry({ searchDirs: [root] });
    for (const args of [
      { query: 42 },
      { query: "   " },
      { query: "research", limit: "5" },
      { query: "research", limit: 1.5 },
      { query: "research", limit: 0 },
      { query: "research", limit: 21 },
    ]) {
      const response = handleSkillRegistryLine(
        registry,
        JSON.stringify({
          id: "search",
          method: "tools/call",
          params: { name: "search_skills", arguments: args },
        }),
      );
      expect(response?.error?.code).toBe(-32602);
    }
    const response = handleSkillRegistryLine(
      registry,
      JSON.stringify({
        id: "valid",
        method: "tools/call",
        params: { name: "search_skills", arguments: { query: "research", limit: 1 } },
      }),
    );
    expect(decodeSearch(response?.result).structuredContent.results).toHaveLength(1);
  });

  test("processes malformed stdin and a final request without a trailing newline", async () => {
    const modulePath = join(import.meta.dir, "../../packages/runtime/mcp/skill-registry.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { runSkillRegistryStdio } from ${JSON.stringify(modulePath)}; await runSkillRegistryStdio({ searchDirs: [${JSON.stringify(root)}] });`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(
      '{broken\nnull\n{"method":"notifications/initialized"}\n{"id":7,"method":"ping"}',
    );
    child.stdin.end();
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(errors).toBe("");
    const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
    const responses = output
      .trim()
      .split("\n")
      .map((line) => parse(line));
    expect(responses).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
  });
});
