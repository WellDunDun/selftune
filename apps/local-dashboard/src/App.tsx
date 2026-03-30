import { deriveStatus, sortByPassRateAndChecks } from "@selftune/ui/lib";
import { TooltipProvider } from "@selftune/ui/primitives";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { RuntimeFooter } from "@/components/runtime-footer";
import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useOverview } from "@/hooks/useOverview";
import { useSSE } from "@/hooks/useSSE";
import { Overview } from "@/pages/Overview";
import { PerformanceAnalytics } from "@/pages/PerformanceAnalytics";
import { SkillReport } from "@/pages/SkillReport";
import { SkillReportV2 } from "@/pages/SkillReportV2";
import { SkillsLibrary } from "@/pages/SkillsLibrary";
import { Status } from "@/pages/Status";
import type { SkillHealthStatus, SkillSummary } from "@/types";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      gcTime: 5 * 60 * 1000,
    },
  },
});

function SkillReportWithHeader({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <>
      <SiteHeader search={search} onSearchChange={onSearchChange} />
      <SkillReport />
    </>
  );
}

function SkillReportV2WithHeader({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <>
      <SiteHeader search={search} onSearchChange={onSearchChange} />
      <SkillReportV2 />
    </>
  );
}

function StatusWithHeader({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <>
      <SiteHeader search={search} onSearchChange={onSearchChange} />
      <Status />
    </>
  );
}

function DashboardShell() {
  useSSE();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SkillHealthStatus | "ALL">("ALL");
  const overviewQuery = useOverview();
  const { data } = overviewQuery;

  const skillNavItems = useMemo(() => {
    if (!data) return [];
    return sortByPassRateAndChecks(
      data.skills.map((s: SkillSummary) => ({
        name: s.skill_name,
        scope: s.skill_scope,
        status: deriveStatus(s.pass_rate, s.total_checks),
        passRate: s.total_checks > 0 ? s.pass_rate : null,
        checks: s.total_checks,
      })),
    );
  }, [data]);

  const filteredNavItems = useMemo(() => {
    if (!search) return skillNavItems;
    const q = search.toLowerCase();
    return skillNavItems.filter((s) => s.name.toLowerCase().includes(q));
  }, [skillNavItems, search]);

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
                <SiteHeader search={search} onSearchChange={setSearch} />
                <Overview
                  search={search}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  overviewQuery={overviewQuery}
                />
              </>
            }
          />
          <Route
            path="/skills-library"
            element={
              <>
                <SiteHeader search={search} onSearchChange={setSearch} />
                <SkillsLibrary overviewQuery={overviewQuery} />
              </>
            }
          />
          <Route
            path="/analytics"
            element={
              <>
                <SiteHeader search={search} onSearchChange={setSearch} />
                <PerformanceAnalytics />
              </>
            }
          />
          <Route
            path="/skills/:name"
            element={<SkillReportWithHeader search={search} onSearchChange={setSearch} />}
          />
          <Route
            path="/skills-v2/:name"
            element={<SkillReportV2WithHeader search={search} onSearchChange={setSearch} />}
          />
          <Route
            path="/status"
            element={<StatusWithHeader search={search} onSearchChange={setSearch} />}
          />
        </Routes>
      </SidebarInset>
      <RuntimeFooter />
    </SidebarProvider>
  );
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
  );
}
