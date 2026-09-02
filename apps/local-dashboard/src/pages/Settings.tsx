import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  TabsContent,
} from "@selftune/ui/primitives";
import { PageScaffold } from "@selftune/ui/components";
import { ThemeSegmentedControl } from "@selftune/dashboard-core/chrome";
import { SettingsShell } from "@selftune/dashboard-core/screens";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  DownloadIcon,
  EyeIcon,
  HardDriveDownloadIcon,
  LogInIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ServerIcon,
  Share2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { SetupWizard } from "@/components/SetupWizard";
import { BillingSettingsPanel } from "@/components/settings/BillingSettingsPanel";
import { HarnessLogo } from "@/components/HarnessLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  SELFTUNE_CLOUD_SYNC_URL,
  syncDestinationCopy,
  syncDestinationFromUrl,
  syncDestinationName,
  type SyncDestination,
} from "@/lib/sync-destination";
import {
  useExportRemoteLibrary,
  useLinkCloudAccount,
  usePreviewRemoteLibrary,
  useRemoteLibraryStatus,
  useRemoteLibraryShares,
  useCreateRemoteLibraryShare,
  useRemoteLibraryShareAction,
  useRestoreRemoteLibrary,
  useSettings,
  useSyncRemoteLibrary,
  useUpdateRemoteLibrarySettings,
  useUpdateScheduleSettings,
  useWorkspaceSkillSetPolicies,
  useUpdateWorkspaceSkillSetPolicy,
  useResetWorkspaceSkillSetPolicy,
  useWorkspaceMembers,
  useInviteWorkspaceMember,
  useUpdateWorkspaceMemberRole,
  useRemoveWorkspaceMember,
} from "@/hooks/useSettings";
import type {
  DesktopScheduleJob,
  DesktopScheduleJobId,
  DesktopSettingsResponse,
  HarnessConnection,
  SyncPreferences,
  RemoteLibraryShare,
  WorkspaceMemberRole,
} from "@/types";

type ScheduleDraft = Record<DesktopScheduleJobId, { enabled: boolean; schedule: string }>;
type RemoteDraft = {
  destination: SyncDestination;
  url: string;
  apiKey: string;
  preferences: SyncPreferences;
};

type SettingsSectionId =
  | "connections"
  | "billing"
  | "remote-library"
  | "workspace"
  | "private-sharing"
  | "background-service"
  | "automation"
  | "appearance";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  availability: "always" | "workspace" | "self_hosted" | "desktop";
}> = [
  { id: "connections", label: "Connections", availability: "always" },
  { id: "billing", label: "Billing", availability: "always" },
  { id: "remote-library", label: "Cloud & self-hosting", availability: "always" },
  { id: "workspace", label: "Workspace", availability: "workspace" },
  { id: "private-sharing", label: "Private sharing", availability: "self_hosted" },
  {
    id: "background-service",
    label: "Background service",
    availability: "desktop",
  },
  { id: "automation", label: "Automation", availability: "always" },
  { id: "appearance", label: "Appearance", availability: "always" },
];

function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

function settingsSectionFromSearch(searchParams: URLSearchParams): SettingsSectionId {
  const section = searchParams.get("section");
  return isSettingsSectionId(section) ? section : "connections";
}

const REMOTE_PREFERENCES: Array<{
  key: keyof SyncPreferences;
  label: string;
  description: string;
}> = [
  {
    key: "releasedSkills",
    label: "Skills",
    description: "Canonical immutable revisions across locations and connections",
  },
  {
    key: "drafts",
    label: "Drafts",
    description: "Unreleased packages you explicitly back up",
  },
  {
    key: "skillSets",
    label: "Skill Sets",
    description: "Pinned project configurations",
  },
  {
    key: "metadata",
    label: "Library metadata",
    description: "Revisions and lifecycle state",
  },
  {
    key: "decisionHistory",
    label: "Decision history",
    description: "Overrides, evidence, reviews, and measured outcomes",
  },
];

interface ScheduleOption {
  label: string;
  value: string;
}

const SCHEDULE_PRESETS: Record<DesktopScheduleJobId, ScheduleOption[]> = {
  "selftune-sync": [
    { label: "Every 30 minutes", value: "*/30 * * * *" },
    { label: "Every 15 minutes", value: "*/15 * * * *" },
    { label: "Every hour", value: "0 */1 * * *" },
    { label: "Every 2 hours", value: "0 */2 * * *" },
  ],
  "selftune-status": [
    { label: "Daily at 8:00 AM", value: "0 8 * * *" },
    { label: "Daily at 9:00 AM", value: "0 9 * * *" },
    { label: "Daily at 12:00 PM", value: "0 12 * * *" },
    { label: "Daily at 6:00 PM", value: "0 18 * * *" },
  ],
  "selftune-orchestrate": [
    { label: "Every 2 hours", value: "0 */2 * * *" },
    { label: "Every 4 hours", value: "0 */4 * * *" },
    { label: "Every 6 hours", value: "0 */6 * * *" },
    { label: "Every 12 hours", value: "0 */12 * * *" },
  ],
};

function draftFromJobs(jobs: DesktopScheduleJob[]): ScheduleDraft {
  return Object.fromEntries(
    jobs.map((job) => [job.id, { enabled: job.enabled, schedule: job.schedule }]),
  ) as ScheduleDraft;
}

function humanizeSchedule(schedule: string): string {
  const minuteInterval = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minuteInterval) return `Every ${minuteInterval[1]} minutes`;

  const hourInterval = schedule.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourInterval) {
    const hours = Number(hourInterval[1]);
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }

  const daily = schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    const minute = Number(daily[1]);
    const hour = Number(daily[2]);
    const displayHour = hour % 12 || 12;
    const period = hour < 12 ? "AM" : "PM";
    return `Daily at ${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
  }

  return "Custom schedule";
}

function optionsForJob(job: DesktopScheduleJob, selectedSchedule: string): ScheduleOption[] {
  const presets = SCHEDULE_PRESETS[job.id];
  if (presets.some((option) => option.value === selectedSchedule)) return presets;
  return [...presets, { label: humanizeSchedule(selectedSchedule), value: selectedSchedule }];
}

function HarnessStatus({ harness }: { harness: HarnessConnection }) {
  const classes =
    harness.status === "connected"
      ? "border-primary/25 bg-primary/10 text-primary"
      : harness.status === "detected"
        ? "border-warning/25 bg-warning/10 text-warning-foreground"
        : "border-border bg-muted/30 text-muted-foreground";
  const label =
    harness.status === "connected"
      ? "Connected"
      : harness.status === "detected"
        ? "Setup needed"
        : "Not found";
  return (
    <Badge variant="outline" className={classes}>
      {harness.status === "connected" && <CheckIcon className="mr-1 size-3" />}
      {label}
    </Badge>
  );
}

function credentialProviderLabel(
  provider: DesktopSettingsResponse["remote_library"]["credential_provider"],
): string | null {
  switch (provider) {
    case "macos-keychain":
      return "macOS Keychain";
    case "windows-credential-manager":
      return "Windows Credential Manager";
    case "linux-secret-service":
      return "Desktop Keyring";
    case "environment":
      return "Environment";
    case "file":
      return "Owner-only file";
    case null:
      return null;
  }
}

function SettingsSkeleton() {
  return (
    <PageScaffold className="max-w-6xl gap-8" aria-label="Loading settings" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid min-w-0 gap-8 lg:grid-cols-[160px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border/60 pr-5 lg:flex lg:flex-col lg:gap-2">
          <Skeleton className="mb-1 h-3 w-16" />
          {SETTINGS_SECTIONS.map((section) => (
            <Skeleton key={section.id} className="h-7 w-full" />
          ))}
        </aside>
        <div className="flex min-w-0 flex-col gap-8">
          {["connections", "remote-library", "automation"].map((section) => (
            <section key={section} className="flex flex-col gap-3" aria-hidden="true">
              <div className="flex items-end justify-between gap-4">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-64 max-w-full" />
                </div>
                <Skeleton className="h-7 w-24" />
              </div>
              <div className="divide-y divide-border/60 border border-border/60">
                {["first", "second", "third"].map((row) => (
                  <div key={row} className="flex items-center gap-4 px-4 py-3">
                    <Skeleton className="size-8 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton className="h-4 w-36" />
                      <Skeleton className="h-3 w-56 max-w-full" />
                    </div>
                    <Skeleton className="h-6 w-20" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PageScaffold>
  );
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsQuery = useSettings();
  const selfHostedWorkspaceConfigured = Boolean(
    settingsQuery.data?.remote_library.configured &&
    syncDestinationFromUrl(settingsQuery.data.remote_library.url ?? "") === "self_hosted",
  );
  const connectedWorkspaceConfigured = Boolean(settingsQuery.data?.remote_library.configured);
  const updateSchedule = useUpdateScheduleSettings();
  const updateRemote = useUpdateRemoteLibrarySettings();
  const linkCloudAccount = useLinkCloudAccount();
  const previewRemote = usePreviewRemoteLibrary();
  const remoteStatus = useRemoteLibraryStatus(
    settingsQuery.data?.remote_library.configured ?? false,
  );
  const syncRemote = useSyncRemoteLibrary();
  const exportRemote = useExportRemoteLibrary();
  const restoreRemote = useRestoreRemoteLibrary();
  const remoteShares = useRemoteLibraryShares(
    settingsQuery.data?.remote_library.configured ?? false,
  );
  const createShare = useCreateRemoteLibraryShare();
  const shareAction = useRemoteLibraryShareAction();
  const workspacePolicies = useWorkspaceSkillSetPolicies(selfHostedWorkspaceConfigured);
  const updateWorkspacePolicy = useUpdateWorkspaceSkillSetPolicy();
  const resetWorkspacePolicy = useResetWorkspaceSkillSetPolicy();
  const workspaceMembers = useWorkspaceMembers(connectedWorkspaceConfigured);
  const inviteWorkspaceMember = useInviteWorkspaceMember();
  const updateWorkspaceMemberRole = useUpdateWorkspaceMemberRole();
  const removeWorkspaceMember = useRemoveWorkspaceMember();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<RemoteDraft | null>(null);
  const [shareEmail, setShareEmail] = useState("");
  const [shareArtifactId, setShareArtifactId] = useState("");
  const [shareExpiry, setShareExpiry] = useState("30_days");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceMemberRole>("member");
  const [backgroundService, setBackgroundService] = useState<SelfTuneBackgroundServiceState | null>(
    null,
  );
  const [backgroundServicePending, setBackgroundServicePending] = useState(false);
  const currentWorkspaceRole = workspaceMembers.data?.current_role;
  const canManageWorkspace = currentWorkspaceRole === "admin" || currentWorkspaceRole === "owner";
  const canChangeWorkspaceRoles = currentWorkspaceRole === "owner";
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    settingsSectionFromSearch(searchParams),
  );
  const shareableArtifacts = useMemo(
    () =>
      (remoteStatus.data?.head?.artifacts ?? []).filter(
        (artifact) =>
          artifact.artifactType === "skill_revision" || artifact.artifactType === "skill_set",
      ),
    [remoteStatus.data?.head?.artifacts],
  );

  useEffect(() => {
    if (settingsQuery.data) {
      const configuredUrl = settingsQuery.data.remote_library.url ?? "";
      const destination = syncDestinationFromUrl(configuredUrl);
      setDraft(draftFromJobs(settingsQuery.data.schedule.jobs));
      setRemoteDraft({
        destination,
        url: configuredUrl || (destination === "cloud" ? SELFTUNE_CLOUD_SYNC_URL : configuredUrl),
        apiKey: "",
        preferences: settingsQuery.data.remote_library.preferences,
      });
    }
  }, [settingsQuery.data]);

  useEffect(() => {
    setActiveSection(settingsSectionFromSearch(searchParams));
  }, [searchParams]);

  useEffect(() => {
    void window.selftuneDesktop?.getBackgroundService().then(setBackgroundService);
  }, []);

  useEffect(() => {
    if (!shareableArtifacts.some((artifact) => artifact.artifactId === shareArtifactId)) {
      setShareArtifactId(shareableArtifacts[0]?.artifactId ?? "");
    }
  }, [shareArtifactId, shareableArtifacts]);

  const remoteLibraryConfigured = settingsQuery.data?.remote_library.configured ?? false;
  const cloudAccountLinked = settingsQuery.data?.cloud_account.linked ?? false;
  const configuredDestination = syncDestinationFromUrl(
    settingsQuery.data?.remote_library.url ?? "",
  );
  const configuredDestinationName = syncDestinationName(configuredDestination);
  const draftDestinationName = syncDestinationName(remoteDraft?.destination ?? "cloud");
  const configuredDestinationCopy = syncDestinationCopy(configuredDestination);
  const draftDestinationCopy = syncDestinationCopy(remoteDraft?.destination ?? "cloud");
  const hasBackgroundService = backgroundService !== null;
  const selfHostedKeyRequired = Boolean(
    remoteDraft?.destination === "self_hosted" &&
    (!remoteLibraryConfigured ||
      configuredDestination !== "self_hosted" ||
      remoteDraft.url.trim() !== (settingsQuery.data?.remote_library.url ?? "")) &&
    !remoteDraft.apiKey.trim(),
  );

  const hasChanges = useMemo(() => {
    if (!settingsQuery.data || !draft) return false;
    return settingsQuery.data.schedule.jobs.some((job) => {
      const next = draft[job.id];
      return next.enabled !== job.enabled || next.schedule.trim() !== job.schedule;
    });
  }, [draft, settingsQuery.data]);

  if (settingsQuery.isLoading) return <SettingsSkeleton />;

  if (settingsQuery.isError || !settingsQuery.data || !draft || !remoteDraft) {
    return (
      <PageScaffold className="max-w-5xl">
        <div className="flex items-center justify-between rounded-lg border border-destructive/25 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">Settings could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => settingsQuery.refetch()}>
            <RefreshCwIcon /> Retry
          </Button>
        </div>
      </PageScaffold>
    );
  }

  const { harnesses, schedule } = settingsQuery.data;
  const scheduleDraft = draft;
  const connectedCount = harnesses.filter((harness) => harness.connected).length;
  const canResetTimes = schedule.jobs.some(
    (job) => scheduleDraft[job.id].schedule !== job.default_schedule,
  );
  const formatLabel =
    schedule.format === "launchd"
      ? "macOS launchd"
      : schedule.format === "systemd"
        ? "Linux systemd"
        : "Unavailable";
  const availableSections = SETTINGS_SECTIONS.filter(
    (section) =>
      section.availability === "always" ||
      (section.availability === "workspace" && connectedWorkspaceConfigured) ||
      (section.availability === "self_hosted" && selfHostedWorkspaceConfigured) ||
      (section.availability === "desktop" && hasBackgroundService),
  );

  function saveSchedule() {
    updateSchedule.mutate(
      {
        jobs: schedule.jobs.map((job) => ({
          id: job.id,
          ...scheduleDraft[job.id],
        })),
      },
      {
        onSuccess: () => toast.success("Automation schedule saved"),
        onError: (error) =>
          toast.error("Schedule update failed", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function saveRemoteLibrary() {
    if (!remoteDraft) return;
    updateRemote.mutate(
      {
        url: remoteDraft.url,
        api_key: remoteDraft.apiKey || undefined,
        preferences: remoteDraft.preferences,
      },
      {
        onSuccess: () => {
          setRemoteDraft((current) => (current ? { ...current, apiKey: "" } : current));
          toast.success(draftDestinationCopy.connected);
        },
        onError: (error) =>
          toast.error(draftDestinationCopy.connectFailed, {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function connectCloudAccount() {
    if (!remoteDraft) return;
    linkCloudAccount.mutate(remoteDraft.preferences, {
      onSuccess: ({ first_backup: firstBackup }) => {
        if (firstBackup.status === "completed") {
          toast.success("SelfTune Cloud connected", {
            description: `Cloud inventory updated: ${firstBackup.uploaded} reported, ${firstBackup.unchanged} unchanged.`,
          });
        } else {
          toast.warning("SelfTune Cloud connected", {
            description: `The first inventory update did not finish: ${firstBackup.message}`,
          });
        }
      },
      onError: (error) =>
        toast.error("Cloud connection failed", {
          description: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  function shareArtifact() {
    const snapshotId = remoteStatus.data?.head?.snapshotId;
    if (!snapshotId || !shareArtifactId || !shareEmail.trim()) return;
    const expiresAt =
      shareExpiry === "never"
        ? null
        : new Date(
            Date.now() + (shareExpiry === "7_days" ? 7 : 30) * 24 * 60 * 60 * 1_000,
          ).toISOString();
    createShare.mutate(
      {
        snapshot_id: snapshotId,
        artifact_id: shareArtifactId,
        recipient_email: shareEmail.trim(),
        expires_at: expiresAt,
      },
      {
        onSuccess: (share) => {
          setShareEmail("");
          toast.success("Private share created", {
            description: `${share.artifacts.length} immutable artifact${share.artifacts.length === 1 ? "" : "s"} granted to ${share.recipient.email}`,
          });
        },
        onError: (error) =>
          toast.error("Share failed", {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function runShareAction(share: RemoteLibraryShare, action: "accept" | "import" | "revoke") {
    shareAction.mutate(
      { shareId: share.id, action },
      {
        onSuccess: () =>
          toast.success(action === "import" ? "Shared artifacts imported" : `Share ${action}ed`),
        onError: (error) =>
          toast.error(`Could not ${action} share`, {
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  return (
    <SettingsShell
      sections={availableSections}
      activeSection={activeSection}
      onSectionChange={(value) => {
        if (!isSettingsSectionId(value)) return;
        setActiveSection(value);
        const nextSearchParams = new URLSearchParams(searchParams);
        if (value === "connections") nextSearchParams.delete("section");
        else nextSearchParams.set("section", value);
        setSearchParams(nextSearchParams, { replace: true });
      }}
      title="Settings"
      description="Manage Cloud, self-hosted backups, and background automation."
    >
      <TabsContent value="connections" className="min-w-0">
        <section aria-labelledby="connections-heading">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <h2 id="connections-heading" className="text-base font-semibold text-foreground">
                Connections
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {connectedCount} of {harnesses.length} are sending telemetry to SelfTune.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <SetupWizard settings={settingsQuery.data} />
              <Button
                variant="ghost"
                size="icon"
                title="Refresh connection status"
                aria-label="Refresh connection status"
                disabled={settingsQuery.isFetching}
                onClick={() => settingsQuery.refetch()}
              >
                <RefreshCwIcon className={settingsQuery.isFetching ? "animate-spin" : ""} />
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
            <div className="hidden grid-cols-[minmax(180px,1fr)_140px] border-b border-border/70 bg-muted/20 px-4 py-2 text-[11px] font-medium uppercase text-muted-foreground md:grid">
              <span>Connection</span>
              <span>Integration</span>
            </div>
            {harnesses.map((harness) => {
              return (
                <div
                  key={harness.id}
                  className="grid gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(180px,1fr)_140px] md:items-center"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <HarnessLogo name={harness.name} icon={harness.icon} className="size-8" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{harness.name}</p>
                      <p
                        className="truncate text-xs text-muted-foreground"
                        title={harness.description}
                      >
                        {harness.detail}
                      </p>
                    </div>
                  </div>
                  <div>
                    <HarnessStatus harness={harness} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </TabsContent>

      <TabsContent value="billing" className="min-w-0">
        <BillingSettingsPanel
          active={activeSection === "billing"}
          cloudConfigured={selfHostedWorkspaceConfigured}
          connectPending={linkCloudAccount.isPending}
          onConnect={connectCloudAccount}
        />
      </TabsContent>

      <TabsContent value="remote-library" className="min-w-0">
        <section aria-labelledby="remote-library-heading">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 id="remote-library-heading" className="text-base font-semibold text-foreground">
                  Cloud connection & self-hosted backup
                </h2>
                <Badge
                  variant="outline"
                  className="border-border bg-muted/20 text-muted-foreground"
                >
                  {settingsQuery.data.remote_library.configured
                    ? configuredDestinationCopy.connected
                    : draftDestinationCopy.notConnected}
                </Badge>
                {credentialProviderLabel(settingsQuery.data.remote_library.credential_provider) && (
                  <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
                    {credentialProviderLabel(settingsQuery.data.remote_library.credential_provider)}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Your Library stays local. Cloud receives only a privacy-safe inventory; a
                self-hosted server can store a backup when you choose it.
              </p>
            </div>
            <div className="flex gap-2">
              {remoteDraft.destination === "self_hosted" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    previewRemote.isPending ||
                    !remoteLibraryConfigured ||
                    remoteDraft.destination !== configuredDestination
                  }
                  onClick={() =>
                    previewRemote.mutate(
                      { preferences: remoteDraft.preferences },
                      {
                        onError: (error) =>
                          toast.error(draftDestinationCopy.previewFailed, {
                            description: error instanceof Error ? error.message : String(error),
                          }),
                      },
                    )
                  }
                >
                  <EyeIcon data-icon="inline-start" />{" "}
                  {previewRemote.isPending ? "Preparing" : "Preview backup"}
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={
                  !remoteDraft.url.trim() ||
                  selfHostedKeyRequired ||
                  updateRemote.isPending ||
                  linkCloudAccount.isPending
                }
                onClick={
                  remoteDraft.destination === "cloud" && !cloudAccountLinked
                    ? connectCloudAccount
                    : saveRemoteLibrary
                }
              >
                {remoteDraft.destination === "cloud" && !cloudAccountLinked ? (
                  <LogInIcon data-icon="inline-start" />
                ) : (
                  <SaveIcon data-icon="inline-start" />
                )}{" "}
                {linkCloudAccount.isPending
                  ? "Waiting for approval"
                  : updateRemote.isPending
                    ? "Saving"
                    : remoteDraft.destination === "cloud" && !cloudAccountLinked
                      ? "Connect Cloud account"
                      : remoteDraft.destination !== configuredDestination
                        ? `Use ${draftDestinationName}`
                        : remoteLibraryConfigured
                          ? "Save"
                          : "Connect"}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
            <div className="grid gap-3 border-b border-border/60 px-4 py-4 md:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Destination
                <Select
                  value={remoteDraft.destination}
                  onValueChange={(value) => {
                    if (value !== "cloud" && value !== "self_hosted") return;
                    setRemoteDraft((current) => {
                      if (!current) return current;
                      const currentIsCloud = syncDestinationFromUrl(current.url) === "cloud";
                      return {
                        ...current,
                        destination: value,
                        url:
                          value === "cloud"
                            ? SELFTUNE_CLOUD_SYNC_URL
                            : currentIsCloud
                              ? ""
                              : current.url,
                      };
                    });
                  }}
                >
                  <SelectTrigger aria-label="Backup destination">
                    {draftDestinationName}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="cloud">SelfTune Cloud</SelectItem>
                      <SelectItem value="self_hosted">Self-hosted</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              {remoteDraft.destination === "cloud" ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 bg-muted/15 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <CloudIcon className="size-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {cloudAccountLinked
                            ? "SelfTune Cloud account connected"
                            : "No Cloud account"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {cloudAccountLinked
                            ? "Your credential is stored securely by this device."
                            : "Create an account or sign in in your browser. Desktop remains usable without one."}
                        </p>
                      </div>
                    </div>
                    {cloudAccountLinked ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={linkCloudAccount.isPending}
                        onClick={connectCloudAccount}
                      >
                        Reconnect
                      </Button>
                    ) : null}
                  </div>
                  {linkCloudAccount.data?.first_backup.status === "failed" ? (
                    <div
                      role="status"
                      className="flex gap-2 rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                    >
                      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                      <div>
                        <p className="font-medium">
                          Cloud connected; inventory update needs attention
                        </p>
                        <p className="mt-0.5">{linkCloudAccount.data.first_backup.message}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    Server URL
                    <Input
                      value={remoteDraft.url}
                      onChange={(event) =>
                        setRemoteDraft((current) =>
                          current ? { ...current, url: event.target.value } : current,
                        )
                      }
                      placeholder="https://selftune.example.com"
                      className="h-9"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    Device API key
                    <Input
                      type="password"
                      value={remoteDraft.apiKey}
                      onChange={(event) =>
                        setRemoteDraft((current) =>
                          current ? { ...current, apiKey: event.target.value } : current,
                        )
                      }
                      placeholder={
                        configuredDestination === "self_hosted" && remoteLibraryConfigured
                          ? "Leave blank to keep current key"
                          : "Required"
                      }
                      className="h-9"
                    />
                  </label>
                </>
              )}
            </div>
            {remoteDraft.destination === "self_hosted"
              ? REMOTE_PREFERENCES.map((preference) => (
                  <div
                    key={preference.key}
                    className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{preference.label}</p>
                      <p className="text-xs text-muted-foreground">{preference.description}</p>
                    </div>
                    <Switch
                      checked={remoteDraft.preferences[preference.key]}
                      onCheckedChange={(checked) =>
                        setRemoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                preferences: {
                                  ...current.preferences,
                                  [preference.key]: checked,
                                },
                              }
                            : current,
                        )
                      }
                      aria-label={`${preference.label} backup`}
                    />
                  </div>
                ))
              : null}
            <div className="flex items-center gap-3 border-t border-border/60 bg-muted/15 px-4 py-3 text-xs text-muted-foreground">
              <CloudIcon className="size-4" />
              {remoteDraft.destination === "cloud"
                ? "Skill contents, paths, prompts, sessions, and evaluations stay local."
                : "Raw transcripts are never synced."}
            </div>
            {previewRemote.data ? (
              <Collapsible defaultOpen className="border-t border-border/60 px-4 py-3 text-xs">
                <CollapsibleTrigger
                  render={
                    <Button variant="ghost" size="sm" className="w-full justify-between px-0" />
                  }
                >
                  {previewRemote.data.artifacts.length} artifacts ·{" "}
                  {previewRemote.data.totalBytes.toLocaleString()} bytes
                  <ChevronDownIcon data-icon="inline-end" />
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-2 pt-2">
                  {previewRemote.data.artifacts.map((artifact) => (
                    <div
                      key={`${artifact.artifactType}:${artifact.artifactId}`}
                      className="flex min-w-0 items-center justify-between gap-4 border-b border-border/40 pb-2 last:border-0"
                    >
                      <span className="min-w-0 truncate text-foreground">
                        {artifact.artifactId}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {artifact.artifactType} · {artifact.bytes.toLocaleString()} B
                      </span>
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {settingsQuery.data.remote_library.configured ? (
              <div className="border-t border-border/60 px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-muted-foreground">
                    {remoteStatus.data?.diagnostics ? (
                      <>
                        {remoteStatus.data.diagnostics.objectCount} objects ·{" "}
                        {remoteStatus.data.diagnostics.snapshotCount} snapshots ·{" "}
                        {remoteStatus.data.diagnostics.totalBytes.toLocaleString()} bytes
                      </>
                    ) : remoteStatus.isError ? (
                      configuredDestinationCopy.unavailable
                    ) : (
                      configuredDestinationCopy.checking
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={syncRemote.isPending}
                      onClick={() =>
                        syncRemote.mutate(undefined, {
                          onSuccess: (result) =>
                            toast.success(configuredDestinationCopy.synced, {
                              description: `${result.uploaded} uploaded, ${result.unchanged} already present`,
                            }),
                          onError: (error) =>
                            toast.error(configuredDestinationCopy.syncFailed, {
                              description: error instanceof Error ? error.message : String(error),
                            }),
                        })
                      }
                    >
                      <RefreshCwIcon
                        data-icon="inline-start"
                        className={syncRemote.isPending ? "animate-spin" : ""}
                      />{" "}
                      Sync now
                    </Button>
                    {selfHostedWorkspaceConfigured ? (
                      <>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="Export complete backup"
                          disabled={exportRemote.isPending}
                          onClick={() =>
                            exportRemote.mutate(undefined, {
                              onSuccess: (result) =>
                                toast.success("Library backup exported", {
                                  description: result.outputPath,
                                }),
                              onError: (error) =>
                                toast.error("Export failed", {
                                  description:
                                    error instanceof Error ? error.message : String(error),
                                }),
                            })
                          }
                        >
                          <DownloadIcon />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="Restore into a new local directory"
                          disabled={restoreRemote.isPending}
                          onClick={() =>
                            restoreRemote.mutate(undefined, {
                              onSuccess: (result) =>
                                toast.success("Library restored to a clean directory", {
                                  description: result.targetRoot,
                                }),
                              onError: (error) =>
                                toast.error("Restore failed", {
                                  description:
                                    error instanceof Error ? error.message : String(error),
                                }),
                            })
                          }
                        >
                          <HardDriveDownloadIcon />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
                {remoteStatus.data?.diagnostics?.missingObjects.length ? (
                  <p className="mt-2 text-xs text-destructive">
                    {configuredDestinationName} is missing{" "}
                    {remoteStatus.data.diagnostics.missingObjects.length} objects. Restore from a
                    complete backup before syncing again.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </TabsContent>

      {connectedWorkspaceConfigured ? (
        <TabsContent value="workspace" className="min-w-0">
          <section aria-labelledby="workspace-heading">
            {selfHostedWorkspaceConfigured ? (
              <>
                <div className="mb-3">
                  <div className="flex items-center gap-2">
                    <h2 id="workspace-heading" className="text-base font-semibold text-foreground">
                      Workspace Skill Sets
                    </h2>
                    <Badge variant="outline">Shared with every member</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Workspace Skill Sets sync automatically. Admins can allow them, require a
                    reviewed install, block them, or mark them as required.
                  </p>
                </div>
                <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
                  {workspacePolicies.isLoading ? (
                    <div className="space-y-2 p-4">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : workspacePolicies.data?.policies.length ? (
                    workspacePolicies.data.policies.map((policy) => (
                      <div
                        key={policy.skill_set_id}
                        className="grid gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_210px_auto] md:items-center"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {policy.skill_set_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {policy.reason || "Available to all workspace members after sync."}
                          </p>
                        </div>
                        <Select
                          value={policy.action}
                          disabled={!canManageWorkspace}
                          onValueChange={(action) => {
                            if (
                              action !== "allow" &&
                              action !== "require_approval" &&
                              action !== "block" &&
                              action !== "require"
                            )
                              return;
                            updateWorkspacePolicy.mutate(
                              {
                                skillSetId: policy.skill_set_id,
                                action,
                                reason: policy.reason,
                              },
                              {
                                onSuccess: () => toast.success("Workspace policy updated"),
                                onError: (error) =>
                                  toast.error("Policy update failed", {
                                    description:
                                      error instanceof Error ? error.message : String(error),
                                  }),
                              },
                            );
                          }}
                        >
                          <SelectTrigger
                            className="h-9 w-full"
                            aria-label={`${policy.skill_set_name} policy`}
                          >
                            {policy.action === "allow"
                              ? "Allowed"
                              : policy.action === "require_approval"
                                ? "Approval required"
                                : policy.action === "block"
                                  ? "Blocked"
                                  : "Required"}
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="allow">Allowed</SelectItem>
                              <SelectItem value="require_approval">Approval required</SelectItem>
                              <SelectItem value="block">Blocked</SelectItem>
                              <SelectItem value="require">Required</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            !canManageWorkspace ||
                            policy.updated_at === null ||
                            resetWorkspacePolicy.isPending
                          }
                          onClick={() =>
                            resetWorkspacePolicy.mutate(
                              { skillSetId: policy.skill_set_id },
                              {
                                onSuccess: () => toast.success("Workspace policy reset to Allowed"),
                              },
                            )
                          }
                        >
                          Reset
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="px-4 py-5 text-sm text-muted-foreground">
                      Sync or create a Cloud Skill Set to make it available to this workspace.
                    </p>
                  )}
                </div>
              </>
            ) : null}

            <div className="mt-7 mb-3">
              <h3 className="text-base font-semibold text-foreground">Members</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Members see workspace Skill Sets automatically. Roles control who can install,
                publish, manage policies, and administer the workspace.
              </p>
            </div>
            <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
              <div className="grid gap-3 border-b border-border/60 px-4 py-4 md:grid-cols-[minmax(0,1fr)_180px_auto]">
                <Input
                  type="email"
                  disabled={!canManageWorkspace}
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  aria-label="Workspace member email"
                />
                <Select
                  value={inviteRole}
                  disabled={!canManageWorkspace}
                  onValueChange={(role) => {
                    if (
                      role === "viewer" ||
                      role === "member" ||
                      role === "admin" ||
                      role === "owner"
                    )
                      setInviteRole(role);
                  }}
                >
                  <SelectTrigger className="h-9 w-full">{inviteRole}</SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="owner" disabled={currentWorkspaceRole !== "owner"}>
                        Owner
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  disabled={
                    !canManageWorkspace || !inviteEmail.trim() || inviteWorkspaceMember.isPending
                  }
                  onClick={() =>
                    inviteWorkspaceMember.mutate(
                      { email: inviteEmail.trim(), role: inviteRole },
                      {
                        onSuccess: (result) => {
                          setInviteEmail("");
                          toast.success(
                            result.status === "joined"
                              ? "Workspace member added"
                              : "Workspace invitation sent",
                          );
                        },
                        onError: (error) =>
                          toast.error("Could not add member", {
                            description: error instanceof Error ? error.message : String(error),
                          }),
                      },
                    )
                  }
                >
                  Add member
                </Button>
              </div>
              {workspaceMembers.data?.members.map((member) => (
                <div
                  key={member.user_id}
                  className="grid gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {member.name || member.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  </div>
                  <Select
                    value={member.role}
                    disabled={
                      !canChangeWorkspaceRoles ||
                      member.user_id === workspaceMembers.data?.current_user_id
                    }
                    onValueChange={(role) => {
                      if (
                        role !== "viewer" &&
                        role !== "member" &&
                        role !== "admin" &&
                        role !== "owner"
                      )
                        return;
                      updateWorkspaceMemberRole.mutate(
                        { userId: member.user_id, role },
                        {
                          onSuccess: () => toast.success("Member role updated"),
                          onError: (error) =>
                            toast.error("Role update failed", {
                              description: error instanceof Error ? error.message : String(error),
                            }),
                        },
                      );
                    }}
                  >
                    <SelectTrigger className="h-9 w-full" aria-label={`${member.email} role`}>
                      {member.role}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="owner">Owner</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      !canManageWorkspace ||
                      member.user_id === workspaceMembers.data?.current_user_id ||
                      member.role === "owner" ||
                      removeWorkspaceMember.isPending
                    }
                    onClick={() =>
                      removeWorkspaceMember.mutate(
                        { userId: member.user_id },
                        {
                          onSuccess: () => toast.success("Workspace member removed"),
                        },
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {workspaceMembers.data?.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="grid gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invitation.email}
                    </p>
                    <p className="text-xs text-muted-foreground">Invitation pending</p>
                  </div>
                  <Badge variant="outline">{invitation.role}</Badge>
                  <span className="text-xs text-muted-foreground">Awaiting sign-in</span>
                </div>
              ))}
              {!workspaceMembers.isLoading &&
              !workspaceMembers.data?.members.length &&
              !workspaceMembers.data?.invitations.length ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  No workspace members could be loaded.
                </p>
              ) : null}
            </div>
          </section>
        </TabsContent>
      ) : null}

      {settingsQuery.data.remote_library.configured ? (
        <TabsContent value="private-sharing" className="min-w-0">
          <section aria-labelledby="private-sharing-heading">
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <h2
                  id="private-sharing-heading"
                  className="text-base font-semibold text-foreground"
                >
                  Private sharing
                </h2>
                <Badge
                  variant="outline"
                  className="border-border bg-muted/20 text-muted-foreground"
                >
                  Recipient only
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Grant a person an immutable skill or complete Skill Set revision.
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
              <div className="grid gap-3 border-b border-border/60 px-4 py-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(180px,1fr)_150px_auto]">
                <Select
                  value={shareArtifactId}
                  onValueChange={(value) => {
                    if (value) setShareArtifactId(value);
                  }}
                >
                  <SelectTrigger className="h-9 w-full">
                    {shareArtifactId || "Sync a skill or Skill Set first"}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {shareableArtifacts.map((artifact) => (
                        <SelectItem key={artifact.artifactId} value={artifact.artifactId}>
                          {artifact.artifactId}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Input
                  type="email"
                  value={shareEmail}
                  onChange={(event) => setShareEmail(event.target.value)}
                  placeholder="person@example.com"
                  aria-label="Recipient email"
                  className="h-9"
                />
                <Select
                  value={shareExpiry}
                  onValueChange={(value) => {
                    if (value) setShareExpiry(value);
                  }}
                >
                  <SelectTrigger className="h-9 w-full">
                    {shareExpiry === "never"
                      ? "Never expires"
                      : `Expires in ${shareExpiry === "7_days" ? 7 : 30} days`}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="7_days">7 days</SelectItem>
                      <SelectItem value="30_days">30 days</SelectItem>
                      <SelectItem value="never">Never</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={
                    createShare.isPending ||
                    !shareArtifactId ||
                    !shareEmail.trim() ||
                    !remoteStatus.data?.head
                  }
                  onClick={shareArtifact}
                >
                  <Share2Icon /> Share
                </Button>
              </div>

              <div className="grid gap-0 md:grid-cols-2">
                <div className="border-b border-border/60 md:border-r md:border-b-0">
                  <div className="border-b border-border/60 bg-muted/15 px-4 py-2 text-xs font-medium text-foreground">
                    Shared with you
                  </div>
                  {remoteShares.data?.inbox.length ? (
                    remoteShares.data.inbox.map((share) => (
                      <div
                        key={share.id}
                        className="flex items-center gap-3 border-b border-border/50 px-4 py-3 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-foreground">
                            {share.root_artifact_id}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {share.owner.name} · {share.artifacts.length} artifact
                            {share.artifacts.length === 1 ? "" : "s"} · {share.status}
                          </p>
                        </div>
                        {share.status === "pending" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => runShareAction(share, "accept")}
                          >
                            Accept
                          </Button>
                        ) : share.status === "accepted" ? (
                          <Button size="sm" onClick={() => runShareAction(share, "import")}>
                            Import
                          </Button>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="px-4 py-5 text-xs text-muted-foreground">
                      No private shares received.
                    </p>
                  )}
                </div>
                <div>
                  <div className="border-b border-border/60 bg-muted/15 px-4 py-2 text-xs font-medium text-foreground">
                    Shared by you
                  </div>
                  {remoteShares.data?.outbox.length ? (
                    remoteShares.data.outbox.map((share) => (
                      <div
                        key={share.id}
                        className="flex items-center gap-3 border-b border-border/50 px-4 py-3 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-foreground">
                            {share.root_artifact_id}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {share.recipient.email} · {share.status}
                          </p>
                        </div>
                        {share.status !== "revoked" && share.status !== "expired" ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Revoke private share"
                            aria-label="Revoke private share"
                            onClick={() => runShareAction(share, "revoke")}
                          >
                            <XIcon />
                          </Button>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="px-4 py-5 text-xs text-muted-foreground">
                      No active private shares.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>
        </TabsContent>
      ) : null}

      {backgroundService ? (
        <TabsContent value="background-service" className="min-w-0">
          <section aria-labelledby="background-service-heading">
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <h2
                  id="background-service-heading"
                  className="text-base font-semibold text-foreground"
                >
                  Background service
                </h2>
                <Badge
                  variant="outline"
                  className={
                    backgroundService.running
                      ? "border-primary/25 bg-primary/10 text-primary"
                      : "border-border bg-muted/20 text-muted-foreground"
                  }
                >
                  {backgroundService.running ? "Running" : "Stopped"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep collection, backups, and scheduled work available after the app closes.
              </p>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-border/70 bg-background/25 px-4 py-4">
              <Switch
                checked={backgroundService.enabled}
                disabled={!backgroundService.supported || backgroundServicePending}
                aria-label={`${backgroundService.enabled ? "Disable" : "Enable"} background service`}
                onCheckedChange={(enabled) => {
                  setBackgroundServicePending(true);
                  void window.selftuneDesktop
                    ?.setBackgroundService(enabled)
                    .then(setBackgroundService)
                    .catch((error: unknown) =>
                      toast.error("Background service update failed", {
                        description: error instanceof Error ? error.message : String(error),
                      }),
                    )
                    .finally(() => setBackgroundServicePending(false));
                }}
              />
              <ServerIcon className="size-5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Run when SelfTune is closed</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {backgroundService.detail[0] ?? `Managed by ${backgroundService.platform}`}
                </p>
              </div>
            </div>
          </section>
        </TabsContent>
      ) : null}

      <TabsContent value="automation" className="min-w-0">
        <section aria-labelledby="automation-heading">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 id="automation-heading" className="text-base font-semibold text-foreground">
                  Automation schedule
                </h2>
                <Badge
                  variant="outline"
                  className="border-border bg-muted/20 text-muted-foreground"
                >
                  {formatLabel}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Run local collection and improvement jobs in the background.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!canResetTimes || updateSchedule.isPending}
                onClick={() =>
                  setDraft(
                    Object.fromEntries(
                      schedule.jobs.map((job) => [
                        job.id,
                        {
                          enabled: scheduleDraft[job.id].enabled,
                          schedule: job.default_schedule,
                        },
                      ]),
                    ) as ScheduleDraft,
                  )
                }
              >
                <RotateCcwIcon /> Reset defaults
              </Button>
              <Button
                size="sm"
                disabled={!schedule.supported || !hasChanges || updateSchedule.isPending}
                onClick={saveSchedule}
              >
                <SaveIcon /> {updateSchedule.isPending ? "Saving" : "Save"}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
            {schedule.jobs.map((job) => {
              const jobDraft = draft[job.id];
              const scheduleOptions = optionsForJob(job, jobDraft.schedule);
              return (
                <div
                  key={job.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border/60 px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(200px,1fr)_280px_44px] lg:items-center"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{job.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{job.description}</p>
                  </div>
                  <div className="col-span-2 lg:col-span-1">
                    <Select
                      value={jobDraft.schedule}
                      disabled={!schedule.supported || updateSchedule.isPending}
                      onValueChange={(scheduleValue) =>
                        setDraft((current) =>
                          current && scheduleValue
                            ? {
                                ...current,
                                [job.id]: {
                                  ...current[job.id],
                                  schedule: scheduleValue,
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <SelectTrigger
                        id={`schedule-${job.id}`}
                        aria-label={`${job.label} frequency`}
                        className="w-full"
                      >
                        <span className="truncate text-left">
                          {humanizeSchedule(jobDraft.schedule)}
                          {jobDraft.schedule === job.default_schedule ? " (Recommended)" : ""}
                        </span>
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectGroup>
                          {scheduleOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                              {option.value === job.default_schedule ? " (Recommended)" : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <Switch
                    className="col-start-2 row-start-1 justify-self-end lg:col-start-3"
                    checked={jobDraft.enabled}
                    disabled={!schedule.supported || updateSchedule.isPending}
                    aria-label={`${jobDraft.enabled ? "Disable" : "Enable"} ${job.label}`}
                    onCheckedChange={(enabled) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              [job.id]: { ...current[job.id], enabled },
                            }
                          : current,
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
          {!schedule.supported && (
            <p className="mt-2 text-xs text-warning-foreground">
              Native background scheduling is not available on this operating system.
            </p>
          )}
        </section>
      </TabsContent>

      <TabsContent value="appearance" className="min-w-0">
        <section aria-labelledby="appearance-heading">
          <div className="mb-3">
            <h2 id="appearance-heading" className="text-base font-semibold text-foreground">
              Appearance
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose how SelfTune looks on this device.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-background/25 px-4 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Theme</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Light, dark, or match your system setting.
              </p>
            </div>
            <ThemeSegmentedControl />
          </div>
        </section>
      </TabsContent>
    </SettingsShell>
  );
}
