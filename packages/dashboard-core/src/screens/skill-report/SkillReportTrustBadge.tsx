import { cn } from "@selftune/ui/lib";
import { Badge } from "@selftune/ui/primitives";
import type { TrustState } from "@selftune/ui/types";

export function SkillReportTrustBadge({ state }: { state: TrustState }) {
  const config = getSkillReportTrustBadgeConfig(state);

  return (
    <Badge variant={config.variant} className="gap-1.5 shrink-0 text-[10px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", config.dotClassName)} />
      {config.label}
    </Badge>
  );
}

export function getSkillReportTrustBadgeConfig(state: TrustState): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  dotClassName: string;
} {
  switch (state) {
    case "low_sample":
      return {
        label: "Low Sample",
        variant: "secondary",
        dotClassName: "bg-muted-foreground/60",
      };
    case "observed":
      return {
        label: "Observed",
        variant: "outline",
        dotClassName: "bg-muted-foreground",
      };
    case "watch":
      return {
        label: "Watch",
        variant: "secondary",
        dotClassName: "bg-amber-400",
      };
    case "validated":
      return {
        label: "Validated",
        variant: "default",
        dotClassName: "bg-primary",
      };
    case "deployed":
      return {
        label: "Deployed",
        variant: "default",
        dotClassName: "bg-primary",
      };
    case "rolled_back":
      return {
        label: "Rolled Back",
        variant: "destructive",
        dotClassName: "bg-destructive",
      };
  }
}
