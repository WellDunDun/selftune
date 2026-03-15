import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { OrchestrateRunReport, OrchestrateRunSkillAction } from "@/types"
import { timeAgo } from "@/utils"
import {
  BotIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  EyeIcon,
  SkipForwardIcon,
  ZapIcon,
} from "lucide-react"

const ACTION_ICON: Record<string, React.ReactNode> = {
  evolve: <ZapIcon className="size-3 text-amber-500" />,
  watch: <EyeIcon className="size-3 text-blue-500" />,
  skip: <SkipForwardIcon className="size-3 text-muted-foreground" />,
}

function SkillActionRow({ action }: { action: OrchestrateRunSkillAction }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <div className="mt-0.5 shrink-0">{ACTION_ICON[action.action] ?? null}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{action.skill}</span>
          <Badge
            variant={
              action.rolledBack ? "destructive"
              : action.action === "evolve" && action.deployed ? "default"
              : action.action === "evolve" ? "secondary"
              : action.action === "watch" ? "outline"
              : "secondary"
            }
            className="text-[10px] h-4 px-1.5 shrink-0"
          >
            {action.rolledBack ? "rolled back"
             : action.action === "evolve" && action.deployed ? "deployed"
             : action.action === "evolve" ? "evolved"
             : action.action}
          </Badge>
          {action.alert && (
            <Badge variant="destructive" className="text-[10px] h-4 px-1.5 shrink-0">
              alert
            </Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground line-clamp-1">{action.reason}</p>
      </div>
    </div>
  )
}

function RunCard({ run }: { run: OrchestrateRunReport }) {
  const [open, setOpen] = useState(false)
  const nonSkipActions = run.skill_actions.filter((a) => a.action !== "skip")
  const skipActions = run.skill_actions.filter((a) => a.action === "skip")

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full text-left">
        <div className="flex items-start gap-3 py-2 hover:bg-muted/50 rounded-md px-2 -mx-2 transition-colors">
          <div className={`mt-1.5 size-2 shrink-0 rounded-full ${
            run.deployed > 0 ? "bg-emerald-500"
            : run.evolved > 0 ? "bg-amber-400"
            : "bg-muted-foreground/40"
          }`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">{timeAgo(run.timestamp)}</span>
              {run.dry_run && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">dry-run</Badge>
              )}
              {run.approval_mode === "review" && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">review</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              {run.deployed > 0 && <span className="text-emerald-600 font-medium">{run.deployed} deployed</span>}
              {run.evolved > 0 && <span>{run.evolved} evolved</span>}
              {run.watched > 0 && <span>{run.watched} watched</span>}
              {run.skipped > 0 && <span>{run.skipped} skipped</span>}
              <span>{(run.elapsed_ms / 1000).toFixed(1)}s</span>
            </div>
          </div>
          <ChevronRightIcon className={`size-4 text-muted-foreground shrink-0 mt-1 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 pl-3 border-l border-border space-y-0.5 pb-2">
          {nonSkipActions.map((action, i) => (
            <SkillActionRow key={`${action.skill}-${i}`} action={action} />
          ))}
          {skipActions.length > 0 && (
            <details className="group">
              <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground py-1">
                {skipActions.length} skipped
              </summary>
              <div className="space-y-0.5">
                {skipActions.map((action, i) => (
                  <SkillActionRow key={`${action.skill}-skip-${i}`} action={action} />
                ))}
              </div>
            </details>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function OrchestrateRunsPanel({ runs }: { runs: OrchestrateRunReport[] }) {
  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <BotIcon className="size-4" />
            Orchestrate Runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No orchestrate runs yet. Run <code className="text-xs bg-muted px-1 py-0.5 rounded">selftune orchestrate</code> to start.
          </p>
        </CardContent>
      </Card>
    )
  }

  const totalDeployed = runs.reduce((sum, r) => sum + r.deployed, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BotIcon className="size-4" />
          Orchestrate Runs
        </CardTitle>
        <CardDescription>
          {runs.length} recent run{runs.length !== 1 ? "s" : ""}
          {totalDeployed > 0 && <> &middot; {totalDeployed} total deployments</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-0">
        {runs.slice(0, 10).map((run) => (
          <RunCard key={run.run_id} run={run} />
        ))}
      </CardContent>
    </Card>
  )
}
