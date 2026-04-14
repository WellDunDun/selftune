import { useSyncExternalStore } from "react";

import type {
  DashboardActionEvent,
  DashboardActionMetrics,
  DashboardActionName,
  DashboardActionProgress,
  DashboardActionResultSummary,
} from "@/types";

export interface LiveActionLogEntry {
  id: string;
  stage: "stdout" | "stderr" | "progress" | "metrics";
  text: string;
  ts: number;
}

export interface LiveActionEntry {
  id: string;
  action: DashboardActionName;
  skillName: string | null;
  skillPath: string | null;
  status: "running" | "success" | "error";
  startedAt: number;
  updatedAt: number;
  output: string[];
  logs: LiveActionLogEntry[];
  error: string | null;
  exitCode: number | null;
  summary: DashboardActionResultSummary | null;
  metrics: DashboardActionMetrics | null;
  progress: DashboardActionProgress | null;
}

export interface LiveActionSelection {
  eventId?: string | null;
  skillName?: string | null;
  action?: DashboardActionName | null;
  preferRunning?: boolean;
}

const listeners = new Set<() => void>();
let liveActionEntries: LiveActionEntry[] = [];
const seenActionEventKeys: string[] = [];
const seenActionEventKeySet = new Set<string>();

const MAX_ENTRIES = 24;
const MAX_OUTPUT_LINES = 8;
const MAX_LOG_LINES = 240;
const MAX_SEEN_ACTION_EVENTS = 2048;

function emitChange(): void {
  for (const listener of listeners) listener();
}

function trimOutput(lines: string[]): string[] {
  return lines.filter(Boolean).slice(-MAX_OUTPUT_LINES);
}

function trimLogs(lines: LiveActionLogEntry[]): LiveActionLogEntry[] {
  return lines.slice(-MAX_LOG_LINES);
}

function rememberSeenActionEvent(key: string): void {
  if (seenActionEventKeySet.has(key)) return;
  seenActionEventKeySet.add(key);
  seenActionEventKeys.push(key);
  if (seenActionEventKeys.length <= MAX_SEEN_ACTION_EVENTS) return;
  const oldestKey = seenActionEventKeys.shift();
  if (oldestKey) seenActionEventKeySet.delete(oldestKey);
}

function splitChunk(chunk: string | undefined): string[] {
  if (!chunk) return [];
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sortEntries(entries: LiveActionEntry[]): LiveActionEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeMetrics(
  previous: DashboardActionMetrics | null,
  next: DashboardActionMetrics | null | undefined,
): DashboardActionMetrics | null {
  if (!next) return previous;
  if (!previous) return next;

  return {
    platform: next.platform ?? previous.platform,
    model: next.model ?? previous.model,
    session_id: next.session_id ?? previous.session_id,
    input_tokens: next.input_tokens ?? previous.input_tokens,
    output_tokens: next.output_tokens ?? previous.output_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? previous.cache_creation_input_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? previous.cache_read_input_tokens,
    total_cost_usd: next.total_cost_usd ?? previous.total_cost_usd,
    duration_ms: next.duration_ms ?? previous.duration_ms,
    num_turns: next.num_turns ?? previous.num_turns,
  };
}

function mergeProgress(
  previous: DashboardActionProgress | null,
  next: DashboardActionProgress | null | undefined,
): DashboardActionProgress | null {
  if (!next) return previous;
  if (!previous) return next;

  return {
    current: next.current ?? previous.current,
    total: next.total ?? previous.total,
    status: next.status ?? previous.status,
    unit: next.unit ?? previous.unit,
    phase: next.phase ?? previous.phase,
    label: next.label ?? previous.label,
    query: next.query ?? previous.query,
    passed: next.passed ?? previous.passed,
    evidence: next.evidence ?? previous.evidence,
  };
}

function buildActionEventKey(event: DashboardActionEvent): string {
  return JSON.stringify({
    event_id: event.event_id,
    action: event.action,
    stage: event.stage,
    ts: event.ts,
    chunk: event.chunk ?? null,
    success: event.success ?? null,
    exit_code: event.exit_code ?? null,
    error: event.error ?? null,
    summary: event.summary ?? null,
    metrics: event.metrics ?? null,
    progress: event.progress ?? null,
  });
}

function appendLogEntries(
  entry: LiveActionEntry,
  lines: LiveActionLogEntry[],
  output: string[] = [],
): void {
  entry.logs = trimLogs([...entry.logs, ...lines]);
  if (output.length > 0) {
    entry.output = trimOutput([...entry.output, ...output]);
  }
}

function titleCaseProgressUnit(unit: DashboardActionProgress["unit"]): string {
  switch (unit) {
    case "llm_call":
      return "Call";
    case "step":
      return "Step";
    case "eval":
    default:
      return "Eval";
  }
}

function formatProgressLog(progress: DashboardActionProgress): string {
  const prefix = `${titleCaseProgressUnit(progress.unit)} ${progress.current}/${progress.total}`;
  const detailLabel = progress.label ?? progress.query;
  const phase = progress.phase ? progress.phase.replaceAll("_", " ") : null;
  if (progress.status === "started") {
    const detail = [phase, detailLabel].filter(Boolean).join(" · ");
    return detail ? `${prefix} started · ${detail}` : `${prefix} started`;
  }

  const outcome = progress.passed == null ? "finished" : progress.passed ? "passed" : "failed";
  const detail = [phase, detailLabel, progress.evidence].filter(Boolean).join(" · ");
  return detail ? `${prefix} ${outcome} · ${detail}` : `${prefix} ${outcome}`;
}

function formatMetricsLog(metrics: DashboardActionMetrics): string | null {
  const parts = [
    metrics.platform,
    metrics.model,
    metrics.session_id ? `session ${metrics.session_id}` : null,
    metrics.input_tokens != null ? `in ${Math.round(metrics.input_tokens).toLocaleString()}` : null,
    metrics.output_tokens != null
      ? `out ${Math.round(metrics.output_tokens).toLocaleString()}`
      : null,
    metrics.total_cost_usd != null ? `$${metrics.total_cost_usd.toFixed(4)}` : null,
    metrics.duration_ms != null ? `${(metrics.duration_ms / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);

  if (parts.length === 0) return null;
  return `Runtime metrics · ${parts.join(" · ")}`;
}

export function ingestDashboardActionEvent(event: DashboardActionEvent): boolean {
  const eventKey = buildActionEventKey(event);
  if (seenActionEventKeySet.has(eventKey)) return false;
  rememberSeenActionEvent(eventKey);

  const existing = liveActionEntries.find((entry) => entry.id === event.event_id);

  if (event.stage === "started") {
    const nextEntry: LiveActionEntry = {
      id: event.event_id,
      action: event.action,
      skillName: event.skill_name,
      skillPath: event.skill_path,
      status: "running",
      startedAt: event.ts,
      updatedAt: event.ts,
      output: [],
      logs: [],
      error: null,
      exitCode: null,
      summary: null,
      metrics: null,
      progress: null,
    };
    liveActionEntries = [
      nextEntry,
      ...liveActionEntries.filter((entry) => entry.id !== event.event_id),
    ].slice(0, MAX_ENTRIES);
    emitChange();
    return true;
  }

  if (!existing) return false;

  if (event.stage === "stdout" || event.stage === "stderr") {
    const stage = event.stage;
    const nextLines = splitChunk(event.chunk);
    existing.updatedAt = event.ts;
    appendLogEntries(
      existing,
      nextLines.map((line, index) => ({
        id: `${event.event_id}:${event.ts}:${stage}:${index}`,
        stage,
        text: line,
        ts: event.ts,
      })),
      nextLines,
    );
    if (stage === "stderr" && event.chunk?.trim()) {
      existing.error = event.chunk.trim();
    }
    liveActionEntries = sortEntries(liveActionEntries);
    emitChange();
    return true;
  }

  if (event.stage === "progress") {
    existing.updatedAt = event.ts;
    existing.progress = mergeProgress(existing.progress, event.progress);
    if (event.progress) {
      const text = formatProgressLog(event.progress);
      appendLogEntries(
        existing,
        [
          {
            id: `${event.event_id}:${event.ts}:progress:${event.progress.status}:${event.progress.current}`,
            stage: "progress",
            text,
            ts: event.ts,
          },
        ],
        [text],
      );
    }
    liveActionEntries = sortEntries(liveActionEntries);
    emitChange();
    return true;
  }

  if (event.stage === "finished") {
    existing.updatedAt = event.ts;
    existing.status = event.success ? "success" : "error";
    existing.error = event.error ?? existing.error;
    existing.exitCode = event.exit_code ?? null;
    existing.summary = event.summary ?? existing.summary;
    existing.metrics = mergeMetrics(existing.metrics, event.metrics);
    existing.progress = mergeProgress(existing.progress, event.progress);
    liveActionEntries = sortEntries(liveActionEntries);
    emitChange();
    return true;
  }

  if (event.stage === "metrics") {
    existing.updatedAt = event.ts;
    existing.metrics = mergeMetrics(existing.metrics, event.metrics);
    if (event.metrics) {
      const text = formatMetricsLog(event.metrics);
      if (text) {
        appendLogEntries(
          existing,
          [
            {
              id: `${event.event_id}:${event.ts}:metrics`,
              stage: "metrics",
              text,
              ts: event.ts,
            },
          ],
          [text],
        );
      }
    }
    liveActionEntries = sortEntries(liveActionEntries);
    emitChange();
    return true;
  }

  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LiveActionEntry[] {
  return liveActionEntries;
}

export function useLiveActionFeed(): LiveActionEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function selectLiveActionEntry(
  entries: LiveActionEntry[],
  selection: LiveActionSelection,
): LiveActionEntry | null {
  const { eventId, skillName, action, preferRunning = true } = selection;

  if (eventId) {
    return entries.find((entry) => entry.id === eventId) ?? null;
  }

  const filtered = entries.filter((entry) => {
    if (skillName && entry.skillName !== skillName) return false;
    if (action && entry.action !== action) return false;
    return true;
  });

  if (filtered.length === 0) return null;
  if (!preferRunning) return filtered[0] ?? null;
  return filtered.find((entry) => entry.status === "running") ?? filtered[0] ?? null;
}

export function useSelectedLiveActionEntry(selection: LiveActionSelection): LiveActionEntry | null {
  const entries = useLiveActionFeed();
  return selectLiveActionEntry(entries, selection);
}

export function formatActionLabel(action: DashboardActionName): string {
  switch (action) {
    case "generate-evals":
      return "Generate evals";
    case "generate-unit-tests":
      return "Generate unit tests";
    case "replay-dry-run":
      return "Replay dry-run";
    case "measure-baseline":
      return "Measure baseline";
    case "deploy-candidate":
      return "Deploy candidate";
    case "watch":
      return "Watch deployment";
    case "orchestrate":
      return "Orchestrate";
    case "rollback":
      return "Rollback";
  }

  return action;
}
