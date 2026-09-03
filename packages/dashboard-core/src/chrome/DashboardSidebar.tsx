"use client";

import { ChevronDownIcon, LockIcon, LogOutIcon } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@selftune/ui/primitives";

import type { DashboardUser } from "../host/index";
import type { ServerProfileController } from "../host/server-profiles";
import { ServerProfileSwitcher } from "./ServerProfileSwitcher";
import { cn, getUserInitials } from "./utils";
import type {
  DashboardBrand,
  DashboardCloudProfileConnection,
  DashboardLinkRenderer,
  DashboardNavItem,
} from "./types";

interface DashboardSidebarProps {
  brand: DashboardBrand;
  navItems: DashboardNavItem[];
  renderLink: DashboardLinkRenderer;
  sidebarHeader?: ReactNode;
  sidebarUser?: DashboardUser;
  serverProfiles?: ServerProfileController;
  cloudProfileConnection?: DashboardCloudProfileConnection;
  onOpenCommands(): void;
  onSignOut?(): Promise<void> | void;
  mobileOpen: boolean;
  onMobileOpenChange(open: boolean): void;
}

export function DashboardSidebar({
  brand,
  navItems,
  renderLink,
  sidebarHeader,
  sidebarUser,
  serverProfiles,
  cloudProfileConnection,
  onOpenCommands,
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
        <div className="desktop-macos-titlebar px-4 pb-6 pt-6">
          {sidebarHeader
            ? sidebarHeader
            : renderLink({
                href: brand.href,
                className: "desktop-macos-no-drag flex items-center gap-2",
                onClick: () => onMobileOpenChange(false),
                children: (
                  <>
                    <div
                      className="size-5 shrink-0 bg-sidebar-primary"
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
                        <span className="desktop-macos-brand-name font-headline text-2xl font-medium tracking-tighter text-sidebar-primary">
                          {brand.name}
                        </span>
                        {brand.badge ? (
                          <span className="rounded-full bg-sidebar-primary/10 px-1.5 py-0.5 text-xs font-medium text-sidebar-primary">
                            {brand.badge}
                          </span>
                        ) : null}
                      </div>
                      {brand.caption ? (
                        <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/50">
                          {brand.caption}
                        </span>
                      ) : null}
                    </div>
                  </>
                ),
              })}
        </div>

        {serverProfiles ? (
          <div className="px-4 pb-3">
            <ServerProfileSwitcher
              controller={serverProfiles}
              cloudConnection={cloudProfileConnection}
            />
          </div>
        ) : null}

        <nav className="flex-1 space-y-1 px-2">
          {navItems.map((item) => (
            <Fragment key={item.href}>
              {renderLink({
                href: item.href,
                onClick: () => onMobileOpenChange(false),
                className: cn(
                  "flex items-center rounded-lg px-4 py-2.5 font-headline text-sm tracking-tight transition-all duration-200 active:translate-y-px",
                  item.isActive
                    ? "bg-sidebar-accent font-medium text-sidebar-primary ring-1 ring-sidebar-border"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-primary",
                ),
                children: (
                  <span className="flex min-w-0 items-center gap-2">
                    <span>{item.label}</span>
                    {item.isLocked ? <LockIcon className="size-3.5 opacity-70" /> : null}
                  </span>
                ),
              })}
            </Fragment>
          ))}
        </nav>

        <div className="px-4 pb-4">
          <div className="flex flex-col gap-1.5 border-t border-sidebar-border/60 pt-3 text-xs leading-none">
            <button
              type="button"
              onClick={onOpenCommands}
              className="flex items-center justify-between rounded-sm text-left text-sidebar-foreground/50 transition-colors hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
            >
              <span>Commands</span>
              <span className="font-mono text-[11px]">⌘K</span>
            </button>
            <a
              href="https://docs.selftune.dev"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm text-sidebar-foreground/50 transition-colors hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
            >
              Docs
            </a>
            <a
              href="https://github.com/selftune-dev/selftune/issues"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm text-sidebar-foreground/50 transition-colors hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
            >
              Feedback / bug?
            </a>
            <a
              href="https://github.com/selftune-dev/selftune"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm text-sidebar-foreground/50 transition-colors hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
            >
              Star on GitHub
            </a>
          </div>

          {brand.footerLabel ? (
            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
              {brand.footerHref ? (
                renderLink({
                  href: brand.footerHref,
                  onClick: () => onMobileOpenChange(false),
                  className:
                    "flex min-w-0 items-center gap-2 rounded-sm py-1 text-xs text-sidebar-foreground/50 transition-colors hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40",
                  children: (
                    <>
                      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sidebar-ring" />
                      <span className="truncate">{brand.footerLabel}</span>
                    </>
                  ),
                })
              ) : (
                <div className="flex min-w-0 items-center gap-2 py-1 text-xs text-sidebar-foreground/50">
                  <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sidebar-ring" />
                  <span className="truncate">{brand.footerLabel}</span>
                </div>
              )}
              {brand.footerAction ? (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={brand.footerAction.ariaLabel ?? brand.footerAction.label}
                  title={brand.footerAction.ariaLabel ?? brand.footerAction.label}
                  disabled={brand.footerAction.disabled}
                  className="group/update relative min-w-16 text-sidebar-primary hover:text-sidebar-primary"
                  onClick={() => {
                    onMobileOpenChange(false);
                    brand.footerAction?.onClick();
                  }}
                >
                  {brand.footerAction.icon ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="flex items-center justify-center transition-opacity duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover/update:opacity-0 group-focus-visible/update:opacity-0 group-focus-visible/update:duration-0 motion-reduce:transition-none"
                      >
                        {brand.footerAction.icon}
                      </span>
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover/update:opacity-100 group-focus-visible/update:opacity-100 group-focus-visible/update:duration-0 motion-reduce:transition-none"
                      >
                        {brand.footerAction.label}
                      </span>
                    </>
                  ) : (
                    brand.footerAction.label
                  )}
                </Button>
              ) : null}
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
                  <span className="block truncate text-xs text-sidebar-foreground/50">
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
