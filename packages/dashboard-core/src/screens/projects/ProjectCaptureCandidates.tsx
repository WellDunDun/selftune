"use client";

import { useState } from "react";
import { FolderInputIcon, FolderKanbanIcon } from "lucide-react";

import type { ProjectCaptureCandidateModel, ProjectConnectionId } from "../../models";
import { Badge, Button } from "@selftune/ui/primitives";

const CONNECTION_LABELS: Record<ProjectConnectionId, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  pi: "Pi",
};

export function ProjectCaptureCandidates({
  candidates,
  selectedProjectRoot,
  onSelect,
}: {
  candidates: ProjectCaptureCandidateModel[];
  selectedProjectRoot: string;
  onSelect(candidate: ProjectCaptureCandidateModel): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (candidates.length === 0) return null;
  const visibleCandidates = expanded ? candidates : candidates.slice(0, 6);
  return (
    <section className="rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-4 py-3">
        <h2 className="px-3 text-sm font-semibold">Detected projects</h2>
        <Badge variant="outline">{candidates.length}</Badge>
      </div>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {visibleCandidates.map((candidate) => (
          <div
            key={candidate.projectRoot}
            className="flex min-w-0 flex-col gap-3 py-3 sm:flex-row sm:items-center"
          >
            <FolderKanbanIcon className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{candidate.name}</p>
              <p className="truncate text-xs text-muted-foreground" title={candidate.projectRoot}>
                {candidate.projectRoot}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {candidate.skillCount} skill{candidate.skillCount === 1 ? "" : "s"}
              </span>
              {candidate.connections.map((connection) => (
                <Badge key={connection} variant="outline">
                  {CONNECTION_LABELS[connection]}
                </Badge>
              ))}
              <Button
                size="sm"
                variant={selectedProjectRoot === candidate.projectRoot ? "secondary" : "outline"}
                aria-label={`Use ${candidate.name}`}
                onClick={() => onSelect(candidate)}
              >
                <FolderInputIcon data-icon="inline-start" />
                {selectedProjectRoot === candidate.projectRoot ? "Selected" : "Use project"}
              </Button>
            </div>
          </div>
        ))}
        {candidates.length > 6 ? (
          <Button
            variant="ghost"
            className="my-2 w-full"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show all ${candidates.length} projects`}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
