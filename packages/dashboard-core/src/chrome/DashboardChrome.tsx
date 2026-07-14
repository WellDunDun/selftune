"use client";

import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { TooltipProvider } from "@selftune/ui/primitives";

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
  sidebarAction,
  onSignOut,
  overlay,
  contentClassName,
  children,
}: DashboardChromeProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const content =
    contentClassName === null ? (
      children
    ) : (
      <div className={cn(contentClassName ?? DEFAULT_CONTENT_CLASS_NAME)}>{children}</div>
    );

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <DashboardSidebar
          brand={brand}
          navItems={navItems}
          renderLink={renderLink}
          sidebarHeader={sidebarHeader}
          sidebarAction={
            sidebarAction ?? {
              label: "Run Evolution",
              tooltip: "Dashboard-triggered evolution is not available yet.",
              icon: <PlayIcon className="size-4" />,
              disabled: true,
            }
          }
          sidebarUser={sidebarUser}
          onSignOut={onSignOut}
          mobileOpen={mobileOpen}
          onMobileOpenChange={setMobileOpen}
        />

        <div className="min-h-screen lg:pl-64">
          <DashboardHeader
            renderLink={renderLink}
            headerMeta={headerMeta}
            searchItems={searchItems}
            headerUser={headerUser}
            onToggleSidebar={() => setMobileOpen((open) => !open)}
          />
          <main className="min-h-[calc(100vh-4rem)]">{content}</main>
        </div>

        {overlay}
      </div>
    </TooltipProvider>
  );
}
