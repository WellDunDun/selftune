import {
  emitDashboardActionMetrics,
  emitDashboardActionProgress,
} from "./dashboard-action-events.js";
import type {
  DashboardActionMetrics,
  DashboardActionProgress,
  DashboardActionProgressUnit,
} from "./dashboard-contract.js";
import type { LlmCallObserver, LlmCallLifecycleEvent } from "./utils/llm-call.js";

export interface DashboardStepProgressOptions {
  current: number;
  total: number;
  status: DashboardActionProgress["status"];
  unit?: DashboardActionProgressUnit;
  phase?: string | null;
  label?: string | null;
  query?: string | null;
  passed?: boolean | null;
  evidence?: string | null;
}

export interface DashboardLlmObserverOptions {
  current: number;
  total: number;
  phase: string;
  label: string;
}

function buildRuntimeMetrics(event: LlmCallLifecycleEvent): DashboardActionMetrics {
  return {
    platform: event.platform,
    model: event.model,
    session_id: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    total_cost_usd: null,
    duration_ms: event.durationMs,
    num_turns: null,
  };
}

function describeInvocation(event: LlmCallLifecycleEvent): string {
  const parts = [event.platform, event.model].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "runtime invoked";
}

function describeCompletion(event: LlmCallLifecycleEvent): string {
  const durationText =
    event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : "completed";
  if (event.success === false && event.error) {
    return event.error;
  }
  return `${describeInvocation(event)} · ${durationText}`;
}

export function emitDashboardStepProgress(options: DashboardStepProgressOptions): void {
  emitDashboardActionProgress({
    current: options.current,
    total: options.total,
    status: options.status,
    unit: options.unit ?? "step",
    phase: options.phase ?? null,
    label: options.label ?? null,
    query: options.query ?? null,
    passed: options.passed ?? null,
    evidence: options.evidence ?? null,
  });
}

export function createDashboardLlmObserver(options: DashboardLlmObserverOptions): LlmCallObserver {
  return {
    onStart(event) {
      emitDashboardActionMetrics(buildRuntimeMetrics(event));
      emitDashboardStepProgress({
        current: options.current,
        total: options.total,
        status: "started",
        unit: "llm_call",
        phase: options.phase,
        label: options.label,
        passed: null,
        evidence: describeInvocation(event),
      });
    },
    onFinish(event) {
      emitDashboardActionMetrics(buildRuntimeMetrics(event));
      emitDashboardStepProgress({
        current: options.current,
        total: options.total,
        status: "finished",
        unit: "llm_call",
        phase: options.phase,
        label: options.label,
        passed: event.success,
        evidence: describeCompletion(event),
      });
    },
  };
}
