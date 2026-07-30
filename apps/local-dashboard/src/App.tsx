import {
  DashboardChrome,
  type DashboardCloudProfileConnection,
  type DashboardHeaderMeta,
  type DashboardLinkRenderer,
} from "@selftune/dashboard-core/chrome";
import { LockedRoute } from "@selftune/dashboard-core/gates";
import {
  createBrowserServerProfileController,
  consumeServerProfilesHandoff,
  DashboardHostProvider,
  SERVER_PROFILES_STORAGE_KEY,
  type ServerRuntimeProfile,
} from "@selftune/dashboard-core/host";
import {
  isDashboardRouteActive,
  matchDashboardRoute,
  resolveDashboardRoutes,
} from "@selftune/dashboard-core/routes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agentation } from "agentation";
import { ActivityIcon, WaypointsIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
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
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useOverview } from "@/hooks/useOverview";
import { useSSE } from "@/hooks/useSSE";
import { useLinkCloudAccount, useSettings } from "@/hooks/useSettings";
import { useStaleClient } from "@/hooks/use-stale-client";
import { Insights } from "@/pages/Insights";
import { LiveRun } from "@/pages/LiveRun";
import { SkillReport } from "@/pages/SkillReport";
import { Settings } from "@/pages/Settings";
import { Status } from "@/pages/Status";
import { localDashboardHost } from "@/runtime-host";
import {
  composeLocalPrimaryRoutes,
  getLocalAppCoreNavigation,
  isLocalAppCoreRouteActive,
  LOCAL_APP_CORE_ROUTE_MANIFEST,
  LOCAL_APP_CORE_ROUTE_REGISTRY,
  matchLocalAppCoreShellRoute,
} from "@/shared-app-routes";
import {
  createLocalHostAdapter,
  LOCAL_CAPABILITIES,
  SELF_HOST_CAPABILITIES,
} from "@/dashboard-host";
import { deriveStatus, formatRate } from "@selftune/ui/lib";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      gcTime: 5 * 60 * 1000,
    },
  },
});

const LOCAL_SKILLS_ROUTE = LOCAL_APP_CORE_ROUTE_REGISTRY.skills;

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

function LockedLocalCloudRoute({
  routeId,
  runtime,
}: {
  routeId: "registry" | "signals" | "proposals";
  runtime: ServerRuntimeProfile;
}) {
  const capabilities = runtime.host === "selfhost" ? SELF_HOST_CAPABILITIES : LOCAL_CAPABILITIES;
  const routes = resolveDashboardRoutes(localDashboardHost(runtime), capabilities);
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
      backHref: LOCAL_SKILLS_ROUTE.path,
      backLabel: LOCAL_SKILLS_ROUTE.navigation.label,
    };
  }

  const matchedRoute = matchDashboardRoute(pathname, routes);
  if (matchedRoute?.id === "skills" && matchedRoute.matchKind === "detail") {
    return {
      title: decodeURIComponent(pathname.slice(`${LOCAL_SKILLS_ROUTE.path}/`.length)),
      icon: <WaypointsIcon className="size-4 text-primary" />,
      badge: matchedRoute.badge,
      backHref: matchedRoute.backHref,
      backLabel: matchedRoute.backLabel,
    };
  }

  const sharedRoute = matchLocalAppCoreShellRoute(pathname);
  if (sharedRoute && pathname === sharedRoute.path && matchedRoute) {
    const Icon = matchedRoute.icon;
    return {
      title: sharedRoute.header.title,
      icon: <Icon className="size-4 text-primary" />,
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

function DashboardShell({ runtime }: { runtime: ServerRuntimeProfile }) {
  useSSE();
  const staleClient = useStaleClient();
  const overviewQuery = useOverview();
  const settingsQuery = useSettings();
  const cloudAccountLink = useLinkCloudAccount();
  const { data } = overviewQuery;
  const location = useLocation();
  const navigate = useNavigate();
  const capabilities = runtime.host === "selfhost" ? SELF_HOST_CAPABILITIES : LOCAL_CAPABILITIES;
  const routes = resolveDashboardRoutes(localDashboardHost(runtime), capabilities);
  const primaryRoutes = composeLocalPrimaryRoutes(routes);
  const cloudConnectionState: DashboardCloudProfileConnection["state"] = cloudAccountLink.isPending
    ? "connecting"
    : settingsQuery.data?.cloud_account.linked
      ? "linked"
      : settingsQuery.data
        ? "unlinked"
        : settingsQuery.isPending
          ? "checking"
          : "unavailable";
  const cloudProfileConnection: DashboardCloudProfileConnection | undefined =
    runtime.host === "local"
      ? {
          state: cloudConnectionState,
          connect: async () => {
            const settings = settingsQuery.data ?? (await settingsQuery.refetch()).data;
            if (!settings) {
              throw new Error("Cloud account status could not be loaded. Try again.");
            }
            const { first_backup: firstBackup } = await cloudAccountLink.mutateAsync(
              settings.remote_library.preferences,
            );
            if (firstBackup.status === "completed") {
              toast.success("selftune Cloud connected", {
                description: `First backup complete: ${firstBackup.uploaded} uploaded, ${firstBackup.unchanged} unchanged.`,
              });
            } else {
              toast.warning("selftune Cloud connected", {
                description: `The first backup did not finish: ${firstBackup.message}`,
              });
            }
          },
          manage: () => navigate("/settings?section=remote-library"),
          openDashboard: async () => {
            const url = "https://app.selftune.dev";
            if (window.selftuneDesktop) {
              await window.selftuneDesktop.openExternal(url);
              return;
            }
            const opened = window.open(url, "_blank", "noopener,noreferrer");
            if (!opened) throw new Error("Allow popups to open the selftune Cloud dashboard.");
          },
        }
      : undefined;

  const navItems = primaryRoutes.map((route) => {
    const Icon = route.icon;
    const sharedNavigation = getLocalAppCoreNavigation(route.id);
    return {
      href: sharedNavigation?.path ?? route.path,
      label: sharedNavigation?.label ?? (route.id === "analytics" ? "Insights" : route.label),
      icon: <Icon className="size-4" />,
      tooltip: sharedNavigation?.tooltip ?? route.tooltip,
      isActive: sharedNavigation
        ? isLocalAppCoreRouteActive(location.pathname, sharedNavigation.id)
        : isDashboardRouteActive(location.pathname, route),
      isLocked: route.access === "locked",
    };
  });

  const searchItems = [
    ...primaryRoutes.map((route) => {
      const Icon = route.icon;
      const sharedNavigation = getLocalAppCoreNavigation(route.id);
      return {
        id: `page:${route.id}`,
        group: "Pages",
        label: sharedNavigation?.label ?? (route.id === "analytics" ? "Insights" : route.label),
        meta: sharedNavigation?.tooltip ?? route.tooltip,
        leading: <Icon className="size-4" />,
        trailing: route.access === "locked" ? "Locked" : undefined,
        onSelect: () => navigate(sharedNavigation?.path ?? route.path),
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
        onSelect: () =>
          navigate(`${LOCAL_SKILLS_ROUTE.path}/${encodeURIComponent(skill.skill_name)}`),
      };
    }),
  ];

  return (
    <DashboardChrome
      brand={{
        href: LOCAL_SKILLS_ROUTE.path,
        name: "selftune",
        footerLabel: data?.version ? `selftune v${data.version}` : "selftune",
        footerHref: "/status",
        footerAction: staleClient
          ? {
              label: "Update",
              ariaLabel: `Update dashboard to v${staleClient.serverVersion}`,
              onClick: () => window.location.reload(),
            }
          : undefined,
      }}
      navItems={navItems}
      renderLink={renderRouterLink}
      headerMeta={getLocalHeaderMeta(location.pathname, routes)}
      searchItems={searchItems}
      headerUser={{ name: "Admin Node", subtitle: "Active" }}
      cloudProfileConnection={cloudProfileConnection}
      showHeader={false}
      contentClassName={null}
      overlay={<LiveActionFeed />}
    >
      <Routes>
        <Route path="/" element={<Navigate replace to={LOCAL_SKILLS_ROUTE.path} />} />
        {LOCAL_APP_CORE_ROUTE_MANIFEST.map(({ Component, id, path }) => (
          <Route key={id} path={path} element={<Component />} />
        ))}
        <Route path="/skills-library" element={<Navigate replace to={LOCAL_SKILLS_ROUTE.path} />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/analytics" element={<Navigate replace to="/insights" />} />
        <Route path={`${LOCAL_SKILLS_ROUTE.path}/:name`} element={<SkillReport />} />
        <Route path="/live-run" element={<LiveRun />} />
        <Route
          path="/registry"
          element={<LockedLocalCloudRoute routeId="registry" runtime={runtime} />}
        />
        <Route
          path="/signals"
          element={<LockedLocalCloudRoute routeId="signals" runtime={runtime} />}
        />
        <Route path="/community" element={<Navigate replace to="/signals" />} />
        <Route
          path="/proposals"
          element={<LockedLocalCloudRoute routeId="proposals" runtime={runtime} />}
        />
        <Route path="/settings" element={<Settings />} />
        <Route path="/status" element={<Status />} />
      </Routes>
    </DashboardChrome>
  );
}

export function App({ runtime }: { runtime: ServerRuntimeProfile }) {
  const runtimeHost = localDashboardHost(runtime);
  const capabilities = runtime.host === "selfhost" ? SELF_HOST_CAPABILITIES : LOCAL_CAPABILITIES;
  const serverProfiles = useMemo(
    () =>
      createBrowserServerProfileController({
        origin: window.location.origin,
        capabilities: capabilities.features,
        runtime,
        load: () => window.localStorage.getItem(SERVER_PROFILES_STORAGE_KEY),
        persist: (serialized) =>
          window.localStorage.setItem(SERVER_PROFILES_STORAGE_KEY, serialized),
        clearHostState: () => queryClient.clear(),
        currentPath: () => `${window.location.pathname}${window.location.search}`,
        navigation: window.selftuneDesktop
          ? {
              mode: "external",
              navigate: (url) => window.selftuneDesktop?.openExternal(url),
            }
          : {
              mode: "same_window",
              navigate: (url) => window.location.assign(url),
            },
        fetch: window.fetch.bind(window),
      }),
    [capabilities.features, runtime],
  );
  const hostAdapter = useMemo(
    () => createLocalHostAdapter(runtimeHost, serverProfiles),
    [runtimeHost, serverProfiles],
  );

  useEffect(() => {
    const handoff = consumeServerProfilesHandoff(window.location.href, capabilities.features);
    if (handoff) {
      window.localStorage.setItem(SERVER_PROFILES_STORAGE_KEY, handoff.serialized);
      serverProfiles.reconcileExternal(handoff.serialized);
      window.history.replaceState(window.history.state, "", handoff.cleanUrl);
    }
    const reconcileProfiles = (event: StorageEvent): void => {
      if (event.key !== SERVER_PROFILES_STORAGE_KEY || event.newValue === null) return;
      serverProfiles.reconcileExternal(event.newValue);
    };
    window.addEventListener("storage", reconcileProfiles);
    return () => window.removeEventListener("storage", reconcileProfiles);
  }, [capabilities.features, serverProfiles]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider defaultTheme="light">
          <DashboardHostProvider adapter={hostAdapter}>
            <DashboardShell runtime={runtime} />
          </DashboardHostProvider>
          <Toaster richColors closeButton />
          {import.meta.env.DEV && <Agentation />}
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
