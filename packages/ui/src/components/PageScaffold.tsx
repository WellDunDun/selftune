import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/utils";

export function PageScaffold({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-6xl flex-col gap-7 p-6 lg:p-8", className)}
      {...props}
    />
  );
}

export interface PageHeaderProps extends HTMLAttributes<HTMLElement> {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <header
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="font-headline text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
