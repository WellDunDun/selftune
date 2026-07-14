import type * as React from "react";

import { Badge } from "../primitives";
import { cn } from "../lib/utils";

export type StatusTone = "healthy" | "warning" | "critical" | "pending" | "neutral";
export type StatusBadgeAppearance = "badge" | "soft" | "text";

const BADGE_VARIANT_BY_TONE = {
  healthy: "default",
  warning: "warning",
  critical: "destructive",
  pending: "outline",
  neutral: "outline",
} as const;

const DOT_CLASS_BY_TONE = {
  healthy: "bg-primary",
  warning: "bg-amber-400",
  critical: "bg-destructive",
  pending: "bg-muted-foreground",
  neutral: "bg-muted-foreground",
} as const;

const SOFT_CLASS_BY_TONE = {
  healthy: "border-primary/30 bg-primary/10 text-primary",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  critical: "border-destructive/20 bg-destructive/10 text-destructive",
  pending: "border-border/60 bg-background/60 text-muted-foreground",
  neutral: "border-border/60 bg-background/60 text-muted-foreground",
} as const;

const TEXT_CLASS_BY_TONE = {
  healthy: "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-primary shadow-none",
  warning: "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-amber-400 shadow-none",
  critical: "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-destructive shadow-none",
  pending:
    "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-muted-foreground shadow-none",
  neutral:
    "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-muted-foreground shadow-none",
} as const;

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-2 shrink-0 rounded-full", DOT_CLASS_BY_TONE[tone], className)}
    />
  );
}

export function StatusBadge({
  tone,
  children,
  className,
  showDot = true,
  appearance = "badge",
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant"> & {
  tone: StatusTone;
  showDot?: boolean;
  appearance?: StatusBadgeAppearance;
}) {
  if (appearance === "text") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-0 text-[11px] font-medium uppercase tracking-[0.16em]",
          TEXT_CLASS_BY_TONE[tone],
          className,
        )}
        {...props}
      >
        {showDot ? <StatusDot tone={tone} className="mr-1.5 size-1.5" /> : null}
        {children}
      </span>
    );
  }

  const toneClass = appearance === "soft" ? SOFT_CLASS_BY_TONE[tone] : undefined;

  return (
    <Badge
      variant={appearance === "badge" ? BADGE_VARIANT_BY_TONE[tone] : "outline"}
      className={cn("gap-1.5 uppercase tracking-[0.16em]", toneClass, className)}
      {...props}
    >
      {showDot ? <StatusDot tone={tone} className="size-1.5" /> : null}
      {children}
    </Badge>
  );
}
