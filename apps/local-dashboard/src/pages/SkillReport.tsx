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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSkillReport } from "@/hooks/useSkillReport"
import { deriveStatus, formatRate, timeAgo } from "@/utils"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  XCircleIcon,
  CircleDotIcon,
  FlaskConicalIcon,
  ActivityIcon,
  EyeIcon,
  RefreshCwIcon,
  LayersIcon,
  TrendingUpIcon,
  TrendingDownIcon,
} from "lucide-react"

const STATUS_CONFIG: Record<string, {
  icon: React.ReactNode
  variant: "default" | "secondary" | "destructive" | "outline"
  label: string
}> = {
  HEALTHY: {
    icon: <CheckCircleIcon className="size-4 text-emerald-600" />,
    variant: "outline",
    label: "Healthy",
  },
  WARNING: {
    icon: <AlertTriangleIcon className="size-4 text-amber-500" />,
    variant: "secondary",
    label: "Warning",
  },
  CRITICAL: {
    icon: <XCircleIcon className="size-4 text-red-500" />,
    variant: "destructive",
    label: "Critical",
  },
  UNGRADED: {
    icon: <CircleDotIcon className="size-4 text-muted-foreground" />,
    variant: "secondary",
    label: "Ungraded",
  },
  UNKNOWN: {
    icon: <CircleDotIcon className="size-4 text-muted-foreground/60" />,
    variant: "secondary",
    label: "Unknown",
  },
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
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
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

  const { usage, recent_invocations, evidence, evolution, pending_proposals } = data
  const status = deriveStatus(usage.pass_rate, usage.total_checks)
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN
  const passRateGood = status === "HEALTHY"

  return (
    <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
      {/* Skill Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight lg:text-2xl">{data.skill_name}</h1>
        <Badge variant={config.variant} className="gap-1">
          {config.icon}
          {config.label}
        </Badge>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        <Card className="@container/card">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <FlaskConicalIcon className="size-3.5" />
              Pass Rate
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
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {data.sessions_with_skill}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Recent Invocations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Invocations</CardTitle>
          <CardDescription>{recent_invocations.length} records</CardDescription>
        </CardHeader>
        <CardContent>
          {recent_invocations.length === 0 ? (
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
                    <TableRow key={`${rec.session_id}-${i}`} className={rec.triggered ? "" : "bg-red-50/50"}>
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

      {/* Pending Proposals */}
      {pending_proposals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pending Proposals</CardTitle>
            <CardDescription>{pending_proposals.length} awaiting review</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pending_proposals.map((p) => (
              <div key={p.proposal_id} className="flex gap-3 rounded-lg border p-3">
                <div className="mt-0.5 size-2 shrink-0 rounded-full bg-amber-400" />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={ACTION_VARIANT[p.action] ?? "secondary"} className="text-[10px]">
                      {p.action}
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">{timeAgo(p.timestamp)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{p.details}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Evolution History */}
      {evolution.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Evolution History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {evolution.slice(0, 20).map((entry, i) => (
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
                    <span className="text-xs text-muted-foreground font-mono">{timeAgo(entry.timestamp)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{entry.details}</p>
                  <span className="text-[10px] text-muted-foreground/60 font-mono">
                    #{entry.proposal_id.slice(0, 8)}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Evidence */}
      {evidence.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Evolution Evidence</CardTitle>
            <CardDescription>{evidence.length} entries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Proposal</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Confidence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evidence.map((e, i) => (
                    <TableRow key={`${e.proposal_id}-${e.stage}-${i}`}>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {timeAgo(e.timestamp)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        #{e.proposal_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{e.target}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">{e.stage}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {e.confidence !== null ? e.confidence.toFixed(2) : "--"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
