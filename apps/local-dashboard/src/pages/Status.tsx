import { InfoTip } from "@selftune/ui/components";
import { timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@selftune/ui/primitives";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  FileTextIcon,
  HardDriveIcon,
  HeartPulseIcon,
  PlugIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useDoctor } from "@/hooks/useDoctor";
import type { HealthCheck, HealthStatus } from "@/types";

const STATUS_DISPLAY: Record<
  HealthStatus,
  {
    icon: React.ReactNode;
    variant: "default" | "secondary" | "destructive" | "outline";
    label: string;
  }
> = {
  pass: {
    icon: <CheckCircleIcon className="size-4 text-emerald-600" />,
    variant: "outline",
    label: "Pass",
  },
  warn: {
    icon: <AlertTriangleIcon className="size-4 text-amber-500" />,
    variant: "secondary",
    label: "Warning",
  },
  fail: {
    icon: <XCircleIcon className="size-4 text-red-500" />,
    variant: "destructive",
    label: "Fail",
  },
};

const CHECK_META: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  config: {
    label: "Configuration",
    description: "selftune.json exists and contains valid agent_type and llm_mode",
    icon: <SettingsIcon className="size-4 text-muted-foreground" />,
  },
  log_session_telemetry: {
    label: "Session Telemetry Log",
    description: "session_telemetry_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4 text-muted-foreground" />,
  },
  log_skill_usage: {
    label: "Skill Usage Log",
    description: "skill_usage_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4 text-muted-foreground" />,
  },
  log_all_queries: {
    label: "Query Log",
    description: "all_queries_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4 text-muted-foreground" />,
  },
  log_evolution_audit: {
    label: "Evolution Audit Log",
    description: "evolution_audit_log.jsonl exists and records parse correctly",
    icon: <FileTextIcon className="size-4 text-muted-foreground" />,
  },
  hook_settings: {
    label: "Hook Installation",
    description: "Claude Code settings.json has all required selftune hooks configured",
    icon: <PlugIcon className="size-4 text-muted-foreground" />,
  },
  evolution_audit: {
    label: "Evolution Health",
    description: "Evolution audit log is intact and records are well-formed",
    icon: <ShieldCheckIcon className="size-4 text-muted-foreground" />,
  },
  dashboard_freshness_mode: {
    label: "Dashboard Freshness",
    description:
      "The current dashboard still invalidates live updates from JSONL log watchers. SQLite WAL live invalidation has not been cut over yet.",
    icon: <HardDriveIcon className="size-4 text-muted-foreground" />,
  },
};

function CheckCard({ check }: { check: HealthCheck }) {
  const meta = CHECK_META[check.name] ?? {
    label: check.name,
    description: "",
    icon: <HardDriveIcon className="size-4 text-muted-foreground" />,
  };
  const display = STATUS_DISPLAY[check.status] ?? {
    icon: <AlertCircleIcon className="size-4 text-muted-foreground" />,
    variant: "outline" as const,
    label: check.status,
  };

  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5">
          {meta.icon}
          {meta.label}
          {meta.description && <InfoTip text={meta.description} />}
        </CardDescription>
        <CardTitle className="text-sm font-medium">{check.message || "No details"}</CardTitle>
        <CardAction>
          <Badge variant={display.variant} className="gap-1">
            {display.icon}
            {display.label}
          </Badge>
        </CardAction>
      </CardHeader>
      {check.path && (
        <CardContent className="pt-0">
          <p className="text-[11px] text-muted-foreground font-mono truncate">{check.path}</p>
        </CardContent>
      )}
    </Card>
  );
}

export function Status() {
  const { data, isPending, isError, error, refetch } = useDoctor();

  if (isPending) {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
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
  const freshnessCheck = checks.find((c) => c.name === "dashboard_freshness_mode");

  // Group checks by category
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
    <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <HeartPulseIcon className="size-5 text-muted-foreground" />
        <h1 className="text-base font-semibold tracking-tight lg:text-lg">System Status</h1>
        <Badge variant={healthy ? "outline" : "destructive"} className="gap-1">
          {healthy ? (
            <CheckCircleIcon className="size-3 text-emerald-600" />
          ) : (
            <XCircleIcon className="size-3" />
          )}
          {healthy ? "Healthy" : "Unhealthy"}
        </Badge>
        <span className="text-xs text-muted-foreground ml-auto">
          Last checked {timestamp ? timeAgo(timestamp) : "—"}
        </span>
        <Button
          aria-label="Refresh status"
          title="Refresh status"
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          className="shrink-0"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {freshnessCheck?.status === "warn" && (
        <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
              <AlertTriangleIcon className="size-4" />
              Legacy freshness mode active
            </CardDescription>
            <CardTitle className="text-sm font-medium text-amber-950 dark:text-amber-100">
              {freshnessCheck.message}
            </CardTitle>
          </CardHeader>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 px-0">
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <CheckCircleIcon className="size-3.5 text-emerald-600" />
              Passed
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {summary.pass}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <AlertTriangleIcon className="size-3.5 text-amber-500" />
              Warnings
            </CardDescription>
            <CardTitle
              className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${summary.warn > 0 ? "text-amber-500" : ""}`}
            >
              {summary.warn}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <XCircleIcon className="size-3.5 text-red-500" />
              Failed
            </CardDescription>
            <CardTitle
              className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${summary.fail > 0 ? "text-red-600" : ""}`}
            >
              {summary.fail}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Check groups */}
      {groups.map((group) => (
        <div key={group.title}>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">{group.title}</h2>
          <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2">
            {group.checks.map((check, idx) => (
              <CheckCard key={`${check.name}-${idx}`} check={check} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
