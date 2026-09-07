import type { LibrarySkillModel, SkillContextEntry } from "../../models";

const names = new Map([
  ["claude_code", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
  ["openclaw", "OpenClaw"],
]);
const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

// Discovery-only projection, not total prompt usage. See docs/cli/skills-search.
export function discoveryText(entry: SkillContextEntry): string | null {
  const metadata = entry.metadata;
  if (!metadata) return null;
  const { name, description, originalSkillPath, disableModelInvocation } = metadata;
  switch (entry.harness) {
    case "claude_code":
      return disableModelInvocation
        ? ""
        : `${name}: ${[description, metadata.whenToUse].filter(Boolean).join(" ").slice(0, 1536)}`;
    case "codex":
      return `- ${name}: ${description} (file: ${originalSkillPath})`;
    case "opencode":
      return `  <skill>\n    <name>${xml(name)}</name>\n    <description>${xml(description)}</description>\n  </skill>`;
    case "pi":
      return disableModelInvocation
        ? ""
        : `  <skill>\n    <name>${xml(name)}</name>\n    <description>${xml(description)}</description>\n    <location>${xml(originalSkillPath)}</location>\n  </skill>`;
    default:
      return null;
  }
}

export interface ContextFootprintRow {
  key: string;
  harness: string;
  scope: string;
  current: number;
  savings: number;
  unknown: number;
}

function contextScope(entry: SkillContextEntry): string {
  switch (entry.scope) {
    case "global":
      return "All projects";
    case "system":
      return "System skills";
    case "admin":
      return "Administrator-managed";
    case "project":
      return entry.projectRoot || "Project not identified";
    default:
      return "Scope not identified";
  }
}

export function contextFootprint(
  skills: readonly LibrarySkillModel[],
  selectedIds: ReadonlySet<string> = new Set(),
): ContextFootprintRow[] {
  const rows = new Map<string, ContextFootprintRow>();
  for (const skill of skills) {
    const entries = skill.contextEntries ?? [];
    const effective = new Map<
      string,
      { entry: SkillContextEntry; before: number | null; after: number | null }
    >();
    for (const entry of entries) {
      const scope = contextScope(entry);
      const key = `${entry.harness}:${scope}`;
      const text = discoveryText(entry);
      const count = text === null ? null : Math.ceil(new TextEncoder().encode(text).length / 4);
      const after = entry.state === "active" && !selectedIds.has(skill.id) ? count : 0;
      // Duplicate names are shadowed by most hosts. Codex may list different paths.
      const identity = `${key}:${entry.harness === "codex" ? entry.path : skill.name}`;
      const previous = effective.get(identity);
      effective.set(identity, {
        entry,
        before:
          previous?.before === null || count === null
            ? null
            : Math.max(previous?.before ?? 0, count),
        after:
          previous?.after === null || after === null ? null : Math.max(previous?.after ?? 0, after),
      });
    }
    for (const { entry, before, after } of effective.values()) {
      const scope = contextScope(entry);
      const key = `${entry.harness}:${scope}`;
      const row = rows.get(key) ?? {
        key,
        harness: names.get(entry.harness ?? "") ?? "Unknown harness",
        scope,
        current: 0,
        savings: 0,
        unknown: 0,
      };
      if (before === null || after === null) row.unknown++;
      else {
        row.current += after;
        row.savings += Math.max(0, before - after);
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}
