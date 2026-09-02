"use client";

import { useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, CircleAlertIcon, RotateCcwIcon } from "lucide-react";

import type {
  DashboardAssignedSkillSetsActions,
  DashboardAssignedSkillSetsContribution,
} from "../../host";
import type {
  ProjectAssignedSkillSetContributionPreviewModel,
  ProjectAssignedSkillSetInstallPreviewModel,
  ProjectAssignedSkillSetModel,
} from "../../models";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@selftune/ui/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@selftune/ui/primitives";

const STATUS_LABELS = {
  current: "Current",
  failed: "Failed",
  unknown: "Unknown",
  rolled_back: "Rolled back",
} as const;

function AssignmentStatus({ assignment }: { assignment: ProjectAssignedSkillSetModel }) {
  const pendingMessage =
    assignment.status === "rolled_back"
      ? "Undone locally; waiting to update Team status."
      : assignment.status === "failed"
        ? "Failed locally; waiting to update Team status."
        : "Installed locally; waiting to update Team status.";
  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Badge variant={assignment.status === "failed" ? "destructive" : "outline"}>
        {STATUS_LABELS[assignment.status]}
      </Badge>
      {assignment.status === "unknown" ? (
        <p className="max-w-sm text-xs text-muted-foreground sm:text-right">
          No installation receipt has been received from this device.
        </p>
      ) : null}
      {assignment.status === "current" ? (
        <p className="text-xs text-muted-foreground">This release is installed.</p>
      ) : null}
      {assignment.status === "rolled_back" ? (
        <p className="text-xs text-muted-foreground">This install was undone on this device.</p>
      ) : null}
      {assignment.syncStatus === "pending" ? (
        <p className="max-w-sm text-xs text-warning sm:text-right">{pendingMessage}</p>
      ) : null}
      {assignment.syncStatus === "failed" ? (
        <p className="max-w-sm text-xs text-destructive sm:text-right">
          Team status could not be updated. Reconnect and retry.
        </p>
      ) : null}
    </div>
  );
}

function TechnicalDetails({ assignment }: { assignment: ProjectAssignedSkillSetModel }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground">
        Technical details
      </summary>
      <dl className="mt-3 grid gap-2 break-all font-mono">
        <div>
          <dt className="font-sans font-medium text-foreground">Assignment ID</dt>
          <dd>{assignment.assignmentId}</dd>
        </div>
        {assignment.requestId ? (
          <div>
            <dt className="font-sans font-medium text-foreground">Request ID</dt>
            <dd>{assignment.requestId}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-sans font-medium text-foreground">Release ID</dt>
          <dd>{assignment.releaseId}</dd>
        </div>
        {assignment.receiptId ? (
          <div>
            <dt className="font-sans font-medium text-foreground">Receipt ID</dt>
            <dd>{assignment.receiptId}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-sans font-medium text-foreground">Skill Set revision</dt>
          <dd>{assignment.skillSetRevisionSha256}</dd>
        </div>
        <div>
          <dt className="font-sans font-medium text-foreground">Package hash</dt>
          <dd>{assignment.envelopeSha256}</dd>
        </div>
      </dl>
    </details>
  );
}

function ContributionControls({
  assignment,
  actions,
  onChanged,
}: {
  assignment: ProjectAssignedSkillSetModel;
  actions: DashboardAssignedSkillSetsActions;
  onChanged(): void | Promise<void>;
}) {
  const contribution = assignment.contribution;
  const contributionActions = actions.contribute;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [preview, setPreview] = useState<ProjectAssignedSkillSetContributionPreviewModel | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!contribution || !contributionActions) return null;

  const availableContributionActions = contributionActions;
  const canPreview = availableContributionActions.preview.access === "available";
  const canSend = availableContributionActions.send.access === "available";

  async function openPreview() {
    if (availableContributionActions.preview.access !== "available") return;
    setPreviewOpen(true);
    setPreview(null);
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await availableContributionActions.preview.execute(assignment.assignmentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreviewing(false);
    }
  }

  async function sendContribution() {
    if (!preview || availableContributionActions.send.access !== "available") return;
    setSending(true);
    setError(null);
    try {
      await availableContributionActions.send.execute({
        assignmentId: preview.assignmentId,
        requestId: preview.requestId,
        expectedBaseReleaseId: preview.baseReleaseId,
        expectedSkillSetRevisionSha256: preview.proposedSkillSetRevisionSha256,
        expectedEnvelopeSha256: preview.proposedEnvelopeSha256,
        confirmShare: true,
      });
      setConfirmationOpen(false);
      setPreviewOpen(false);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Your proposed changes</p>
          <p className="mt-1 text-sm text-muted-foreground">{contribution.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            SelfTune never submits local changes automatically.
          </p>
        </div>
        <Badge variant={contribution.status === "failed" ? "destructive" : "outline"}>
          {contribution.status === "local_only"
            ? "Local only"
            : contribution.status === "offline"
              ? "Offline"
              : contribution.status === "pending"
                ? "Pending"
                : "Failed"}
        </Badge>
      </div>
      {canPreview ? (
        <div>
          <Button variant="outline" onClick={() => void openPreview()}>
            Preview contribution
          </Button>
        </div>
      ) : null}

      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) {
            setPreview(null);
            setError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview contribution</DialogTitle>
            <DialogDescription>
              Compare your local proposal with Release {assignment.releaseSequence}. Nothing has
              left this device.
            </DialogDescription>
          </DialogHeader>

          {previewing ? (
            <div aria-label="Preparing contribution preview" aria-busy="true">
              <Skeleton className="h-32 w-full" />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {preview ? <ContributionPreview preview={preview} /> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Cancel
            </Button>
            {preview ? (
              <Button disabled={!canSend || sending} onClick={() => setConfirmationOpen(true)}>
                Send for review
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send this contribution for review?</DialogTitle>
            <DialogDescription>
              This uploads the proposed Skill Set package to your workspace. Local paths, sessions,
              and prompts are not included.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmationOpen(false)}>
              Cancel
            </Button>
            <Button disabled={sending} onClick={() => void sendContribution()}>
              {sending ? "Sending…" : "Send package"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContributionPreview({
  preview,
}: {
  preview: ProjectAssignedSkillSetContributionPreviewModel;
}) {
  return (
    <div className="grid gap-4">
      <div className="rounded-md bg-muted p-3 text-sm">
        <p className="font-medium">Nothing has left this device.</p>
        <p className="mt-1 text-muted-foreground">
          Send for review uploads the proposed Skill Set package. It does not upload local paths,
          prompts, or sessions.
        </p>
      </div>
      <div>
        <h3 className="font-medium">{preview.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{preview.message}</p>
      </div>
      <div className="divide-y rounded-lg border">
        {preview.changes.map((change) => (
          <div
            key={`${change.componentName}:${change.changeType}`}
            className="grid gap-1 p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{change.componentName}</span>
              <Badge variant="outline">{change.changeType}</Badge>
            </div>
            <p className="text-muted-foreground">{change.summary}</p>
            <p className="break-all font-mono text-xs text-muted-foreground">{change.filePath}</p>
          </div>
        ))}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          Technical details
        </summary>
        <div className="mt-3 grid gap-3">
          <dl className="grid gap-2 break-all font-mono">
            <div>
              <dt className="font-sans font-medium text-foreground">Contribution request ID</dt>
              <dd>{preview.requestId}</dd>
            </div>
            <div>
              <dt className="font-sans font-medium text-foreground">Proposed revision</dt>
              <dd>{preview.proposedSkillSetRevisionSha256}</dd>
            </div>
            <div>
              <dt className="font-sans font-medium text-foreground">Proposed package hash</dt>
              <dd>{preview.proposedEnvelopeSha256}</dd>
            </div>
          </dl>
          {preview.changes.map((change) => (
            <pre
              key={`${change.componentName}:exact-diff`}
              className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono"
            >
              {change.exactDiff}
            </pre>
          ))}
        </div>
      </details>
    </div>
  );
}

function AssignmentCard({
  assignment,
  actions,
  onChanged,
}: {
  assignment: ProjectAssignedSkillSetModel;
  actions: DashboardAssignedSkillSetsActions;
  onChanged(): void | Promise<void>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<ProjectAssignedSkillSetInstallPreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const canReviewInstall =
    assignment.canInstall &&
    actions.previewInstall.access === "available" &&
    actions.install.access === "available";
  const canUndoInstall = Boolean(
    assignment.canRollback && assignment.receiptId && actions.rollback.access === "available",
  );

  async function openReview() {
    if (actions.previewInstall.access !== "available") return;
    setReviewOpen(true);
    setPreview(null);
    setInstallError(null);
    setPreviewLoading(true);
    try {
      setPreview(await actions.previewInstall.execute(assignment.assignmentId));
    } catch (cause) {
      setInstallError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function installReviewedRelease() {
    if (!preview || actions.install.access !== "available") return;
    setInstalling(true);
    setInstallError(null);
    try {
      await actions.install.execute({
        assignmentId: preview.assignmentId,
        requestId: preview.requestId,
        expectedReleaseId: preview.releaseId,
        expectedSkillSetRevisionSha256: preview.skillSetRevisionSha256,
        expectedEnvelopeSha256: preview.envelopeSha256,
        confirmInstall: true,
      });
      setReviewOpen(false);
      await onChanged();
    } catch (cause) {
      setInstallError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  }

  async function rollbackInstall() {
    if (!assignment.receiptId || actions.rollback.access !== "available") return;
    setRollingBack(true);
    setRollbackError(null);
    try {
      await actions.rollback.execute({
        assignmentId: assignment.assignmentId,
        receiptId: assignment.receiptId,
        confirmRollback: true,
      });
      setRollbackOpen(false);
      await onChanged();
    } catch (cause) {
      setRollbackError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRollingBack(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate">{assignment.releaseName}</CardTitle>
            <CardDescription>
              Release {assignment.releaseSequence} ·{" "}
              {assignment.publisherName
                ? `Published by ${assignment.publisherName}`
                : "Publisher not provided"}
            </CardDescription>
          </div>
          <AssignmentStatus assignment={assignment} />
        </CardHeader>
        <CardContent className="grid gap-4">
          {assignment.description ? (
            <p className="text-sm text-muted-foreground">{assignment.description}</p>
          ) : null}
          {assignment.status === "failed" ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="grid gap-1 text-sm">
                  <p className="font-medium">{assignment.failure.message}</p>
                  <p className="text-muted-foreground">{assignment.failure.guidance}</p>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canReviewInstall ? (
              <Button onClick={() => void openReview()}>
                <CheckCircle2Icon data-icon="inline-start" /> Review install
              </Button>
            ) : null}
            {canUndoInstall ? (
              <Button
                variant="outline"
                onClick={() => {
                  setRollbackError(null);
                  setRollbackOpen(true);
                }}
              >
                <RotateCcwIcon data-icon="inline-start" /> Undo install
              </Button>
            ) : null}
          </div>
          <ContributionControls assignment={assignment} actions={actions} onChanged={onChanged} />
          <TechnicalDetails assignment={assignment} />
        </CardContent>
      </Card>

      {canReviewInstall ? (
        <Dialog
          open={reviewOpen}
          onOpenChange={(open) => {
            setReviewOpen(open);
            if (!open) {
              setPreview(null);
              setInstallError(null);
            }
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review {assignment.releaseName}</DialogTitle>
              <DialogDescription>
                Release {assignment.releaseSequence} ·{" "}
                {assignment.publisherName
                  ? `Published by ${assignment.publisherName}`
                  : "Publisher not provided"}
                . Nothing is installed until you choose Install.
              </DialogDescription>
            </DialogHeader>

            {previewLoading ? (
              <div className="grid gap-3" aria-label="Preparing install review" aria-busy="true">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : null}

            {installError ? (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                role="alert"
              >
                <p className="font-medium">Install review could not be completed</p>
                <p className="mt-1 text-sm text-muted-foreground">{installError}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Nothing was installed. Close this review and try again.
                </p>
              </div>
            ) : null}

            {preview ? <InstallPreview preview={preview} /> : null}

            <DialogFooter>
              <Button variant="outline" onClick={() => setReviewOpen(false)}>
                Cancel
              </Button>
              {preview ? (
                <Button
                  disabled={
                    preview.conflicts.some((conflict) => conflict.blocking) ||
                    preview.checks.some((check) => check.status === "blocked") ||
                    installing ||
                    (actions.install.access === "available" && Boolean(actions.install.isPending))
                  }
                  onClick={() => void installReviewedRelease()}
                >
                  {installing ||
                  (actions.install.access === "available" && actions.install.isPending)
                    ? "Installing…"
                    : "Install"}
                </Button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {canUndoInstall ? (
        <Dialog open={rollbackOpen} onOpenChange={setRollbackOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Undo this install?</DialogTitle>
              <DialogDescription>
                The team assignment stays in place. Only this device is restored.
              </DialogDescription>
            </DialogHeader>
            {rollbackError ? (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                role="alert"
              >
                <p className="font-medium">The install could not be undone</p>
                <p className="mt-1 text-sm text-muted-foreground">{rollbackError}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  The current installation was left unchanged.
                </p>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRollbackOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  rollingBack ||
                  (actions.rollback.access === "available" && Boolean(actions.rollback.isPending))
                }
                onClick={() => void rollbackInstall()}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {rollingBack ||
                (actions.rollback.access === "available" && actions.rollback.isPending)
                  ? "Undoing…"
                  : "Undo install"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function InstallPreview({ preview }: { preview: ProjectAssignedSkillSetInstallPreviewModel }) {
  const packagePaths = [
    ...new Set([
      ...preview.skills.flatMap((skill) => skill.packagePaths),
      ...preview.conflicts.flatMap((conflict) =>
        conflict.packagePath ? [conflict.packagePath] : [],
      ),
    ]),
  ];

  return (
    <div className="grid gap-5">
      <p className="rounded-md bg-muted px-3 py-2 text-sm">
        <span className="block font-medium">This installs only on this device.</span>
        <span className="block font-medium">
          Destination: {preview.scope === "global" ? "All projects" : "The selected project"} on
          this computer
        </span>
        <span className="block text-muted-foreground">
          It does not publish, share, or reassign the release.
        </span>
      </p>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Skills and licenses</h3>
        {preview.skills.length ? (
          <div className="divide-y rounded-lg border">
            {preview.skills.map((skill) => (
              <div
                key={`${skill.name}:${skill.revisionSha256}`}
                className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
              >
                <span className="font-medium">{skill.name}</span>
                <span className="text-muted-foreground">{skill.licenseExpression} license</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No skills are listed for this release.</p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Tools</h3>
        {preview.tools.length ? (
          <div className="flex flex-wrap gap-2">
            {preview.tools.map((tool) => (
              <Badge key={tool} variant="outline">
                {toolLabel(tool)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No target tools are listed.</p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Checks</h3>
        {preview.checks.length ? (
          <div className="grid gap-2">
            {preview.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-2 rounded-lg border p-3 text-sm">
                {check.status === "passed" ? (
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                )}
                <div className="grid gap-0.5">
                  <p className="font-medium">{check.title}</p>
                  <p className="text-muted-foreground">{check.detail}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No checks were recorded.</p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Conflicts</h3>
        {preview.conflicts.length ? (
          <div className="grid gap-2">
            {preview.conflicts.map((conflict) => (
              <div
                key={`${conflict.code}:${conflict.title}`}
                className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="grid gap-0.5">
                    <p className="font-medium">{conflict.title}</p>
                    <p className="text-muted-foreground">{conflict.detail}</p>
                    {conflict.blocking ? (
                      <p className="font-medium text-warning">Resolve this before installing.</p>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No conflicts found.</p>
        )}
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          Technical details
        </summary>
        <dl className="mt-3 grid gap-2 break-all font-mono">
          <div>
            <dt className="font-sans font-medium text-foreground">Assignment ID</dt>
            <dd>{preview.assignmentId}</dd>
          </div>
          <div>
            <dt className="font-sans font-medium text-foreground">Install request ID</dt>
            <dd>{preview.requestId}</dd>
          </div>
          <div>
            <dt className="font-sans font-medium text-foreground">Release ID</dt>
            <dd>{preview.releaseId}</dd>
          </div>
          <div>
            <dt className="font-sans font-medium text-foreground">Skill Set revision</dt>
            <dd>{preview.skillSetRevisionSha256}</dd>
          </div>
          <div>
            <dt className="font-sans font-medium text-foreground">Package hash</dt>
            <dd>{preview.envelopeSha256}</dd>
          </div>
          {preview.skills.map((skill) => (
            <div key={`${skill.name}:revision`}>
              <dt className="font-sans font-medium text-foreground">{skill.name} revision</dt>
              <dd>{skill.revisionSha256}</dd>
            </div>
          ))}
          {packagePaths.length ? (
            <div>
              <dt className="font-sans font-medium text-foreground">Package paths</dt>
              {packagePaths.map((path) => (
                <dd key={path}>{path}</dd>
              ))}
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  );
}

function toolLabel(tool: string): string {
  if (tool === "codex") return "Codex";
  if (tool === "claude_code") return "Claude Code";
  if (tool === "opencode") return "OpenCode";
  if (tool === "openclaw") return "OpenClaw";
  if (tool === "pi") return "Pi";
  return tool;
}

function AvailableAssignedSkillSets({
  contribution,
}: {
  contribution: DashboardAssignedSkillSetsContribution & { access: "available" };
}) {
  const assignments = contribution.useAssignments();
  const actions = contribution.useActions();

  if (assignments.isLoading) {
    return (
      <section className="grid gap-4" aria-label="Assigned to this device" aria-busy="true">
        <AssignedSkillSetsHeader />
        <Skeleton className="h-48 w-full" />
      </section>
    );
  }

  return (
    <section className="grid gap-4" aria-labelledby="assigned-skill-sets-title">
      <AssignedSkillSetsHeader />
      {assignments.error ? (
        <Card role="alert">
          <CardHeader>
            <CardTitle>Assignments could not be loaded</CardTitle>
            <CardDescription>{assignments.error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void assignments.refresh()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : assignments.data?.length ? (
        <div className="grid gap-4">
          {assignments.data.map((assignment) => (
            <AssignmentCard
              key={assignment.assignmentId}
              assignment={assignment}
              actions={actions}
              onChanged={assignments.refresh}
            />
          ))}
        </div>
      ) : (
        <Card className="bg-transparent">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No assignments for this device</EmptyTitle>
              <EmptyDescription>
                Team assignments for this device will appear here before anything is installed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Card>
      )}
    </section>
  );
}

function AssignedSkillSetsHeader() {
  return (
    <div className="grid gap-1">
      <h2 id="assigned-skill-sets-title" className="text-lg font-semibold tracking-tight">
        Assigned to this device
      </h2>
      <p className="text-sm text-muted-foreground">
        Review team releases here. Publishing, sharing, and assigning do not install them.
      </p>
    </div>
  );
}

export function AssignedSkillSets({
  contribution,
}: {
  contribution: DashboardAssignedSkillSetsContribution;
}) {
  if (contribution.access === "available") {
    return <AvailableAssignedSkillSets contribution={contribution} />;
  }

  return (
    <section className="grid gap-4" aria-labelledby="assigned-skill-sets-title">
      <AssignedSkillSetsHeader />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Assignments unavailable</EmptyTitle>
            <EmptyDescription>{contribution.reason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    </section>
  );
}
