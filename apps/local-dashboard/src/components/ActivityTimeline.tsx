import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { EvolutionEntry, PendingProposal, UnmatchedQuery } from "@/types"
import { timeAgo } from "@/utils"
import {
  ClockIcon,
  GitPullRequestArrowIcon,
  SearchXIcon,
  ActivityIcon,
} from "lucide-react"

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  validated: "secondary",
  deployed: "default",
  rejected: "destructive",
  rolled_back: "destructive",
  pending: "secondary",
}

export function ActivityPanel({
  evolution,
  pendingProposals,
  unmatchedQueries,
}: {
  evolution: EvolutionEntry[]
  pendingProposals: PendingProposal[]
  unmatchedQueries: UnmatchedQuery[]
}) {
  const hasActivity = evolution.length > 0 || pendingProposals.length > 0 || unmatchedQueries.length > 0

  if (!hasActivity) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ActivityIcon className="size-4" />
            Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent activity
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="size-4" />
          Activity
        </CardTitle>
        <CardDescription>Recent evolution events and queries</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs
          defaultValue={
            pendingProposals.length > 0
              ? "pending"
              : evolution.length > 0
                ? "timeline"
                : "unmatched"
          }
        >
          <TabsList className="w-full">
            {pendingProposals.length > 0 && (
              <TabsTrigger value="pending" className="flex-1 gap-1.5">
                <GitPullRequestArrowIcon className="size-3.5" />
                Pending
                <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                  {pendingProposals.length}
                </Badge>
              </TabsTrigger>
            )}
            <TabsTrigger value="timeline" className="flex-1 gap-1.5">
              <ClockIcon className="size-3.5" />
              Timeline
            </TabsTrigger>
            {unmatchedQueries.length > 0 && (
              <TabsTrigger value="unmatched" className="flex-1 gap-1.5">
                <SearchXIcon className="size-3.5" />
                Unmatched
                <Badge variant="destructive" className="ml-1 h-4 px-1.5 text-[10px]">
                  {unmatchedQueries.length}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>

          {pendingProposals.length > 0 && (
            <TabsContent value="pending" className="mt-4 space-y-3">
              {pendingProposals.slice(0, 10).map((p) => (
                <div key={p.proposal_id} className="flex gap-3">
                  <div className="mt-1 size-2 shrink-0 rounded-full bg-amber-400" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={ACTION_VARIANT[p.action] ?? "secondary"} className="text-[10px]">
                        {p.action}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">
                        {timeAgo(p.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{p.details}</p>
                  </div>
                </div>
              ))}
            </TabsContent>
          )}

          <TabsContent value="timeline" className="mt-4 space-y-3">
            {evolution.slice(0, 30).map((entry, i) => (
              <div key={`${entry.proposal_id}-${i}`} className="flex gap-3">
                <div className={`mt-1 size-2 shrink-0 rounded-full ${
                  entry.action === "deployed" ? "bg-emerald-500"
                  : entry.action === "rejected" || entry.action === "rolled_back" ? "bg-red-500"
                  : entry.action === "validated" ? "bg-amber-400"
                  : "bg-primary-accent"
                }`} />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={ACTION_VARIANT[entry.action] ?? "secondary"} className="text-[10px]">
                      {entry.action}
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">
                      {timeAgo(entry.timestamp)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{entry.details}</p>
                  <span className="text-[10px] text-muted-foreground/60 font-mono">
                    #{entry.proposal_id.slice(0, 8)}
                  </span>
                </div>
              </div>
            ))}
            {evolution.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No timeline events</p>
            )}
          </TabsContent>

          {unmatchedQueries.length > 0 && (
            <TabsContent value="unmatched" className="mt-4 space-y-2">
              {unmatchedQueries.slice(0, 15).map((q, i) => (
                <div key={`${q.session_id}-${i}`} className="flex gap-3">
                  <div className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <span className="text-xs text-muted-foreground font-mono">
                      {timeAgo(q.timestamp)}
                    </span>
                    <p className="text-xs font-mono text-foreground/80 line-clamp-2">{q.query}</p>
                  </div>
                </div>
              ))}
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  )
}
