import { Badge } from "../primitives/badge";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "../primitives/card";
import { InfoTip } from "./InfoTip";
import {
  TrendingUpIcon,
  TrendingDownIcon,
  AlertTriangleIcon,
  ActivityIcon,
  EyeIcon,
  FlaskConicalIcon,
  LayersIcon,
  SearchXIcon,
} from "lucide-react";

interface SectionCardsProps {
  skillsCount: number;
  avgPassRate: number | null;
  unmatchedCount: number;
  sessionsCount: number;
  pendingCount: number;
  evidenceCount: number;
  hasEvolution?: boolean;
}

export function SectionCards({
  skillsCount,
  avgPassRate,
  unmatchedCount,
  sessionsCount,
  pendingCount,
  evidenceCount,
  hasEvolution = true,
}: SectionCardsProps) {
  const passRateStr = avgPassRate !== null ? `${Math.round(avgPassRate * 100)}%` : "--";
  const passRateGood = avgPassRate !== null && avgPassRate >= 0.7;

  return (
    <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
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

      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
            <FlaskConicalIcon className="size-3.5" />
            Avg Trigger Rate
            <InfoTip text="Average percentage of skill checks that resulted in a trigger across all graded skills (5+ checks). Run selftune evolve to improve this." />
          </CardDescription>
          <CardTitle
            className={`text-2xl font-semibold tabular-nums @[250px]/card:text-3xl ${!passRateGood && avgPassRate !== null ? "text-red-600" : ""}`}
          >
            {passRateStr}
          </CardTitle>
          <CardAction>
            {avgPassRate !== null ? (
              <Badge variant={passRateGood ? "outline" : "destructive"}>
                {passRateGood ? (
                  <TrendingUpIcon className="size-3" />
                ) : (
                  <TrendingDownIcon className="size-3" />
                )}
                {passRateStr}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                needs 5+ checks
              </Badge>
            )}
          </CardAction>
        </CardHeader>
      </Card>

      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
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

      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
            <ActivityIcon className="size-3.5" />
            Sessions
            <InfoTip text="Total agent sessions that have been recorded and analyzed" />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {sessionsCount}
          </CardTitle>
        </CardHeader>
      </Card>

      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
            <AlertTriangleIcon className="size-3.5" />
            Pending Proposals
            <InfoTip text="Evolution proposals that have been generated but not yet validated or deployed. Requires running selftune evolve." />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {hasEvolution ? pendingCount : "--"}
          </CardTitle>
          <CardAction>
            {!hasEvolution ? (
              <Badge variant="secondary" className="text-[10px]">
                no evolution runs yet
              </Badge>
            ) : pendingCount > 0 ? (
              <Badge variant="secondary">awaiting review</Badge>
            ) : null}
          </CardAction>
        </CardHeader>
      </Card>

      <Card className="@container/card bg-muted border-none shadow-none ring-0">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5 font-headline">
            <EyeIcon className="size-3.5" />
            Total Evidence
            <InfoTip text="Number of evidence entries documenting skill changes with before/after validation results. Requires running selftune evolve." />
          </CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {hasEvolution ? evidenceCount : "--"}
          </CardTitle>
          {!hasEvolution && (
            <CardAction>
              <Badge variant="secondary" className="text-[10px]">
                no evolution runs yet
              </Badge>
            </CardAction>
          )}
        </CardHeader>
      </Card>
    </div>
  );
}
