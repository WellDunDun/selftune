import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { InfoTip } from "@/components/InfoTip"
import {
  TrendingUpIcon,
  TrendingDownIcon,
  AlertTriangleIcon,
  ActivityIcon,
  EyeIcon,
  FlaskConicalIcon,
  LayersIcon,
  SearchXIcon,
} from "lucide-react"

interface SectionCardsProps {
  skillsCount: number
  avgPassRate: number | null
  unmatchedCount: number
  sessionsCount: number
  pendingCount: number
  evidenceCount: number
}

export function SectionCards({
  skillsCount,
  avgPassRate,
  unmatchedCount,
  sessionsCount,
  pendingCount,
  evidenceCount,
}: SectionCardsProps) {
  const passRateStr = avgPassRate !== null ? `${Math.round(avgPassRate * 100)}%` : "--"
  const passRateGood = avgPassRate !== null && avgPassRate >= 0.7

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <LayersIcon className="size-3.5" />
            Skills Monitored
            <InfoTip text="Total number of skills detected and being tracked by selftune" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {skillsCount}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <ActivityIcon className="size-3" />
              live
            </Badge>
          </CardAction>
        </CardHeader>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <FlaskConicalIcon className="size-3.5" />
            Avg Pass Rate
            <InfoTip text="Average percentage of eval test cases that passed across all graded skills (5+ checks)" />
          </CardDescription>
          <CardTitle className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${!passRateGood && avgPassRate !== null ? "text-red-600" : ""}`}>
            {passRateStr}
          </CardTitle>
          {avgPassRate !== null && (
            <CardAction>
              <Badge variant={passRateGood ? "outline" : "destructive"}>
                {passRateGood ? (
                  <TrendingUpIcon className="size-3" />
                ) : (
                  <TrendingDownIcon className="size-3" />
                )}
                {passRateStr}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <SearchXIcon className="size-3.5" />
            Unmatched Queries
            <InfoTip text="User prompts that didn't match any skill's trigger criteria — potential gaps in coverage" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {unmatchedCount}
          </CardTitle>
          {unmatchedCount > 0 && (
            <CardAction>
              <Badge variant="destructive">
                <AlertTriangleIcon className="size-3" />
                needs attention
              </Badge>
            </CardAction>
          )}
        </CardHeader>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <ActivityIcon className="size-3.5" />
            Sessions
            <InfoTip text="Total agent sessions that have been recorded and analyzed" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {sessionsCount}
          </CardTitle>
        </CardHeader>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <AlertTriangleIcon className="size-3.5" />
            Pending Proposals
            <InfoTip text="Evolution proposals that have been generated but not yet validated or deployed" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {pendingCount}
          </CardTitle>
          {pendingCount > 0 && (
            <CardAction>
              <Badge variant="secondary">
                awaiting review
              </Badge>
            </CardAction>
          )}
        </CardHeader>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <EyeIcon className="size-3.5" />
            Total Evidence
            <InfoTip text="Number of evidence entries documenting skill changes with before/after validation results" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {evidenceCount}
          </CardTitle>
        </CardHeader>
      </Card>
    </div>
  )
}
