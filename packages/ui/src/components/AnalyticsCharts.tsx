"use client";

import * as React from "react";

/* ── Types ──────────────────────────────────────────────── */

export interface PassRateTrendPoint {
  date: string;
  pass_rate: number;
  total_checks: number;
}

export interface SkillRanking {
  skill_name: string;
  pass_rate: number;
  total_checks: number;
  triggered_count: number;
}

export interface DailyActivity {
  date: string;
  checks: number;
}

export interface EvolutionImpact {
  skill_name: string;
  proposal_id: string;
  deployed_at: string;
  pass_rate_before: number;
  pass_rate_after: number;
}

export interface AnalyticsSummary {
  total_evolutions: number;
  avg_improvement: number;
  total_checks_30d: number;
  active_skills: number;
}

export interface AnalyticsResponse {
  pass_rate_trend: PassRateTrendPoint[];
  skill_rankings: SkillRanking[];
  daily_activity: DailyActivity[];
  evolution_impact: EvolutionImpact[];
  summary: AnalyticsSummary;
}

/* ── Helpers ────────────────────────────────────────────── */

function formatDayBucketLabel(day: string): string {
  const parts = day.split("-");
  const month = parts[1];
  const date = parts[2];
  if (!month || !date) return day;
  return `${Number(month)}/${Number(date)}`;
}

/* ── SVG Line Chart ─────────────────────────────────────── */

export function PassRateTrendChart({
  data,
  mode,
}: {
  data: PassRateTrendPoint[];
  mode: "pass_rate" | "volume";
}) {
  const width = 720;
  const height = 260;
  const padX = 48;
  const padY = 32;
  const padBottom = 28;

  const values = data.map((d) => (mode === "pass_rate" ? d.pass_rate * 100 : d.total_checks));
  const maxVal = Math.max(...values, mode === "pass_rate" ? 100 : 1);
  const minVal = 0;

  const chartW = width - padX * 2;
  const chartH = height - padY - padBottom;

  const points = values.map((v, i) => {
    const x = padX + (i / Math.max(1, values.length - 1)) * chartW;
    const y = padY + chartH - ((v - minVal) / Math.max(1, maxVal - minVal)) * chartH;
    return { x, y };
  });

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaD = `${pathD} L${points[points.length - 1]?.x ?? padX},${padY + chartH} L${padX},${padY + chartH} Z`;

  const yTicks =
    mode === "pass_rate"
      ? [0, 25, 50, 75, 100]
      : Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));

  const xLabels: Array<{ label: string; x: number }> = [];
  const step = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += step) {
    const d = data[i];
    const pt = points[i];
    if (d && pt) {
      xLabels.push({ label: formatDayBucketLabel(d.date), x: pt.x });
    }
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[260px] text-muted-foreground text-sm">
        No trend data available yet
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="analytics-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {yTicks.map((tick) => {
        const y = padY + chartH - ((tick - minVal) / Math.max(1, maxVal - minVal)) * chartH;
        return (
          <g key={tick}>
            <line
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />
            <text
              x={padX - 8}
              y={y + 3}
              textAnchor="end"
              fill="var(--muted-foreground)"
              fontSize="9"
              fontFamily="var(--font-headline)"
            >
              {mode === "pass_rate" ? `${tick}%` : tick}
            </text>
          </g>
        );
      })}

      {xLabels.map((label) => (
        <text
          key={label.label}
          x={label.x}
          y={height - 4}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize="9"
          fontFamily="var(--font-headline)"
        >
          {label.label}
        </text>
      ))}

      {points.length > 1 && <path d={areaD} fill="url(#analytics-chart-fill)" />}

      {points.length > 1 && (
        <path
          d={pathD}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: "drop-shadow(0 0 4px rgba(79,242,255,0.5))" }}
        />
      )}

      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill="var(--primary)"
          stroke="var(--muted)"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

/* ── Skill Rankings List ────────────────────────────────── */

export function SkillRankingsList({ skills }: { skills: SkillRanking[] }) {
  if (skills.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No skills graded yet</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col gap-4">
      {skills.map((skill) => (
        <div key={skill.skill_name}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-headline text-[11px] uppercase tracking-wider text-foreground truncate max-w-[65%]">
              {skill.skill_name}
            </span>
            <span className="font-headline text-xs font-semibold text-primary">
              {Math.round(skill.pass_rate * 100)}%
            </span>
          </div>
          <div className="h-[1.5px] rounded-full bg-border/30 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{
                width: `${Math.round(skill.pass_rate * 100)}%`,
                boxShadow: "0 0 6px rgba(79,242,255,0.4)",
              }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {skill.total_checks} checks &middot; {skill.triggered_count} triggered
          </p>
        </div>
      ))}
    </div>
  );
}

/* ── Activity Heatmap ───────────────────────────────────── */

export function ActivityHeatmap({ data }: { data: DailyActivity[] }) {
  const cells = data.slice(-84);
  const maxChecks = Math.max(...cells.map((d) => d.checks), 1);

  if (cells.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        No grading activity recorded yet
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap gap-1.5 flex-1 content-start">
        {cells.map((day) => {
          const intensity = day.checks / maxChecks;
          const opacity = Math.max(0.08, intensity);
          return (
            <div
              key={day.date}
              className="size-5 rounded-sm transition-colors"
              style={{
                backgroundColor: `color-mix(in srgb, var(--primary) ${Math.round(opacity * 100)}%, transparent)`,
              }}
              title={`${day.date}: ${day.checks} checks`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 mt-auto pt-3">
        <span className="text-[10px] font-headline uppercase tracking-widest text-muted-foreground">
          Quiet
        </span>
        {[8, 25, 50, 75, 100].map((pct) => (
          <div
            key={pct}
            className="size-3 rounded-sm"
            style={{
              backgroundColor: `color-mix(in srgb, var(--primary) ${pct}%, transparent)`,
            }}
          />
        ))}
        <span className="text-[10px] font-headline uppercase tracking-widest text-muted-foreground">
          Active
        </span>
      </div>
    </div>
  );
}

/* ── Evolution ROI List ─────────────────────────────────── */

export function EvolutionROIList({ impacts }: { impacts: EvolutionImpact[] }) {
  if (impacts.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-sm text-muted-foreground">No evolution deployments yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-h-[260px] overflow-y-auto">
      {impacts.map((evo) => {
        const delta = (evo.pass_rate_after - evo.pass_rate_before) * 100;
        const improved = delta > 0;
        return (
          <div
            key={evo.proposal_id}
            className="flex items-center justify-between bg-muted/50 rounded-lg px-4 py-3"
          >
            <div className="min-w-0">
              <p className="font-headline text-[11px] uppercase tracking-wider text-foreground truncate">
                {evo.skill_name}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {Math.round(evo.pass_rate_before * 100)}% &rarr;{" "}
                {Math.round(evo.pass_rate_after * 100)}%
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <svg
                className={`size-3.5 ${improved ? "text-primary" : "text-destructive rotate-90"}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
              <span
                className={`font-headline text-sm font-semibold ${improved ? "text-primary" : "text-destructive"}`}
              >
                {improved ? "+" : ""}
                {Math.round(delta)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
