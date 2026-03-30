import { ClockIcon, GitPullRequestArrowIcon, SearchXIcon, ActivityIcon } from "lucide-react";

import { timeAgo } from "../lib/format";
import { Badge } from "../primitives/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../primitives/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/tooltip";
import type { EvolutionEntry, PendingProposal, UnmatchedQuery } from "../types";

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  validated: "secondary",
  deployed: "default",
  rejected: "destructive",
  rolled_back: "destructive",
  pending: "secondary",
};

export function ActivityPanel({
  evolution,
  pendingProposals,
  unmatchedQueries,
  onSelectProposal,
  embedded = false,
}: {
  evolution: EvolutionEntry[];
  pendingProposals: PendingProposal[];
  unmatchedQueries: UnmatchedQuery[];
  onSelectProposal?: (skillName: string, proposalId: string) => void;
  embedded?: boolean;
}) {
  const hasActivity =
    evolution.length > 0 || pendingProposals.length > 0 || unmatchedQueries.length > 0;

  const content = hasActivity ? (
    <Tabs
      defaultValue={
        pendingProposals.length > 0 ? "pending" : evolution.length > 0 ? "timeline" : "unmatched"
      }
    >
      <TooltipProvider>
        <TabsList className="w-full">
          {pendingProposals.length > 0 && (
            <Tooltip>
              <TooltipTrigger render={<TabsTrigger value="pending" className="flex-1 gap-1.5" />}>
                <GitPullRequestArrowIcon className="size-3.5" />
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {pendingProposals.length}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Undeployed proposals</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger render={<TabsTrigger value="timeline" className="flex-1" />}>
              <ClockIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Timeline</TooltipContent>
          </Tooltip>
          {unmatchedQueries.length > 0 && (
            <Tooltip>
              <TooltipTrigger render={<TabsTrigger value="unmatched" className="flex-1 gap-1.5" />}>
                <SearchXIcon className="size-3.5" />
                <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                  {unmatchedQueries.length}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Unmatched queries</TooltipContent>
            </Tooltip>
          )}
        </TabsList>
      </TooltipProvider>

      {pendingProposals.length > 0 && (
        <TabsContent value="pending" className="mt-4 space-y-3">
          {pendingProposals.slice(0, 10).map((p) => (
            <button
              key={p.proposal_id}
              type="button"
              onClick={() => {
                if (p.skill_name && onSelectProposal) onSelectProposal(p.skill_name, p.proposal_id);
              }}
              disabled={!p.skill_name || !onSelectProposal}
              className="flex w-full gap-3 rounded-md p-1.5 text-left transition-colors enabled:hover:bg-accent/40 disabled:cursor-default"
            >
              <div className="mt-1 size-2 shrink-0 rounded-full bg-primary-accent" />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={ACTION_VARIANT[p.action] ?? "secondary"} className="text-[10px]">
                    {p.action}
                  </Badge>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {timeAgo(p.timestamp)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{p.details}</p>
                {p.skill_name && (
                  <span className="text-[10px] text-muted-foreground/60 font-mono">
                    {p.skill_name} · #{p.proposal_id.slice(0, 8)}
                  </span>
                )}
              </div>
            </button>
          ))}
        </TabsContent>
      )}

      <TabsContent value="timeline" className="mt-4 space-y-3">
        {evolution.slice(0, 30).map((entry, i) => (
          <button
            key={`${entry.proposal_id}-${i}`}
            type="button"
            onClick={() => {
              if (entry.skill_name && onSelectProposal)
                onSelectProposal(entry.skill_name, entry.proposal_id);
            }}
            disabled={!entry.skill_name || !onSelectProposal}
            className="flex w-full gap-3 rounded-md p-1.5 text-left transition-colors enabled:hover:bg-accent/40 disabled:cursor-default"
          >
            <div
              className={`mt-1 size-2 shrink-0 rounded-full ${
                entry.action === "deployed"
                  ? "bg-primary"
                  : entry.action === "rejected" || entry.action === "rolled_back"
                    ? "bg-destructive"
                    : entry.action === "validated"
                      ? "bg-primary-accent"
                      : "bg-primary-accent"
              }`}
            />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Badge
                  variant={ACTION_VARIANT[entry.action] ?? "secondary"}
                  className="text-[10px]"
                >
                  {entry.action}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">
                  {timeAgo(entry.timestamp)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{entry.details}</p>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                {entry.skill_name ? `${entry.skill_name} · ` : ""}#{entry.proposal_id.slice(0, 8)}
              </span>
            </div>
          </button>
        ))}
        {evolution.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No timeline events</p>
        )}
      </TabsContent>

      {unmatchedQueries.length > 0 && (
        <TabsContent value="unmatched" className="mt-4 space-y-2">
          {unmatchedQueries.slice(0, 15).map((q, i) => (
            <div key={`${q.session_id}-${i}`} className="flex gap-3">
              <div className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/40" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <span className="font-mono text-xs text-muted-foreground">
                  {timeAgo(q.timestamp)}
                </span>
                <p className="line-clamp-2 font-mono text-xs text-foreground/80">{q.query}</p>
              </div>
            </div>
          ))}
        </TabsContent>
      )}
    </Tabs>
  ) : (
    <p className="py-6 text-center text-sm text-muted-foreground">No recent activity</p>
  );

  if (embedded) {
    return <div>{content}</div>;
  }

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
          <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
        </CardContent>
      </Card>
    );
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
      <CardContent>{content}</CardContent>
    </Card>
  );
}
