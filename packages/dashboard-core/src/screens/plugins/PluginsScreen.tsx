"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  BlocksIcon,
  CheckCircle2Icon,
  CircleSlash2Icon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { usePluginsModule, type DashboardPluginsContribution } from "../../host";
import type {
  PluginHostInstallationModel,
  PluginHostModel,
  PluginInventoryItemModel,
  PluginManagementActionModel,
} from "../../models";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  PageHeader,
  PageScaffold,
} from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from "@selftune/ui/primitives";

type HostFilter = "all" | PluginHostModel;
type OwnershipFilter = "all" | "selftune" | "external";

const HOST_ACCENTS = {
  claude: { monogram: "C", className: "border-border bg-muted text-muted-foreground" },
  codex: { monogram: "◎", className: "border-primary/20 bg-primary/10 text-primary" },
} satisfies Record<PluginHostModel, { monogram: string; className: string }>;

function actionLabel(action: PluginManagementActionModel): string {
  if (action === "remove") return "Remove";
  if (action === "disable") return "Disable";
  if (action === "enable") return "Enable";
  return "Update";
}

function actionIcon(action: PluginManagementActionModel) {
  if (action === "remove") return <Trash2Icon aria-hidden="true" />;
  if (action === "disable") return <CircleSlash2Icon aria-hidden="true" />;
  if (action === "enable") return <PowerIcon aria-hidden="true" />;
  return <RefreshCwIcon aria-hidden="true" />;
}

function hostCount(plugins: readonly PluginInventoryItemModel[], host: PluginHostModel): number {
  return plugins.filter((plugin) =>
    plugin.installations.some((installation) => installation.host === host),
  ).length;
}

function PluginsUnavailable({ reason }: { reason: string }) {
  return (
    <PageScaffold data-parity-root="plugins">
      <PageHeader
        title="Plugins"
        description="See and manage the plugins installed in your local agent apps."
      />
      <Card className="shadow-none">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Plugin management unavailable</EmptyTitle>
            <EmptyDescription>{reason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

function PluginsLoading() {
  return (
    <PageScaffold aria-label="Loading plugins" aria-busy="true" data-parity-root="plugins">
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-[min(100%,38rem)]" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-64 w-full" />
        ))}
      </div>
    </PageScaffold>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-none">
      <p className="text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function HostMark({ host }: { host: PluginHostModel }) {
  const accent = HOST_ACCENTS[host];
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold ${accent.className}`}
      aria-hidden="true"
    >
      {accent.monogram}
    </span>
  );
}

interface InstallationRowProps {
  installation: PluginHostInstallationModel;
  pendingKey: string | null;
  onAction(installation: PluginHostInstallationModel, action: PluginManagementActionModel): void;
}

function InstallationRow({ installation, pendingKey, onAction }: InstallationRowProps) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-start gap-3">
        <HostMark host={installation.host} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{installation.hostLabel}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {installation.version ?? "Version unknown"}
            </span>
            <Badge variant={installation.enabled ? "secondary" : "outline"}>
              {installation.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {installation.sourceLabel}
            {installation.scope ? ` · ${installation.scope} scope` : ""}
          </p>
        </div>
      </div>
      {installation.availableActions.length > 0 ? (
        <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t border-border/60 pt-3">
          {installation.availableActions.map((action) => {
            const key = `${installation.host}:${installation.pluginId}:${action}`;
            return (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={action === "remove" ? "destructive" : "outline"}
                disabled={pendingKey !== null}
                onClick={() => onAction(installation, action)}
              >
                {pendingKey === key ? (
                  <RefreshCwIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  actionIcon(action)
                )}
                {pendingKey === key ? `${actionLabel(action)}…` : actionLabel(action)}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Managed by your organization. Change it in the host policy that installed it.
        </p>
      )}
    </div>
  );
}

function PluginCard({
  plugin,
  pendingKey,
  onAction,
}: {
  plugin: PluginInventoryItemModel;
  pendingKey: string | null;
  onAction(installation: PluginHostInstallationModel, action: PluginManagementActionModel): void;
}) {
  return (
    <Card className="gap-3 py-4 shadow-none" data-testid={`plugin-card-${plugin.pluginId}`}>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
            <BlocksIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">{plugin.name}</h2>
              {plugin.managedBySelfTune ? (
                <Badge variant="secondary">SelfTune managed</Badge>
              ) : null}
              {plugin.versionDrift ? <Badge variant="warning">Versions differ</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {plugin.marketplaceName === "unknown"
                ? plugin.pluginId
                : `${plugin.marketplaceName} marketplace`}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {plugin.installations.map((installation) => (
            <InstallationRow
              key={installation.host}
              installation={installation}
              pendingKey={pendingKey}
              onAction={onAction}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PluginsAvailable({
  contribution,
}: {
  contribution: Extract<DashboardPluginsContribution, { access: "available" }>;
}) {
  const inventory = contribution.useInventory();
  const actions = contribution.useActions();
  const [search, setSearch] = useState("");
  const [hostFilter, setHostFilter] = useState<HostFilter>("all");
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipFilter>("all");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PluginHostInstallationModel | null>(null);

  const plugins = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (inventory.data?.plugins ?? []).filter((plugin) => {
      if (
        normalizedSearch &&
        !`${plugin.name} ${plugin.pluginId} ${plugin.marketplaceName}`
          .toLowerCase()
          .includes(normalizedSearch)
      ) {
        return false;
      }
      if (
        hostFilter !== "all" &&
        !plugin.installations.some((installation) => installation.host === hostFilter)
      ) {
        return false;
      }
      if (ownershipFilter === "selftune" && !plugin.managedBySelfTune) return false;
      if (ownershipFilter === "external" && plugin.managedBySelfTune) return false;
      return true;
    });
  }, [hostFilter, inventory.data?.plugins, ownershipFilter, search]);

  if (inventory.isLoading && !inventory.data) return <PluginsLoading />;
  if (!inventory.data) {
    return (
      <PluginsUnavailable reason={inventory.error ?? "The plugin inventory could not be loaded."} />
    );
  }

  const runAction = async (
    installation: PluginHostInstallationModel,
    action: PluginManagementActionModel,
  ) => {
    if (actions.manage.access !== "available") return;
    const key = `${installation.host}:${installation.pluginId}:${action}`;
    setPendingKey(key);
    try {
      await actions.manage.execute({
        host: installation.host,
        pluginId: installation.pluginId,
        action,
      });
      toast.success(`${installation.hostLabel} plugin ${actionLabel(action).toLowerCase()}d`, {
        description: installation.pluginId,
      });
      setRemoveTarget(null);
    } catch (error) {
      toast.error(`${actionLabel(action)} failed`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingKey(null);
    }
  };

  const requestAction = (
    installation: PluginHostInstallationModel,
    action: PluginManagementActionModel,
  ) => {
    if (action === "remove") {
      setRemoveTarget(installation);
      return;
    }
    void runAction(installation, action);
  };

  const allPlugins = inventory.data.plugins;
  return (
    <PageScaffold data-parity-root="plugins" className="max-w-7xl">
      <PageHeader
        title="Plugins"
        description="One place to see and manage the plugins already installed in Claude and Codex on this machine."
        actions={
          <Button type="button" variant="outline" onClick={() => void inventory.refresh()}>
            <RefreshCwIcon className={inventory.isLoading ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />

      {inventory.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {inventory.error}
        </div>
      ) : null}

      <section
        aria-label="Plugin inventory summary"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <SummaryTile label="Unique plugins" value={inventory.data.totalPlugins} />
        <SummaryTile label="Installed in Claude" value={hostCount(allPlugins, "claude")} />
        <SummaryTile label="Installed in Codex" value={hostCount(allPlugins, "codex")} />
        <SummaryTile label="Installed by SelfTune" value={inventory.data.managedPlugins} />
      </section>

      <section aria-label="Agent host status" className="grid gap-3 sm:grid-cols-2">
        {inventory.data.hosts.map((host) => (
          <div
            key={host.host}
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <HostMark host={host.host} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{host.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {host.status === "available"
                  ? `${host.installedCount} plugin${host.installedCount === 1 ? "" : "s"} detected`
                  : host.message}
              </p>
            </div>
            {host.status === "available" ? (
              <CheckCircle2Icon className="size-5 text-success" aria-label="Available" />
            ) : (
              <AlertTriangleIcon className="size-5 text-warning" aria-label={host.status} />
            )}
          </div>
        ))}
      </section>

      <div className="flex flex-col gap-3 border-y border-border py-4 md:flex-row md:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search plugins</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins or marketplaces"
            className="pl-9"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" aria-label="Plugin filters">
          {(["all", "claude", "codex"] as const).map((host) => (
            <Button
              key={host}
              type="button"
              size="sm"
              variant={hostFilter === host ? "secondary" : "ghost"}
              aria-pressed={hostFilter === host}
              onClick={() => setHostFilter(host)}
            >
              {host === "all" ? "All hosts" : host === "claude" ? "Claude" : "Codex"}
            </Button>
          ))}
          <span className="mx-1 hidden h-7 w-px bg-border sm:block" aria-hidden="true" />
          {(["all", "selftune", "external"] as const).map((ownership) => (
            <Button
              key={ownership}
              type="button"
              size="sm"
              variant={ownershipFilter === ownership ? "secondary" : "ghost"}
              aria-pressed={ownershipFilter === ownership}
              onClick={() => setOwnershipFilter(ownership)}
            >
              {ownership === "all"
                ? "Any owner"
                : ownership === "selftune"
                  ? "SelfTune"
                  : "Other sources"}
            </Button>
          ))}
        </div>
      </div>

      {plugins.length > 0 ? (
        <section aria-label="Installed plugins" className="grid items-start gap-4 lg:grid-cols-2">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.pluginId}
              plugin={plugin}
              pendingKey={pendingKey}
              onAction={requestAction}
            />
          ))}
        </section>
      ) : (
        <Card className="shadow-none">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No plugins match</EmptyTitle>
              <EmptyDescription>
                {allPlugins.length === 0
                  ? "No Claude or Codex plugins were detected on this machine."
                  : "Clear the search or change the filters to see more plugins."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Card>
      )}

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this plugin from {removeTarget?.hostLabel}?</DialogTitle>
            <DialogDescription>
              This removes {removeTarget?.pluginId} from {removeTarget?.hostLabel}. The plugin can
              be installed again from its marketplace.
              {removeTarget?.host === "claude"
                ? " Claude plugin data will be kept so reinstalling can restore its state."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingKey !== null}
              onClick={() => removeTarget && void runAction(removeTarget, "remove")}
            >
              <Trash2Icon />
              Remove from {removeTarget?.hostLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageScaffold>
  );
}

export function PluginsScreen() {
  const contribution = usePluginsModule().plugins;
  if (!contribution) {
    return <PluginsUnavailable reason="This host does not provide local plugin management." />;
  }
  if (contribution.access === "unavailable") {
    return <PluginsUnavailable reason={contribution.reason} />;
  }
  return <PluginsAvailable contribution={contribution} />;
}
