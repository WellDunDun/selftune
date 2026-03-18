import { useEffect, useState } from "react"
import type { HealthResponse } from "@/types"

export function RuntimeFooter() {
  const [health, setHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => {
        /* non-critical — footer simply stays hidden */
      })
  }, [])

  if (!health) return null
  const legacyWatcherMode = health.watcher_mode === "jsonl"

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-10 border-t border-border/40 bg-background/80 backdrop-blur-sm px-4 py-1.5">
      <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-muted-foreground">
        <span title="Workspace root">{health.workspace_root}</span>
        <span title="Git SHA">{health.git_sha}</span>
        <span title="Database path">{health.db_path}</span>
        <span title="Process mode">mode: {health.process_mode}</span>
        <span
          title="Watcher mode"
          className={legacyWatcherMode ? "text-amber-700 dark:text-amber-300" : undefined}
        >
          watcher: {health.watcher_mode}
        </span>
        {legacyWatcherMode && (
          <span
            className="rounded border border-amber-300/70 bg-amber-500/10 px-2 py-0.5 text-amber-800 dark:border-amber-800 dark:text-amber-300"
            title="Dashboard reads SQLite, but live invalidation still comes from JSONL log watchers."
          >
            warning: legacy JSONL watcher invalidation
          </span>
        )}
      </div>
    </footer>
  )
}
