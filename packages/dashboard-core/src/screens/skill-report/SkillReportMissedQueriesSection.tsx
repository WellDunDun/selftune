"use client";

import type { ReactNode } from "react";

export interface SkillReportMissedQueryRow {
  id: string;
  query: string;
  confidence: number | null;
  source: string | null;
  createdAt: string;
}

export interface SkillReportMissedQueriesSectionProps {
  rows: SkillReportMissedQueryRow[];
  emptyState?: ReactNode;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SkillReportMissedQueriesSection({
  rows,
  emptyState,
}: SkillReportMissedQueriesSectionProps) {
  if (rows.length === 0) {
    return (
      emptyState ?? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No missed queries detected.
        </div>
      )
    );
  }

  return (
    <div data-parity-root="skill-report-missed-queries" className="space-y-3">
      {rows.map((row) => (
        <div key={row.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
          <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warning" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{row.query}</p>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              {row.confidence !== null && (
                <span className="font-medium text-warning-foreground">
                  {(row.confidence * 100).toFixed(0)}% confidence
                </span>
              )}
              {row.source ? (
                <span className="rounded bg-muted px-1.5 py-0.5">{row.source}</span>
              ) : null}
              <span>{formatRelativeTime(row.createdAt)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
