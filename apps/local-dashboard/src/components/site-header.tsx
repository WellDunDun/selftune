import { deriveStatus, formatRate } from "@selftune/ui/lib";
import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  BellIcon,
  BoltIcon,
  BrainCircuitIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  SearchIcon,
  UserIcon,
  WaypointsIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Command,
} from "@/components/ui/command";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useOverview } from "@/hooks/useOverview";

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

const PAGES = [
  { name: "Overview", path: "/", icon: <LayoutDashboardIcon className="size-4" /> },
  {
    name: "Skills Library",
    path: "/skills-library",
    icon: <BrainCircuitIcon className="size-4" />,
  },
  { name: "Analytics", path: "/analytics", icon: <BarChart3Icon className="size-4" /> },
  { name: "System Status", path: "/status", icon: <HeartPulseIcon className="size-4" /> },
];

export function SiteHeader() {
  const meta = useHeaderMeta();
  const navigate = useNavigate();
  const { data } = useOverview();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const skills = data?.skills ?? [];

  const handleSelect = useCallback(
    (path: string) => {
      setOpen(false);
      navigate(path);
      // blur the input after navigation
      setTimeout(() => inputRef.current?.blur(), 0);
    },
    [navigate],
  );

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center border-b border-border/10 bg-background/80 backdrop-blur-xl transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-auto">
      <div className="flex w-full items-center justify-between px-4 lg:px-8">
        {/* Left: sidebar trigger + search */}
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

          {/* Autocomplete search */}
          <div className="relative w-full max-w-md">
            <Command className="rounded-full bg-transparent overflow-visible" shouldFilter>
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400 pointer-events-none z-10" />
                <CommandPrimitive.Input
                  ref={inputRef}
                  placeholder="Search skills or pages..."
                  className="h-9 w-full bg-input/50 border-none rounded-full pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 focus:outline-none placeholder:text-slate-500 text-foreground"
                  onFocus={() => setOpen(true)}
                  onBlur={() => {
                    setTimeout(() => setOpen(false), 200);
                  }}
                />
              </div>
              {open && (
                <CommandList className="absolute top-full left-0 right-0 mt-2 rounded-xl border border-border/15 bg-card shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-xl max-h-80 overflow-y-auto z-50">
                  <CommandEmpty className="py-4 text-center text-sm text-muted-foreground">
                    No results found.
                  </CommandEmpty>
                  <CommandGroup
                    heading="Pages"
                    className="text-[10px] uppercase tracking-widest text-muted-foreground"
                  >
                    {PAGES.map((page) => (
                      <CommandItem
                        key={page.path}
                        value={page.name}
                        onSelect={() => handleSelect(page.path)}
                        className="gap-3 rounded-lg cursor-pointer"
                      >
                        {page.icon}
                        <span>{page.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {skills.length > 0 && (
                    <CommandGroup
                      heading="Skills"
                      className="text-[10px] uppercase tracking-widest text-muted-foreground"
                    >
                      {skills.map((s) => {
                        const status = deriveStatus(s.pass_rate, s.total_checks);
                        const dotColor =
                          status === "HEALTHY"
                            ? "bg-primary"
                            : status === "WARNING"
                              ? "bg-primary-accent"
                              : status === "CRITICAL"
                                ? "bg-destructive"
                                : "bg-muted-foreground";
                        return (
                          <CommandItem
                            key={s.skill_name}
                            value={s.skill_name}
                            onSelect={() =>
                              handleSelect(`/skills/${encodeURIComponent(s.skill_name)}`)
                            }
                            className="gap-3 rounded-lg cursor-pointer"
                          >
                            <span className={`size-2 rounded-full ${dotColor} shrink-0`} />
                            <span className="flex-1 truncate">{s.skill_name}</span>
                            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                              {formatRate(s.total_checks > 0 ? s.pass_rate : null)}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                </CommandList>
              )}
            </Command>
          </div>
        </div>

        {/* Right: notifications + user */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4">
            <span className="relative text-slate-400" aria-hidden="true">
              <BellIcon className="size-4" />
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary border-2 border-background shadow-[0_0_6px_color-mix(in_srgb,var(--primary)_50%,transparent)]" />
            </span>
            <span className="text-slate-400" aria-hidden="true">
              <BoltIcon className="size-4" />
            </span>
          </div>
          <div className="h-8 w-px bg-border/20" />
          <div className="flex items-center gap-3 group">
            <span className="sr-only">Profile: Admin Node</span>
            <span className="hidden md:block font-headline uppercase tracking-widest text-[10px] text-slate-400 group-hover:text-primary transition-colors text-right">
              Admin Node
              <br />
              <span className="text-primary">Active</span>
            </span>
            <div className="flex size-8 items-center justify-center rounded-full bg-card border border-primary/20 text-primary transition-colors hover:bg-input">
              <UserIcon className="size-4" />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
