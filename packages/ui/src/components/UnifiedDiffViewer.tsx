"use client";

import { useMemo, useState } from "react";

import { Badge, Button } from "../primitives";
import { cn } from "../lib/utils";
import { parseUnifiedDiff, type ParsedDiffLine } from "../lib/unified-diff";

export interface UnifiedDiffViewerProps {
  diffText: string;
  title: string;
  description?: string;
  className?: string;
  collapsedLineCount?: number;
}

export function UnifiedDiffViewer({
  diffText,
  title,
  description = "Rendered from the actual unified diff.",
  className,
  collapsedLineCount = 24,
}: UnifiedDiffViewerProps) {
  const diff = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const [expanded, setExpanded] = useState(false);
  const visibleLines = expanded ? diff.lines : diff.lines.slice(0, collapsedLineCount);
  const hasOverflow = diff.lines.length > collapsedLineCount;

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-success/10 text-success-foreground">+{diff.additions}</Badge>
            <Badge variant="destructive">-{diff.removals}</Badge>
          </div>
        </div>
        <div className="max-h-[30rem] overflow-auto">
          <div className="divide-y divide-border/40 font-mono text-xs">
            {visibleLines.map((line) => (
              <DiffLineRow
                key={`${line.kind}-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "x"}-${line.text}`}
                line={line}
              />
            ))}
          </div>
        </div>
      </div>
      {hasOverflow ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 text-muted-foreground"
        >
          {expanded ? "Collapse full diff" : `View full diff (${diff.lines.length} lines)`}
        </Button>
      ) : null}
    </div>
  );
}

function DiffLineRow({ line }: { line: ParsedDiffLine }) {
  const tone =
    line.kind === "add"
      ? "bg-success/10 text-success-foreground"
      : line.kind === "remove"
        ? "bg-destructive/10 text-destructive"
        : line.kind === "hunk"
          ? "bg-primary/10 text-primary"
          : line.kind === "meta"
            ? "bg-muted/50 text-muted-foreground"
            : "bg-background text-foreground";
  const gutter =
    line.kind === "add"
      ? "text-success-foreground"
      : line.kind === "remove"
        ? "text-destructive"
        : line.kind === "hunk"
          ? "text-primary"
          : "text-muted-foreground";
  const marker =
    line.kind === "add"
      ? "+"
      : line.kind === "remove"
        ? "-"
        : line.kind === "hunk"
          ? "@@"
          : line.kind === "meta"
            ? "⋯"
            : " ";

  return (
    <div className={cn("grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] items-start", tone)}>
      <span className="select-none border-r border-border/40 px-2 py-1 text-right text-[11px] text-muted-foreground">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="select-none border-r border-border/40 px-2 py-1 text-right text-[11px] text-muted-foreground">
        {line.newLineNumber ?? ""}
      </span>
      <span className={cn("select-none border-r border-border/40 px-2 py-1 text-center", gutter)}>
        {marker}
      </span>
      <pre className="overflow-x-auto px-3 py-1 whitespace-pre-wrap break-words">
        {line.text || " "}
      </pre>
    </div>
  );
}
