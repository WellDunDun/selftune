/**
 * frontmatter.ts
 *
 * Line-based YAML frontmatter parser for SKILL.md files.
 * Extracts name, description, and version without a YAML library.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md file.
 *
 * Handles two description formats:
 *   - Single-line:  `description: When the user wants to...`
 *   - Folded scalar: `description: >\n  Multi-line text...`
 *
 * Handles two version locations:
 *   - Top-level: `version: 1.0.0`
 *   - Nested:    `metadata:\n  version: 1.0.0`
 *
 * Returns the full content as description if no frontmatter is found.
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split("\n");

  // Check for opening delimiter
  if (lines[0]?.trim() !== "---") {
    return { name: "", description: content, version: "", body: content };
  }

  // Find closing delimiter
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx < 0) {
    return { name: "", description: content, version: "", body: content };
  }

  const yamlLines = lines.slice(1, endIdx);
  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .replace(/^\n+/, "");

  let name = "";
  let description = "";
  let version = "";
  let inMetadata = false;

  for (let i = 0; i < yamlLines.length; i++) {
    const line = yamlLines[i];
    const trimmed = line.trimEnd();

    // Top-level `name:`
    if (trimmed.startsWith("name:")) {
      name = trimmed.slice("name:".length).trim();
      inMetadata = false;
      continue;
    }

    // Top-level `version:`
    if (trimmed.startsWith("version:") && !trimmed.startsWith("  ")) {
      version = trimmed.slice("version:".length).trim();
      inMetadata = false;
      continue;
    }

    // `metadata:` block start
    if (trimmed === "metadata:" || trimmed.startsWith("metadata:")) {
      inMetadata = true;
      continue;
    }

    // Nested `version:` inside metadata
    if (inMetadata && /^\s+version:/.test(trimmed)) {
      version = trimmed.replace(/^\s+version:\s*/, "");
      continue;
    }

    // Top-level `description:` — single-line or folded scalar
    if (trimmed.startsWith("description:")) {
      inMetadata = false;
      const afterKey = trimmed.slice("description:".length).trim();

      if (afterKey === ">" || afterKey === "|") {
        // Folded/literal scalar: collect indented continuation lines
        const descParts: string[] = [];
        let j = i + 1;
        while (j < yamlLines.length) {
          const next = yamlLines[j];
          // Continuation line must be indented (starts with whitespace)
          if (next.length > 0 && /^\s/.test(next)) {
            descParts.push(next.replace(/^\s+/, ""));
          } else {
            break;
          }
          j++;
        }
        description = descParts.join(" ").trim();
        i = j - 1; // advance past consumed lines
      } else {
        // Single-line value
        description = afterKey;
      }
      continue;
    }

    // Any other top-level key resets inMetadata
    if (/^\S/.test(trimmed) && trimmed.includes(":")) {
      inMetadata = false;
    }
  }

  return { name, description, version, body };
}

// ---------------------------------------------------------------------------
// Frontmatter description replacement
// ---------------------------------------------------------------------------

/**
 * Replace the `description:` field in YAML frontmatter, preserving all other
 * content. If the new description contains special YAML characters, it is
 * written as a folded scalar (`description: >`).
 *
 * Returns the original content unchanged if no frontmatter is found.
 */
export function replaceFrontmatterDescription(content: string, newDescription: string): string {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") return content;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return content;

  // Find and replace the description within frontmatter lines
  const yamlLines = lines.slice(1, endIdx);
  const newYamlLines: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < yamlLines.length) {
    const trimmed = yamlLines[i].trimEnd();

    if (trimmed.startsWith("description:")) {
      replaced = true;
      const afterKey = trimmed.slice("description:".length).trim();

      // Skip continuation lines of folded/literal scalars
      if (afterKey === ">" || afterKey === "|") {
        i++;
        while (i < yamlLines.length && yamlLines[i].length > 0 && /^\s/.test(yamlLines[i])) {
          i++;
        }
      } else {
        i++;
      }

      // Write new description — use folded scalar if it's long or has special chars
      const needsFolded = newDescription.length > 120 || /[:#"'[\]{}|>]/.test(newDescription);
      if (needsFolded) {
        newYamlLines.push("description: >");
        // Wrap at ~78 chars with 2-space indent
        const words = newDescription.split(/\s+/);
        let line = "  ";
        for (const word of words) {
          if (line.length + word.length + 1 > 80 && line.trim().length > 0) {
            newYamlLines.push(line);
            line = `  ${word}`;
          } else {
            line = line.trim().length === 0 ? `  ${word}` : `${line} ${word}`;
          }
        }
        if (line.trim().length > 0) newYamlLines.push(line);
      } else {
        newYamlLines.push(`description: ${newDescription}`);
      }
      continue;
    }

    newYamlLines.push(yamlLines[i]);
    i++;
  }

  // If description wasn't found in frontmatter, add it
  if (!replaced) {
    newYamlLines.push(`description: ${newDescription}`);
  }

  const before = lines[0]; // "---"
  const after = lines.slice(endIdx); // "---" + body
  return [before, ...newYamlLines, ...after].join("\n");
}
