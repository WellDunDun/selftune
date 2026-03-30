import { InfoTip } from "@selftune/ui/components";
import { timeAgo } from "@selftune/ui/lib";
import { Badge, Button } from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  FileTextIcon,
  HardDriveIcon,
  HeartPulseIcon,
  PlugIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useDoctor } from "@/hooks/useDoctor";
import type { HealthCheck, HealthStatus } from "@/types";

const STATUS_DISPLAY: Record<
  HealthStatus,
  {
    color: string;
    label: string;
    dotColor: string;
    dotGlow: string;
    animate: boolean;
  }
> = {
  pass: {
    color: "text-primary",
    label: "Pass",
    dotColor: "bg-primary",
    dotGlow: "shadow-[0_0_8px_rgba(79,242,255,0.6)]",
    animate: true,
  },
  warn: {
    color: "text-amber-400",
    label: "Warn",
    dotColor: "bg-amber-400",
    dotGlow: "",
    animate: false,
  },
  fail: {
    color: "text-destructive",
    label: "Fail",
    dotColor: "bg-destructive",
    dotGlow: "shadow-[0_0_8px_rgba(255,180,171,0.6)]",
    animate: false,
  },
};

const CHECK_META: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  config: {
    label: "Configuration",
    description: "selftune.json exists and contains valid agent_type and llm_mode",
    icon: <SettingsIcon className="size-4" />,
  },
  log_session_telemetry: {
    label: "Session Telemetry Log",
    description: "session_telemetry_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4" />,
  },
  log_skill_usage: {
    label: "Skill Usage Log",
    description: "skill_usage_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4" />,
  },
  log_all_queries: {
    label: "Query Log",
    description: "all_queries_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4" />,
  },
  log_evolution_audit: {
    label: "Evolution Audit Log",
    description: "evolution_audit_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4" />,
  },
  hook_settings: {
    label: "Hook Installation",
    description: "Claude Code settings.json has all required selftune hooks configured",
    icon: <PlugIcon className="size-4" />,
  },
  evolution_audit: {
    label: "Evolution Health",
    description: "Evolution audit log is intact and records are well-formed",
    icon: <ShieldCheckIcon className="size-4" />,
  },
  dashboard_freshness_mode: {
    label: "Dashboard Freshness",
    description:
      "The current dashboard still invalidates live updates from JSONL log watchers. SQLite WAL live invalidation has not been cut over yet.",
    icon: <HardDriveIcon className="size-4" />,
  },
};

function CheckRow({ check }: { check: HealthCheck }) {
  const meta = CHECK_META[check.name] ?? {
    label: check.name,
    description: "",
    icon: <HardDriveIcon className="size-4" />,
  };
  const display = STATUS_DISPLAY[check.status] ?? {
    color: "text-muted-foreground",
    label: check.status,
    dotColor: "bg-muted-foreground",
    dotGlow: "",
    animate: false,
  };

  return (
    <div className="group flex items-start gap-4 px-6 py-4 border-b border-border/10 last:border-b-0 hover:bg-secondary/40 transition-colors">
      {/* Status dot — Stitch pulsing indicator */}
      <div className="mt-1.5 flex-shrink-0">
        <span
          className={`block size-1.5 rounded-full ${display.dotColor} ${display.dotGlow} ${display.animate ? "animate-pulse" : ""}`}
        />
      </div>

      {/* Icon + Label */}
      <div className="flex-shrink-0 mt-0.5 text-muted-foreground">{meta.icon}</div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{meta.label}</span>
          {meta.description && <InfoTip text={meta.description} />}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {check.message || "No details"}
        </p>
        {check.path && (
          <p className="text-[11px] text-muted-foreground/60 font-mono mt-1 truncate">
            {check.path}
          </p>
        )}
      </div>

      {/* Status pill — Stitch uppercase label */}
      <div className="flex-shrink-0">
        <div
          className={`inline-flex items-center gap-2 px-2 py-1 rounded-md ${
            check.status === "pass"
              ? "bg-primary/10"
              : check.status === "fail"
                ? "bg-destructive/10"
                : "bg-amber-400/10"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${display.dotColor} ${display.animate ? "animate-pulse" : ""}`}
          />
          <span
            className={`text-[10px] font-bold uppercase tracking-tighter font-headline ${display.color}`}
          >
            {display.label}
          </span>
        </div>
      </div>
    </div>
  );
}

export function Status() {
  const { data, isPending, isError, error, refetch } = useDoctor();

  if (isPending) {
    return (
      <div className="flex flex-1 flex-col gap-8 p-8">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-[400px] rounded-xl" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">No diagnostics data available.</p>
      </div>
    );
  }

  const { checks: rawChecks, summary: rawSummary, healthy = false, timestamp } = data;
  const checks = rawChecks ?? [];
  const summary = rawSummary ?? { pass: 0, warn: 0, fail: 0 };
  const total = summary.pass + summary.warn + summary.fail;

  // Group checks by category for section headers within the unified panel
  const configChecks = checks.filter((c) => c.name === "config");
  const logChecks = checks.filter((c) => c.name.startsWith("log_"));
  const hookChecks = checks.filter((c) => c.name === "hook_settings");
  const evolutionChecks = checks.filter((c) => c.name === "evolution_audit");
  const integrityChecks = checks.filter((c) => c.name === "dashboard_freshness_mode");
  const knownNames = new Set([
    "config",
    ...logChecks.map((c) => c.name),
    "hook_settings",
    "evolution_audit",
    "dashboard_freshness_mode",
  ]);
  const otherChecks = checks.filter((c) => !knownNames.has(c.name));

  const groups = [
    { title: "Configuration", checks: configChecks },
    { title: "Log Files", checks: logChecks },
    { title: "Hooks", checks: hookChecks },
    { title: "Evolution", checks: evolutionChecks },
    { title: "Integrity", checks: integrityChecks },
    { title: "Other", checks: otherChecks },
  ].filter((g) => g.checks.length > 0);

  return (
    <div className="flex flex-1 flex-col gap-8 p-8 max-w-5xl mx-auto w-full">
      {/* ── Stitch Header ──────────────────────────────────── */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-4xl font-bold tracking-tight text-foreground">
            System Status
          </h1>
          <p className="text-muted-foreground max-w-md mt-1">
            Diagnostics and health checks for selftune infrastructure.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-headline">
            Last checked {timestamp ? timeAgo(timestamp) : "—"}
          </span>
          <Button
            aria-label="Refresh status"
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="shrink-0"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </section>

      {/* ── Summary Glass Panel ────────────────────────────── */}
      <div className="glass-panel rounded-xl ghost-border p-6 flex items-center justify-between overflow-hidden relative">
        <div className="flex items-center gap-8">
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-headline mb-1">
              Overall
            </span>
            <div className="flex items-center gap-2">
              {healthy ? (
                <span className="size-3 rounded-full bg-primary animate-pulse shadow-[0_0_12px_rgba(79,242,255,0.6)]" />
              ) : (
                <span className="size-3 rounded-full bg-destructive shadow-[0_0_12px_rgba(255,180,171,0.6)]" />
              )}
              <span className="font-headline text-2xl font-bold text-foreground">
                {healthy ? "Healthy" : "Unhealthy"}
              </span>
            </div>
          </div>
          <div className="h-10 w-px bg-border/20" />
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-headline mb-1">
              Passed
            </span>
            <span className="font-headline text-2xl font-bold text-primary">
              {summary.pass}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-headline mb-1">
              Warnings
            </span>
            <span
              className={`font-headline text-2xl font-bold ${summary.warn > 0 ? "text-amber-400" : "text-foreground"}`}
            >
              {summary.warn}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-headline mb-1">
              Failed
            </span>
            <span
              className={`font-headline text-2xl font-bold ${summary.fail > 0 ? "text-destructive" : "text-foreground"}`}
            >
              {summary.fail}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs font-bold text-foreground font-headline">
              {total} Checks
            </p>
            <p className="text-[10px] text-muted-foreground">
              {summary.pass === total ? "All checks passing" : `${summary.fail + summary.warn} issue${summary.fail + summary.warn !== 1 ? "s" : ""} detected`}
            </p>
          </div>
          <div className="size-12 rounded-full flex items-center justify-center border-4 border-primary/20 border-t-primary">
            <HeartPulseIcon className="size-5 text-primary" />
          </div>
        </div>
        {/* Background glow */}
        <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-primary/5 blur-3xl rounded-full pointer-events-none" />
      </div>

      {/* ── Unified Checks Panel ───────────────────────────── */}
      <div className="bg-muted rounded-xl ghost-border overflow-hidden">
        {groups.map((group, gi) => (
          <div key={group.title}>
            {/* Section header */}
            <div className="px-6 py-3 bg-secondary/60 border-b border-border/15">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em] font-headline">
                {group.title}
              </span>
              <Badge
                variant="outline"
                className="ml-3 text-[10px] px-1.5 py-0 border-border/40 text-muted-foreground"
              >
                {group.checks.length}
              </Badge>
            </div>
            {/* Checks */}
            {group.checks.map((check, idx) => (
              <CheckRow key={`${check.name}-${idx}`} check={check} />
            ))}
            {/* Separator between groups (not after last) */}
            {gi < groups.length - 1 && (
              <div className="border-b border-border/25" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
