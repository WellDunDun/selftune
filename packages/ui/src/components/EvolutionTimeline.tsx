import { useState } from "react";
import { Badge } from "../primitives/badge";
import { cn } from "../lib/utils";
import type { EvalSnapshot, EvolutionEntry } from "../types";
import { timeAgo } from "../lib/format";
import { TrendingUpIcon, TrendingDownIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";

const ACTION_COLOR: Record<string, string> = {
  created: "bg-primary/35",
  validated: "bg-primary/65",
  deployed: "bg-primary",
  rejected: "bg-destructive/85",
  rolled_back: "bg-destructive/45",
};

const ACTION_RING: Record<string, string> = {
  created: "ring-primary/15",
  validated: "ring-primary/20",
  deployed: "ring-primary/30",
  rejected: "ring-destructive/20",
  rolled_back: "ring-destructive/15",
};

const ACTION_LINE: Record<string, string> = {
  created: "bg-primary/12",
  validated: "bg-primary/18",
  deployed: "bg-primary/30",
  rejected: "bg-destructive/18",
  rolled_back: "bg-destructive/12",
};

interface Props {
  entries: EvolutionEntry[];
  selectedProposalId: string | null;
  onSelect: (proposalId: string) => void;
}

/** Group evolution entries by proposal_id, ordered newest-first. */
function groupByProposal(entries: EvolutionEntry[]) {
  const map = new Map<string, EvolutionEntry[]>();
  for (const e of entries) {
    const group = map.get(e.proposal_id) ?? [];
    group.push(e);
    map.set(e.proposal_id, group);
  }
  for (const group of map.values()) {
    group.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  return Array.from(map.entries()).sort((a, b) => {
    const aLast = a[1][a[1].length - 1];
    const bLast = b[1][b[1].length - 1];
    return new Date(bLast.timestamp).getTime() - new Date(aLast.timestamp).getTime();
  });
}

function terminalAction(entries: EvolutionEntry[]): string {
  return entries[entries.length - 1].action;
}

/** Find the best eval_snapshot across all steps in a proposal group */
function findEvalSnapshot(steps: EvolutionEntry[]): EvalSnapshot | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].eval_snapshot) return steps[i].eval_snapshot!;
  }
  return null;
}

function PassRateDelta({ snapshot }: { snapshot: EvalSnapshot }) {
  const net = snapshot.net_change;
  if (net === undefined || net === null) return null;
  const pct = Math.round(net * 100);
  const isPositive = pct > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-mono font-medium",
        isPositive ? "text-primary" : "text-destructive",
      )}
    >
      {isPositive ? (
        <TrendingUpIcon className="size-2.5" />
      ) : (
        <TrendingDownIcon className="size-2.5" />
      )}
      {isPositive ? "+" : ""}
      {pct}%
    </span>
  );
}

const LIFECYCLE_STEPS = [
  { action: "created", label: "Created", desc: "Proposal generated from session data" },
  { action: "validated", label: "Validated", desc: "Eval tests run, awaiting deployment" },
  { action: "deployed", label: "Deployed", desc: "Accepted and applied to skill file" },
  { action: "rejected", label: "Rejected", desc: "Failed validation criteria" },
  { action: "rolled_back", label: "Rolled Back", desc: "Reverted after deployment" },
];

function LifecycleLegend() {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors w-full"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        Lifecycle stages
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-md border bg-muted/30 p-2">
          {LIFECYCLE_STEPS.map((step) => (
            <div key={step.action} className="flex items-start gap-2">
              <div className={cn("size-2 rounded-full mt-1 shrink-0", ACTION_COLOR[step.action])} />
              <div className="min-w-0">
                <span className="text-[10px] font-medium">{step.label}</span>
                <p className="text-[10px] text-muted-foreground/70 leading-tight">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EvolutionTimeline({ entries, selectedProposalId, onSelect }: Props) {
  const groups = groupByProposal(entries);

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed py-6 px-3">
        <p className="text-xs text-muted-foreground">No evolution history yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      <h2 className="sticky top-0 z-10 bg-background px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Evolution
      </h2>
      <LifecycleLegend />
      <nav className="flex flex-col">
        {groups.map(([proposalId, steps], groupIdx) => {
          const terminal = terminalAction(steps);
          const isSelected = selectedProposalId === proposalId;
          const lastStep = steps[steps.length - 1];
          const dotColor = ACTION_COLOR[terminal] ?? "bg-muted-foreground";
          const ringColor = ACTION_RING[terminal] ?? "ring-muted-foreground/30";
          const lineColor = ACTION_LINE[terminal] ?? "bg-border";
          const isLast = groupIdx === groups.length - 1;
          const snapshot = findEvalSnapshot(steps);

          return (
            <div key={proposalId} className="relative flex gap-3">
              {/* Vertical connector line */}
              <div className="flex flex-col items-center">
                <div
                  className={cn("size-3 shrink-0 rounded-full ring-2 z-10", dotColor, ringColor)}
                />
                {!isLast && <div className={cn("w-0.5 flex-1 min-h-[16px]", lineColor)} />}
              </div>

              {/* Content */}
              <button
                type="button"
                onClick={() => onSelect(proposalId)}
                className={cn(
                  "flex-1 min-w-0 rounded-md px-2.5 py-2 text-left transition-all mb-1",
                  "hover:bg-accent/50",
                  isSelected ? "bg-primary/5 ring-1 ring-primary/20" : "",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={
                      terminal === "deployed"
                        ? "default"
                        : terminal === "rejected" || terminal === "rolled_back"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-[10px] capitalize"
                  >
                    {terminal.replace("_", " ")}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {timeAgo(lastStep.timestamp)}
                  </span>
                </div>
                {/* Pass rate delta from eval snapshot */}
                {snapshot && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <PassRateDelta snapshot={snapshot} />
                    {snapshot.before_pass_rate !== undefined &&
                      snapshot.after_pass_rate !== undefined && (
                        <span className="text-[10px] text-muted-foreground/60 font-mono">
                          {Math.round(snapshot.before_pass_rate * 100)}&rarr;
                          {Math.round(snapshot.after_pass_rate * 100)}%
                        </span>
                      )}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] font-mono text-muted-foreground/70">
                    #{proposalId.slice(0, 8)}
                  </span>
                  {/* Step dots */}
                  {steps.length > 1 && (
                    <div className="flex gap-0.5 ml-auto">
                      {steps.map((s, i) => (
                        <div
                          key={`${s.action}-${i}`}
                          className={cn(
                            "size-1.5 rounded-full",
                            ACTION_COLOR[s.action] ?? "bg-muted-foreground",
                          )}
                        />
                      ))}
                    </div>
                  )}
                </div>
                {lastStep.details && (
                  <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-1 leading-snug">
                    {lastStep.details}
                  </p>
                )}
              </button>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
