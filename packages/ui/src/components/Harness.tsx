import { cn } from "../lib/utils";

export type HarnessIconSpec = {
  src: string;
  fit: "contain" | "cover";
  inset: "none" | "sm";
  /** Monochrome near-black glyphs set this to be inverted when the UI is in dark mode. */
  invert_in_dark?: boolean;
};

export type HarnessIconVariant = "tile" | "compact";
export type HarnessLabelVariant = "badge" | "inline";

export function HarnessIcon({
  name,
  icon,
  variant = "tile",
  className,
}: {
  name: string;
  icon?: HarnessIconSpec | null;
  variant?: HarnessIconVariant;
  className?: string;
}) {
  if (!icon) return null;

  // Monochrome glyphs ship near-black; inverting keeps them readable in dark
  // mode. Their tile stays neutral so the glyph never sits on a foreground-
  // colored surface it would disappear against.
  const mono = icon.invert_in_dark === true;

  return (
    <span
      aria-hidden="true"
      className={cn(
        variant === "tile"
          ? cn(
              "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70",
              mono ? "bg-muted" : "bg-foreground",
            )
          : "flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={icon.src}
        alt=""
        title={name}
        className={cn(
          "size-full",
          icon.fit === "cover" ? "object-cover" : "object-contain",
          icon.inset === "sm" && (variant === "tile" ? "p-1.5" : "p-0.5"),
          mono && "dark:invert",
        )}
      />
    </span>
  );
}

export function HarnessLabel({
  name,
  icon,
  variant = "badge",
  className,
}: {
  name: string;
  icon?: HarnessIconSpec | null;
  variant?: HarnessLabelVariant;
  className?: string;
}) {
  return (
    <span
      className={cn(
        variant === "badge"
          ? "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs font-medium text-foreground"
          : "inline-flex min-w-0 items-center gap-2 text-sm",
        className,
      )}
    >
      <HarnessIcon name={name} icon={icon} variant="compact" />
      <span className="truncate">{name}</span>
    </span>
  );
}
