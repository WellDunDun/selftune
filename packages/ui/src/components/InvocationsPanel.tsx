import { useMemo, useState } from "react";
import { ChevronRightIcon, FilterIcon } from "lucide-react";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives";
import { InfoTip } from "./InfoTip";
import { observationBadge, historicalContextBadge } from "./SkillReportPanels";
import { timeAgo } from "../lib/format";

import type { ObservationKind, HistoricalContext } from "../types";

/* ─── Public types ────────────────────────────────────── */

export interface InvocationRow {
  timestamp: string | null;
  session_id: string | null;
  triggered: boolean;
  query: string;
  invocation_mode: string | null;
  confidence: number | null;
  tool_name: string | null;
  agent_type: string | null;
  observation_kind?: ObservationKind | null;
  historical_context?: HistoricalContext | null;
}

export interface SessionMeta {
  session_id: string;
  started_at?: string | null;
  model?: string | null;
  workspace_path?: string | null;
  platform?: string | null;
  agent_cli?: string | null;
}

export type InvocationFilter = "all" | "misses" | "low_confidence";

/* ─── Session group ───────────────────────────────────── */

function SessionGroup({
  sessionId,
  meta,
  invocations,
  defaultExpanded,
}: {
  sessionId: string;
  meta?: SessionMeta;
  invocations: InvocationRow[];
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const ts = meta?.started_at ?? invocations[0]?.timestamp;

  const modeBreakdown = invocations.reduce(
    (acc, inv) => {
      const mode = inv.invocation_mode ?? "unknown";
      acc[mode] = (acc[mode] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const formatInvoker = (inv: InvocationRow): { label: string; hint: string } => {
    const cli = meta?.agent_cli?.replace(/_/g, " ");
    const platform = meta?.platform?.replace(/_/g, " ");

    if (inv.agent_type && inv.agent_type !== "main") {
      return {
        label: inv.agent_type,
        hint: cli ? `${cli} subagent` : "subagent invocation",
      };
    }
    if (cli) {
      return {
        label: cli,
        hint:
          inv.agent_type === "main"
            ? "main agent invocation"
            : "session agent that invoked the skill",
      };
    }
    if (platform) {
      return {
        label: platform,
        hint: inv.agent_type === "main" ? "main agent invocation" : "session platform",
      };
    }
    if (inv.agent_type) {
      return { label: inv.agent_type, hint: "recorded subagent type" };
    }
    return {
      label: "No data",
      hint: "invoker was not captured in this record",
    };
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 transition-colors dark:border-slate-800">
      {/* Session header */}
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-slate-800/40 dark:active:bg-slate-800/60"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-slate-400 transition-transform duration-150 dark:text-slate-500 ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-900 dark:text-white">
              {invocations.length} invocation
              {invocations.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {ts ? timeAgo(ts) : ""}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {meta?.model && (
              <Badge variant="secondary" className="text-[10px] font-normal">
                {meta.model}
              </Badge>
            )}
            {meta?.workspace_path && (
              <span
                className="font-mono text-[11px] text-slate-500 dark:text-slate-400"
                title={meta.workspace_path}
              >
                {meta.workspace_path.split("/").slice(-2).join("/")}
              </span>
            )}
          </div>
        </div>

        {/* Compact mode summary when collapsed */}
        {!expanded && (
          <div className="flex shrink-0 items-center gap-1">
            {Object.entries(modeBreakdown).map(([mode, count]) => (
              <Badge key={mode} variant="outline" className="gap-1 text-[10px] font-normal">
                {mode} <span className="text-slate-400 dark:text-slate-500">{count}</span>
              </Badge>
            ))}
          </div>
        )}
        <span className="shrink-0 font-mono text-[10px] text-slate-300 dark:text-slate-600">
          {sessionId.substring(0, 8)}
        </span>
      </button>

      {/* Invocation table */}
      {expanded && (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 hover:bg-slate-50 dark:bg-slate-800/40 dark:hover:bg-slate-800/40">
                <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Prompt <InfoTip text="The user prompt that led to this skill being invoked" />
                </TableHead>
                <TableHead className="h-8 w-[90px] text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Mode{" "}
                  <InfoTip text="explicit = user typed /skillname; implicit = user mentioned skill by name; inferred = agent chose skill autonomously" />
                </TableHead>
                <TableHead className="h-8 w-[70px] text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Confidence{" "}
                  <InfoTip text="Model's confidence score (0-100%) when routing this prompt to the skill" />
                </TableHead>
                <TableHead className="h-8 w-[110px] text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Invoker{" "}
                  <InfoTip text="Who invoked the skill. Prefers subagent type when present, otherwise falls back to the session agent or platform." />
                </TableHead>
                <TableHead className="h-8 w-[120px] text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Evidence
                </TableHead>
                <TableHead className="h-8 w-[70px] text-right text-[10px] font-semibold uppercase tracking-[0.15em]">
                  Time
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invocations.map((inv, i) => (
                <TableRow
                  key={i}
                  className={!inv.triggered ? "bg-red-50/50 dark:bg-red-950/10" : ""}
                >
                  <TableCell
                    className="max-w-[500px] truncate py-2 text-sm"
                    title={inv.query || undefined}
                  >
                    {inv.query || (
                      <span className="italic text-slate-300 dark:text-slate-600">
                        No prompt recorded
                      </span>
                    )}
                    {!inv.triggered && (
                      <Badge variant="destructive" className="ml-2 text-[10px] font-normal">
                        missed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    {inv.invocation_mode ? (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {inv.invocation_mode}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-slate-400 dark:text-slate-500">
                        Unknown mode
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                    {inv.confidence !== null
                      ? `${Math.round(inv.confidence * 100)}%`
                      : "Not recorded"}
                  </TableCell>
                  <TableCell className="py-2">
                    {(() => {
                      const invoker = formatInvoker(inv);
                      return invoker.label === "No data" ? (
                        <span
                          className="text-[11px] text-slate-400 dark:text-slate-500"
                          title={invoker.hint}
                        >
                          {invoker.label}
                        </span>
                      ) : (
                        <Badge
                          variant={
                            inv.agent_type && inv.agent_type !== "main" ? "outline" : "secondary"
                          }
                          className="text-[10px] font-normal capitalize"
                          title={invoker.hint}
                        >
                          {invoker.label}
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="py-2">
                    {(() => {
                      const observation = observationBadge(inv.observation_kind);
                      const historicalCtx = historicalContextBadge(inv.historical_context);
                      return observation ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={observation.variant} className="text-[10px] font-normal">
                            {observation.label}
                          </Badge>
                          {historicalCtx && (
                            <Badge
                              variant={historicalCtx.variant}
                              className="text-[10px] font-normal"
                            >
                              {historicalCtx.label}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-slate-400 dark:text-slate-500">
                            canonical
                          </span>
                          {historicalCtx && (
                            <Badge
                              variant={historicalCtx.variant}
                              className="text-[10px] font-normal"
                            >
                              {historicalCtx.label}
                            </Badge>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2 text-right font-mono text-[11px] text-slate-400 dark:text-slate-500">
                    {inv.timestamp ? timeAgo(inv.timestamp) : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ─── InvocationsPanel ────────────────────────────────── */

export function InvocationsPanel({
  invocations,
  sessionMetadata = [],
}: {
  invocations: InvocationRow[];
  sessionMetadata?: SessionMeta[];
}) {
  const [filter, setFilter] = useState<InvocationFilter>("all");

  const sessionMetaMap = useMemo(
    () => new Map(sessionMetadata.map((s) => [s.session_id, s])),
    [sessionMetadata],
  );

  const filtered = useMemo(() => {
    switch (filter) {
      case "misses":
        return invocations.filter((i) => !i.triggered);
      case "low_confidence":
        return invocations.filter((i) => i.confidence !== null && i.confidence < 0.5);
      default:
        return invocations;
    }
  }, [invocations, filter]);

  const groupedSessions = useMemo(() => {
    const sessionMap = new Map<string, InvocationRow[]>();
    for (const inv of filtered) {
      const sid = inv.session_id ?? "unknown";
      const arr = sessionMap.get(sid);
      if (arr) arr.push(inv);
      else sessionMap.set(sid, [inv]);
    }
    return [...sessionMap.entries()].sort(([, a], [, b]) =>
      (b[0]?.timestamp ?? "").localeCompare(a[0]?.timestamp ?? ""),
    );
  }, [filtered]);

  if (invocations.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-300 py-12 dark:border-slate-700">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No invocation records yet. Invocations appear when skills are triggered during real
          sessions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterIcon className="size-3.5 text-slate-400 dark:text-slate-500" />
          {(
            [
              ["all", "All"],
              ["misses", "Misses"],
              ["low_confidence", "Low confidence"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setFilter(key)} className="inline-block">
              <Badge
                variant={filter === key ? "default" : "outline"}
                className="cursor-pointer text-[10px]"
              >
                {label}
              </Badge>
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {filtered.length} invocations across {groupedSessions.length} sessions
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-slate-400" />
          explicit = user typed /skill
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-slate-400" />
          implicit = mentioned by name
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-slate-400" />
          inferred = agent chose autonomously
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-red-400" />
          missed = skill should have triggered
        </span>
      </div>

      {/* Session groups */}
      {groupedSessions.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-slate-500 dark:text-slate-400">
          No invocations match this filter.
        </div>
      ) : (
        groupedSessions.map(([sessionId, sessionInvocations], idx) => {
          const meta = sessionMetaMap.get(sessionId);
          return (
            <SessionGroup
              key={sessionId}
              sessionId={sessionId}
              meta={meta}
              invocations={sessionInvocations}
              defaultExpanded={idx < 3}
            />
          );
        })
      )}
    </div>
  );
}
