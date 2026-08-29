import { describe, expect, it } from "vitest";

import {
  createPortablePluginZip,
  projectPortablePluginFiles,
} from "../src/domain/portable-plugin-export";

const revision = "a".repeat(64);
const skill = {
  name: "Research",
  files: [
    { path: "reference.md", content: new TextEncoder().encode("Reference\n") },
    { path: "skill.md", content: new TextEncoder().encode("# Research\n") },
  ],
};

describe("portable plugin export", () => {
  it("projects all manifests and binds Agent Plugins provenance to the sealed revision", () => {
    const result = projectPortablePluginFiles({
      target: "all",
      name: "Research Set",
      description: "Pinned research tools",
      skillSetId: "research-set",
      skillSetRevisionSha256: revision,
      skills: [skill],
    });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain(".claude-plugin/plugin.json");
    expect(paths).toContain(".codex-plugin/plugin.json");
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("skills/research/SKILL.md");
    const manifest = result.files.find((file) => file.path === "plugin.json");
    expect(JSON.parse(new TextDecoder().decode(manifest?.content))).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      extensions: {
        "dev.selftune": {
          skillSetId: "research-set",
          skillSetRevisionSha256: revision,
        },
      },
    });
  });

  it("creates deterministic archives and rejects ambiguous paths", () => {
    const files = projectPortablePluginFiles({
      target: "agent-plugins-v1",
      name: "Research Set",
      description: "Pinned research tools",
      skillSetId: "research-set",
      skillSetRevisionSha256: revision,
      skills: [skill],
    }).files;
    const reordered = [files.at(-1)!, ...files.slice(0, -1)];
    expect(createPortablePluginZip(files)).toEqual(createPortablePluginZip(reordered));
    expect(() =>
      createPortablePluginZip([
        { path: "SKILL.md", content: new Uint8Array() },
        { path: "skill.md", content: new Uint8Array() },
      ]),
    ).toThrow("duplicate path");
  });

  it("requires every projected skill to contain a root SKILL.md", () => {
    expect(() =>
      projectPortablePluginFiles({
        target: "openai",
        name: "Invalid",
        description: "Invalid",
        skillSetId: "invalid",
        skillSetRevisionSha256: revision,
        skills: [{ name: "missing", files: [{ path: "README.md", content: new Uint8Array() }] }],
      }),
    ).toThrow("root SKILL.md");
  });
});
