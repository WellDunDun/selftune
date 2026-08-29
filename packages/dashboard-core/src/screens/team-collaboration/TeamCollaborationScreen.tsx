"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileDiffIcon,
  LaptopIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";

import {
  useTeamCollaborationModule,
  type DashboardTeamCollaborationContribution,
} from "../../host";
import type {
  TeamContributionChangeModel,
  TeamCollaborationSnapshotModel,
  TeamManagedInstallationModel,
  TeamRevisionContributionModel,
  TeamRolloutPolicyModel,
} from "../../models";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  LoadingButton,
  PageHeader,
  PageScaffold,
  SkeletonSwap,
  SortableTable,
  type SortableColumn,
} from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";

const rolloutCopy = {
  manual: {
    label: "Ask first",
    detail: "Each person chooses when to install an update.",
  },
  notify: {
    label: "Notify people",
    detail: "Send a notification, then let each person choose.",
  },
  automatic: {
    label: "Update automatically",
    detail: "Update unchanged team copies during scheduled sync.",
  },
} satisfies Record<TeamRolloutPolicyModel, { label: string; detail: string }>;

const ROLLOUT_POLICIES = [
  "manual",
  "notify",
  "automatic",
] as const satisfies readonly TeamRolloutPolicyModel[];

function parseRolloutPolicy(value: string | null): TeamRolloutPolicyModel | null {
  switch (value) {
    case "manual":
    case "notify":
    case "automatic":
      return value;
    default:
      return null;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusVariant(status: TeamManagedInstallationModel["updateStatus"]) {
  if (status === "conflict" || status === "failed") return "destructive" as const;
  if (status === "update_available") return "warning" as const;
  if (status === "current" || status === "updated") return "secondary" as const;
  return "outline" as const;
}

function statusLabel(status: TeamManagedInstallationModel["updateStatus"]): string {
  const labels = {
    current: "Up to date",
    update_available: "Update available",
    updated: "Up to date",
    conflict: "Needs attention",
    failed: "Update failed",
    rolled_back: "Update undone",
  } satisfies Record<TeamManagedInstallationModel["updateStatus"], string>;
  return labels[status];
}

function contributionStatusLabel(status: TeamRevisionContributionModel["status"]): string {
  const labels = {
    pending: "Needs review",
    rejected: "Dismissed",
    adopted: "Accepted",
    stale: "Outdated",
    rolled_back: "Undone",
  } satisfies Record<TeamRevisionContributionModel["status"], string>;
  return labels[status];
}

function changeVariant(kind: TeamContributionChangeModel["kind"]) {
  if (kind === "removed") return "destructive" as const;
  if (kind === "added") return "secondary" as const;
  return "outline" as const;
}

function changeLabel(kind: TeamContributionChangeModel["kind"]): string {
  if (kind === "modified") return "Changed";
  if (kind === "removed") return "Removed";
  return "Added";
}

function CollaborationUnavailable({ reason }: { reason: string }) {
  return (
    <PageScaffold data-parity-root="team-collaboration">
      <PageHeader
        title="Team collaboration"
        description="Review team updates and choose how shared skills stay current."
      />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Team collaboration unavailable</EmptyTitle>
            <EmptyDescription>{reason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

function CollaborationLoading() {
  return (
    <PageScaffold aria-label="Loading team collaboration" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-[min(100%,36rem)]" />
      </div>
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </PageScaffold>
  );
}

function SharingNotice() {
  return (
    <details className="group rounded-lg border border-border/70 bg-muted/25 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-3 text-sm marker:hidden">
        <span className="rounded-md border bg-background p-2 text-muted-foreground">
          <ShieldCheckIcon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">About privacy and sharing</span>
          <span className="mt-0.5 block text-muted-foreground">
            See what information is included in a team update.
          </span>
        </span>
        <span className="text-xs font-medium text-muted-foreground group-open:hidden">
          Show details
        </span>
        <span className="hidden text-xs font-medium text-muted-foreground group-open:inline">
          Hide details
        </span>
      </summary>
      <div className="ml-11 mt-3 grid gap-3 border-t pt-3 text-sm leading-6 text-muted-foreground md:grid-cols-2">
        <p>
          When someone submits an update, teammates receive the skill files, version information,
          contributor name, and change summary.
        </p>
        <p>
          Raw prompts, transcripts, and usage content are not included. Optional usage signals are
          separate and stay off until enabled.
        </p>
      </div>
    </details>
  );
}

function SummaryStrip({
  pending,
  managed,
  conflicts,
  current,
}: {
  pending: number;
  managed: number;
  conflicts: number;
  current: number;
}) {
  const items = [
    { label: "Updates to review", value: pending, icon: FileDiffIcon },
    { label: "Team installs", value: managed, icon: LaptopIcon },
    { label: "Up to date", value: current, icon: CheckCircle2Icon },
    { label: "Need attention", value: conflicts, icon: AlertTriangleIcon },
  ];
  return (
    <section className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2 lg:grid-cols-4">
      {items.map(({ label, value, icon: Icon }, index) => (
        <div
          key={label}
          className={`flex items-center gap-3 p-4 ${index > 0 ? "border-t sm:border-t-0 sm:border-l" : ""} ${index === 2 ? "sm:border-l-0 lg:border-l" : ""}`}
        >
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-mono text-xl font-semibold tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

interface CandidateReviewProps {
  contribution: TeamRevisionContributionModel;
  rolloutPolicy: TeamRolloutPolicyModel;
  pendingAction: string | null;
  canAdopt: boolean;
  canReject: boolean;
  canRollback: boolean;
  onAdopt(): void;
  onReject(): void;
  onRollback(): void;
}

function CandidateReview({
  contribution,
  rolloutPolicy,
  pendingAction,
  canAdopt,
  canReject,
  canRollback,
  onAdopt,
  onReject,
  onRollback,
}: CandidateReviewProps) {
  const isPending = contribution.status === "pending";
  const efficacyEvidence = contribution.efficacyEvidence;
  return (
    <article className="border-t first:border-t-0" data-candidate-id={contribution.id}>
      <div className="space-y-4 px-5 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-foreground">{contribution.entryName}</h3>
              <Badge variant={isPending ? "warning" : "outline"}>
                {contributionStatusLabel(contribution.status)}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Suggested by {contribution.submittedByName} · {formatDate(contribution.createdAt)}
            </p>
          </div>
          {isPending ? (
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canReject || pendingAction !== null}
                onClick={onReject}
              >
                {pendingAction === `reject:${contribution.id}` ? "Dismissing…" : "Dismiss"}
              </Button>
              <Button size="sm" disabled={!canAdopt || pendingAction !== null} onClick={onAdopt}>
                {pendingAction === `adopt:${contribution.id}` ? "Accepting…" : "Accept update"}
              </Button>
            </div>
          ) : contribution.status === "adopted" ? (
            <div className="flex max-w-xs shrink-0 flex-col items-end gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={!canRollback || pendingAction !== null}
                onClick={onRollback}
              >
                {pendingAction === `rollback:${contribution.id}` ? "Undoing…" : "Undo update"}
              </Button>
              {rolloutPolicy === "automatic" ? (
                <p className="text-right text-xs leading-5 text-muted-foreground">
                  Team copies set to update automatically receive the previous version at their next
                  sync.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="max-w-3xl text-sm leading-6 text-foreground">{contribution.summary}</p>

        <dl className="grid gap-3 rounded-lg bg-muted/30 p-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">New version</dt>
            <dd className="mt-1 font-medium">{contribution.candidateVersion}</dd>
            <dd className="text-xs text-muted-foreground">Updates {contribution.baseVersion}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Files changed</dt>
            <dd className="mt-1 font-medium">{contribution.changes.length}</dd>
            <dd className="text-xs text-muted-foreground">
              {contribution.files.length} files in the shared skill
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Testing</dt>
            <dd className="mt-1">
              <Badge variant={efficacyEvidence ? "secondary" : "outline"}>
                {efficacyEvidence ? "Tested" : "Not tested"}
              </Badge>
            </dd>
          </div>
        </dl>

        <section
          aria-label={`Test results for ${contribution.entryName}`}
          className="rounded-lg border p-3"
        >
          <h4 className="text-sm font-medium">Test results</h4>
          {efficacyEvidence ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm leading-6 text-foreground">{efficacyEvidence.summary}</p>
              <p className="text-sm text-muted-foreground">
                {efficacyEvidence.passedCases} of {efficacyEvidence.evaluatedCases} test cases
                passed ·{" "}
                {efficacyEvidence.regressionCount === 0
                  ? "No regressions found"
                  : `${efficacyEvidence.regressionCount} regression${efficacyEvidence.regressionCount === 1 ? "" : "s"} found`}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              No test results were included. Review the changed files before accepting this update.
            </p>
          )}
        </section>

        <section
          className="rounded-lg border"
          aria-label={`Files changed in ${contribution.entryName}`}
        >
          <h4 className="border-b px-3 py-2.5 text-sm font-medium">Files changed</h4>
          {contribution.changes.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No file changes were reported for this update.
            </p>
          ) : (
            <ul className="divide-y" aria-label={`File changes for ${contribution.entryName}`}>
              {contribution.changes.map((change) => (
                <li
                  key={`${change.kind}:${change.path}`}
                  className="flex min-w-0 items-center gap-2 px-3 py-3"
                >
                  <Badge variant={changeVariant(change.kind)}>{changeLabel(change.kind)}</Badge>
                  <code className="truncate text-xs" title={change.path}>
                    {change.path}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="rounded-lg border border-dashed px-3 py-2.5 text-sm">
          <summary className="cursor-pointer font-medium text-muted-foreground">
            Technical details
          </summary>
          <div className="mt-3 space-y-4 border-t pt-3">
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Contributor ID</dt>
                <dd className="mt-1 break-all font-mono">{contribution.submittedBy}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Base version ID</dt>
                <dd className="mt-1 break-all font-mono">{contribution.baseVersionId}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Package SHA-256</dt>
                <dd className="mt-1 break-all font-mono">{contribution.candidateContentHash}</dd>
              </div>
            </dl>
            {contribution.changes.length > 0 ? (
              <ul className="space-y-3" aria-label={`File hashes for ${contribution.entryName}`}>
                {contribution.changes.map((change) => (
                  <li key={`hash:${change.kind}:${change.path}`} className="text-xs">
                    <p className="font-mono font-medium">{change.path}</p>
                    <dl className="mt-1 grid gap-2 text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt>Previous SHA-256</dt>
                        <dd className="mt-0.5 break-all font-mono">
                          {change.baseHash ?? "Not present"}
                        </dd>
                      </div>
                      <div>
                        <dt>New SHA-256</dt>
                        <dd className="mt-0.5 break-all font-mono text-foreground">
                          {change.candidateHash ?? "Not present"}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </div>
    </article>
  );
}

function TeamCollaborationAvailable({
  contribution,
}: {
  contribution: Extract<DashboardTeamCollaborationContribution, { access: "available" }>;
}) {
  const query = contribution.useSnapshot();
  const actions = contribution.useActions();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const snapshot = query.data;

  const summary = useMemo(() => {
    const installations = snapshot?.installations ?? [];
    return {
      pending: snapshot?.contributions.filter(({ status }) => status === "pending").length ?? 0,
      managed: installations.length,
      conflicts: installations.filter(({ updateStatus }) => updateStatus === "conflict").length,
      current: installations.filter(
        ({ updateStatus }) => updateStatus === "current" || updateStatus === "updated",
      ).length,
    };
  }, [snapshot]);

  const rolloutColumns: SortableColumn<TeamCollaborationSnapshotModel["entries"][number]>[] = [
    {
      id: "skill",
      header: "Skill",
      width: "minmax(14rem, 1.5fr)",
      value: (entry) => entry.name,
      cell: (entry) => (
        <div>
          <div className="font-medium">{entry.name}</div>
          <div className="text-xs text-muted-foreground">
            {entry.pendingContributions} to review · {entry.conflicts} need attention
          </div>
        </div>
      ),
    },
    {
      id: "published",
      header: "Shared version",
      width: "minmax(7rem, 0.7fr)",
      value: (entry) => entry.currentVersion ?? "Not published",
      cell: (entry) => (
        <span className="font-mono text-xs">{entry.currentVersion ?? "Not published"}</span>
      ),
    },
    {
      id: "fleet",
      header: "Installs",
      width: "minmax(5rem, 0.45fr)",
      value: (entry) => entry.installations,
      numeric: true,
      cell: (entry) => <span className="font-mono tabular-nums">{entry.installations}</span>,
    },
    {
      id: "policy",
      header: "Updates",
      width: "minmax(15rem, 1.2fr)",
      value: (entry) => rolloutCopy[entry.rolloutPolicy].label,
      cell: (entry) => {
        const actionKey = `policy:${entry.id}`;
        return (
          <Select
            value={entry.rolloutPolicy}
            disabled={actions.updateRolloutPolicy.access !== "available" || pendingAction !== null}
            onValueChange={(value) => {
              const action = actions.updateRolloutPolicy;
              const policy = parseRolloutPolicy(value);
              if (action.access !== "available" || !policy || policy === entry.rolloutPolicy)
                return;
              void runAction(actionKey, () =>
                action.execute({
                  entryId: entry.id,
                  policy,
                }),
              );
            }}
          >
            <SelectTrigger aria-label={`Update setting for ${entry.name}`} className="w-full">
              <SelectValue>
                {pendingAction === actionKey ? "Saving…" : rolloutCopy[entry.rolloutPolicy].label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ROLLOUT_POLICIES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  <span className="flex flex-col py-0.5">
                    <span>{rolloutCopy[policy].label}</span>
                    <span className="text-xs text-muted-foreground">
                      {rolloutCopy[policy].detail}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      },
    },
  ];

  if (query.isLoading && !snapshot) return <CollaborationLoading />;
  if (query.error && !snapshot) {
    return (
      <PageScaffold data-parity-root="team-collaboration">
        <PageHeader title="Team collaboration" />
        <Card role="alert">
          <CardHeader>
            <CardTitle>Team updates could not be loaded</CardTitle>
            <CardDescription>{query.error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void query.refresh()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </PageScaffold>
    );
  }
  if (!snapshot) return <CollaborationLoading />;

  async function runAction(key: string, operation: () => Promise<void>) {
    setPendingAction(key);
    setActionError(null);
    try {
      await operation();
      await query.refresh();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The team change could not be saved.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <PageScaffold data-parity-root="team-collaboration">
      <PageHeader
        title="Team collaboration"
        description="Review updates from teammates and choose how shared skills stay current."
        actions={
          <LoadingButton
            onAction={() => query.refresh()}
            pendingLabel="Refreshing…"
            successLabel="Refreshed"
            errorLabel="Retry"
            disabled={query.isLoading || pendingAction !== null}
          >
            Refresh
          </LoadingButton>
        }
      />

      <SkeletonSwap ready={!query.isLoading} reserve={112} label="Team summary">
        {query.isLoading ? null : <SummaryStrip {...summary} />}
      </SkeletonSwap>

      {query.error || actionError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {actionError ?? query.error}
        </div>
      ) : null}

      <section
        aria-labelledby="change-suggestions-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex flex-col gap-2 border-b px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="change-suggestions-heading" className="font-semibold">
              Updates from your team
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              See what changed, check any test results, and choose whether to accept the update.
            </p>
          </div>
          <Badge variant="outline">{summary.pending} to review</Badge>
        </div>
        {snapshot.contributions.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No updates to review</EmptyTitle>
              <EmptyDescription>
                New skill updates from your teammates will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          snapshot.contributions.map((item) => (
            <CandidateReview
              key={item.id}
              contribution={item}
              rolloutPolicy={
                snapshot.entries.find(({ id }) => id === item.entryId)?.rolloutPolicy ?? "manual"
              }
              pendingAction={pendingAction}
              canAdopt={actions.adoptContribution.access === "available"}
              canReject={actions.rejectContribution.access === "available"}
              canRollback={actions.rollbackContribution.access === "available"}
              onAdopt={() => {
                const action = actions.adoptContribution;
                if (action.access !== "available") return;
                void runAction(`adopt:${item.id}`, () => action.execute(item.id));
              }}
              onReject={() => {
                const action = actions.rejectContribution;
                if (action.access !== "available") return;
                void runAction(`reject:${item.id}`, () => action.execute(item.id));
              }}
              onRollback={() => {
                const action = actions.rollbackContribution;
                if (action.access !== "available") return;
                void runAction(`rollback:${item.id}`, () => action.execute(item.id));
              }}
            />
          ))
        )}
      </section>

      <section
        aria-labelledby="rollout-policies-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="border-b px-5 py-4">
          <h2 id="rollout-policies-heading" className="font-semibold">
            Update settings
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose how each shared skill reaches the people who use it.
          </p>
        </div>
        <SkeletonSwap ready={!query.isLoading} reserve={220} label="Update settings">
          {query.isLoading ? null : (
            <SortableTable
              rows={snapshot.entries}
              columns={rolloutColumns}
              getRowId={(entry) => entry.id}
              label="Update settings"
              defaultSort={{ columnId: "skill", direction: "asc" }}
              rowHeight={68}
              maxHeight={320}
              className="rounded-none border-0 shadow-none"
            />
          )}
        </SkeletonSwap>
        {snapshot.entries.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            Share a skill with your workspace before choosing how it should update.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="managed-installations-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <UsersIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
          <div>
            <h2 id="managed-installations-heading" className="font-semibold">
              Team installs
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              See which team copies are current. SelfTune never overwrites local changes
              automatically.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Skill / device</TableHead>
                <TableHead>Installed</TableHead>
                <TableHead>Available</TableHead>
                <TableHead>Updates</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.installations.map((installation) => (
                <TableRow key={installation.id}>
                  <TableCell>
                    <div className="font-medium">{installation.entryName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {installation.deviceId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{installation.installedVersion}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{installation.latestVersion}</div>
                  </TableCell>
                  <TableCell>{rolloutCopy[installation.rolloutPolicy].label}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(installation.updateStatus)}>
                      {statusLabel(installation.updateStatus)}
                    </Badge>
                    {installation.lastConflictAt ? (
                      <div className="mt-1 text-xs text-destructive">
                        Since {formatDate(installation.lastConflictAt)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <details className="max-w-56 text-xs">
                      <summary className="cursor-pointer font-medium text-muted-foreground">
                        View details
                      </summary>
                      <dl className="mt-2 space-y-2 text-muted-foreground">
                        <div>
                          <dt>Last checked</dt>
                          <dd className="mt-0.5 text-foreground">
                            {formatDate(installation.lastSyncedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt>Installed SHA-256</dt>
                          <dd className="mt-0.5 break-all font-mono text-[10px] text-foreground">
                            {installation.installedContentHash ?? "Not available"}
                          </dd>
                        </div>
                        <div>
                          <dt>Available SHA-256</dt>
                          <dd className="mt-0.5 break-all font-mono text-[10px] text-foreground">
                            {installation.latestContentHash}
                          </dd>
                        </div>
                        <div>
                          <dt>Update receipt</dt>
                          <dd className="mt-0.5 break-all font-mono text-[10px] text-foreground">
                            {installation.lastReceiptId ?? "Not available"}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {snapshot.installations.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            Team installs appear after someone installs a shared skill.
          </p>
        ) : null}
      </section>

      <SharingNotice />
    </PageScaffold>
  );
}

export function TeamCollaborationScreen() {
  const contribution = useTeamCollaborationModule().collaboration;
  if (!contribution) {
    return (
      <CollaborationUnavailable reason="This host has not connected team collaboration yet." />
    );
  }
  if (contribution.access === "upgrade") {
    return (
      <CollaborationUnavailable reason="Team collaboration requires a workspace plan with team sharing." />
    );
  }
  if (contribution.access === "unavailable") {
    return <CollaborationUnavailable reason={contribution.reason} />;
  }
  return <TeamCollaborationAvailable contribution={contribution} />;
}
