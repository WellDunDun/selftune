import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BotIcon,
  BoxesIcon,
  CpuIcon,
  Loader2Icon,
  TerminalSquareIcon,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { useSkillReport } from "@/hooks/useSkillReport";
import {
  formatActionLabel,
  useLiveActionFeed,
  useSelectedLiveActionEntry,
} from "@/lib/live-action-feed";
import type { DashboardActionName, SessionMeta } from "@/types";

function statusBadge(status: "running" | "success" | "error") {
  if (status === "running") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2Icon className="size-3 animate-spin" />
        Running
      </Badge>
    );
  }
  if (status === "success") return <Badge variant="default">Validated</Badge>;
  return <Badge variant="destructive">Failed</Badge>;
}

function countValues(
  rows: SessionMeta[],
  selector: (row: SessionMeta) => string | null,
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = selector(row) ?? "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}

function formatPercent(value: number | null): string {
  return value == null ? "--" : `${Math.round(value * 100)}%`;
}

function formatDelta(value: number | null): string {
  return value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatInteger(value: number | null): string {
  return value == null ? "--" : Math.round(value).toLocaleString();
}

function formatCurrency(value: number | null): string {
  return value == null ? "--" : `$${value.toFixed(4)}`;
}

function formatDurationMs(value: number | null): string {
  return value == null ? "--" : `${(value / 1000).toFixed(1)}s`;
}

function formatProgressStatus(
  progress:
    | {
        current: number;
        total: number;
        status: "started" | "finished";
        unit?: "eval" | "llm_call" | "step" | null;
        query: string | null;
        passed: boolean | null;
        evidence: string | null;
      }
    | null
    | undefined,
): string {
  if (!progress) return "Waiting for action progress";
  const unitLabel =
    progress.unit === "llm_call" ? "call" : progress.unit === "step" ? "step" : "eval";
  if (progress.status === "started") {
    return `Running ${unitLabel} ${progress.current}/${progress.total}`;
  }
  if (progress.passed == null) {
    return `Finished ${unitLabel} ${progress.current}/${progress.total}`;
  }
  return `${progress.passed ? "Passed" : "Failed"} ${unitLabel} ${progress.current}/${progress.total}`;
}

function progressUnitLabel(
  progress:
    | {
        unit?: "eval" | "llm_call" | "step" | null;
      }
    | null
    | undefined,
): string {
  if (progress?.unit === "llm_call") return "Current call";
  if (progress?.unit === "step") return "Current step";
  return "Current eval";
}

function progressSubjectLabel(
  progress:
    | {
        unit?: "eval" | "llm_call" | "step" | null;
      }
    | null
    | undefined,
): string {
  if (progress?.unit === "eval") return "Query";
  return "Current item";
}

export function LiveRun() {
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get("event") || undefined;
  const skillName = searchParams.get("skill") || undefined;
  const action = (searchParams.get("action") || undefined) as DashboardActionName | undefined;

  const entries = useLiveActionFeed();
  const selectedEntry = useSelectedLiveActionEntry({
    eventId,
    skillName,
    action,
    preferRunning: true,
  });
  const selectedSkillName = selectedEntry?.skillName ?? skillName;
  const skillQuery = useSkillReport(selectedSkillName);
  const sessionMetadata = skillQuery.data?.session_metadata ?? [];
  const platformCounts = countValues(sessionMetadata, (row) => row.platform);
  const modelCounts = countValues(sessionMetadata, (row) => row.model);
  const agentCounts = countValues(sessionMetadata, (row) => row.agent_cli);

  const recentEntries = entries.filter((entry) => {
    if (skillName && entry.skillName !== skillName) return false;
    return true;
  });

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
            <Link
              to={
                selectedSkillName ? `/skills/${encodeURIComponent(selectedSkillName)}` : "/skills"
              }
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3" />
              Back to skill
            </Link>
            <span>/</span>
            <span>Live run</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {selectedEntry ? formatActionLabel(selectedEntry.action) : "Creator loop live run"}
            </h1>
            {selectedEntry ? statusBadge(selectedEntry.status) : null}
            {selectedSkillName ? <Badge variant="outline">{selectedSkillName}</Badge> : null}
          </div>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            Dedicated streaming view for creator-loop actions. This screen shows the live terminal
            output, parsed dry-run result, and historical platform/model/token aggregates for the
            selected skill.
          </p>
        </div>

        <div className="rounded-2xl border border-border/20 bg-muted/20 px-4 py-3 text-right">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Watching
          </div>
          <div className="mt-1 text-sm font-medium">
            {selectedEntry?.startedAt
              ? timeAgo(new Date(selectedEntry.startedAt).toISOString())
              : "Waiting for stream"}
          </div>
          <div className="mt-1 text-[11px] font-mono text-muted-foreground">
            {selectedEntry?.id ?? "Awaiting action event"}
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_400px]">
        <div className="space-y-6">
          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <ActivityIcon className="size-4" />
                Run summary
              </CardTitle>
              <CardDescription>
                Structured dry-run result when the evolution command emits machine-readable output.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedEntry?.summary ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      Before
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatPercent(selectedEntry.summary.before_pass_rate)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      After
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatPercent(selectedEntry.summary.after_pass_rate)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      Net change
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {formatDelta(selectedEntry.summary.net_change)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      Validation
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {selectedEntry.summary.validation_mode ?? "Dry-run"}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  No structured summary yet. Start a replay dry-run from the skill report to watch
                  its output stream into this screen.
                </div>
              )}

              {selectedEntry?.summary?.reason ? (
                <div className="mt-4 rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                  {selectedEntry.summary.reason}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <ActivityIcon className="size-4" />
                Live action progress
              </CardTitle>
              <CardDescription>
                Structured progress updates from the active creator-loop action. Replay emits
                per-eval progress, while eval generation and unit-test generation emit step and
                LLM-call progress through the same contract.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedEntry?.progress ? (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        {progressUnitLabel(selectedEntry.progress)}
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {selectedEntry.progress.current}/{selectedEntry.progress.total}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Status
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatProgressStatus(selectedEntry.progress)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Outcome
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {selectedEntry.progress.passed == null
                          ? "Pending"
                          : selectedEntry.progress.passed
                            ? "Pass"
                            : "Fail"}
                      </div>
                    </div>
                  </div>

                  {selectedEntry.progress.phase ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Phase
                      </div>
                      <div className="text-foreground">
                        {selectedEntry.progress.phase.replaceAll("_", " ")}
                      </div>
                    </div>
                  ) : null}

                  {(selectedEntry.progress.label ?? selectedEntry.progress.query) ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        {progressSubjectLabel(selectedEntry.progress)}
                      </div>
                      <div className="text-foreground">
                        {selectedEntry.progress.label ?? selectedEntry.progress.query}
                      </div>
                    </div>
                  ) : null}

                  {selectedEntry.progress.evidence ? (
                    <div className="rounded-xl border border-border/15 bg-background px-4 py-3 text-sm text-muted-foreground">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Last detail
                      </div>
                      <div>{selectedEntry.progress.evidence}</div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  Waiting for structured progress. Open this page before or during a creator-loop
                  run to watch evals, LLM calls, or action steps stream through.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <CpuIcon className="size-4" />
                Live runtime metrics
              </CardTitle>
              <CardDescription>
                Per-run metadata emitted from the active action runtime. Replay still has the
                richest token and cost detail today, while other provider-backed actions emit
                normalized platform, model, and duration updates through the same metrics surface.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedEntry?.metrics ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {selectedEntry.metrics.platform ?? "Unknown platform"}
                    </Badge>
                    <Badge variant="secondary">
                      {selectedEntry.metrics.model ?? "Unknown model"}
                    </Badge>
                    {selectedEntry.metrics.session_id ? (
                      <Badge variant="outline">{selectedEntry.metrics.session_id}</Badge>
                    ) : null}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Input tokens
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Output tokens
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.output_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cache read
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.cache_read_input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cache create
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatInteger(selectedEntry.metrics.cache_creation_input_tokens)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Cost
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatCurrency(selectedEntry.metrics.total_cost_usd)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Duration
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {formatDurationMs(selectedEntry.metrics.duration_ms)}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-sm text-muted-foreground">
                  Waiting for structured runtime metrics. Replay emits token and cost detail today,
                  while other actions emit normalized provider/model/duration data once their LLM
                  calls start and finish.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <TerminalSquareIcon className="size-4" />
                Streaming output
              </CardTitle>
              <CardDescription>
                Live stdout and stderr from the active creator-loop action.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[640px] overflow-auto rounded-2xl border border-border/15 bg-zinc-950 px-4 py-3 font-mono text-[12px] leading-6 text-zinc-100">
                {selectedEntry?.logs.length ? (
                  selectedEntry.logs.map((log) => (
                    <div
                      key={log.id}
                      className={
                        log.stage === "stderr"
                          ? "text-amber-300"
                          : log.stage === "progress"
                            ? "text-emerald-300"
                            : log.stage === "metrics"
                              ? "text-sky-300"
                              : ""
                      }
                    >
                      <span className="mr-3 text-zinc-500">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>
                      <span className="mr-3 inline-block min-w-16 text-zinc-500">
                        [{log.stage}]
                      </span>
                      <span>{log.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-zinc-500">
                    Waiting for live output. Start a dashboard action or run a supported `selftune`
                    command in another terminal.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <CpuIcon className="size-4" />
                Skill telemetry context
              </CardTitle>
              <CardDescription>
                Historical aggregate data for the selected skill. This uses the existing skill
                report telemetry so you can narrate model and token footprint during the demo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Input tokens
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {skillQuery.data?.token_usage.total_input_tokens.toLocaleString() ?? "--"}
                  </div>
                </div>
                <div className="rounded-xl border border-border/15 bg-muted/20 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Output tokens
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {skillQuery.data?.token_usage.total_output_tokens.toLocaleString() ?? "--"}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <BoxesIcon className="size-3.5" />
                  Platforms
                </div>
                <div className="flex flex-wrap gap-2">
                  {platformCounts.length ? (
                    platformCounts.map((item) => (
                      <Badge key={`platform-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No platform data yet</Badge>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <BotIcon className="size-3.5" />
                  Models
                </div>
                <div className="flex flex-wrap gap-2">
                  {modelCounts.length ? (
                    modelCounts.map((item) => (
                      <Badge key={`model-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No model data yet</Badge>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  <CpuIcon className="size-3.5" />
                  Agent CLIs
                </div>
                <div className="flex flex-wrap gap-2">
                  {agentCounts.length ? (
                    agentCounts.map((item) => (
                      <Badge key={`agent-${item.label}`} variant="secondary">
                        {item.label} · {item.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">No agent CLI data yet</Badge>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/20">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Recent live runs</CardTitle>
              <CardDescription>
                Quick jump list for the latest streamed creator-loop actions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentEntries.length ? (
                recentEntries.slice(0, 8).map((entry) => {
                  const params = new URLSearchParams();
                  params.set("event", entry.id);
                  if (entry.skillName) params.set("skill", entry.skillName);
                  params.set("action", entry.action);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="w-full rounded-xl border border-border/15 bg-muted/20 px-3 py-3 text-left transition-colors hover:bg-muted/35"
                      onClick={() => setSearchParams(params)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {formatActionLabel(entry.action)}
                          </div>
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {entry.skillName ?? "No skill"} ·{" "}
                            {timeAgo(new Date(entry.updatedAt).toISOString())}
                          </div>
                        </div>
                        {statusBadge(entry.status)}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-xl border border-dashed border-border/20 px-4 py-6 text-sm text-muted-foreground">
                  No live runs have been observed in this browser session yet.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
