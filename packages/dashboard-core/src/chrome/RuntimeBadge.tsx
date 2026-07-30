"use client";

import { cn } from "./utils";
import type { RuntimeBadgeProps } from "./types";

export function RuntimeBadge({
  href,
  label,
  detail,
  tone = "healthy",
  renderLink,
}: RuntimeBadgeProps) {
  const toneClassName =
    tone === "warning"
      ? "text-warning-foreground ring-warning/20 hover:bg-warning/20"
      : tone === "critical"
        ? "text-destructive ring-destructive/20 hover:bg-destructive/8"
        : "text-primary ring-primary/20 hover:bg-primary/8";

  const dotClassName =
    tone === "warning"
      ? "bg-warning"
      : tone === "critical"
        ? "bg-destructive"
        : "animate-pulse bg-success";

  return (
    <footer className="pointer-events-none fixed bottom-4 right-4 z-20">
      {renderLink({
        href,
        className: cn(
          "glass-panel pointer-events-auto flex items-center gap-2 rounded-full border border-border px-3 py-2 font-headline text-[10px] uppercase tracking-[0.18em] shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          toneClassName,
        ),
        children: (
          <>
            <span className={cn("size-1.5 rounded-full", dotClassName)} />
            <span>{label}</span>
            <span className="text-foreground/25">/</span>
            <span className="text-muted-foreground">{detail}</span>
          </>
        ),
      })}
    </footer>
  );
}
