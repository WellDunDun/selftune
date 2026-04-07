import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/card";
import { Badge } from "../primitives/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../primitives/collapsible";
import { timeAgo } from "../lib/format";
import { ActivityIcon, ChevronDownIcon } from "lucide-react";
import type { JobExecution } from "../types";

const JOB_NAMES = [
  "aggregation",
  "alert-checker",
  "badge-cache",
  "retention-cleanup",
  "orchestrate",
  "sync",
  "status",
] as const;

export interface JobHistoryFilters {
  job: string;
  status: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function JobHistoryTimeline({
  executions,
  filters,
  onFilterChange,
}: {
  executions: JobExecution[];
  filters?: JobHistoryFilters;
  onFilterChange?: (filters: JobHistoryFilters) => void;
}) {
  const currentJob = filters?.job ?? "";
  const currentStatus = filters?.status ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="size-4" />
          Execution History
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        {onFilterChange && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={currentJob}
              onChange={(e) => onFilterChange({ job: e.target.value, status: currentStatus })}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus:border-ring"
            >
              <option value="">All jobs</option>
              {JOB_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={currentStatus}
              onChange={(e) => onFilterChange({ job: currentJob, status: e.target.value })}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus:border-ring"
            >
              <option value="">All statuses</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
          </div>
        )}

        {/* Timeline */}
        {executions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No executions yet</p>
        ) : (
          <div className="space-y-2">
            {executions.map((exec) => (
              <ExecutionRow key={exec.id} execution={exec} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExecutionRow({ execution }: { execution: JobExecution }) {
  const [open, setOpen] = useState(false);
  const isError = execution.status === "error";
  const hasDetails = execution.error || Object.keys(execution.metrics).length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={`rounded-md border p-2 ${
          isError ? "border-red-500/30 bg-red-950/10" : "border-border"
        }`}
      >
        <CollapsibleTrigger
          disabled={!hasDetails}
          className="flex w-full items-center gap-3 text-left disabled:cursor-default"
        >
          <span
            className={`mt-0.5 size-2 shrink-0 rounded-full ${
              isError ? "bg-red-500" : "bg-emerald-500"
            }`}
          />
          <Badge variant={isError ? "destructive" : "secondary"} className="text-[10px]">
            {execution.jobName}
          </Badge>
          <span className="text-xs text-muted-foreground font-mono">
            {timeAgo(execution.startedAt)}
          </span>
          <span className="text-xs text-muted-foreground/60 font-mono">
            took {formatDuration(execution.durationMs)}
          </span>
          {typeof execution.metrics.total_llm_calls === "number" &&
            execution.metrics.total_llm_calls > 0 && (
              <span className="text-xs text-muted-foreground/60 font-mono">
                {execution.metrics.total_llm_calls} LLM calls
              </span>
            )}
          {hasDetails && (
            <ChevronDownIcon
              className={`ml-auto size-3.5 text-muted-foreground transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          )}
        </CollapsibleTrigger>

        {hasDetails && (
          <CollapsibleContent className="mt-2 border-t border-border pt-2">
            {execution.error && (
              <p className="text-xs text-red-400 font-mono mb-1">{execution.error}</p>
            )}
            {Object.keys(execution.metrics).length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(execution.metrics).map(([key, value]) => (
                  <span key={key} className="text-[11px] text-muted-foreground font-mono">
                    {key}: {String(value)}
                  </span>
                ))}
              </div>
            )}
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}
