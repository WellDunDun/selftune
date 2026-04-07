import { Card, CardContent } from "../primitives/card";
import { timeAgo } from "../lib/format";
import { ArrowRightIcon } from "lucide-react";
import type { JobScheduleEntry } from "../types";

function statusDot(status: "success" | "error" | null) {
  if (status === "success") return "bg-emerald-500";
  if (status === "error") return "bg-red-500";
  return "bg-muted-foreground/40";
}

function formatNextRun(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return `in ${hours}h`;
}

export function PipelineStatusBar({
  jobs,
  viewAllHref = "/jobs",
}: {
  jobs: JobScheduleEntry[];
  viewAllHref?: string;
}) {
  if (jobs.length === 0) return null;

  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center gap-3">
        {jobs.map((job) => {
          const hasError = job.lastRunStatus === "error";
          return (
            <div
              key={job.name}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                hasError ? "border-red-500/40 bg-red-950/20" : "border-border bg-card"
              }`}
            >
              <span className={`size-2 shrink-0 rounded-full ${statusDot(job.lastRunStatus)}`} />
              <span className="font-medium text-foreground">{job.name}</span>
              {job.lastRunAt ? (
                <span className="text-muted-foreground font-mono">{timeAgo(job.lastRunAt)}</span>
              ) : (
                <span className="text-muted-foreground font-mono">--</span>
              )}
              <span className="text-muted-foreground/60">|</span>
              <span className="text-muted-foreground font-mono">
                {formatNextRun(job.nextRunAt)}
              </span>
            </div>
          );
        })}
        <a
          href={viewAllHref}
          className="ml-auto flex items-center gap-1 text-xs text-primary hover:text-primary/80"
        >
          View all <ArrowRightIcon className="size-3" />
        </a>
      </CardContent>
    </Card>
  );
}
