import { expect, it } from "vitest";
import { contextFootprint, discoveryText } from "./context-footprint";
import type { LibrarySkillModel, SkillContextEntry } from "../../models";
const entry: SkillContextEntry = {
  harness: "pi",
  scope: "global",
  projectRoot: null,
  path: "/skills/demo/SKILL.md",
  state: "active",
  metadata: {
    name: "demo",
    description: "Short description",
    disableModelInvocation: false,
    originalSkillPath: "/skills/demo/SKILL.md",
  },
};
const skill: LibrarySkillModel = {
  id: "demo",
  name: "demo",
  lifecycle: "active",
  status: "Ready",
  updateStatus: "current",
  sources: [],
  locations: [],
  revisionHashes: [],
  instructionBytes: 100000,
  contextEntries: [entry],
};
it("uses each harness discovery format, not instruction size", () => {
  const pi = discoveryText(entry)!;
  expect(pi).toContain("<location>");
  expect(discoveryText({ ...entry, harness: "opencode" })).not.toContain("<location>");
  expect(discoveryText({ ...entry, harness: "codex" })).toContain("file:");
  const rows = contextFootprint([skill], new Set(["demo"]));
  expect(rows[0]!.current).toBe(0);
  expect(rows[0]!.savings).toBe(Math.ceil(new TextEncoder().encode(pi).length / 4));
});
it("excludes manual-only skills in Claude/Pi but not OpenCode", () => {
  const hidden = { ...entry, metadata: { ...entry.metadata!, disableModelInvocation: true } };
  expect(discoveryText(hidden)).toBe("");
  expect(discoveryText({ ...hidden, harness: "claude_code" })).toBe("");
  expect(discoveryText({ ...hidden, harness: "opencode" })).not.toBe("");
});
it("does not double count duplicates or claim savings when a copy remains", () => {
  const rows = contextFootprint([
    { ...skill, contextEntries: [entry, { ...entry, path: "/copy", state: "saved" }] },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.savings).toBe(0);
});
it("keeps project contexts separate and unavailable data unknown", () => {
  const rows = contextFootprint([
    {
      ...skill,
      contextEntries: [
        { ...entry, scope: "project", projectRoot: "/one" },
        { ...entry, scope: "project", projectRoot: "/two" },
        { ...entry, harness: "openclaw" },
      ],
    },
  ]);
  expect(rows).toHaveLength(3);
  expect(rows[2]!.unknown).toBe(1);
});

it("labels non-project scopes explicitly and keeps their estimates separate", () => {
  const scopes = ["global", "system", "admin", "unknown", "project"];
  const rows = contextFootprint([
    {
      ...skill,
      contextEntries: scopes.map((scope) => ({ ...entry, harness: "codex", scope })),
    },
  ]);
  expect(rows.map((row) => row.scope)).toEqual([
    "All projects",
    "System skills",
    "Administrator-managed",
    "Scope not identified",
    "Project not identified",
  ]);
  expect(rows.every((row) => row.current > 0 && row.savings === 0)).toBe(true);
});
