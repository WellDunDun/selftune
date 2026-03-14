import { useMemo, useState } from "react"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      gcTime: 5 * 60 * 1000,
    },
  },
})

function SkillReportWithHeader() {
  return (
    <>
      <SiteHeader />
      <SkillReport />
    </>
  )
}

function DashboardShell() {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<SkillHealthStatus | "ALL">("ALL")
  const overviewQuery = useOverview()
  const { data } = overviewQuery

  const skillNavItems = useMemo(() => {
    if (!data) return []
    return sortByPassRateAndChecks(
      data.skills.map((s: SkillSummary) => ({
        name: s.skill_name,
        scope: s.skill_scope,
        status: deriveStatus(s.pass_rate, s.total_checks),
        passRate: s.total_checks > 0 ? s.pass_rate : null,
        checks: s.total_checks,
      }))
    )
  }, [data])

  const filteredNavItems = useMemo(() => {
    if (!search) return skillNavItems
    const q = search.toLowerCase()
    return skillNavItems.filter((s) => s.name.toLowerCase().includes(q))
  }, [skillNavItems, search])

  return (
    <SidebarProvider>
      <AppSidebar
        skills={filteredNavItems}
        search={search}
        onSearchChange={setSearch}
        version={data?.version}
      />
      <SidebarInset>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <SiteHeader />
                <Overview search={search} statusFilter={statusFilter} onStatusFilterChange={setStatusFilter} overviewQuery={overviewQuery} />
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            <DashboardShell />
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
