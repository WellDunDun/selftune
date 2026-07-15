"use client";

import { MenuIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { TooltipProvider } from "@selftune/ui/primitives";

import { DashboardCommandPalette } from "./DashboardCommandPalette";
import { DashboardHeader } from "./DashboardHeader";
import { DashboardSidebar } from "./DashboardSidebar";
import { cn } from "./utils";
import type { DashboardChromeProps } from "./types";

const DEFAULT_CONTENT_CLASS_NAME = "@container/main mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8";

export function DashboardChrome({
  brand,
  navItems,
  renderLink,
  headerMeta,
  searchItems = [],
  headerUser,
  sidebarUser,
  sidebarHeader,
  showHeader = true,
  onSignOut,
  overlay,
  contentClassName,
  children,
}: DashboardChromeProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const openCommands = useCallback(() => {
    setCommandPaletteOpen(true);
    setMobileOpen(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      openCommands();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openCommands]);

  const content =
    contentClassName === null ? (
      children
    ) : (
      <div className={cn(contentClassName ?? DEFAULT_CONTENT_CLASS_NAME)}>{children}</div>
    );

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <DashboardCommandPalette
          open={commandPaletteOpen}
          searchItems={searchItems}
          onOpenChange={setCommandPaletteOpen}
        />
        <DashboardSidebar
          brand={brand}
          navItems={navItems}
          renderLink={renderLink}
          sidebarHeader={sidebarHeader}
          onOpenCommands={openCommands}
          sidebarUser={sidebarUser}
          onSignOut={onSignOut}
          mobileOpen={mobileOpen}
          onMobileOpenChange={setMobileOpen}
        />

        <div className="min-h-screen lg:pl-64">
          {showHeader ? (
            <DashboardHeader
              renderLink={renderLink}
              headerMeta={headerMeta}
              searchItems={searchItems}
              headerUser={headerUser}
              onToggleSidebar={() => setMobileOpen((open) => !open)}
            />
          ) : (
            <button
              type="button"
              aria-label="Toggle sidebar"
              onClick={() => setMobileOpen((open) => !open)}
              className="fixed left-4 top-4 z-40 rounded-lg border border-border/20 bg-card p-2 text-foreground shadow-lg lg:hidden"
            >
              <MenuIcon className="size-5" />
            </button>
          )}
          <main className={cn(showHeader ? "min-h-[calc(100vh-4rem)]" : "min-h-screen")}>
            {content}
          </main>
        </div>

        {overlay}
      </div>
    </TooltipProvider>
  );
}
