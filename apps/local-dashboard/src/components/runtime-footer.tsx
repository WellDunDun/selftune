import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { HealthResponse } from "@/types";

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspace_root === "string" &&
    typeof record.git_sha === "string" &&
    typeof record.db_path === "string" &&
    typeof record.process_mode === "string" &&
    typeof record.update_available === "boolean" &&
    typeof record.auto_update_supported === "boolean" &&
    ("latest_version" in record
      ? record.latest_version === null || typeof record.latest_version === "string"
      : true) &&
    (record.watcher_mode === "wal" ||
      record.watcher_mode === "jsonl" ||
      record.watcher_mode === "none")
  );
}

function getBadgeToneClasses(tone: "healthy" | "warning" | "critical") {
  if (tone === "warning") {
    return {
      text: "text-amber-400 ring-amber-400/20 hover:bg-amber-400/8",
      dot: "bg-amber-400",
    };
  }

  if (tone === "critical") {
    return {
      text: "text-destructive ring-destructive/20 hover:bg-destructive/8",
      dot: "bg-destructive",
    };
  }

  return {
    text: "text-primary ring-primary/20 hover:bg-primary/8",
    dot: "animate-pulse bg-primary shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_60%,transparent)]",
  };
}

function FooterBadge({
  href,
  label,
  detail,
  tone,
}: {
  href: string;
  label: string;
  detail: string;
  tone: "healthy" | "warning" | "critical";
}) {
  const classes = getBadgeToneClasses(tone);

  return (
    <Link
      to={href}
      className={`glass-panel pointer-events-auto flex items-center gap-2 rounded-full border border-foreground/5 px-3 py-2 font-headline text-[10px] uppercase tracking-[0.18em] text-slate-300 shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${classes.text}`}
    >
      <span className={`size-1.5 rounded-full ${classes.dot}`} />
      <span>{label}</span>
      <span className="text-foreground/25">/</span>
      <span className="text-slate-400">{detail}</span>
    </Link>
  );
}

export function RuntimeFooter() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: unknown) => {
        if (isHealthResponse(data)) {
          setHealth(data);
        }
      })
      .catch(() => {
        /* non-critical — footer simply stays hidden */
      });
  }, []);

  if (!health) return null;
  const legacyWatcherMode = health.watcher_mode === "jsonl";
  const disabledWatcherMode = health.watcher_mode === "none";
  const spaModeLabel =
    health.spa_mode === "proxy" ? "proxy" : health.spa_mode === "dist" ? "dist" : "missing";
  const runtimeLabel = legacyWatcherMode
    ? "Legacy watcher"
    : disabledWatcherMode
      ? "Watcher disabled"
      : "Runtime healthy";
  const runtimeTone = legacyWatcherMode ? "warning" : disabledWatcherMode ? "critical" : "healthy";
  const updateDetail = health.latest_version
    ? `v${health.latest_version} · ${health.auto_update_supported ? "auto" : "manual"}`
    : "check pending";

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-20 flex max-w-[calc(100vw-2rem)] flex-wrap justify-end gap-2">
      {health.update_available ? (
        <FooterBadge href="/status" label="Update available" detail={updateDetail} tone="warning" />
      ) : null}
      <FooterBadge
        href="/status"
        label={runtimeLabel}
        detail={`${health.process_mode} · ${spaModeLabel}`}
        tone={runtimeTone}
      />
    </div>
  );
}
