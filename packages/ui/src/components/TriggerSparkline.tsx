"use client";

import { Line, LineChart, Tooltip as RechartsTooltip, YAxis } from "recharts";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/tooltip";

export interface TriggerSparklinePoint {
  date: string;
  count: number;
}

function ZeroTriggerSparkline({ label }: { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className="flex h-8 w-24 items-center"
          aria-label={`${label}: no recorded triggers`}
          onClick={(event) => event.stopPropagation()}
        >
          <svg aria-hidden="true" viewBox="0 0 96 32" className="h-8 w-24">
            <line
              x1="2"
              y1="29"
              x2="94"
              y2="29"
              stroke="var(--primary)"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start gap-0.5">
          <span>0 in the last 30 days</span>
          <span>0 lifetime</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TriggerTooltip({
  active,
  payload,
  total,
  lifetimeTotal,
}: {
  active?: boolean;
  payload?: Array<{ payload: TriggerSparklinePoint }>;
  total: number;
  lifetimeTotal?: number | null;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="flex flex-col gap-0.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
      <div>
        <span className="font-medium">{point.count.toLocaleString()}</span>{" "}
        {point.count === 1 ? "trigger" : "triggers"}
        <span className="ml-1 text-muted-foreground">
          {new Date(`${point.date}T00:00:00Z`).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
      </div>
      <div className="text-muted-foreground">{total.toLocaleString()} in the last 30 days</div>
      {lifetimeTotal != null ? (
        <div className="text-muted-foreground">{lifetimeTotal.toLocaleString()} lifetime</div>
      ) : null}
    </div>
  );
}

export function TriggerSparkline({
  data,
  label,
  lifetimeTotal,
}: {
  data: TriggerSparklinePoint[];
  label: string;
  lifetimeTotal?: number | null;
}) {
  if (data.length === 0) {
    if (lifetimeTotal === 0) {
      return <ZeroTriggerSparkline label={label} />;
    }

    return (
      <div
        className="h-8 w-24 rounded-sm bg-muted/35"
        aria-label={`${label}: no trigger history`}
      />
    );
  }

  const total = data.reduce((sum, point) => sum + point.count, 0);
  const upperBound = Math.max(1, ...data.map((point) => point.count));

  return (
    <div
      className="h-8 w-24"
      role="img"
      aria-label={`${label} trigger history`}
      onClick={(event) => event.stopPropagation()}
    >
      <LineChart
        width={96}
        height={32}
        data={data}
        margin={{ top: 3, right: 2, bottom: 3, left: 2 }}
      >
        <YAxis hide domain={[0, upperBound]} />
        <RechartsTooltip
          content={<TriggerTooltip total={total} lifetimeTotal={lifetimeTotal} />}
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="count"
          stroke="var(--primary)"
          strokeWidth={1.75}
          dot={false}
          activeDot={{ r: 2.5, fill: "var(--primary)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}
