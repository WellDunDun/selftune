"use client";

import { useState } from "react";
import {
  ArchiveRestoreIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CloudUploadIcon,
  DownloadIcon,
  GitMergeIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import type { DashboardLibraryActions } from "../../host";
import { CloudFeatureGateDialog } from "../../gates";
import type {
  DashboardDecisionModel,
  LibraryConnectionIconModel,
  LibraryMergeModel,
  LibrarySkillBackupReceiptModel,
  LibraryInstallAgent,
  LibraryLocationModel,
  LibrarySkillInstallReceiptModel,
  LibraryPrepareMergeInput,
  LibrarySkillModel,
  LibrarySourceUpdateModel,
  LibraryUpdateReceiptModel,
} from "../../models";
import { DurableDecisionCard } from "../decisions";
import { UnifiedDiffViewer } from "@selftune/ui/components";
import { cn, timeAgo } from "@selftune/ui/lib";
import {
  Badge,
  Button,
  DialogFooter,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";

function actionMessage(action: { access: string; reason?: string }): string | null {
  return action.access === "unavailable" ? (action.reason ?? "This action is unavailable.") : null;
}

interface GroupedLocation {
  readonly path: string;
  readonly label: string;
  readonly sourceKind?: string | null;
  readonly lastUsedAt?: string | null;
  readonly modifiedAt?: string | null;
  readonly connections: Array<{
    readonly label: string;
    readonly icon?: LibraryConnectionIconModel | null;
  }>;
}

function groupLocations(locations: LibraryLocationModel[]): GroupedLocation[] {
  const grouped = new Map<string, GroupedLocation>();
  for (const location of locations) {
    const groupId = location.groupId ?? location.path;
    const existing = grouped.get(groupId);
    const connection = location.connection
      ? [{ label: location.connection, icon: location.connectionIcon }]
      : [];
    if (!existing) {
      grouped.set(groupId, {
        path: location.rootPath ?? location.path,
        label: location.label,
        sourceKind: location.sourceKind,
        lastUsedAt: location.lastUsedAt,
        modifiedAt: location.modifiedAt,
        connections: connection,
      });
      continue;
    }
    if (
      location.connection &&
      !existing.connections.some((candidate) => candidate.label === location.connection)
    ) {
      existing.connections.push(...connection);
    }
  }
  return [...grouped.values()];
}

function LocationConnections({ connections }: { connections: GroupedLocation["connections"] }) {
  const label = `${connections.length} ${connections.length === 1 ? "agent" : "agents"}`;
  return (
    <div className="flex items-center gap-1.5" aria-label={label}>
      {connections.map((connection) =>
        connection.icon ? (
          <span
            key={connection.label}
            className="inline-flex size-7 items-center justify-center overflow-hidden rounded-md border bg-background"
            title={connection.label}
          >
            <span
              role="img"
              aria-label={connection.label}
              className={cn(
                "bg-center bg-no-repeat",
                connection.icon.inset === "sm" ? "size-5" : "size-full",
                connection.icon.invert_in_dark && "dark:invert",
              )}
              style={{
                backgroundImage: `url("${connection.icon.src}")`,
                backgroundSize: connection.icon.fit,
              }}
            />
          </span>
        ) : (
          <Badge key={connection.label} variant="secondary" title={connection.label}>
            {connection.label}
          </Badge>
        ),
      )}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function ConnectionIdentity({
  label,
  icon,
}: {
  label: string;
  icon?: LibraryConnectionIconModel | null;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {icon ? (
        <span
          className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background"
          title={label}
        >
          <span
            role="img"
            aria-label={label}
            className={cn(
              "bg-center bg-no-repeat",
              icon.inset === "sm" ? "size-5" : "size-full",
              icon.invert_in_dark && "dark:invert",
            )}
            style={{ backgroundImage: `url("${icon.src}")`, backgroundSize: icon.fit }}
          />
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function SkillDetail({
  skill,
  sourceUpdate,
  updateReceipt,
  merge,
  actionError,
  onPreviewUpdate,
  onApplyUpdate,
  onPrepareMerge,
  onApplyMerge,
  onRemove,
  onRestore,
  removalDecision,
  onDecideRemoval,
  actions,
}: {
  skill: LibrarySkillModel;
  sourceUpdate: LibrarySourceUpdateModel | null;
  updateReceipt: LibraryUpdateReceiptModel | null;
  merge: LibraryMergeModel | null;
  actionError: string | null;
  onPreviewUpdate(): void;
  onApplyUpdate(): void;
  onPrepareMerge(input: LibraryPrepareMergeInput): void;
  onApplyMerge(): void;
  onRemove(): void;
  onRestore(): void;
  removalDecision: DashboardDecisionModel | null;
  onDecideRemoval(action: "approve" | "decline"): void;
  actions: DashboardLibraryActions;
}) {
  const [mergeConnectionId, setMergeConnectionId] = useState(actions.mergeConnections[0]?.id ?? "");
  const [mergeModel, setMergeModel] = useState("");
  const [installAgent, setInstallAgent] = useState<LibraryInstallAgent>(
    actions.installTargets?.[0]?.id ?? "codex",
  );
  const [backupReceipt, setBackupReceipt] = useState<LibrarySkillBackupReceiptModel | null>(null);
  const [installReceipt, setInstallReceipt] = useState<LibrarySkillInstallReceiptModel | null>(
    null,
  );
  const [transferError, setTransferError] = useState<string | null>(null);
  const [cloudBackupGateOpen, setCloudBackupGateOpen] = useState(false);
  const selectedMergeConnection = actions.mergeConnections.find(
    (connection) => connection.id === mergeConnectionId,
  );
  const backupAction = actions.backup;
  const installAction = actions.install;
  const unavailableMessages = [
    actionMessage(actions.previewSourceUpdate),
    actionMessage(actions.prepareMerge),
    actionMessage(actions.remove),
  ].filter((message): message is string => Boolean(message));

  const previewPending =
    actions.previewSourceUpdate.access === "available" &&
    actions.previewSourceUpdate.isPending === true;
  const applyPending =
    actions.applySourceUpdate.access === "available" &&
    actions.applySourceUpdate.isPending === true;
  const prepareMergePending =
    actions.prepareMerge.access === "available" && actions.prepareMerge.isPending === true;
  const applyMergePending =
    actions.applyMerge.access === "available" && actions.applyMerge.isPending === true;
  const backupPending = backupAction?.access === "available" && backupAction.isPending === true;
  const installPending = installAction?.access === "available" && installAction.isPending === true;
  const canInstall = skill.locations.some((location) => location.sourceKind === "cached");
  const canBackup = skill.locations.some((location) => location.sourceKind !== "cached");
  const groupedLocations = groupLocations(skill.locations);

  return (
    <div className="contents" data-skill-detail={skill.id}>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {groupedLocations.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Connected agents</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedLocations.map((location) => (
                <TableRow key={location.path}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-1">
                      <Badge className="w-fit" variant="secondary">
                        {location.label}
                      </Badge>
                      <span
                        className="max-w-80 truncate font-mono text-xs text-muted-foreground"
                        title={location.path}
                      >
                        {location.path}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <LocationConnections connections={location.connections} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {location.sourceKind ?? "installed"}
                  </TableCell>
                  <TableCell>
                    {location.lastUsedAt ? timeAgo(location.lastUsedAt) : "Never"}
                  </TableCell>
                  <TableCell>
                    {location.modifiedAt ? timeAgo(location.modifiedAt) : "Unknown"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {!sourceUpdate && previewPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Checking the upstream source...
          </div>
        ) : null}

        {sourceUpdate ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {sourceUpdate.status === "current"
                ? "This skill is current."
                : `${sourceUpdate.installedVersion ?? "Installed"} to ${sourceUpdate.latestVersion ?? "latest"}`}
            </p>
            {sourceUpdate.conflicts === 0 ? (
              <p className="text-xs text-muted-foreground">
                All {sourceUpdate.locations.length} tracked location
                {sourceUpdate.locations.length === 1 ? "" : "s"} match the recorded upstream
                revision.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-foreground">
                  Local changes were found in {sourceUpdate.conflicts} location
                  {sourceUpdate.conflicts === 1 ? "" : "s"}. Replacing from upstream preserves
                  backups in the update receipt.
                </p>
                {sourceUpdate.locations
                  .filter((location) => location.localState !== "clean")
                  .map((location) => (
                    <div
                      key={location.path}
                      className="flex items-start justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 break-all font-mono text-muted-foreground">
                        {location.path}
                      </span>
                      <Badge variant="warning" title={location.reason}>
                        Local changes
                      </Badge>
                    </div>
                  ))}
              </div>
            )}
            {sourceUpdate.diffs.map((diff) => (
              <UnifiedDiffViewer
                key={`${diff.title}:${diff.description ?? ""}`}
                title={diff.title}
                description={diff.description ?? undefined}
                diffText={diff.diff}
              />
            ))}
          </div>
        ) : null}

        {merge ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{merge.summary}</p>
            {merge.diffs.map((diff) => (
              <UnifiedDiffViewer
                key={`${diff.title}:${diff.description ?? ""}`}
                title={diff.title}
                description={diff.description ?? undefined}
                diffText={diff.diff}
              />
            ))}
          </div>
        ) : null}

        {updateReceipt ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3"
          >
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-medium text-foreground">
                Updated to {updateReceipt.installedVersion}
              </p>
              <p className="text-xs text-muted-foreground">
                Backup receipt {updateReceipt.receiptId} retained.
              </p>
            </div>
          </div>
        ) : null}

        {backupReceipt ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3"
          >
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-medium text-foreground">Backed up to SelfTune Cloud</p>
              <p className="text-xs text-muted-foreground">
                {backupReceipt.uploaded > 0
                  ? "This immutable revision is now available on your connected machines."
                  : "This revision was already backed up."}
              </p>
            </div>
          </div>
        ) : null}

        {installReceipt ? (
          <div
            role="status"
            className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-3"
          >
            <p className="text-sm font-medium text-foreground">
              Installed for {installReceipt.targetAgent}
            </p>
            <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
              {installReceipt.targetPath}
            </p>
          </div>
        ) : null}

        {removalDecision ? (
          <DurableDecisionCard
            decision={removalDecision}
            pending={
              actions.decideRemoval.access === "available" && actions.decideRemoval.isPending
            }
            onApprove={() => onDecideRemoval("approve")}
            onDecline={() => onDecideRemoval("decline")}
          />
        ) : null}

        {actionError || transferError ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words">{actionError ?? transferError}</p>
          </div>
        ) : null}
        {unavailableMessages.length > 0 ? (
          <p className="text-xs text-muted-foreground">{unavailableMessages.join(" ")}</p>
        ) : null}
      </div>

      <DialogFooter className="m-0 shrink-0 rounded-none">
        {canBackup && backupAction?.access === "available" ? (
          <Button
            variant="outline"
            disabled={backupPending}
            onClick={() => {
              setTransferError(null);
              void backupAction
                .execute(skill.id)
                .then(setBackupReceipt)
                .catch((error: unknown) =>
                  setTransferError(error instanceof Error ? error.message : String(error)),
                );
            }}
          >
            {backupPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <CloudUploadIcon data-icon="inline-start" />
            )}
            {backupPending ? "Backing up" : "Back up to Cloud"}
          </Button>
        ) : canBackup && backupAction?.access === "upgrade" ? (
          <Button variant="outline" onClick={() => setCloudBackupGateOpen(true)}>
            <CloudUploadIcon data-icon="inline-start" />
            Back up to Cloud
          </Button>
        ) : null}
        {canInstall && installAction?.access === "available" ? (
          <div className="flex items-center gap-2">
            <Select
              value={installAgent}
              onValueChange={(value) => setInstallAgent((value ?? "codex") as LibraryInstallAgent)}
            >
              <SelectTrigger aria-label="Install for agent" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(actions.installTargets ?? []).map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              disabled={installPending}
              onClick={() => {
                setTransferError(null);
                void installAction
                  .execute({ skillId: skill.id, targetAgent: installAgent })
                  .then(setInstallReceipt)
                  .catch((error: unknown) =>
                    setTransferError(error instanceof Error ? error.message : String(error)),
                  );
              }}
            >
              {installPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              {installPending ? "Installing" : "Install"}
            </Button>
          </div>
        ) : null}
        {actions.remove.access === "available" &&
        skill.locations.some((location) => location.removable) &&
        !removalDecision ? (
          <Button variant="destructive" className="sm:mr-auto" onClick={onRemove}>
            <Trash2Icon data-icon="inline-start" />
            Review removal
          </Button>
        ) : null}
        {skill.detailHref ? (
          <Button nativeButton={false} render={<a href={skill.detailHref} />} variant="outline">
            Open report
          </Button>
        ) : null}
        {actions.previewSourceUpdate.access === "available" && !sourceUpdate ? (
          <Button onClick={onPreviewUpdate} disabled={previewPending}>
            {previewPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {previewPending ? "Checking for updates" : "Review update"}
          </Button>
        ) : actions.previewSourceUpdate.access === "upgrade" ? (
          <Button nativeButton={false} render={<a href={actions.previewSourceUpdate.href} />}>
            Upgrade for source updates
          </Button>
        ) : null}
        {sourceUpdate?.status === "available" && sourceUpdate.conflicts === 0 ? (
          <Button onClick={onApplyUpdate} disabled={applyPending}>
            {applyPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {applyPending ? "Installing update" : "Install update"}
          </Button>
        ) : null}
        {sourceUpdate && sourceUpdate.conflicts > 0 && !merge ? (
          actions.prepareMerge.access === "available" ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-end justify-end gap-2">
              <label className="flex min-w-48 flex-col gap-1 text-xs text-muted-foreground">
                Merge connection
                <Select
                  value={mergeConnectionId}
                  onValueChange={(value) => setMergeConnectionId(value ?? "")}
                >
                  <SelectTrigger aria-label="Merge connection" className="w-full">
                    <SelectValue>
                      {selectedMergeConnection?.label ?? "Select connection"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {actions.mergeConnections.map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>
                          <ConnectionIdentity label={connection.label} icon={connection.icon} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              {selectedMergeConnection?.supportsModelOverride ? (
                <label className="flex min-w-48 flex-col gap-1 text-xs text-muted-foreground">
                  Model (optional)
                  <Input
                    value={mergeModel}
                    onChange={(event) => setMergeModel(event.target.value)}
                    placeholder="Use connection default"
                  />
                </label>
              ) : null}
              <Button
                disabled={!selectedMergeConnection || prepareMergePending}
                onClick={() =>
                  onPrepareMerge({
                    skillId: skill.id,
                    connectionId: mergeConnectionId,
                    model: mergeModel.trim() || null,
                  })
                }
              >
                {prepareMergePending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <GitMergeIcon data-icon="inline-start" />
                )}
                {prepareMergePending ? "Preparing merge" : "Prepare merge"}
              </Button>
            </div>
          ) : actions.prepareMerge.access === "upgrade" ? (
            <Button nativeButton={false} render={<a href={actions.prepareMerge.href} />}>
              Upgrade for agent merge
            </Button>
          ) : null
        ) : null}
        {merge ? (
          <Button onClick={onApplyMerge} disabled={applyMergePending}>
            {applyMergePending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {applyMergePending ? "Applying merged update" : "Apply merged update"}
          </Button>
        ) : null}
        {skill.restoreId && actions.restore.access === "available" ? (
          <Button variant="outline" onClick={onRestore}>
            <ArchiveRestoreIcon data-icon="inline-start" />
            Restore skill
          </Button>
        ) : null}
      </DialogFooter>
      {backupAction?.access === "upgrade" ? (
        <CloudFeatureGateDialog
          kind="skill-backup"
          open={cloudBackupGateOpen}
          onOpenChange={setCloudBackupGateOpen}
          upgradeHref={backupAction.href}
          context={{
            name: skill.name,
            detail: `${skill.locations.length} installed location${skill.locations.length === 1 ? "" : "s"}`,
          }}
        />
      ) : null}
    </div>
  );
}
