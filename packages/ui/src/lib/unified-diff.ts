export type ParsedDiffLineKind = "meta" | "hunk" | "add" | "remove" | "context";

export interface ParsedDiffLine {
  kind: ParsedDiffLineKind;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface ParsedUnifiedDiff {
  lines: ParsedDiffLine[];
  additions: number;
  removals: number;
}

export function isUnifiedDiffText(diffText: string | null | undefined): boolean {
  if (!diffText) return false;
  const normalized = diffText.replace(/\r\n/g, "\n").trim();
  return (
    (normalized.startsWith("--- ") || normalized.includes("\n--- ")) &&
    normalized.includes("+++ ") &&
    normalized.includes("@@ ")
  );
}

export function parseUnifiedDiff(diffText: string): ParsedUnifiedDiff {
  const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
  const lines: ParsedDiffLine[] = [];
  let additions = 0;
  let removals = 0;
  let oldLineNumber: number | null = null;
  let newLineNumber: number | null = null;

  for (const rawLine of rawLines) {
    if (rawLine.startsWith("@@")) {
      const match = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLineNumber = match ? Number(match[1]) : null;
      newLineNumber = match ? Number(match[2]) : null;
      lines.push({ kind: "hunk", text: rawLine, oldLineNumber: null, newLineNumber: null });
      continue;
    }

    if (
      rawLine.startsWith("diff --git") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("+++") ||
      rawLine.startsWith("rename from ") ||
      rawLine.startsWith("rename to ") ||
      rawLine.startsWith("new file mode ") ||
      rawLine.startsWith("deleted file mode ") ||
      rawLine.startsWith("similarity index ") ||
      rawLine.startsWith("Binary files ") ||
      rawLine.startsWith("\\ No newline at end of file")
    ) {
      lines.push({ kind: "meta", text: rawLine, oldLineNumber: null, newLineNumber: null });
      continue;
    }

    if (rawLine.startsWith("+")) {
      lines.push({ kind: "add", text: rawLine.slice(1), oldLineNumber: null, newLineNumber });
      additions += 1;
      newLineNumber = newLineNumber === null ? null : newLineNumber + 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      lines.push({ kind: "remove", text: rawLine.slice(1), oldLineNumber, newLineNumber: null });
      removals += 1;
      oldLineNumber = oldLineNumber === null ? null : oldLineNumber + 1;
      continue;
    }

    lines.push({
      kind: "context",
      text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
      oldLineNumber,
      newLineNumber,
    });
    oldLineNumber = oldLineNumber === null ? null : oldLineNumber + 1;
    newLineNumber = newLineNumber === null ? null : newLineNumber + 1;
  }

  return { lines, additions, removals };
}
