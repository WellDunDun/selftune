import { formatRate } from "@selftune/ui/lib";
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@selftune/ui/primitives";
import {
  AlertTriangleIcon,
  BarChart3Icon,
  BrainCircuitIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FolderIcon,
  GlobeIcon,
  HeartPulseIcon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  PlayIcon,
  ServerIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import type { SkillHealthStatus } from "@/types";

interface SkillNavItem {
  name: string;
  scope: string | null;
  status: SkillHealthStatus;
  passRate: number | null;
  checks: number;
}

const STATUS_ICON: Record<SkillHealthStatus, React.ReactNode> = {
  HEALTHY: <CheckCircleIcon className="size-3.5 text-emerald-400" />,
  WARNING: <AlertTriangleIcon className="size-3.5 text-amber-400" />,
  CRITICAL: <XCircleIcon className="size-3.5 text-red-400" />,
  UNGRADED: <CircleDotIcon className="size-3.5 text-slate-500" />,
  UNKNOWN: <HelpCircleIcon className="size-3.5 text-slate-600" />,
};

const SCOPE_CONFIG: Record<string, { label: string; icon: React.ReactNode }> = {
  project: { label: "Project", icon: <FolderIcon className="size-4 text-slate-400" /> },
  global: { label: "Global", icon: <GlobeIcon className="size-4 text-slate-400" /> },
  system: { label: "System", icon: <ServerIcon className="size-4 text-slate-400" /> },
  admin: { label: "Admin", icon: <GlobeIcon className="size-4 text-slate-400" /> },
  unknown: { label: "Unknown", icon: <HelpCircleIcon className="size-4 text-slate-400" /> },
};

/* ── Stitch-style nav item ──────────────────────────────────── */

function NavItem({
  to,
  icon,
  label,
  tooltip,
  isActive,
}: {
  to: string;
  icon: React.ReactNode;
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
            className={`flex items-center gap-3 px-4 py-3 font-headline text-sm tracking-tight rounded-lg transition-all duration-300 ease-in-out ${
              isActive
                ? "bg-card text-primary font-bold"
                : "text-slate-400 hover:text-slate-100 hover:bg-muted"
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

/* ── Scope group (collapsible skill list per scope) ─────────── */

function ScopeGroup({
  scope,
  skills,
  pathname,
  defaultOpen,
}: {
  scope: string;
  skills: SkillNavItem[];
  pathname: string;
  defaultOpen: boolean;
}) {
  const config = SCOPE_CONFIG[scope] ?? { label: scope, icon: <GlobeIcon className="size-4" /> };
  const hasActive = skills.some((s) => pathname === `/skills/${encodeURIComponent(s.name)}`);
  const [open, setOpen] = useState(defaultOpen || hasActive);

  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/scope">
      <Tooltip>
        <TooltipTrigger
          render={
            <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2 text-slate-400 hover:text-slate-100 hover:bg-muted rounded-lg transition-all duration-200 font-headline text-xs tracking-tight cursor-pointer" />
          }
        >
          {config.icon}
          <span>{config.label}</span>
          <Badge
            variant="secondary"
            className="ml-auto h-4 px-1.5 text-[10px] bg-muted text-slate-500 border-none"
          >
            {skills.length}
          </Badge>
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-200 group-data-[open]/scope:rotate-90" />
        </TooltipTrigger>
        <TooltipContent side="right">
          {config.label} &mdash; {skills.length} skill{skills.length !== 1 ? "s" : ""}
        </TooltipContent>
      </Tooltip>
      <CollapsibleContent>
        <div className="ml-4 mt-1 space-y-0.5 border-l border-border/15 pl-3">
          {skills.map((skill) => {
            const isActive = pathname === `/skills/${encodeURIComponent(skill.name)}`;
            return (
              <Tooltip key={skill.name}>
                <TooltipTrigger
                  render={
                    <Link
                      to={`/skills/${encodeURIComponent(skill.name)}`}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all duration-200 ${
                        isActive
                          ? "bg-card text-primary font-bold"
                          : "text-slate-400 hover:text-slate-100 hover:bg-muted"
                      }`}
                    />
                  }
                >
                  {STATUS_ICON[skill.status]}
                  <span className="truncate flex-1">{skill.name}</span>
                  <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                    {formatRate(skill.passRate)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {skill.name} &mdash; {formatRate(skill.passRate)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ── Main sidebar ───────────────────────────────────────────── */

export function AppSidebar({
  skills,
  search: _search,
  onSearchChange: _onSearchChange,
  version,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  skills: SkillNavItem[];
  search: string;
  onSearchChange: (v: string) => void;
  version?: string;
}) {
  const location = useLocation();

  const scopeGroups = useMemo(() => {
    const groups: Record<string, SkillNavItem[]> = {};
    for (const skill of skills) {
      const key = skill.scope ?? "unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push(skill);
    }
    const order = ["global", "project", "system", "admin", "unknown"];
    const ordered = order
      .filter((k) => groups[k]?.length)
      .map((k) => ({ scope: k, skills: groups[k] }));
    const remaining = Object.keys(groups)
      .filter((k) => !order.includes(k))
      .sort()
      .map((k) => ({ scope: k, skills: groups[k] }));
    return [...ordered, ...remaining];
  }, [skills]);

  const hasMultipleScopes = scopeGroups.length > 1;

  const isSkillActive =
    location.pathname.startsWith("/skills/") || location.pathname === "/skills-library";

  // Skills section open state
  const [skillsOpen, setSkillsOpen] = useState(true);

  useEffect(() => {
    if (isSkillActive) setSkillsOpen(true);
  }, [isSkillActive]);

  return (
    <TooltipProvider>
      <Sidebar collapsible="offcanvas" {...props}>
        {/* Logo — matches Stitch: logo + title + subtitle with generous spacing */}
        <SidebarHeader className="px-4 pb-8 pt-6">
          <Link to="/" className="flex items-center gap-3">
            <div
              className="size-8 bg-primary shrink-0"
              style={{
                mask: "url(/logo.svg) center/contain no-repeat",
                WebkitMask: "url(/logo.svg) center/contain no-repeat",
              }}
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span className="font-headline text-2xl font-bold tracking-tighter text-primary text-glow">
                Selftune
              </span>
              <span className="font-headline text-[10px] uppercase tracking-widest text-slate-500">
                Skill Evolution Engine
              </span>
            </div>
          </Link>
        </SidebarHeader>

        {/* Main navigation — matches Stitch's 6-item icon nav */}
        <SidebarContent className="px-2">
          <nav className="space-y-1">
            <NavItem
              to="/"
              icon={<LayoutDashboardIcon className="size-5" />}
              label="Overview"
              tooltip="Dashboard overview"
              isActive={location.pathname === "/"}
            />
            {/* Skills — collapsible section showing actual skill nav */}
            <Collapsible open={skillsOpen} onOpenChange={setSkillsOpen} className="group/skills">
              <div
                className={`flex w-full items-center gap-3 px-4 py-3 font-headline text-sm tracking-tight rounded-lg transition-all duration-300 ease-in-out ${
                  isSkillActive
                    ? "bg-card text-primary font-bold"
                    : "text-slate-400 hover:text-slate-100 hover:bg-muted"
                }`}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Link
                        to="/skills-library"
                        className="flex items-center gap-3 flex-1 min-w-0"
                      />
                    }
                  >
                    <BrainCircuitIcon className="size-5 shrink-0" />
                    <span className="flex-1 text-left">Skills</span>
                  </TooltipTrigger>
                  <TooltipContent side="right">Skills Library</TooltipContent>
                </Tooltip>
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[10px] bg-muted text-slate-500 border-none"
                >
                  {skills.length}
                </Badge>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <CollapsibleTrigger className="shrink-0 cursor-pointer p-0.5 rounded hover:bg-muted transition-colors" />
                    }
                  >
                    <ChevronDownIcon className="size-4 transition-transform duration-200 group-data-[state=closed]/skills:-rotate-90" />
                  </TooltipTrigger>
                  <TooltipContent side="right">Toggle skill list</TooltipContent>
                </Tooltip>
              </div>
              <CollapsibleContent>
                <div className="mt-1 space-y-0.5 px-1">
                  {hasMultipleScopes
                    ? scopeGroups.map(({ scope, skills: groupSkills }) => (
                        <ScopeGroup
                          key={scope}
                          scope={scope}
                          skills={groupSkills}
                          pathname={location.pathname}
                          defaultOpen={scope === "global" || scope === "project"}
                        />
                      ))
                    : skills.map((skill) => {
                        const isActive =
                          location.pathname === `/skills/${encodeURIComponent(skill.name)}`;
                        return (
                          <Tooltip key={skill.name}>
                            <TooltipTrigger
                              render={
                                <Link
                                  to={`/skills/${encodeURIComponent(skill.name)}`}
                                  className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs transition-all duration-200 ${
                                    isActive
                                      ? "bg-card text-primary font-bold"
                                      : "text-slate-400 hover:text-slate-100 hover:bg-muted"
                                  }`}
                                />
                              }
                            >
                              {STATUS_ICON[skill.status]}
                              <span className="truncate flex-1">{skill.name}</span>
                              <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                                {formatRate(skill.passRate)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              {skill.name} &mdash; {formatRate(skill.passRate)}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                  {skills.length === 0 && (
                    <div className="px-4 py-4 text-center font-headline text-xs text-slate-600">
                      No skills found
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

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
                  className="w-full cognitive-gradient text-primary-foreground font-bold py-3 rounded-xl flex items-center justify-center gap-2 pulse-aura transition-transform active:scale-95 font-headline text-sm uppercase tracking-wider"
                  type="button"
                />
              }
            >
              <PlayIcon className="size-4" />
              <span>Run Evolution</span>
            </TooltipTrigger>
            <TooltipContent side="right">Trigger skill evolution pipeline</TooltipContent>
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
