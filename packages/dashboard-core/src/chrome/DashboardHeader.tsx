"use client";

import { ArrowLeftIcon, BellIcon, BoltIcon, MenuIcon, SearchIcon, UserIcon } from "lucide-react";
import { useDeferredValue, useRef, useState } from "react";

import type { DashboardUser } from "../host/index";
import { getUserInitials, matchesSearchItem } from "./utils";
import type { DashboardHeaderMeta, DashboardLinkRenderer, DashboardSearchItem } from "./types";

interface DashboardHeaderProps {
  renderLink: DashboardLinkRenderer;
  headerMeta: DashboardHeaderMeta;
  searchItems: DashboardSearchItem[];
  headerUser?: DashboardUser;
  onToggleSidebar(): void;
}

export function DashboardHeader({
  renderLink,
  headerMeta,
  searchItems,
  headerUser,
  onToggleSidebar,
}: DashboardHeaderProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const suppressBlurRef = useRef(false);
  const deferredQuery = useDeferredValue(query);

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
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between gap-4 px-4 lg:px-8">
        <div className="flex min-w-0 flex-1 items-center gap-3 lg:gap-4">
          <button
            type="button"
            className="rounded-lg bg-card p-2 text-foreground lg:hidden"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
          >
            <MenuIcon className="size-5" />
          </button>

          {headerMeta.backHref && headerMeta.backLabel
            ? renderLink({
                href: headerMeta.backHref,
                className:
                  "inline-flex items-center gap-1 font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-primary",
                children: (
                  <>
                    <ArrowLeftIcon className="size-3" />
                    {headerMeta.backLabel}
                  </>
                ),
              })
            : null}

          <div className="hidden xl:flex items-center gap-3 rounded-full border border-border bg-card/80 px-3 py-1.5 text-sm shadow-sm">
            {headerMeta.icon ? (
              <span className="shrink-0 text-primary">{headerMeta.icon}</span>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-headline text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {headerMeta.badge ?? "View"}
              </span>
              <span className="truncate font-medium text-foreground">{headerMeta.title}</span>
            </div>
          </div>

          <div className="relative w-full max-w-xl">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setOpen(true)}
              onBlur={() => {
                if (suppressBlurRef.current) {
                  suppressBlurRef.current = false;
                  return;
                }
                setOpen(false);
              }}
              placeholder="Search skills or pages..."
              className="h-9 w-full rounded-full border border-border bg-input/80 pl-10 pr-4 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground"
            />

            {open ? (
              <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-border bg-card shadow-xl backdrop-blur-xl">
                {filteredItems.length === 0 ? (
                  <div className="px-4 py-5 text-sm text-muted-foreground">No results found.</div>
                ) : (
                  Array.from(groups.entries()).map(([group, items]) => (
                    <div key={group} className="border-b border-border/10 last:border-b-0">
                      <div className="px-4 pt-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {group}
                      </div>
                      <div className="p-2">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              suppressBlurRef.current = true;
                            }}
                            onClick={() => {
                              item.onSelect();
                              setOpen(false);
                              setQuery("");
                            }}
                            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                          >
                            {item.leading ? (
                              <span className="shrink-0">{item.leading}</span>
                            ) : (
                              <span className="shrink-0 text-muted-foreground">
                                {item.meta ? "•" : ""}
                              </span>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-foreground">{item.label}</div>
                              {item.meta ? (
                                <div className="truncate text-xs text-muted-foreground">
                                  {item.meta}
                                </div>
                              ) : null}
                            </div>
                            {item.trailing ? (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {item.trailing}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="hidden items-center gap-4 sm:flex lg:gap-6">
          <div className="flex items-center gap-4 text-muted-foreground">
            <span className="relative" aria-hidden="true">
              <BellIcon className="size-4" />
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-background bg-primary shadow-[0_0_6px_color-mix(in_srgb,var(--primary)_50%,transparent)]" />
            </span>
            <BoltIcon className="size-4" aria-hidden="true" />
          </div>

          {headerUser ? (
            <>
              <div className="h-8 w-px bg-border/20" />
              <div className="flex items-center gap-3">
                <div className="hidden text-right md:block">
                  <div className="font-headline text-[10px] uppercase tracking-widest text-muted-foreground">
                    {headerUser.name}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-primary">
                    {headerUser.subtitle ?? headerUser.email ?? "Active"}
                  </div>
                </div>
                {headerUser.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={headerUser.image}
                    alt={headerUser.name}
                    className="size-8 rounded-full"
                  />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded-full border border-primary/20 bg-card text-primary">
                    {headerUser.name ? (
                      <span className="text-xs font-medium">
                        {getUserInitials(headerUser.name)}
                      </span>
                    ) : (
                      <UserIcon className="size-4" />
                    )}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
