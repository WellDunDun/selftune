import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EvolutionTimeline } from "@/components/EvolutionTimeline"
import { EvidenceViewer } from "@/components/EvidenceViewer"
import { InfoTip } from "@/components/InfoTip"
import { useSkillReport } from "@/hooks/useSkillReport"
import { STATUS_CONFIG } from "@/constants"
import { deriveStatus, formatRate, timeAgo } from "@/utils"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  FlaskConicalIcon,
  ActivityIcon,
  EyeIcon,
  RefreshCwIcon,
  LayersIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  CoinsIcon,
  ClockIcon,
  AlertOctagonIcon,
  TargetIcon,
  MessageSquareTextIcon,
  ServerIcon,
  GitBranchIcon,
} from "lucide-react"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = secs / 60
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  validated: "secondary",
  deployed: "default",
  rejected: "destructive",
  rolled_back: "destructive",
}

export function SkillReport() {
  const { name } = useParams<{ name: string }>()
  const { data, state, error, retry } = useSkillReport(name)
  const [selectedProposal, setSelectedProposal] = useState<string | null>(null)

  if (!name) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-destructive">No skill name provided</p>
      </div>
    )
  }

  if (state === "loading") {
    return (
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (state === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error ?? "Unknown error"}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          <RefreshCwIcon className="mr-2 size-3.5" />
          Retry
        </Button>
      </div>
    )
  }

  if (state === "not-found") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-muted-foreground">No data found for skill "{name}".</p>
        <Button variant="outline" size="sm" render={<Link to="/" />}>
          <ArrowLeftIcon className="mr-2 size-3.5" />
          Back to Overview
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">No data yet</p>
      </div>
    )
  }

  const {
    usage,
    recent_invocations,
    evidence,
    evolution,
    pending_proposals,
    token_usage,
    canonical_invocations,
    duration_stats,
    prompt_samples,
    session_metadata,
  } = data
  const status = deriveStatus(usage.pass_rate, usage.total_checks)
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN
  const passRateGood = status === "HEALTHY"
  const totalTokens = (token_usage?.total_input_tokens ?? 0) + (token_usage?.total_output_tokens ?? 0)

  // Auto-select first proposal if none selected
  const activeProposal = selectedProposal ?? (evolution.length > 0 ? evolution[0].proposal_id : null)

  // Unique models/platforms from session metadata
  const uniqueModels = [...new Set((session_metadata ?? []).map((s) => s.model).filter(Boolean))]
  const uniquePlatforms = [...new Set((session_metadata ?? []).map((s) => s.platform).filter(Boolean))]
  const uniqueBranches = [...new Set((session_metadata ?? []).map((s) => s.branch).filter(Boolean))]

  return (
    <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
      {/* Skill Header — sticky */}
      <div className="flex items-center gap-3 sticky top-0 z-20 bg-background py-2 -mt-2">
        <h1 className="text-xl font-bold tracking-tight lg:text-2xl">{data.skill_name}</h1>
        <Badge variant={config.variant} className="gap-1">
          {config.icon}
          {config.label}
        </Badge>
      </div>

      {/* KPIs — 2 rows of 4 */}
      <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {/* Row 1: Core metrics */}
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <FlaskConicalIcon className="size-3.5" />
              Pass Rate
              <InfoTip text="Percentage of eval test cases that passed for this skill" />
            </CardDescription>
            <CardTitle className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${!passRateGood ? "text-red-600" : ""}`}>
              {formatRate(usage.pass_rate)}
            </CardTitle>
            <CardAction>
              <Badge variant={passRateGood ? "outline" : "destructive"}>
                {passRateGood ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
                {formatRate(usage.pass_rate)}
              </Badge>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <LayersIcon className="size-3.5" />
              Total Checks
              <InfoTip text="Total evaluation checks run across all sessions for this skill" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {usage.total_checks}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <ActivityIcon className="size-3.5" />
              Triggered
              <InfoTip text="Number of times this skill was invoked by the agent during sessions" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {usage.triggered_count}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <EyeIcon className="size-3.5" />
              Sessions
              <InfoTip text="Number of unique agent sessions where this skill was present" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {data.sessions_with_skill}
            </CardTitle>
          </CardHeader>
        </Card>

        {/* Row 2: Extended metrics */}
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <CoinsIcon className="size-3.5" />
              Tokens Used
              <InfoTip text="Combined input + output tokens consumed across all invocations" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {formatTokens(totalTokens)}
            </CardTitle>
            <CardAction>
              <span className="text-[10px] text-muted-foreground font-mono">
                {formatTokens(token_usage?.total_input_tokens ?? 0)} in / {formatTokens(token_usage?.total_output_tokens ?? 0)} out
              </span>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <ClockIcon className="size-3.5" />
              Avg Duration
              <InfoTip text="Average execution time per invocation of this skill" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {formatDuration(duration_stats?.avg_duration_ms ?? 0)}
            </CardTitle>
            <CardAction>
              <span className="text-[10px] text-muted-foreground font-mono">
                {duration_stats?.execution_count ?? 0} executions
              </span>
            </CardAction>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <AlertOctagonIcon className="size-3.5" />
              Errors
              <InfoTip text="Total errors encountered during skill execution" />
            </CardDescription>
            <CardTitle className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${(duration_stats?.total_errors ?? 0) > 0 ? "text-red-600" : ""}`}>
              {duration_stats?.total_errors ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <TargetIcon className="size-3.5" />
              Avg Confidence
              <InfoTip text="Average model confidence score when routing user prompts to this skill" />
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {(() => {
                const withConfidence = canonical_invocations?.filter((i) => i.confidence !== null) ?? [];
                return withConfidence.length > 0
                  ? formatRate(withConfidence.reduce((sum, i) => sum + (i.confidence ?? 0), 0) / withConfidence.length)
                  : "--";
              })()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Main content: sidebar timeline + tabbed detail */}
      <div className="flex gap-6">
        {/* Left sidebar: Evolution Timeline — sticky so it stays visible while scrolling */}
        {evolution.length > 0 && (
          <aside className="w-[220px] shrink-0 border-r pr-4 sticky top-10 self-start max-h-[calc(100svh-2.5rem)] overflow-y-auto">
            <EvolutionTimeline
              entries={evolution}
              selectedProposalId={activeProposal}
              onSelect={setSelectedProposal}
            />
          </aside>
        )}

        {/* Right content area */}
        <div className="flex-1 min-w-0">
          <Tabs defaultValue={evolution.length > 0 ? "evidence" : "invocations"}>
            <TabsList variant="line" className="sticky top-10 z-20 bg-background">
              {evolution.length > 0 && (
                <TabsTrigger value="evidence">
                  <Tooltip>
                    <TooltipTrigger className="inline-flex items-center gap-1">
                      Evidence
                      {activeProposal && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          #{activeProposal.slice(0, 8)}
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>Change history and validation results</TooltipContent>
                  </Tooltip>
                </TabsTrigger>
              )}
              <TabsTrigger value="invocations">
                <Tooltip>
                  <TooltipTrigger className="inline-flex items-center gap-1">
                    Invocations
                    <Badge variant="secondary" className="text-[10px]">{recent_invocations.length}</Badge>
                  </TooltipTrigger>
                  <TooltipContent>Recent skill triggers and their outcomes</TooltipContent>
                </Tooltip>
              </TabsTrigger>
              {prompt_samples && prompt_samples.length > 0 && (
                <TabsTrigger value="prompts">
                  <Tooltip>
                    <TooltipTrigger className="inline-flex items-center gap-1">
                      Prompts
                      <Badge variant="secondary" className="text-[10px]">{prompt_samples.length}</Badge>
                    </TooltipTrigger>
                    <TooltipContent>User inputs that matched this skill</TooltipContent>
                  </Tooltip>
                </TabsTrigger>
              )}
              {session_metadata && session_metadata.length > 0 && (
                <TabsTrigger value="sessions">
                  <Tooltip>
                    <TooltipTrigger className="inline-flex items-center gap-1">
                      Sessions
                      <Badge variant="secondary" className="text-[10px]">{session_metadata.length}</Badge>
                    </TooltipTrigger>
                    <TooltipContent>Environment and runtime information</TooltipContent>
                  </Tooltip>
                </TabsTrigger>
              )}
              {pending_proposals.length > 0 && (
                <TabsTrigger value="pending">
                  <Tooltip>
                    <TooltipTrigger className="inline-flex items-center gap-1">
                      Pending
                      <Badge variant="destructive" className="text-[10px]">{pending_proposals.length}</Badge>
                    </TooltipTrigger>
                    <TooltipContent>Proposals awaiting review</TooltipContent>
                  </Tooltip>
                </TabsTrigger>
              )}
            </TabsList>

            {/* Evidence tab */}
            {evolution.length > 0 && (
              <TabsContent value="evidence">
                {activeProposal ? (
                  <EvidenceViewer
                    proposalId={activeProposal}
                    evolution={evolution}
                    evidence={evidence}
                  />
                ) : (
                  <div className="flex items-center justify-center rounded-lg border border-dashed py-12">
                    <p className="text-sm text-muted-foreground">Select a proposal from the timeline</p>
                  </div>
                )}
              </TabsContent>
            )}

            {/* Invocations tab — now with confidence from canonical_invocations */}
            <TabsContent value="invocations">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Recent Invocations</CardTitle>
                  <CardDescription>
                    {recent_invocations.length} usage records
                    {canonical_invocations && canonical_invocations.length > 0 && (
                      <> · {canonical_invocations.length} canonical</>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {canonical_invocations && canonical_invocations.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Mode</TableHead>
                            <TableHead>Triggered</TableHead>
                            <TableHead>Confidence</TableHead>
                            <TableHead>Tool</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {canonical_invocations.map((inv, i) => (
                            <TableRow key={`${inv.session_id}-${i}`} className={inv.triggered ? "" : "bg-red-50/50 dark:bg-red-950/30"}>
                              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {timeAgo(inv.timestamp)}
                              </TableCell>
                              <TableCell>
                                {inv.invocation_mode && (
                                  <Badge variant="secondary" className="text-[10px]">{inv.invocation_mode}</Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={inv.triggered ? "outline" : "destructive"} className="text-[10px]">
                                  {inv.triggered ? "Yes" : "No"}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {inv.confidence !== null ? `${Math.round(inv.confidence * 100)}%` : "--"}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[150px]">
                                {inv.tool_name ?? "--"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : recent_invocations.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No invocation records yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Query</TableHead>
                            <TableHead>Triggered</TableHead>
                            <TableHead>Source</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recent_invocations.map((rec, i) => (
                            <TableRow key={`${rec.session_id}-${i}`} className={rec.triggered ? "" : "bg-red-50/50 dark:bg-red-950/30"}>
                              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {timeAgo(rec.timestamp)}
                              </TableCell>
                              <TableCell className="max-w-[500px] truncate">{rec.query}</TableCell>
                              <TableCell>
                                <Badge variant={rec.triggered ? "outline" : "destructive"} className="text-[10px]">
                                  {rec.triggered ? "Yes" : "No"}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {rec.source ?? "--"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Prompts tab */}
            {prompt_samples && prompt_samples.length > 0 && (
              <TabsContent value="prompts">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <MessageSquareTextIcon className="size-3.5" />
                      User Prompts
                    </CardTitle>
                    <CardDescription>Prompts from sessions that invoked this skill</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Prompt</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>Actionable</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {prompt_samples.map((p, i) => (
                            <TableRow key={`${p.session_id}-${i}`}>
                              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {timeAgo(p.occurred_at)}
                              </TableCell>
                              <TableCell className="max-w-[500px]">
                                <p className="text-xs line-clamp-3">{p.prompt_text}</p>
                              </TableCell>
                              <TableCell>
                                {p.prompt_kind && (
                                  <Badge variant="secondary" className="text-[10px]">{p.prompt_kind}</Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={p.is_actionable ? "outline" : "secondary"} className="text-[10px]">
                                  {p.is_actionable ? "Yes" : "No"}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            )}

            {/* Sessions tab */}
            {session_metadata && session_metadata.length > 0 && (
              <TabsContent value="sessions">
                <div className="space-y-4">
                  {/* Session environment summary */}
                  <div className="flex flex-wrap gap-3">
                    {uniqueModels.length > 0 && (
                      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 bg-card">
                        <ServerIcon className="size-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Models:</span>
                        {uniqueModels.map((m) => (
                          <Badge key={m} variant="secondary" className="text-[10px]">{m}</Badge>
                        ))}
                      </div>
                    )}
                    {uniquePlatforms.length > 0 && (
                      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 bg-card">
                        <span className="text-xs text-muted-foreground">Platforms:</span>
                        {uniquePlatforms.map((p) => (
                          <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>
                        ))}
                      </div>
                    )}
                    {uniqueBranches.length > 0 && (
                      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 bg-card">
                        <GitBranchIcon className="size-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Branches:</span>
                        {uniqueBranches.map((b) => (
                          <Badge key={b} variant="secondary" className="text-[10px] font-mono">{b}</Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Session Details</CardTitle>
                      <CardDescription>{session_metadata.length} sessions</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Started</TableHead>
                              <TableHead>Model</TableHead>
                              <TableHead>Platform</TableHead>
                              <TableHead>Agent</TableHead>
                              <TableHead>Branch</TableHead>
                              <TableHead>Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {session_metadata.map((s) => (
                              <TableRow key={s.session_id}>
                                <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                  {s.started_at ? timeAgo(s.started_at) : "--"}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {s.model ? <Badge variant="secondary" className="text-[10px]">{s.model}</Badge> : "--"}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">{s.platform ?? "--"}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[120px]">{s.agent_cli ?? "--"}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[120px]">{s.branch ?? "--"}</TableCell>
                                <TableCell>
                                  {s.completion_status && (
                                    <Badge
                                      variant={s.completion_status === "success" ? "outline" : s.completion_status === "error" ? "destructive" : "secondary"}
                                      className="text-[10px]"
                                    >
                                      {s.completion_status}
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            )}

            {/* Pending tab */}
            {pending_proposals.length > 0 && (
              <TabsContent value="pending">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Pending Proposals</CardTitle>
                    <CardDescription>{pending_proposals.length} awaiting review</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {pending_proposals.map((p) => (
                      <button
                        key={p.proposal_id}
                        type="button"
                        onClick={() => setSelectedProposal(p.proposal_id)}
                        className="flex gap-3 rounded-lg border p-3 w-full text-left hover:bg-accent/50 transition-colors"
                      >
                        <div className="mt-0.5 size-2 shrink-0 rounded-full bg-amber-400" />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge variant={ACTION_VARIANT[p.action] ?? "secondary"} className="text-[10px]">
                              {p.action}
                            </Badge>
                            <span className="text-xs text-muted-foreground font-mono">{timeAgo(p.timestamp)}</span>
                            <span className="text-[10px] text-muted-foreground/60 font-mono ml-auto">
                              #{p.proposal_id.slice(0, 8)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">{p.details}</p>
                        </div>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>
            )}
          </Tabs>
        </div>
      </div>
    </div>
  )
}
