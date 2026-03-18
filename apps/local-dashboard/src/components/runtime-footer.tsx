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

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-10 border-t border-border/40 bg-background/80 backdrop-blur-sm px-4 py-1.5">
      <div className="flex items-center gap-4 text-[11px] font-mono text-muted-foreground">
        <span title="Workspace root">{health.workspace_root}</span>
        <span title="Git SHA">{health.git_sha}</span>
        <span title="Database path">{health.db_path}</span>
        <span title="Watcher mode">watcher: {health.watcher_mode}</span>
      </div>
    </footer>
  )
}
