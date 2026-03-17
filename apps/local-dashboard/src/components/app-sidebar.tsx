import { useEffect, useMemo, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@selftune/ui/primitives"
import { Input } from "@/components/ui/input"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FolderIcon,
  GlobeIcon,
  HeartPulseIcon,
  HelpCircleIcon,
  SearchIcon,
  ServerIcon,
  XCircleIcon,
} from "lucide-react"
import { formatRate } from "@selftune/ui/lib"
import type { SkillHealthStatus } from "@/types"

interface SkillNavItem {
  name: string
  scope: string | null
  status: SkillHealthStatus
  passRate: number | null
  checks: number
}

const STATUS_ICON: Record<SkillHealthStatus, React.ReactNode> = {
  HEALTHY: <CheckCircleIcon className="size-3.5 text-emerald-600" />,
  WARNING: <AlertTriangleIcon className="size-3.5 text-amber-500" />,
  CRITICAL: <XCircleIcon className="size-3.5 text-red-500" />,
  UNGRADED: <CircleDotIcon className="size-3.5 text-muted-foreground" />,
  UNKNOWN: <HelpCircleIcon className="size-3.5 text-muted-foreground/60" />,
}

const SCOPE_CONFIG: Record<string, { label: string; icon: React.ReactNode }> = {
  project: { label: "Project", icon: <FolderIcon className="size-4" /> },
  global: { label: "Global", icon: <GlobeIcon className="size-4" /> },
  system: { label: "System", icon: <ServerIcon className="size-4" /> },
  admin: { label: "Admin", icon: <GlobeIcon className="size-4" /> },
  unknown: { label: "Unknown", icon: <HelpCircleIcon className="size-4" /> },
}

function ScopeGroup({
  scope,
  skills,
  pathname,
  defaultOpen,
}: {
  scope: string
  skills: SkillNavItem[]
  pathname: string
  defaultOpen: boolean
}) {
  const config = SCOPE_CONFIG[scope] ?? { label: scope, icon: <GlobeIcon className="size-4" /> }
  const hasActive = skills.some((s) => pathname === `/skills/${encodeURIComponent(s.name)}`)
  const [open, setOpen] = useState(defaultOpen || hasActive)

  useEffect(() => {
    if (hasActive) setOpen(true)
  }, [hasActive])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger render={<SidebarMenuButton tooltip={config.label} />}>
          {config.icon}
          <span>{config.label}</span>
          <Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[10px]">
            {skills.length}
          </Badge>
          <ChevronRightIcon className="ml-1 size-4 shrink-0 transition-transform duration-200 group-data-[open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {skills.map((skill) => {
              const isActive = pathname === `/skills/${encodeURIComponent(skill.name)}`
              return (
                <SidebarMenuSubItem key={skill.name}>
                  <SidebarMenuSubButton
                    isActive={isActive}
                    render={<Link to={`/skills/${encodeURIComponent(skill.name)}`} />}
                  >
                    {STATUS_ICON[skill.status]}
                    <span className="truncate">{skill.name}</span>
                    <Badge
                      variant={
                        skill.status === "CRITICAL" ? "destructive"
                        : skill.status === "HEALTHY" ? "outline"
                        : "secondary"
                      }
                      className="ml-auto h-4 text-[10px] px-1.5 shrink-0"
                    >
                      {formatRate(skill.passRate)}
                    </Badge>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

export function AppSidebar({
  skills,
  search,
  onSearchChange,
  version,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  skills: SkillNavItem[]
  search: string
  onSearchChange: (v: string) => void
  version?: string
}) {
  const location = useLocation()

  const scopeGroups = useMemo(() => {
    const groups: Record<string, SkillNavItem[]> = {}
    for (const skill of skills) {
      const key = skill.scope ?? "unknown"
      if (!groups[key]) groups[key] = []
      groups[key].push(skill)
    }
    // Sort: global first, then project, then known scopes, then any unexpected ones
    const order = ["global", "project", "system", "admin", "unknown"]
    const ordered = order
      .filter((k) => groups[k]?.length)
      .map((k) => ({ scope: k, skills: groups[k] }))
    const remaining = Object.keys(groups)
      .filter((k) => !order.includes(k))
      .sort()
      .map((k) => ({ scope: k, skills: groups[k] }))
    return [...ordered, ...remaining]
  }, [skills])

  const hasMultipleScopes = scopeGroups.length > 1

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:!p-1.5"
              render={<Link to="/" />}
            >
              <div
                className="size-5 bg-current"
                style={{ mask: "url(/logo.svg) center/contain no-repeat", WebkitMask: "url(/logo.svg) center/contain no-repeat" }}
                aria-hidden="true"
              />
              <span className="text-base font-semibold">
                self<span className="text-primary-accent">tune</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Search */}
        <SidebarGroup>
          <SidebarGroupContent>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Filter skills"
                placeholder="Filter skills..."
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Skills */}
        <SidebarGroup className="flex-1">
          <SidebarGroupLabel>Skills</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {hasMultipleScopes ? (
                scopeGroups.map(({ scope, skills: groupSkills }) => (
                  <ScopeGroup
                    key={scope}
                    scope={scope}
                    skills={groupSkills}
                    pathname={location.pathname}
                    defaultOpen={scope === "global" || scope === "project"}
                  />
                ))
              ) : (
                skills.map((skill) => {
                  const isActive = location.pathname === `/skills/${encodeURIComponent(skill.name)}`
                  return (
                    <SidebarMenuItem key={skill.name}>
                      <SidebarMenuButton
                        isActive={isActive}
                        tooltip={`${skill.name} — ${formatRate(skill.passRate)}`}
                        render={<Link to={`/skills/${encodeURIComponent(skill.name)}`} />}
                      >
                        {STATUS_ICON[skill.status]}
                        <span className="truncate">{skill.name}</span>
                        <Badge
                          variant={
                            skill.status === "CRITICAL" ? "destructive"
                            : skill.status === "HEALTHY" ? "outline"
                            : "secondary"
                          }
                          className="ml-auto h-4 text-[10px] px-1.5 shrink-0"
                        >
                          {formatRate(skill.passRate)}
                        </Badge>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })
              )}
              {skills.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No skills match
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={location.pathname === "/status"}
              tooltip="System Status"
              render={<Link to="/status" />}
            >
              <HeartPulseIcon className="size-4" />
              <span>System Status</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <ActivityIcon className="size-3" />
          <span>selftune{version ? ` v${version}` : ""}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
