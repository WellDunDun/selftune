import {
  ArrowLeftIcon,
  BellIcon,
  BoltIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  SearchIcon,
  UserIcon,
  WaypointsIcon,
} from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";

import { SidebarTrigger } from "@/components/ui/sidebar";

function useHeaderMeta() {
  const location = useLocation();
  const { name } = useParams<{ name?: string }>();

  if (location.pathname === "/status") {
    return {
      title: "System Status",
      icon: <HeartPulseIcon className="size-4 text-primary" />,
      badge: "Diagnostics",
      backHref: "/",
      backLabel: "Dashboard",
    };
  }

  if (location.pathname.startsWith("/skills/") && name) {
    return {
      title: decodeURIComponent(name),
      icon: <WaypointsIcon className="size-4 text-primary" />,
      badge: "Skill Report",
      backHref: "/",
      backLabel: "Dashboard",
    };
  }

  return {
    title: "Dashboard",
    icon: <LayoutDashboardIcon className="size-4 text-primary" />,
    badge: "Overview",
    backHref: null,
    backLabel: null,
  };
}

export function SiteHeader({
  search,
  onSearchChange,
}: {
  search?: string;
  onSearchChange?: (v: string) => void;
} = {}) {
  const meta = useHeaderMeta();

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center border-b border-border/10 bg-background/80 backdrop-blur-xl transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-auto">
      <div className="flex w-full items-center justify-between px-4 lg:px-8">
        {/* Left: sidebar trigger + search bar */}
        <div className="flex items-center gap-4 w-1/2">
          <SidebarTrigger className="-ml-1 text-slate-400 hover:text-primary" />
          {meta.backHref && meta.backLabel ? (
            <Link
              to={meta.backHref}
              className="inline-flex items-center gap-1 font-headline text-[10px] uppercase tracking-[0.2em] text-slate-500 transition-colors hover:text-primary"
            >
              <ArrowLeftIcon className="size-3" />
              {meta.backLabel}
            </Link>
          ) : null}
          <div className="relative w-full max-w-md group">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400 group-focus-within:text-primary transition-colors" />
            <input
              className="w-full bg-input/50 border-none rounded-full py-2 pl-10 pr-4 text-sm font-sans focus:ring-1 focus:ring-primary/40 focus:outline-none placeholder:text-slate-500 text-foreground"
              placeholder="Search skills, sessions, or parameters..."
              type="text"
              value={search ?? ""}
              onChange={(e) => onSearchChange?.(e.target.value)}
            />
          </div>
        </div>

        {/* Right: notifications + user */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4">
            <button
              className="relative text-slate-400 transition-colors hover:text-primary"
              type="button"
            >
              <BellIcon className="size-4" />
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary border-2 border-background shadow-[0_0_6px_rgba(79,242,255,0.5)]" />
            </button>
            <button className="text-slate-400 transition-colors hover:text-primary" type="button">
              <BoltIcon className="size-4" />
            </button>
          </div>
          <div className="h-8 w-px bg-border/20" />
          <button className="flex items-center gap-3 group" type="button">
            <span className="hidden md:block font-headline uppercase tracking-widest text-[10px] text-slate-400 group-hover:text-primary transition-colors text-right">
              Admin Node
              <br />
              <span className="text-primary">Active</span>
            </span>
            <div className="flex size-8 items-center justify-center rounded-full bg-card border border-primary/20 text-primary transition-colors hover:bg-input">
              <UserIcon className="size-4" />
            </div>
          </button>
        </div>
      </div>
    </header>
  );
}
