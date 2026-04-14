import {
  DashboardChrome,
  type DashboardHeaderMeta,
  type DashboardLinkRenderer,
} from "@selftune/dashboard-core/chrome";
import { LockedRoute } from "@selftune/dashboard-core/gates";
import { DashboardHostProvider } from "@selftune/dashboard-core/host";
import {
  isDashboardRouteActive,
  matchDashboardRoute,
  resolveDashboardRoutes,
} from "@selftune/dashboard-core/routes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { useState } from "react";
import { ActivityIcon, WaypointsIcon } from "lucide-react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { LiveActionFeed } from "@/components/live-action-feed";
import { RuntimeFooter } from "@/components/runtime-footer";
import { StaleClientBanner } from "@/components/stale-client-banner";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useOverview } from "@/hooks/useOverview";
import { useSSE } from "@/hooks/useSSE";
import { Overview } from "@/pages/Overview";
import { PerformanceAnalytics } from "@/pages/PerformanceAnalytics";
import { LiveRun } from "@/pages/LiveRun";
import { SkillReport } from "@/pages/SkillReport";
import { SkillsLibrary } from "@/pages/SkillsLibrary";
import { Status } from "@/pages/Status";
import { localHostAdapter, LOCAL_CAPABILITIES } from "@/dashboard-host";
import type { SkillHealthStatus } from "@/types";
import { deriveStatus, formatRate } from "@selftune/ui/lib";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      gcTime: 5 * 60 * 1000,
    },
  },
});

function renderRouterLink({
  href,
  className,
  children,
  onClick,
}: Parameters<DashboardLinkRenderer>[0]) {
  return (
    <Link to={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

function LockedLocalCloudRoute({ routeId }: { routeId: "registry" | "signals" | "proposals" }) {
  const routes = resolveDashboardRoutes("local", LOCAL_CAPABILITIES);
  const route = routes.find((entry) => entry.id === routeId);

  if (!route || route.access !== "locked" || !route.lockedTitle || !route.lockedBody) {
    return null;
  }

  return (
    <LockedRoute
      eyebrow="Cloud feature"
      title={route.lockedTitle}
      description={route.lockedBody}
      highlights={route.lockedHighlights}
      primaryAction={{
        href: route.lockedPrimaryCtaHref ?? "https://selftune.dev/pricing",
        label: route.lockedPrimaryCtaLabel ?? "View cloud plans",
      }}
      secondaryAction={
        route.lockedSecondaryCtaHref && route.lockedSecondaryCtaLabel
          ? {
              href: route.lockedSecondaryCtaHref,
              label: route.lockedSecondaryCtaLabel,
            }
          : undefined
      }
      note="Keep using the local dashboard for offline diagnostics and day-to-day health checks. Cloud adds the shared coordination layer."
    />
  );
}

function getLocalHeaderMeta(
  pathname: string,
  routes: ReturnType<typeof resolveDashboardRoutes>,
): DashboardHeaderMeta {
  if (pathname.startsWith("/live-run")) {
    return {
      title: "Live run",
      icon: <ActivityIcon className="size-4 text-primary" />,
      badge: "Creator loop",
      backHref: "/skills",
      backLabel: "Skills",
    };
  }

  const matchedRoute = matchDashboardRoute(pathname, routes);
  if (matchedRoute?.id === "skills" && matchedRoute.matchKind === "detail") {
    return {
      title: decodeURIComponent(pathname.slice("/skills/".length)),
      icon: <WaypointsIcon className="size-4 text-primary" />,
      badge: matchedRoute.badge,
      backHref: matchedRoute.backHref,
      backLabel: matchedRoute.backLabel,
    };
  }

  if (matchedRoute) {
    const Icon = matchedRoute.icon;
    return {
      title: matchedRoute.title,
      icon: <Icon className="size-4 text-primary" />,
      badge: matchedRoute.badge,
      backHref: matchedRoute.backHref,
      backLabel: matchedRoute.backLabel,
    };
  }

  return {
    title: "Dashboard",
    icon: undefined,
    badge: "Overview",
    backHref: null,
    backLabel: null,
  };
}

function DashboardShell() {
  useSSE();
  const [statusFilter, setStatusFilter] = useState<SkillHealthStatus | "ALL">("ALL");
  const overviewQuery = useOverview();
  const { data } = overviewQuery;
  const location = useLocation();
  const navigate = useNavigate();
  const routes = resolveDashboardRoutes("local", LOCAL_CAPABILITIES);

  const navItems = routes.map((route) => {
    const Icon = route.icon;
    return {
      href: route.path,
      label: route.label,
      icon: <Icon className="size-4" />,
      tooltip: route.tooltip,
      isActive: isDashboardRouteActive(location.pathname, route),
      isLocked: route.access === "locked",
    };
  });

  const searchItems = [
    ...routes.map((route) => {
      const Icon = route.icon;
      return {
        id: `page:${route.id}`,
        group: "Pages",
        label: route.label,
        meta: route.tooltip,
        leading: <Icon className="size-4" />,
        trailing: route.access === "locked" ? "Locked" : undefined,
        onSelect: () => navigate(route.path),
      };
    }),
    ...(data?.skills ?? []).map((skill) => {
      const status = deriveStatus(skill.pass_rate, skill.total_checks);
      const dotClassName =
        status === "HEALTHY"
          ? "bg-primary"
          : status === "WARNING"
            ? "bg-primary-accent"
            : status === "CRITICAL"
              ? "bg-destructive"
              : "bg-muted-foreground";

      return {
        id: `skill:${skill.skill_name}`,
        group: "Skills",
        label: skill.skill_name,
        meta: "Skill report",
        keywords: [skill.skill_scope ?? "", status],
        leading: <span className={`size-2 rounded-full ${dotClassName}`} />,
        trailing: formatRate(skill.total_checks > 0 ? skill.pass_rate : null),
        onSelect: () => navigate(`/skills/${encodeURIComponent(skill.skill_name)}`),
      };
    }),
  ];

  return (
    <DashboardChrome
      brand={{
        href: "/",
        name: "Selftune",
        caption: "Skill Evolution Engine",
        footerLabel: data?.version ? `selftune v${data.version}` : "selftune",
      }}
      navItems={navItems}
      renderLink={renderRouterLink}
      headerMeta={getLocalHeaderMeta(location.pathname, routes)}
      searchItems={searchItems}
      headerUser={{ name: "Admin Node", subtitle: "Active" }}
      contentClassName={null}
      overlay={
        <>
          <RuntimeFooter />
          <LiveActionFeed />
        </>
      }
    >
      <Routes>
        <Route
          path="/"
          element={
            <Overview
              search=""
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              overviewQuery={overviewQuery}
            />
          }
        />
        <Route path="/skills" element={<SkillsLibrary overviewQuery={overviewQuery} />} />
        <Route path="/skills-library" element={<Navigate replace to="/skills" />} />
        <Route path="/analytics" element={<PerformanceAnalytics />} />
        <Route path="/skills/:name" element={<SkillReport />} />
        <Route path="/live-run" element={<LiveRun />} />
        <Route path="/registry" element={<LockedLocalCloudRoute routeId="registry" />} />
        <Route path="/signals" element={<LockedLocalCloudRoute routeId="signals" />} />
        <Route path="/community" element={<Navigate replace to="/signals" />} />
        <Route path="/proposals" element={<LockedLocalCloudRoute routeId="proposals" />} />
        <Route path="/status" element={<Status />} />
      </Routes>
    </DashboardChrome>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider defaultTheme="dark">
          <DashboardHostProvider adapter={localHostAdapter} capabilities={LOCAL_CAPABILITIES}>
            <DashboardShell />
            <StaleClientBanner />
          </DashboardHostProvider>
          <Toaster richColors closeButton />
          {import.meta.env.DEV && <Agentation />}
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
