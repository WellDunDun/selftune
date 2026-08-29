import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";
import { Label } from "./label";
import { Separator } from "./separator";

function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn("flex w-full flex-col gap-5", className)}
      {...props}
    />
  );
}

function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="field"
      className={cn("flex w-full flex-col gap-2 data-[invalid=true]:text-destructive", className)}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("w-fit", className)} {...props} />;
}

function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "text-sm leading-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: ComponentProps<"div"> & { children?: ReactNode }) {
  return (
    <div data-slot="field-separator" className={cn("relative h-5 text-sm", className)} {...props}>
      <Separator className="absolute inset-0 top-1/2" />
      {children ? (
        <span
          data-slot="field-separator-content"
          className="relative mx-auto block w-fit bg-card px-2 text-muted-foreground"
        >
          {children}
        </span>
      ) : null}
    </div>
  );
}

export { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator };
