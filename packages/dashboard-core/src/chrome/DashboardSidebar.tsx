"use client";

import { ChevronDownIcon, LockIcon, LogOutIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@selftune/ui/primitives";

import type { DashboardUser } from "../host/index";
import { cn, getUserInitials } from "./utils";
import type {
  DashboardBrand,
  DashboardChromeAction,
  DashboardLinkRenderer,
  DashboardNavItem,
} from "./types";

interface DashboardSidebarProps {
  brand: DashboardBrand;
  navItems: DashboardNavItem[];
  renderLink: DashboardLinkRenderer;
  sidebarHeader?: ReactNode;
  sidebarAction?: DashboardChromeAction;
  sidebarUser?: DashboardUser;
  onSignOut?(): Promise<void> | void;
  mobileOpen: boolean;
  onMobileOpenChange(open: boolean): void;
}

export function DashboardSidebar({
  brand,
  navItems,
  renderLink,
  sidebarHeader,
  sidebarAction,
  sidebarUser,
  onSignOut,
  mobileOpen,
  onMobileOpenChange,
}: DashboardSidebarProps) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => onMobileOpenChange(false)}
          aria-label="Close sidebar overlay"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar",
          "transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="px-4 pb-6 pt-6">
          {sidebarHeader
            ? sidebarHeader
            : renderLink({
                href: brand.href,
                className: "flex items-center gap-3",
                onClick: () => onMobileOpenChange(false),
                children: (
                  <>
                    <div
                      className="size-8 shrink-0 bg-primary shadow-[0_0_12px_rgba(79,242,255,0.3)]"
                      role="img"
                      aria-label={brand.name}
                      style={{
                        WebkitMaskImage: "url(/logo.svg)",
                        WebkitMaskSize: "contain",
                        WebkitMaskRepeat: "no-repeat",
                        WebkitMaskPosition: "center",
                        maskImage: "url(/logo.svg)",
                        maskSize: "contain",
                        maskRepeat: "no-repeat",
                        maskPosition: "center",
                      }}
                    />
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-headline text-2xl font-bold tracking-tighter text-primary text-glow">
                          {brand.name}
                        </span>
                        {brand.badge ? (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                            {brand.badge}
                          </span>
                        ) : null}
                      </div>
                      {brand.caption ? (
                        <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-slate-500">
                          {brand.caption}
                        </span>
                      ) : null}
                    </div>
                  </>
                ),
              })}
        </div>

        <nav className="flex-1 space-y-1 px-2">
          {navItems.map((item) => (
            <Tooltip key={item.href}>
              <TooltipTrigger
                render={renderLink({
                  href: item.href,
                  onClick: () => onMobileOpenChange(false),
                  className: cn(
                    "flex items-center gap-3 rounded-lg px-4 py-2.5 font-headline text-sm tracking-tight transition-all duration-200",
                    item.isActive
                      ? "bg-card font-bold text-primary shadow-[inset_0_0_0_1px_rgba(79,242,255,0.08)]"
                      : "text-slate-400 hover:bg-muted/50 hover:text-slate-200",
                  ),
                  children: (
                    <>
                      {item.icon}
                      <span className="flex min-w-0 items-center gap-2">
                        <span>{item.label}</span>
                        {item.isLocked ? <LockIcon className="size-3.5 opacity-70" /> : null}
                      </span>
                    </>
                  ),
                })}
              />
              <TooltipContent side="right">{item.tooltip}</TooltipContent>
            </Tooltip>
          ))}
        </nav>

        <div className="px-4 pb-4">
          {sidebarAction ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    disabled={sidebarAction.disabled}
                    aria-disabled={sidebarAction.disabled}
                    tabIndex={sidebarAction.disabled ? -1 : 0}
                    title={sidebarAction.tooltip}
                    onClick={sidebarAction.onClick}
                    className={cn(
                      "flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 font-headline text-xs uppercase tracking-wider transition-colors",
                      sidebarAction.disabled
                        ? "cursor-not-allowed border-primary/15 bg-gradient-to-r from-primary/10 to-primary/5 text-primary/50 opacity-70"
                        : "border-primary/30 bg-gradient-to-r from-primary/12 to-primary/6 text-primary hover:border-primary/50 hover:bg-primary/10",
                    )}
                  >
                    {sidebarAction.icon}
                    <span>{sidebarAction.label}</span>
                  </button>
                }
              />
              <TooltipContent side="right">{sidebarAction.tooltip}</TooltipContent>
            </Tooltip>
          ) : null}

          {brand.footerLabel ? (
            <div className="mt-3 flex items-center gap-2 px-4 py-1.5 font-headline text-[10px] uppercase tracking-widest text-slate-600">
              <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_rgba(79,242,255,0.4)]" />
              <span>{brand.footerLabel}</span>
            </div>
          ) : null}
        </div>

        {sidebarUser ? (
          <div className="border-t border-sidebar-border p-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((open) => !open)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50"
              >
                {sidebarUser.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={sidebarUser.image}
                    alt={sidebarUser.name}
                    className="size-9 rounded-full"
                  />
                ) : (
                  <div className="flex size-9 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {getUserInitials(sidebarUser.name)}
                  </div>
                )}
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium text-sidebar-foreground">
                    {sidebarUser.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {sidebarUser.subtitle ?? sidebarUser.email ?? "Signed in"}
                  </span>
                </span>
                {onSignOut ? <ChevronDownIcon className="size-4" /> : null}
              </button>

              {userMenuOpen && onSignOut ? (
                <div className="absolute bottom-full left-0 mb-2 w-full rounded-lg border border-border bg-popover py-1 shadow-lg">
                  <button
                    type="button"
                    onClick={async () => {
                      setUserMenuOpen(false);
                      await onSignOut();
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent/50"
                  >
                    <LogOutIcon className="size-4" />
                    <span>Sign out</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </aside>
    </>
  );
}
