import { InfoTip } from "./InfoTip";
import { formatRate, timeAgo } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../primitives";
import {
  ActivityIcon,
  BarChart3Icon,
  DatabaseIcon,
  GitBranchIcon,
  SearchIcon,
  TargetIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  ExampleRow,
  TrustFields,
  TrustState,
  ObservationKind,
  HistoricalContext,
} from "../types";

export function observationBadge(kind: ObservationKind | null | undefined): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} | null {
  switch (kind) {
    case "repaired_contextual_miss":
      return { label: "repaired miss", variant: "destructive" };
    case "repaired_trigger":
      return { label: "repaired trigger", variant: "secondary" };
    case "legacy_materialized":
      return { label: "legacy row", variant: "outline" };
    default:
      return null;
  }
}

export function historicalContextBadge(context: HistoricalContext | null | undefined): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} | null {
  switch (context) {
    case "previously_missed":
      return { label: "previously missed", variant: "secondary" };
    default:
      return null;
  }
}

function ExampleRowItem({ row }: { row: ExampleRow }) {
  const workspace = row.workspace_path ? row.workspace_path.split("/").slice(-2).join("/") : null;
  const observation = observationBadge(row.observation_kind);
  const historicalContext = historicalContextBadge(row.historical_context);

  return (
    <TableRow className={!row.triggered ? "bg-destructive/5" : ""}>
      <TableCell
        className="max-w-[420px] truncate py-2 text-[12px]"
        title={row.query_text || undefined}
      >
        {row.query_text || (
          <span className="italic text-muted-foreground/40">No prompt recorded</span>
        )}
      </TableCell>
      <TableCell className="py-2">
        <div className="flex items-center gap-1.5">
          {row.triggered ? (
            <Badge
              variant="outline"
              className="border-green-600/30 text-[10px] font-normal text-green-600"
            >
              triggered
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px] font-normal">
              missed
            </Badge>
          )}
          {observation && (
            <Badge variant={observation.variant} className="text-[10px] font-normal">
              {observation.label}
            </Badge>
          )}
          {historicalContext && (
            <Badge variant={historicalContext.variant} className="text-[10px] font-normal">
              {historicalContext.label}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2 font-mono text-[11px] tabular-nums text-muted-foreground">
        {row.confidence != null ? `${Math.round(row.confidence * 100)}%` : "Not recorded"}
      </TableCell>
      <TableCell className="py-2">
        {row.invocation_mode ? (
          <Badge variant="secondary" className="text-[10px] font-normal">
            {row.invocation_mode}
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">Unknown mode</span>
        )}
      </TableCell>
      <TableCell className="py-2 text-[11px] text-muted-foreground">
        {row.prompt_kind ?? "Unclassified"}
      </TableCell>
      <TableCell className="py-2 text-[11px] text-muted-foreground">
        {row.source ?? "No data"}
      </TableCell>
      <TableCell className="py-2 text-[11px] text-muted-foreground">
        {row.platform ?? "No data"}
      </TableCell>
      <TableCell
        className="py-2 font-mono text-[11px] text-muted-foreground"
        title={row.workspace_path ?? undefined}
      >
        {workspace ?? "No data"}
      </TableCell>
      <TableCell className="py-2">
        <Badge
          variant={
            row.query_origin === "inline_query"
              ? "outline"
              : row.query_origin === "matched_prompt"
                ? "secondary"
                : "destructive"
          }
          className="text-[10px] font-normal"
        >
          {row.query_origin}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function ExamplesTable({ rows, emptyMessage }: { rows: ExampleRow[]; emptyMessage: string }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="themed-scroll max-h-[340px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="sticky top-0 z-10 bg-muted/70 backdrop-blur hover:bg-muted/70">
            <TableHead className="h-8 font-headline text-[10px] uppercase tracking-[0.15em]">
              Prompt
            </TableHead>
            <TableHead className="h-8 w-[80px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Status
            </TableHead>
            <TableHead className="h-8 w-[70px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Confidence
            </TableHead>
            <TableHead className="h-8 w-[80px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Mode
            </TableHead>
            <TableHead className="h-8 w-[80px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Kind
            </TableHead>
            <TableHead className="h-8 w-[70px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Source
            </TableHead>
            <TableHead className="h-8 w-[70px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Platform
            </TableHead>
            <TableHead className="h-8 w-[100px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Workspace
            </TableHead>
            <TableHead className="h-8 w-[100px] font-headline text-[10px] uppercase tracking-[0.15em]">
              Origin
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <ExampleRowItem key={`${row.session_id}-${i}`} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RateBar({
  label,
  value,
  warn,
}: {
  label: string;
  value: number | null | undefined;
  warn?: boolean;
}) {
  const pct = value != null ? Math.round(value * 100) : null;
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        {pct != null && (
          <div
            className={`h-full rounded-full transition-all ${warn ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        )}
      </div>
      <span
        className={`w-10 text-right font-mono text-xs tabular-nums ${warn ? "text-destructive" : "text-muted-foreground"}`}
      >
        {pct != null ? `${pct}%` : "No data"}
      </span>
    </div>
  );
}

function BreakdownTable({
  title,
  data,
}: {
  title: string;
  data: Array<{ source?: string; kind?: string; count: number }> | null | undefined;
}) {
  if (!data || data.length === 0) return null;

  const labelForValue = (value: string) => {
    switch (value) {
      case "repaired_contextual_miss":
        return "repaired contextual miss";
      case "repaired_trigger":
        return "repaired trigger";
      case "legacy_materialized":
        return "legacy materialized";
      default:
        return value;
    }
  };

  const entries = data
    .map((d) => [labelForValue(d.source ?? d.kind ?? "(unknown)"), d.count] as [string, number])
    .sort(([, a], [, b]) => b - a);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  return (
    <div>
      <h4 className="mb-2 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h4>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-7 font-headline text-[10px] uppercase tracking-[0.15em]">
              Value
            </TableHead>
            <TableHead className="h-7 w-[80px] text-right font-headline text-[10px] uppercase tracking-[0.15em]">
              Count
            </TableHead>
            <TableHead className="h-7 w-[80px] text-right font-headline text-[10px] uppercase tracking-[0.15em]">
              Rate
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([value, count]) => (
            <TableRow key={value}>
              <TableCell className="py-2 text-[11px]">{value}</TableCell>
              <TableCell className="py-2 text-right font-mono text-[11px]">{count}</TableCell>
              <TableCell className="py-2 text-right font-mono text-[11px] text-muted-foreground">
                {total > 0 ? `${Math.round((count / total) * 100)}%` : "0%"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SkillReportTopRow({
  nextAction,
  latestDecision,
}: {
  nextAction: {
    icon: ReactNode;
    text: string;
    actionLabel: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  };
  latestDecision?:
    | {
        action: string;
        timestamp: string | null;
        evolutionCount: number;
      }
    | undefined;
}) {
  const nextActionBorder =
    nextAction.variant === "destructive"
      ? "border-destructive/25"
      : nextAction.variant === "default"
        ? "border-primary/20"
        : "border-border/15";

  return (
    <div className="grid grid-cols-1 gap-3 @4xl/main:grid-cols-12">
      <Card
        className={`rounded-xl border bg-muted/35 shadow-none ${latestDecision ? "@4xl/main:col-span-8" : "@4xl/main:col-span-12"} ${nextActionBorder}`}
      >
        <CardContent className="flex items-start gap-3 px-4 py-4">
          <div className="shrink-0 pt-0.5">{nextAction.icon}</div>
          <div className="flex-1">
            <h3 className="mb-1 font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Next Best Action
            </h3>
            <p className="text-[15px] font-medium leading-6 text-foreground">{nextAction.text}</p>
          </div>
          <Badge variant={nextAction.variant} className="shrink-0 self-start text-[10px]">
            {nextAction.actionLabel}
          </Badge>
        </CardContent>
      </Card>

      {latestDecision && (
        <Card className="rounded-xl border border-border/10 bg-muted/20 @4xl/main:col-span-4">
          <CardContent className="flex h-full items-start gap-3 px-4 py-4">
            <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-primary/80" />
            <div className="min-w-0 flex-1">
              <h3 className="mb-1 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Latest Decision
              </h3>
              <p className="truncate text-sm font-medium leading-6">{latestDecision.action}</p>
              {latestDecision.timestamp && (
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {timeAgo(latestDecision.timestamp)}
                </p>
              )}
            </div>
            <Badge variant="outline" className="shrink-0 self-start text-[9px]">
              {latestDecision.evolutionCount} evolution
              {latestDecision.evolutionCount !== 1 ? "s" : ""}
            </Badge>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function narrativeObservedText({
  checks,
  sessions,
  promptLinkRate,
}: {
  checks: number;
  sessions: number;
  promptLinkRate: number | null | undefined;
}) {
  const promptClause =
    promptLinkRate != null
      ? ` It could link ${formatRate(promptLinkRate)} of those checks back to prompts.`
      : "";
  return `Selftune watched ${checks} skill checks across ${sessions} sessions.${promptClause}`;
}

function narrativeDiagnosisText({
  missRate,
  missedTriggers,
  systemLikeRate,
}: {
  missRate: number | null | undefined;
  missedTriggers: number | null | undefined;
  systemLikeRate: number | null | undefined;
}) {
  if ((missedTriggers ?? 0) > 0 && missRate != null) {
    return `It found ${missedTriggers} likely misses (${formatRate(missRate)} miss rate), which means people asked for this skill and it probably should have triggered.`;
  }
  if ((systemLikeRate ?? 0) > 0.05) {
    return `Routing looks mostly stable, but some records appear system-generated, so selftune is being cautious about making strong claims.`;
  }
  return `Routing looks consistent in the current sample, with no strong signs that this skill is missing obvious requests.`;
}

function narrativeDecisionText({
  trustState,
  latestAction,
  nextActionText,
}: {
  trustState: TrustState;
  latestAction?: string | null;
  nextActionText: string;
}) {
  switch (trustState) {
    case "validated":
      return `Selftune found a candidate that looks promising, but it has not been deployed yet. ${nextActionText}`;
    case "deployed":
      return `A change has already been deployed for this skill. Selftune is now watching for regressions in real use.`;
    case "rolled_back":
      return `A previous change was rolled back, so the live skill is back on the safer version while selftune keeps observing.`;
    case "watch":
      return `Selftune sees enough signal to keep a close eye on this skill, but not enough to blindly change it. ${nextActionText}`;
    case "observed":
      return `Selftune is still learning how people use this skill before making stronger recommendations.`;
    case "low_sample":
      return `There is not enough evidence yet to trust a big change here. Selftune is still collecting examples.`;
    default:
      return latestAction
        ? `The latest automated decision for this skill was ${latestAction}. ${nextActionText}`
        : nextActionText;
  }
}

function StoryStep({ title, icon, body }: { title: string; icon: ReactNode; body: string }) {
  return (
    <div className="rounded-xl border border-border/10 bg-muted/20 p-4">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-primary/80">{icon}</div>
        <h3 className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </h3>
      </div>
      <p className="text-sm leading-6 text-foreground/90">{body}</p>
    </div>
  );
}

export function SkillTrustNarrativePanel({
  trustState,
  coverage,
  evidenceQuality,
  routingQuality,
  evolutionState,
  dataHygiene,
  fallbackChecks,
  fallbackSessions,
  nextActionText,
  onOpenGuide,
}: {
  trustState: TrustState;
  coverage?: TrustFields["coverage"];
  evidenceQuality?: TrustFields["evidence_quality"];
  routingQuality?: TrustFields["routing_quality"];
  evolutionState?: TrustFields["evolution_state"];
  dataHygiene?: TrustFields["data_hygiene"];
  fallbackChecks: number;
  fallbackSessions: number;
  nextActionText: string;
  onOpenGuide?: () => void;
}) {
  const checks = coverage?.checks ?? fallbackChecks;
  const sessions = coverage?.sessions ?? fallbackSessions;
  const rawChecks = dataHygiene?.raw_checks ?? checks;
  const internalRows = dataHygiene?.internal_prompt_rows ?? 0;
  const legacyRows = dataHygiene?.legacy_rows ?? 0;
  const repairedRows = dataHygiene?.repaired_rows ?? 0;
  const excludedRows = Math.max(rawChecks - checks, 0);
  const showTrustNote = excludedRows > 0 || legacyRows > 0 || repairedRows > 0;

  return (
    <Card className="rounded-xl border border-border/10 bg-card/95">
      <CardHeader className="gap-2 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">How selftune is improving this skill</CardTitle>
            <CardDescription>
              Read this first if you want the plain-English version before diving into the evidence
              below.
            </CardDescription>
          </div>
          {onOpenGuide && (
            <Button variant="outline" size="sm" onClick={onOpenGuide}>
              How to read this page
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 pt-0">
        {showTrustNote && (
          <div className="rounded-xl border border-primary/10 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Trust note:</span> This summary is based
            on <span className="font-medium text-foreground">{checks}</span> operational checks from
            real usage.
            {internalRows > 0 && (
              <>
                {" "}
                <span className="font-medium text-foreground">{internalRows}</span> internal
                selftune eval or optimizer prompts are excluded from trust scoring.
              </>
            )}
            {legacyRows > 0 && (
              <>
                {" "}
                <span className="font-medium text-foreground">{legacyRows}</span> legacy rows stay
                in history only.
              </>
            )}
            {repairedRows > 0 && (
              <>
                {" "}
                <span className="font-medium text-foreground">{repairedRows}</span> repaired misses
                come from transcript replay rather than first-party trigger events.
              </>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 @4xl/main:grid-cols-3">
          <StoryStep
            title="What selftune saw"
            icon={<ActivityIcon className="size-4" />}
            body={narrativeObservedText({
              checks,
              sessions,
              promptLinkRate: evidenceQuality?.prompt_link_rate,
            })}
          />
          <StoryStep
            title="Why it acted"
            icon={<SearchIcon className="size-4" />}
            body={narrativeDiagnosisText({
              missRate: routingQuality?.miss_rate,
              missedTriggers: routingQuality?.missed_triggers,
              systemLikeRate: evidenceQuality?.system_like_rate,
            })}
          />
          <StoryStep
            title="What happened next"
            icon={<GitBranchIcon className="size-4" />}
            body={narrativeDecisionText({
              trustState,
              latestAction: evolutionState?.latest_action,
              nextActionText,
            })}
          />
        </div>
        <div className="rounded-xl border border-border/10 bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
          If a proposal is rejected or still pending, your live skill has not changed yet. Selftune
          only earns trust by testing changes before deployment.
        </div>
      </CardContent>
    </Card>
  );
}

export function TrustSignalsGrid({
  coverage,
  evidenceQuality,
  routingQuality,
  evolutionState,
  fallbackChecks,
  fallbackSessions,
  fallbackEvidenceRows,
  fallbackEvolutionRows,
  fallbackLatestAction,
}: {
  coverage?: TrustFields["coverage"];
  evidenceQuality?: TrustFields["evidence_quality"];
  routingQuality?: TrustFields["routing_quality"];
  evolutionState?: TrustFields["evolution_state"];
  fallbackChecks: number;
  fallbackSessions: number;
  fallbackEvidenceRows: number;
  fallbackEvolutionRows: number;
  fallbackLatestAction?: string;
}) {
  const hasEvolutionData = (evolutionState?.evolution_rows ?? fallbackEvolutionRows) > 0;

  return (
    <div>
      <h2 className="mb-2 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        Trust Signals
      </h2>
      <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        <Card className="rounded-xl border border-border/10 bg-muted/20 transition-colors hover:border-border/20 @container/card">
          <CardHeader className="gap-2 px-4 py-3">
            <CardDescription className="flex items-center gap-1.5">
              <ActivityIcon className="size-3.5" />
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Coverage
              </span>
            </CardDescription>
            <CardTitle className="text-[32px] font-semibold leading-none tabular-nums text-foreground">
              {coverage?.checks ?? fallbackChecks}
            </CardTitle>
            <CardAction>
              <span className="font-mono text-[10px] text-muted-foreground">
                {coverage?.sessions ?? fallbackSessions} sessions /{" "}
                {coverage?.workspaces ?? "No data"} dirs
              </span>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="rounded-xl border border-border/10 bg-muted/20 transition-colors hover:border-border/20 @container/card">
          <CardHeader className="gap-2 px-4 py-3">
            <CardDescription className="flex items-center gap-1.5">
              <SearchIcon className="size-3.5" />
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Evidence Quality
              </span>
              <InfoTip text="How well prompts are linked to invocations. Higher prompt-link rate = more trustworthy data." />
            </CardDescription>
            <CardTitle className="text-[32px] font-semibold leading-none tabular-nums text-foreground">
              {evidenceQuality?.prompt_link_rate != null
                ? formatRate(evidenceQuality.prompt_link_rate)
                : "No data"}
            </CardTitle>
            <CardAction>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[10px] text-muted-foreground">
                  inline:{" "}
                  {evidenceQuality?.inline_query_rate != null
                    ? formatRate(evidenceQuality.inline_query_rate)
                    : "No data"}
                </span>
                {(evidenceQuality?.system_like_rate ?? 0) > 0.05 && (
                  <Badge variant="destructive" className="text-[9px]">
                    {formatRate(evidenceQuality?.system_like_rate ?? 0)} system-like
                  </Badge>
                )}
              </div>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="rounded-xl border border-border/10 bg-muted/20 transition-colors hover:border-border/20 @container/card">
          <CardHeader className="gap-2 px-4 py-3">
            <CardDescription className="flex items-center gap-1.5">
              <TargetIcon className="size-3.5" />
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Routing
              </span>
              <InfoTip text="Routing accuracy: average confidence when triggering, and miss rate" />
            </CardDescription>
            <CardTitle className="text-[32px] font-semibold leading-none tabular-nums text-foreground">
              {routingQuality?.avg_confidence != null
                ? formatRate(routingQuality.avg_confidence)
                : "No data"}
            </CardTitle>
            <CardAction>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[10px] text-muted-foreground">
                  miss:{" "}
                  {routingQuality?.miss_rate != null
                    ? formatRate(routingQuality.miss_rate)
                    : "No data"}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {routingQuality?.missed_triggers ?? "No data"} missed
                </span>
              </div>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="rounded-xl border border-border/10 bg-muted/20 transition-colors hover:border-border/20 @container/card">
          <CardHeader className="gap-2 px-4 py-3">
            <CardDescription className="flex items-center gap-1.5">
              <GitBranchIcon className="size-3.5" />
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Evolution
              </span>
            </CardDescription>
            {hasEvolutionData ? (
              <>
                <CardTitle className="text-sm font-medium leading-6">
                  {evolutionState?.latest_action ?? fallbackLatestAction ?? "No data"}
                </CardTitle>
                <CardAction>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {evolutionState?.evidence_rows ?? fallbackEvidenceRows} evidence
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {evolutionState?.evolution_rows ?? fallbackEvolutionRows} evolution
                    </span>
                    {evolutionState?.latest_timestamp && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {timeAgo(evolutionState.latest_timestamp)}
                      </span>
                    )}
                  </div>
                </CardAction>
              </>
            ) : (
              <CardTitle className="text-sm font-normal text-muted-foreground">
                No evolution yet
              </CardTitle>
            )}
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}

export function PromptEvidencePanel({ examples }: { examples?: TrustFields["examples"] }) {
  if (!examples) return null;
  if (examples.good.length === 0 && examples.missed.length === 0 && examples.noisy.length === 0) {
    return null;
  }

  return (
    <Card className="rounded-xl border border-border/10 bg-card/90">
      <CardHeader className="px-4 pb-2 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Prompt Evidence
            </CardTitle>
            <CardDescription>
              Representative real usage first. Internal selftune traffic is separated so it does not
              masquerade as normal skill use.
            </CardDescription>
          </div>
          <div className="hidden items-center gap-2 text-[10px] text-muted-foreground @3xl/main:flex">
            <span>{examples.good.length} successful</span>
            <span className="text-border">|</span>
            <span>{examples.missed.length} missed</span>
            <span className="text-border">|</span>
            <span>{examples.noisy.length} internal/polluted</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        <Tabs defaultValue="good">
          <TabsList
            variant="line"
            className="min-h-0 rounded-xl border border-border/10 bg-muted/20 px-1.5 py-1"
          >
            <TabsTrigger
              value="good"
              className="rounded-lg px-3 data-active:bg-background/70 data-active:text-foreground"
            >
              Successful Triggers
              <Badge variant="outline" className="ml-1.5 text-[10px]">
                {examples.good.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="missed"
              className="rounded-lg px-3 data-active:bg-background/70 data-active:text-foreground"
            >
              Missed Real Usage
              <Badge
                variant={examples.missed.length > 0 ? "destructive" : "outline"}
                className="ml-1.5 text-[10px]"
              >
                {examples.missed.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="noisy"
              className="rounded-lg px-3 data-active:bg-background/70 data-active:text-foreground"
            >
              Internal / Polluted
              <Badge
                variant={examples.noisy.length > 0 ? "destructive" : "outline"}
                className="ml-1.5 text-[10px]"
              >
                {examples.noisy.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="good" className="mt-2">
            <ExamplesTable rows={examples.good} emptyMessage="No successful trigger samples yet." />
          </TabsContent>
          <TabsContent value="missed" className="mt-2">
            <ExamplesTable
              rows={examples.missed}
              emptyMessage="No missed real-usage samples detected."
            />
          </TabsContent>
          <TabsContent value="noisy" className="mt-2">
            <ExamplesTable
              rows={examples.noisy}
              emptyMessage="No internal or polluted samples detected."
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function DataQualityPanel({
  evidenceQuality,
  dataHygiene,
}: {
  evidenceQuality?: TrustFields["evidence_quality"];
  dataHygiene?: TrustFields["data_hygiene"];
}) {
  return (
    <div className="grid grid-cols-1 gap-6 @5xl/main:grid-cols-2 @5xl/main:items-start">
      <Card className="rounded-2xl border border-border/15 bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            <BarChart3Icon className="size-4" />
            Evidence Quality Rates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          <RateBar label="Prompt-linked" value={evidenceQuality?.prompt_link_rate} />
          <RateBar label="Inline query" value={evidenceQuality?.inline_query_rate} />
          <RateBar label="User prompt" value={evidenceQuality?.user_prompt_rate} />
          <RateBar label="Meta prompt" value={evidenceQuality?.meta_prompt_rate} />
          <RateBar label="No prompt" value={evidenceQuality?.no_prompt_rate} />
          <RateBar
            label="System-like"
            value={evidenceQuality?.system_like_rate}
            warn={(evidenceQuality?.system_like_rate ?? 0) > 0.05}
          />
          <div className="mt-3 border-t border-border/40 pt-3" />
          <RateBar label="Invocation mode" value={evidenceQuality?.invocation_mode_coverage} />
          <RateBar label="Confidence" value={evidenceQuality?.confidence_coverage} />
          <RateBar label="Source" value={evidenceQuality?.source_coverage} />
          <RateBar label="Scope" value={evidenceQuality?.scope_coverage} />
        </CardContent>
      </Card>

      {dataHygiene && (
        <Card className="rounded-2xl border border-border/15 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <DatabaseIcon className="size-4" />
              Data Hygiene
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border/15 bg-muted/30 p-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Raw vs Operational
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <div className="text-lg font-semibold tabular-nums text-foreground">
                    {dataHygiene.operational_checks}
                  </div>
                  <div className="pb-0.5 text-xs text-muted-foreground">
                    of {dataHygiene.raw_checks} checks
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Operational checks exclude internal selftune eval and optimizer traffic.
                </p>
              </div>
              <div className="rounded-xl border border-border/15 bg-muted/30 p-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Historical Residue
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <div className="text-lg font-semibold tabular-nums text-foreground">
                    {dataHygiene.legacy_rows}
                  </div>
                  <div className="pb-0.5 text-xs text-muted-foreground">
                    legacy / {dataHygiene.repaired_rows} repaired
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Legacy rows are older materialized history. Repaired rows are transcript-based
                  reconstructions.
                </p>
              </div>
            </div>

            {dataHygiene.naming_variants && dataHygiene.naming_variants.length > 1 && (
              <div>
                <h4 className="mb-2 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Naming Variants
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {dataHygiene.naming_variants.map((v) => (
                    <Badge key={v} variant="outline" className="font-mono text-[10px]">
                      {v}
                    </Badge>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Multiple naming variants may indicate inconsistent skill registration.
                </p>
              </div>
            )}

            <BreakdownTable title="Source Breakdown" data={dataHygiene.source_breakdown} />
            <BreakdownTable
              title="Prompt Kind Breakdown"
              data={dataHygiene.prompt_kind_breakdown}
            />
            <BreakdownTable
              title="Observation Breakdown"
              data={dataHygiene.observation_breakdown}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
