import { cn } from "@/lib/utils";
import { HARNESS_LOGOS } from "@/lib/harnesses";
import type { HarnessId } from "@/types";

export function HarnessLogo({ id, className }: { id: HarnessId; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-[#171717]",
        className,
      )}
    >
      {/* Vite resolves these local assets; the Next.js image rule does not apply to this SPA. */}
      {/* oxlint-disable-next-line eslint-plugin-next/no-img-element */}
      <img
        src={HARNESS_LOGOS[id]}
        alt=""
        className={
          id === "openclaw"
            ? "size-full object-cover"
            : id === "pi"
              ? "size-full object-contain p-0.5"
              : "size-full object-contain p-1.5"
        }
      />
    </span>
  );
}
