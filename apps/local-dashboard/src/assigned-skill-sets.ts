import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  DashboardAssignedSkillSetsActions,
  DashboardAssignedSkillSetsContribution,
} from "@selftune/dashboard-core/host";
import type {
  ProjectAssignedSkillSetInstallInput,
  ProjectAssignedSkillSetInstallPreviewModel,
  ProjectAssignedSkillSetInstallReceiptModel,
  ProjectAssignedSkillSetContributionPreviewModel,
  ProjectAssignedSkillSetContributionSendInput,
  ProjectAssignedSkillSetContributionSendReceiptModel,
  ProjectAssignedSkillSetModel,
  ProjectAssignedSkillSetRollbackInput,
  ProjectAssignedSkillSetRollbackReceiptModel,
} from "@selftune/dashboard-core/models";
import type { TeamAssignmentListItem } from "@selftune/runtime/team-assignment";
import type {
  TeamContributionPreview,
  TeamContributionPreviewInput,
} from "@selftune/runtime/team-contribution";

import { portfolioRequest } from "./dashboard-http";

const QUERY_KEY = ["assigned-skill-sets"] as const;

export function mapAssignedSkillSet(item: TeamAssignmentListItem): ProjectAssignedSkillSetModel {
  const base = {
    assignmentId: item.assignment.assignment_id,
    requestId: item.assignment.request_id,
    skillSetId: item.assignment.skill_set_id,
    releaseId: item.assignment.release_id,
    releaseName: item.assignment.name,
    description: item.assignment.description,
    releaseSequence: item.assignment.sequence,
    publisherName: item.assignment.publisher_name,
    assignedAt: new Date(item.assignment.assigned_at).toISOString(),
    skillSetRevisionSha256: item.assignment.skill_set_revision_sha256,
    envelopeSha256: item.assignment.envelope_sha256,
    canInstall: item.canInstall,
    canRollback: item.canRollback,
    syncStatus: item.syncStatus,
    contribution:
      item.localStatus === "current"
        ? {
            status: "local_only" as const,
            summary: "Review local edits before choosing whether to send them to your team.",
          }
        : undefined,
  };
  if (item.localStatus === "unknown" || item.localReceiptId === null) {
    return { ...base, status: "unknown", receiptId: null, failure: null };
  }
  if (item.localStatus === "failed") {
    const code = item.assignment.observed.failure_code ?? "INSTALL_FAILED";
    return {
      ...base,
      status: "failed",
      receiptId: item.localReceiptId,
      failure: {
        code,
        message: "This release was not installed.",
        guidance: "Review the local failure, then preview the assignment again.",
      },
    };
  }
  return {
    ...base,
    status: item.localStatus,
    receiptId: item.localReceiptId,
    failure: null,
  };
}

export function fetchAssignedSkillSets(): Promise<ReadonlyArray<TeamAssignmentListItem>> {
  return portfolioRequest("/api/v2/skill-sets/assignments");
}

export function previewAssignedSkillSet(
  assignmentId: string,
): Promise<ProjectAssignedSkillSetInstallPreviewModel> {
  return portfolioRequest(
    "/api/v2/skill-sets/assignments/preview",
    JSON.stringify({
      assignment_id: assignmentId,
    }),
  );
}

export function installAssignedSkillSet(
  input: ProjectAssignedSkillSetInstallInput,
): Promise<ProjectAssignedSkillSetInstallReceiptModel> {
  return portfolioRequest(
    "/api/v2/skill-sets/assignments/install",
    JSON.stringify({
      assignment_id: input.assignmentId,
      request_id: input.requestId,
      expected_release_id: input.expectedReleaseId,
      expected_skill_set_revision_sha256: input.expectedSkillSetRevisionSha256,
      expected_envelope_sha256: input.expectedEnvelopeSha256,
      confirm_install: input.confirmInstall,
    }),
  );
}

export function rollbackAssignedSkillSet(
  input: ProjectAssignedSkillSetRollbackInput,
): Promise<ProjectAssignedSkillSetRollbackReceiptModel> {
  return portfolioRequest(
    "/api/v2/skill-sets/assignments/undo",
    JSON.stringify({
      assignment_id: input.assignmentId,
      receipt_id: input.receiptId,
      confirm_rollback: input.confirmRollback,
    }),
  );
}

/** Local host seam for the contribution UI; canonical dashboard composition can adopt it separately. */
export function previewTeamContribution(
  input: TeamContributionPreviewInput,
): Promise<TeamContributionPreview> {
  return portfolioRequest(
    "/api/v2/skill-sets/contributions/preview",
    JSON.stringify({
      assignment_id: input.assignmentId,
      title: input.title,
      message: input.message,
      source_receipt_ids: input.sourceReceiptIds,
    }),
  );
}

export function submitTeamContribution(input: {
  readonly previewToken: string;
  readonly confirmSubmit: true;
}): Promise<{
  readonly requestId: string;
  readonly contributionId: string | null;
  readonly syncStatus: "pending" | "synced";
}> {
  return portfolioRequest(
    "/api/v2/skill-sets/contributions/submit",
    JSON.stringify({
      preview_token: input.previewToken,
      confirm_submit: input.confirmSubmit,
    }),
  );
}

export function syncTeamContributions() {
  return portfolioRequest("/api/v2/skill-sets/contributions/sync", JSON.stringify({}));
}

function mapContributionPreview(
  preview: TeamContributionPreview,
  assignment: TeamAssignmentListItem,
): ProjectAssignedSkillSetContributionPreviewModel {
  return {
    assignmentId: preview.assignmentId,
    requestId: preview.previewToken,
    skillSetId: assignment.assignment.skill_set_id,
    baseReleaseId: preview.baseReleaseId,
    baseReleaseSequence: assignment.assignment.sequence,
    title: `Proposed changes to ${assignment.assignment.name}`,
    message: "Review the local changes before sending this package to your team.",
    proposedSkillSetRevisionSha256: preview.proposedSkillSetRevisionSha256,
    proposedEnvelopeSha256: preview.proposedEnvelopeSha256,
    proposedByteLength: preview.byteLength,
    changes: preview.changes.flatMap((change) =>
      change.packagePaths.map((filePath) => ({
        componentName: change.componentName,
        filePath,
        changeType: change.changeType,
        summary: `${change.changeType === "modified" ? "Modified" : change.changeType === "added" ? "Added" : "Removed"} ${filePath}.`,
        exactDiff: "The exact review diff is derived by SelfTune Cloud after submission.",
      })),
    ),
  };
}

function useAssignments() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAssignedSkillSets,
  });
  return {
    data: query.data ? query.data.map(mapAssignedSkillSet) : null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}

function useActions(): DashboardAssignedSkillSetsActions {
  const queryClient = useQueryClient();
  const preview = useMutation({ mutationFn: previewAssignedSkillSet });
  const install = useMutation({
    mutationFn: installAssignedSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const rollback = useMutation({
    mutationFn: rollbackAssignedSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const contributionPreview = useMutation({
    mutationFn: async (assignmentId: string) => {
      const assignments =
        queryClient.getQueryData<ReadonlyArray<TeamAssignmentListItem>>(QUERY_KEY);
      const assignment = assignments?.find(
        (candidate) => candidate.assignment.assignment_id === assignmentId,
      );
      if (!assignment) throw new Error("Refresh assigned Skill Sets before previewing changes.");
      const preview = await previewTeamContribution({
        assignmentId,
        title: `Proposed changes to ${assignment.assignment.name}`,
        message: "Review the local changes before publishing a new release.",
      });
      return mapContributionPreview(preview, assignment);
    },
  });
  const contributionSend = useMutation({
    mutationFn: async (
      input: ProjectAssignedSkillSetContributionSendInput,
    ): Promise<ProjectAssignedSkillSetContributionSendReceiptModel> => {
      const receipt = await submitTeamContribution({
        previewToken: input.requestId,
        confirmSubmit: input.confirmShare,
      });
      return {
        contributionId: receipt.contributionId ?? receipt.requestId,
        requestId: receipt.requestId,
        status: receipt.syncStatus === "synced" ? "submitted" : "pending",
      };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  return {
    previewInstall: {
      access: "available",
      isPending: preview.isPending,
      error: preview.error instanceof Error ? preview.error.message : null,
      execute: (assignmentId) => preview.mutateAsync(assignmentId),
    },
    install: {
      access: "available",
      isPending: install.isPending,
      error: install.error instanceof Error ? install.error.message : null,
      execute: (input) => install.mutateAsync(input),
    },
    rollback: {
      access: "available",
      isPending: rollback.isPending,
      error: rollback.error instanceof Error ? rollback.error.message : null,
      execute: (input) => rollback.mutateAsync(input),
    },
    contribute: {
      preview: {
        access: "available",
        isPending: contributionPreview.isPending,
        error:
          contributionPreview.error instanceof Error ? contributionPreview.error.message : null,
        execute: (assignmentId) => contributionPreview.mutateAsync(assignmentId),
      },
      send: {
        access: "available",
        isPending: contributionSend.isPending,
        error: contributionSend.error instanceof Error ? contributionSend.error.message : null,
        execute: (input) => contributionSend.mutateAsync(input),
      },
    },
  };
}

export const LOCAL_ASSIGNED_SKILL_SETS: DashboardAssignedSkillSetsContribution = {
  access: "available",
  useAssignments,
  useActions,
};
