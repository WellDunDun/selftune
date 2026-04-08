"use client";

import { useMemo, useState } from "react";
import { CheckCircleIcon, ChevronDownIcon } from "lucide-react";

import { Badge } from "../primitives/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../primitives/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/tabs";
import { timeAgo } from "../lib/format";
import type {
  AttentionItem,
  AttentionSeverity,
  AutonomousDecision,
  AutonomyStatus,
  AutonomyStatusLevel,
  DecisionKind,
  EvolutionEntry,
  TrustBucket,
  TrustWatchlistEntry,
} from "../types";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<AutonomyStatusLevel, { color: string; glow: string }> = {
  healthy: {
    color: "bg-emerald-400",
    glow: "shadow-[0_0_12px_rgba(52,211,153,0.6)]",
  },
  watching: {
    color: "bg-cyan-400",
    glow: "shadow-[0_0_12px_rgba(79,242,255,0.6)]",
  },
  needs_review: {
    color: "bg-amber-400",
    glow: "shadow-[0_0_12px_rgba(251,191,36,0.6)]",
  },
  blocked: {
    color: "bg-red-400",
    glow: "shadow-[0_0_12px_rgba(248,113,113,0.6)]",
  },
};

const STATUS_LABELS: Record<AutonomyStatusLevel, string> = {
  healthy: "Healthy",
  watching: "Watching",
  needs_review: "Needs Review",
  blocked: "Blocked",
};

const SEVERITY: Record<AttentionSeverity, { dot: string; text: string; bg: string }> = {
  critical: {
    dot: "bg-red-400",
    text: "text-red-400",
    bg: "bg-red-500/10",
  },
  warning: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    bg: "bg-amber-500/10",
  },
  info: {
    dot: "bg-cyan-400",
    text: "text-primary",
    bg: "bg-cyan-400/10",
  },
};

const DECISION_MARKERS: Record<DecisionKind, string> = {
  proposal_created: "bg-cyan-400",
  proposal_rejected: "bg-red-400",
  validation_failed: "bg-amber-400",
  proposal_deployed: "bg-emerald-400",
  rollback_triggered: "bg-red-400",
  regression_found: "bg-amber-400",
};

const BUCKET_CFG: Record<TrustBucket, { label: string; accent: string; dot: string }> = {
  at_risk: { label: "At Risk", accent: "text-red-400", dot: "bg-red-400" },
  improving: { label: "Improving", accent: "text-primary", dot: "bg-cyan-400" },
  uncertain: { label: "Uncertain", accent: "text-amber-400", dot: "bg-amber-400" },
  stable: {
    label: "Stable",
    accent: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

// Ambient bar heights for hero background
const BARS = [35, 55, 40, 70, 45, 80, 30, 65, 50, 75, 38, 60, 42, 72];

// ---------------------------------------------------------------------------
// AutonomyHeroCard
// ---------------------------------------------------------------------------

export interface AutonomyHeroCardProps {
  status: AutonomyStatus;
  lastRun: string | null;
}

export function AutonomyHeroCard({ status, lastRun }: AutonomyHeroCardProps) {
  const dot = STATUS_DOT[status.level];
  const primaryStat =
    status.attention_required > 0
      ? { value: status.attention_required, label: "Attention Required" }
      : { value: status.skills_observed, label: "Skills Observed" };

  return (
    <Card className="relative min-h-[332px] border-none bg-gradient-to-br from-muted via-muted to-primary/5 shadow-none py-0 ring-0">
      {/* Ambient bars */}
      <div className="absolute inset-0 flex items-end justify-around px-8 pb-24 pt-20 opacity-[0.08] pointer-events-none">
        {BARS.map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm min-w-[12px]"
            style={{
              height: `${h}%`,
              backgroundColor: `rgba(79, 242, 255, ${0.15 + (h / 100) * 0.3})`,
            }}
          />
        ))}
      </div>

      {/* Top: status + primary stat */}
      <CardHeader className="relative z-10 px-8 pt-8 pb-0">
        <div className="flex items-start gap-3">
          <span
            className={`mt-2 size-3.5 shrink-0 rounded-full animate-pulse ${dot.color} ${dot.glow}`}
          />
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Autonomy Status
            </p>
            <CardTitle className="text-2xl font-extrabold tracking-tight text-foreground">
              {STATUS_LABELS[status.level]}
            </CardTitle>
            <CardDescription className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
              {status.summary}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <div className="text-right shrink-0">
            <p
              className="text-5xl font-extrabold text-primary leading-none"
              style={{ filter: "drop-shadow(0 0 8px rgba(79,242,255,0.3))" }}
            >
              {primaryStat.value}
            </p>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-1.5">
              {primaryStat.label}
            </p>
          </div>
        </CardAction>
      </CardHeader>

      {/* Spacer */}
      <div className="flex-1 min-h-6" />

      {/* Bottom: compact stat chips */}
      <CardContent className="relative z-10 flex flex-col gap-5 px-8 pb-8 pt-0">
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="rounded-full border border-border/40 bg-background/60 px-3 py-1.5 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              Last Run
            </span>
            <span className="ml-2 font-medium text-foreground">
              {lastRun ? timeAgo(lastRun) : "Never"}
            </span>
          </div>
          <div className="rounded-full border border-border/40 bg-background/60 px-3 py-1.5 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              Skills
            </span>
            <span className="ml-2 font-medium text-foreground">{status.skills_observed}</span>
          </div>
          <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 backdrop-blur-sm">
            <span className="text-[10px] uppercase tracking-[0.18em] text-primary/80">Pending</span>
            <span className="ml-2 font-semibold text-primary">{status.pending_reviews}</span>
          </div>
        </div>

        {status.attention_required > 0 ? (
          <a
            href="#supervision-feed"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 w-fit"
          >
            Review Attention Queue
          </a>
        ) : (
          <span className="text-sm text-muted-foreground/70">No action needed</span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TrustWatchlistRail
// ---------------------------------------------------------------------------

export interface TrustWatchlistRailProps {
  entries: TrustWatchlistEntry[];
  /** Optional render prop for skill name links */
  renderSkillLink?: (skillName: string) => React.ReactNode;
}

export function TrustWatchlistRail({ entries, renderSkillLink }: TrustWatchlistRailProps) {
  const buckets = useMemo(() => {
    const order: TrustBucket[] = ["at_risk", "improving", "uncertain", "stable"];
    const grouped: Record<TrustBucket, TrustWatchlistEntry[]> = {
      at_risk: [],
      improving: [],
      uncertain: [],
      stable: [],
    };
    for (const e of entries) grouped[e.bucket].push(e);
    return order
      .filter((b) => grouped[b].length > 0)
      .map((b) => ({ bucket: b, items: grouped[b] }));
  }, [entries]);

  return (
    <Card className="border-none bg-muted shadow-none py-0 max-h-[360px] ring-0">
      <CardHeader className="px-5 pt-5 pb-0">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Trust Watchlist
          </p>
          <CardDescription className="mt-1 text-[11px] text-muted-foreground/70">
            Highest-risk skills worth checking next.
          </CardDescription>
        </div>
        <CardAction>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            {entries.length} skills
          </span>
        </CardAction>
      </CardHeader>

      {buckets.length === 0 ? (
        <CardContent className="flex flex-1 items-center justify-center px-5 py-4">
          <p className="text-xs text-muted-foreground/70">No skills tracked yet.</p>
        </CardContent>
      ) : (
        <CardContent className="space-y-3 overflow-y-auto min-h-0 flex-1 px-5 py-4">
          {buckets.map(({ bucket, items }) => (
            <RailBucket
              key={bucket}
              bucket={bucket}
              items={items}
              renderSkillLink={renderSkillLink}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function RailBucket({
  bucket,
  items,
  renderSkillLink,
}: {
  bucket: TrustBucket;
  items: TrustWatchlistEntry[];
  renderSkillLink?: (skillName: string) => React.ReactNode;
}) {
  const cfg = BUCKET_CFG[bucket];
  const [open, setOpen] = useState(false);
  const MAX = 5;
  const [showAll, setShowAll] = useState(false);
  const visible = open ? (showAll ? items : items.slice(0, MAX)) : [];

  return (
    <div className="rounded-xl bg-background/40 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${cfg.dot}`} />
        <ChevronDownIcon
          className={`size-3 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className={`text-xs font-medium ${cfg.accent}`}>{cfg.label}</span>
        <span className="text-[10px] text-muted-foreground/70">({items.length})</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {visible.map((e) => (
            <div
              key={e.skill_name}
              className="rounded-lg px-2 py-1.5 transition-colors hover:bg-background/55"
            >
              <div className="flex items-baseline justify-between gap-2">
                {renderSkillLink ? (
                  renderSkillLink(e.skill_name)
                ) : (
                  <span className="text-[11px] font-medium text-foreground truncate">
                    {e.skill_name}
                  </span>
                )}
                {e.pass_rate != null && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {Math.round(e.pass_rate * 100)}%
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground/70">{e.reason}</p>
            </div>
          ))}
          {items.length > MAX && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="pl-2 text-[10px] text-primary hover:underline"
            >
              +{items.length - MAX} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SupervisionFeed
// ---------------------------------------------------------------------------

export interface SupervisionFeedProps {
  attention: AttentionItem[];
  decisions: AutonomousDecision[];
  /** Optional render prop for skill name links */
  renderSkillLink?: (skillName: string) => React.ReactNode;
}

export function SupervisionFeed({ attention, decisions, renderSkillLink }: SupervisionFeedProps) {
  return (
    <Card
      id="supervision-feed"
      className="relative overflow-hidden border-none bg-muted shadow-none py-0 scroll-mt-6 ring-0"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
      <Tabs defaultValue="attention" className="gap-0">
        <CardHeader className="relative px-5 pt-4 pb-0">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Supervision Feed
            </p>
            <CardDescription className="mt-1 text-[13px] text-muted-foreground/70">
              What needs review and what selftune just decided.
            </CardDescription>
          </div>
          <TabsList variant="line" className="mt-3">
            <TabsTrigger value="attention" className="text-xs uppercase tracking-[0.15em]">
              Attention Required
              {attention.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 px-1.5">
                  {attention.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="decisions" className="text-xs uppercase tracking-[0.15em]">
              Recent Decisions
              {decisions.length > 0 && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">{decisions.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </CardHeader>

        <CardContent className="max-h-[440px] overflow-y-auto px-5 py-5">
          <TabsContent value="attention">
            <AttentionContent attention={attention} renderSkillLink={renderSkillLink} />
          </TabsContent>
          <TabsContent value="decisions">
            <DecisionsContent decisions={decisions} renderSkillLink={renderSkillLink} />
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  );
}

function AttentionContent({
  attention,
  renderSkillLink,
}: {
  attention: AttentionItem[];
  renderSkillLink?: (skillName: string) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);

  if (attention.length === 0) {
    return (
      <div className="flex items-center gap-3 py-4">
        <CheckCircleIcon className="size-5 text-emerald-400" />
        <p className="text-sm text-muted-foreground">Nothing needs your attention</p>
      </div>
    );
  }

  const visible = showAll ? attention : attention.slice(0, 6);

  return (
    <div className="space-y-2">
      {visible.map((item) => {
        const sev = SEVERITY[item.severity];
        return (
          <div
            key={`${item.skill_name}-${item.category}`}
            className="flex items-start gap-3 rounded-xl bg-background/40 px-3 py-3 transition-colors hover:bg-background/55"
          >
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${sev.dot}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {renderSkillLink ? (
                  renderSkillLink(item.skill_name)
                ) : (
                  <span className="text-sm font-medium text-foreground">{item.skill_name}</span>
                )}
                <Badge
                  variant="outline"
                  className={`text-[10px] font-normal ${sev.text} ${sev.bg} border-transparent`}
                >
                  {item.category.replace(/_/g, " ")}
                </Badge>
              </div>
              <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{item.reason}</p>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/70">
                {item.recommended_action}
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground/70 shrink-0 mt-0.5">
              {item.timestamp ? timeAgo(item.timestamp) : ""}
            </span>
          </div>
        );
      })}
      {attention.length > 6 && !showAll && (
        <div className="pt-3">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-primary hover:underline"
          >
            Show all {attention.length} attention items
          </button>
        </div>
      )}
    </div>
  );
}

function DecisionsContent({
  decisions,
  renderSkillLink,
}: {
  decisions: AutonomousDecision[];
  renderSkillLink?: (skillName: string) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? decisions : decisions.slice(0, 10);

  if (decisions.length === 0) {
    return <p className="text-xs text-muted-foreground/70 py-4">No autonomous decisions yet.</p>;
  }

  return (
    <div className="space-y-1">
      {visible.map((d, i) => {
        const marker = DECISION_MARKERS[d.kind];
        return (
          <div
            key={`${d.timestamp}-${d.skill_name}-${i}`}
            className="flex items-start gap-2.5 rounded-xl bg-background/30 px-3 py-2 transition-colors hover:bg-background/45"
          >
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${marker}`} />
            <div className="flex-1 min-w-0">
              {renderSkillLink ? (
                renderSkillLink(d.skill_name)
              ) : (
                <span className="text-xs font-medium text-foreground truncate block">
                  {d.skill_name}
                </span>
              )}
              <p className="line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>
            </div>
            <span className="text-[10px] text-muted-foreground/70 shrink-0 mt-0.5">
              {timeAgo(d.timestamp)}
            </span>
          </div>
        );
      })}
      {decisions.length > 10 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline mt-1 pl-2"
        >
          Show all ({decisions.length})
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkillComparisonGrid
// ---------------------------------------------------------------------------

export interface SkillComparisonRow {
  skillId?: string;
  skillName: string;
  platforms: string[];
  triggerRate: number | null;
  routingConfidence: number | null;
  confidenceCoverage: number;
  sessions: number;
  lastEvolution: EvolutionEntry | null;
  bucket: TrustBucket;
}

export interface SkillComparisonGridProps {
  rows: SkillComparisonRow[];
  /** Optional render prop for skill name links */
  renderSkillLink?: (skillName: string) => React.ReactNode;
}

function formatEvolutionAction(action: string): string {
  switch (action) {
    case "created":
      return "Proposal created";
    case "validated":
      return "Validated";
    case "deployed":
      return "Deployed";
    case "rolled_back":
      return "Rolled back";
    case "watch":
      return "Watching";
    case "rejected":
      return "Rejected";
    default:
      return action.replace(/_/g, " ");
  }
}

export function SkillComparisonGrid({ rows, renderSkillLink }: SkillComparisonGridProps) {
  if (rows.length === 0) return null;

  return (
    <Card className="border-none bg-muted shadow-none py-0 ring-0">
      <CardHeader className="px-5 pt-5 pb-0">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Skill Comparison
          </p>
          <CardDescription className="mt-1 text-[13px] text-muted-foreground/70">
            Compare skill performance before drilling into the details.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="overflow-x-auto px-5 py-5">
        <div className="min-w-[680px]">
          <div className="grid grid-cols-[minmax(180px,2fr)_1fr_1fr_0.8fr_1.2fr_1fr] gap-3 px-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
            <span>Skill</span>
            <span>Trigger Rate</span>
            <span>Routing Conf.</span>
            <span>Sessions</span>
            <span>Last Evolution</span>
            <span>Status</span>
          </div>
          <div className="space-y-1.5">
            {rows.map((row) => {
              const bucketCfg = BUCKET_CFG[row.bucket];
              return (
                <div
                  key={row.skillId ?? row.skillName}
                  className="grid grid-cols-[minmax(180px,2fr)_1fr_1fr_0.8fr_1.2fr_1fr] items-center gap-3 rounded-xl bg-background/35 px-3 py-3 text-sm transition-colors hover:bg-background/50"
                >
                  <div className="min-w-0">
                    {renderSkillLink ? (
                      renderSkillLink(row.skillName)
                    ) : (
                      <p className="truncate font-medium text-foreground">{row.skillName}</p>
                    )}
                  </div>
                  <div className="font-medium text-foreground">
                    {row.triggerRate != null ? `${Math.round(row.triggerRate * 100)}%` : "--"}
                  </div>
                  <div className="min-w-0">
                    {row.routingConfidence != null && row.confidenceCoverage >= 0.5 ? (
                      <>
                        <p className="text-sm font-medium text-foreground">
                          {Math.round(row.routingConfidence * 100)}%
                        </p>
                        <p className="truncate text-xs text-muted-foreground/70">
                          {Math.round(row.confidenceCoverage * 100)}% coverage
                        </p>
                      </>
                    ) : (
                      <p className="text-sm font-medium text-muted-foreground/70">--</p>
                    )}
                  </div>
                  <div className="text-muted-foreground">{row.sessions}</div>
                  <div className="min-w-0">
                    {row.lastEvolution ? (
                      <>
                        <p className="truncate text-sm text-foreground">
                          {formatEvolutionAction(row.lastEvolution.action)}
                        </p>
                        <p className="text-xs text-muted-foreground/70">
                          {timeAgo(row.lastEvolution.timestamp)}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground/70">No evolutions yet</span>
                    )}
                  </div>
                  <div>
                    <Badge
                      variant="outline"
                      className={`border-transparent ${bucketCfg.accent} bg-background/55`}
                    >
                      <span
                        className={`mr-1.5 inline-block size-1.5 rounded-full ${bucketCfg.dot}`}
                      />
                      {bucketCfg.label}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
