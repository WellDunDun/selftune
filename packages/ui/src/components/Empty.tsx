import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex min-h-56 w-full min-w-0 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center text-balance",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex max-w-sm flex-col items-center gap-2", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-sm font-medium tracking-tight", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm/relaxed text-muted-foreground", className)} {...props} />;
}

export function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-sm flex-col items-center gap-2.5 text-sm", className)}
      {...props}
    />
  );
}
