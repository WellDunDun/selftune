import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@selftune/ui/primitives";
import {
  BarChart3Icon,
  BrainCircuitIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  PlayIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";

/* ── Stitch-style nav item ──────────────────────────────────── */

function NavItem({
  to,
  icon,
  label,
  tooltip,
  isActive,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  tooltip: string;
  isActive: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={to}
            className={`flex items-center gap-3 px-4 py-2.5 font-headline text-sm tracking-tight rounded-lg transition-all duration-200 ${
              isActive
                ? "bg-card text-primary font-bold shadow-[inset_0_0_0_1px_rgba(79,242,255,0.08)]"
                : "text-slate-400 hover:bg-muted/50 hover:text-slate-200"
            }`}
          />
        }
      >
        {icon}
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/* ── Main sidebar ───────────────────────────────────────────── */

export function AppSidebar({
  version,
  ...props
}: ComponentProps<typeof Sidebar> & {
  version?: string;
}) {
  const location = useLocation();

  return (
    <TooltipProvider>
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader className="px-4 pb-8 pt-6">
          <Link to="/" className="flex items-center gap-3">
            <div
              className="size-8 shrink-0 bg-primary shadow-[0_0_12px_rgba(79,242,255,0.3)]"
              role="img"
              aria-label="Selftune"
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
              <span className="font-headline text-2xl font-bold tracking-tighter text-primary text-glow">
                Selftune
              </span>
              <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-slate-500">
                Skill Evolution Engine
              </span>
            </div>
          </Link>
        </SidebarHeader>

        <SidebarContent className="px-2">
          <nav className="space-y-1">
            <NavItem
              to="/"
              icon={<LayoutDashboardIcon className="size-5" />}
              label="Overview"
              tooltip="Dashboard overview"
              isActive={location.pathname === "/"}
            />
            <NavItem
              to="/skills-library"
              icon={<BrainCircuitIcon className="size-5" />}
              label="Skills"
              tooltip="Skills Library"
              isActive={
                location.pathname === "/skills-library" || location.pathname.startsWith("/skills/")
              }
            />
            <NavItem
              to="/analytics"
              icon={<BarChart3Icon className="size-5" />}
              label="Analytics"
              tooltip="Performance analytics"
              isActive={location.pathname === "/analytics"}
            />
            <NavItem
              to="/status"
              icon={<HeartPulseIcon className="size-5" />}
              label="System Status"
              tooltip="System health diagnostics"
              isActive={location.pathname === "/status"}
            />
          </nav>
        </SidebarContent>

        <SidebarFooter className="px-4 pb-4">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className="w-full cursor-not-allowed border border-primary/15 bg-gradient-to-r from-primary/10 to-primary/5 py-2.5 rounded-xl flex items-center justify-center gap-2 font-headline text-xs uppercase tracking-wider text-primary/50 opacity-70"
                  type="button"
                  disabled
                  aria-disabled="true"
                  tabIndex={-1}
                  title="Run Evolution will be available once dashboard actions are wired."
                />
              }
            >
              <PlayIcon className="size-4" />
              <span>Run Evolution</span>
            </TooltipTrigger>
            <TooltipContent side="right">
              Dashboard-triggered evolution is not available yet.
            </TooltipContent>
          </Tooltip>

          <div className="mt-3 flex items-center gap-2 px-4 py-1.5 font-headline text-[10px] uppercase tracking-widest text-slate-600">
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_rgba(79,242,255,0.4)]" />
            <span>selftune{version ? ` v${version}` : ""}</span>
          </div>
        </SidebarFooter>
      </Sidebar>
    </TooltipProvider>
  );
}
