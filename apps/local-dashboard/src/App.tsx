import { useMemo, useState } from "react"
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Overview } from "@/pages/Overview"
import { SkillReport } from "@/pages/SkillReport"
import { useOverview } from "@/hooks/useOverview"
import type { SkillHealthStatus, SkillSummary } from "@/types"
import { deriveStatus, sortByPassRateAndChecks } from "@/utils"

function SkillReportWithHeader() {
  const { name } = useParams<{ name: string }>()
  return (
    <>
      <SiteHeader skillName={name} />
      <SkillReport />
    </>
  )
}

function DashboardShell() {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<SkillHealthStatus | "ALL">("ALL")
  const overviewResult = useOverview()
  const { data } = overviewResult

  const skillNavItems = useMemo(() => {
    if (!data) return []
    return sortByPassRateAndChecks(
      data.skills.map((s: SkillSummary) => ({
        name: s.skill_name,
        status: deriveStatus(s.pass_rate, s.total_checks),
        passRate: s.total_checks > 0 ? s.pass_rate : null,
        checks: s.total_checks,
      }))
    )
  }, [data])

  const filteredNavItems = useMemo(() => {
    let result = skillNavItems
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((s) => s.name.toLowerCase().includes(q))
    }
    if (statusFilter !== "ALL") {
      result = result.filter((s) => s.status === statusFilter)
    }
    return result
  }, [skillNavItems, search, statusFilter])

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { HEALTHY: 0, WARNING: 0, CRITICAL: 0, UNGRADED: 0, UNKNOWN: 0 }
    for (const s of skillNavItems) {
      counts[s.status] = (counts[s.status] ?? 0) + 1
    }
    return counts
  }, [skillNavItems])

  return (
    <SidebarProvider>
      <AppSidebar
        skills={filteredNavItems}
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        counts={statusCounts}
        version={data?.version}
      />
      <SidebarInset>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <SiteHeader />
                <Overview search={search} statusFilter={statusFilter} overviewResult={overviewResult} />
              </>
            }
          />
          <Route path="/skills/:name" element={<SkillReportWithHeader />} />
        </Routes>
      </SidebarInset>
    </SidebarProvider>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <DashboardShell />
        </TooltipProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
