import { Link, useLocation } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  CircleDotIcon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  SearchIcon,
  XCircleIcon,

} from "lucide-react"
import type { SkillHealthStatus } from "@/types"

interface SkillNavItem {
  name: string
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

const STATUS_FILTERS: { label: string; value: SkillHealthStatus | "ALL"; icon: React.ReactNode }[] = [
  { label: "All Skills", value: "ALL", icon: <LayoutDashboardIcon className="size-4" /> },
  { label: "Healthy", value: "HEALTHY", icon: <CheckCircleIcon className="size-4 text-emerald-600" /> },
  { label: "Warning", value: "WARNING", icon: <AlertTriangleIcon className="size-4 text-amber-500" /> },
  { label: "Critical", value: "CRITICAL", icon: <XCircleIcon className="size-4 text-red-500" /> },
  { label: "Ungraded", value: "UNGRADED", icon: <CircleDotIcon className="size-4 text-muted-foreground" /> },
  { label: "Unknown", value: "UNKNOWN", icon: <HelpCircleIcon className="size-4 text-muted-foreground/60" /> },
]

function formatRate(rate: number | null): string {
  if (rate === null) return "--"
  return `${Math.round(rate * 100)}%`
}

export function AppSidebar({
  skills,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  counts,
  version,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  skills: SkillNavItem[]
  search: string
  onSearchChange: (v: string) => void
  statusFilter: SkillHealthStatus | "ALL"
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void
  counts: Partial<Record<SkillHealthStatus, number>>
  version?: string
}) {
  const location = useLocation()

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
                placeholder="Filter skills..."
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Status Filters */}
        <SidebarGroup>
          <SidebarGroupLabel>Status</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {STATUS_FILTERS.map((f) => {
                const count = f.value === "ALL"
                  ? Object.values(counts).reduce((s, n) => s + (n ?? 0), 0)
                  : counts[f.value] ?? 0
                const isActive = statusFilter === f.value
                return (
                  <SidebarMenuItem key={f.value}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => onStatusFilterChange(f.value)}
                      tooltip={f.label}
                    >
                      {f.icon}
                      <span>{f.label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{count}</SidebarMenuBadge>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Skills List */}
        <SidebarGroup className="flex-1">
          <SidebarGroupLabel>Skills</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {skills.map((skill) => {
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
                    </SidebarMenuButton>
                    <SidebarMenuBadge>
                      <Badge
                        variant={
                          skill.status === "CRITICAL" ? "destructive"
                          : skill.status === "HEALTHY" ? "outline"
                          : "secondary"
                        }
                        className="h-4 text-[10px] px-1.5"
                      >
                        {formatRate(skill.passRate)}
                      </Badge>
                    </SidebarMenuBadge>
                  </SidebarMenuItem>
                )
              })}
              {skills.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No skills match filters
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <ActivityIcon className="size-3" />
          <span>selftune {version ? `v${version}` : ""}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
