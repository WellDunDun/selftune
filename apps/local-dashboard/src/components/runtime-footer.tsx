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
    (record.watcher_mode === "wal" ||
      record.watcher_mode === "jsonl" ||
      record.watcher_mode === "none")
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
  const statusLabel = legacyWatcherMode
    ? "Legacy watcher"
    : disabledWatcherMode
      ? "Watcher disabled"
      : "Runtime healthy";
  const statusTone = legacyWatcherMode
    ? "text-amber-400 ring-amber-400/20 hover:bg-amber-400/8"
    : disabledWatcherMode
      ? "text-destructive ring-destructive/20 hover:bg-destructive/8"
      : "text-primary ring-primary/20 hover:bg-primary/8";
  const statusDot = legacyWatcherMode
    ? "bg-amber-400"
    : disabledWatcherMode
      ? "bg-destructive"
      : "animate-pulse bg-primary shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_60%,transparent)]";

  return (
    <footer className="pointer-events-none fixed bottom-4 right-4 z-20">
      <Link
        to="/status"
        className={`glass-panel pointer-events-auto flex items-center gap-2 rounded-full border border-foreground/5 px-3 py-2 font-headline text-[10px] uppercase tracking-[0.18em] text-slate-300 shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${statusTone}`}
      >
        <span className={`size-1.5 rounded-full ${statusDot}`} />
        <span>{statusLabel}</span>
        <span className="text-foreground/25">/</span>
        <span className="text-slate-400">{health.process_mode}</span>
      </Link>
    </footer>
  );
}
