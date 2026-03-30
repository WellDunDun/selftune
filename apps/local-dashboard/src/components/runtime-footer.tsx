import { useEffect, useState } from "react";

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

  return (
    <footer className="pointer-events-none fixed bottom-4 right-4 z-20 max-w-[min(92vw,56rem)]">
      <div className="glass-panel pointer-events-auto rounded-2xl border border-foreground/5 px-5 py-2.5 shadow-lg pulse-aura">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-headline text-[10px] uppercase tracking-[0.2em] text-slate-500">
          <span className="flex items-center gap-2">
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_rgba(79,242,255,0.6)]" />
            <span className="text-slate-300">{health.process_mode}</span>
          </span>
          <span className="text-foreground/10">|</span>
          <span title="Git SHA">{health.git_sha}</span>
          <span className="text-foreground/10">|</span>
          <span title="Watcher mode">watcher:{health.watcher_mode}</span>
          <span className="text-foreground/10">|</span>
          <span className="truncate" title="Workspace root">
            {health.workspace_root}
          </span>
          <span className="text-foreground/10">|</span>
          <span
            className={legacyWatcherMode ? "text-amber-400" : "text-primary"}
            title="Watcher mode"
          >
            {legacyWatcherMode ? "legacy watcher path active" : "live invalidation active"}
          </span>
          {legacyWatcherMode && (
            <span className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-400">
              warning: legacy JSONL watcher invalidation
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
