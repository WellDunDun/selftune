"use client";

import { SearchIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";

import { matchesSearchItem } from "./utils";
import type { DashboardSearchItem } from "./types";

interface DashboardCommandPaletteProps {
  open: boolean;
  searchItems: DashboardSearchItem[];
  onOpenChange(open: boolean): void;
}

export function DashboardCommandPalette({
  open,
  searchItems,
  onOpenChange,
}: DashboardCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);

  const close = useCallback(() => {
    setQuery("");
    onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, open]);

  if (!open) return null;

  const filteredItems = searchItems
    .filter((item) => matchesSearchItem(item, deferredQuery))
    .slice(0, deferredQuery.trim() ? 12 : 8);
  const groups = new Map<string, DashboardSearchItem[]>();
  for (const item of filteredItems) {
    const existing = groups.get(item.group) ?? [];
    existing.push(item);
    groups.set(item.group, existing);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close commands"
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={close}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border/15 px-4">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills or pages..."
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-background/50 px-1.5 py-1 font-mono text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
          {filteredItems.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          ) : (
            Array.from(groups.entries()).map(([group, items]) => (
              <div key={group} className="border-b border-border/10 py-1 last:border-b-0">
                <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {group}
                </div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      item.onSelect();
                      close();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    {item.leading ? (
                      <span className="shrink-0">{item.leading}</span>
                    ) : (
                      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{item.label}</span>
                      {item.meta ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.meta}
                        </span>
                      ) : null}
                    </span>
                    {item.trailing ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.trailing}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
