// oxlint-disable max-lines -- Host capability composition is intentionally centralized here.
import {
  capabilitiesFromModule,
  type DashboardLibraryActions,
  type DashboardHostModules,
  type DashboardHostKind,
  type DashboardPluginsActions,
  type DashboardDecisionsActions,
  type DashboardProjectsActions,
  type DashboardTeamCollaborationActions,
  type ServerProfileController,
} from "@selftune/dashboard-core/host";
import type {
  DashboardDecisionModel,
  PluginInventoryModel,
  ProjectPlanModel,
  ProjectConnectionId,
  ProjectProvisionInput,
  ProjectReceiptModel,
  ProjectsInventoryModel,
  ProjectSkillSetInput,
  ProjectSkillSetModel,
  ProjectSkillSetTargetInput,
  ProjectSkillSetUpdateInput,
  TeamCollaborationSnapshotModel,
  TeamRolloutPolicyModel,
} from "@selftune/dashboard-core/models";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { fetchAnalytics } from "./api";
import { useManagePlugin, usePlugins } from "./hooks/usePlugins";
import {
  useApplySkillSourceMerge,
  useApplyLibrarySkillLicense,
  useApplySkillSourceUpdate,
  useLibrary,
  usePrepareSkillSourceMerge,
  usePreviewSkillSourceUpdate,
  usePreviewLibrarySkillLicense,
} from "./hooks/useLibrary";
import {
  useBulkQuarantinePortfolioSkills,
  usePortfolio,
  useQuarantinePortfolioSkill,
  useRestorePortfolioSkill,
} from "./hooks/usePortfolio";
import {
  useDecideDurableDecision,
  useDurableDecisions,
  usePrepareProjectConflictDecision,
  usePrepareSkillConsolidationDecision,
  usePrepareSkillRemovalDecision,
  useRollbackDurableDecision,
} from "./hooks/useDecisions";
import { recommendLibraryConsolidation } from "@selftune/control-plane/library-consolidation";
import {
  useApplySkillSet,
  useApplyProjectProvision,
  useCreateSkillSet,
  useDeleteSkillSet,
  useDeriveSkillSet,
  useExportSkillSetPlugin,
  useImportSkillSetPack,
  useInstallSkillSetPlugin,
  usePreviewSkillSet,
  usePreviewSkillSetPublish,
  usePreviewSkillSetPluginInstall,
  usePreviewSkillSetPack,
  useRevokeSkillSetPack,
  usePublishSkillSet,
  useSkillSetPacks,
  usePreviewProjectProvision,
  useRollbackSkillSet,
  useShareSkillSet,
  useSkillSets,
  useUpdateSkillSet,
} from "./hooks/useSkillSets";
import {
  useReviewSkillSetSuggestion,
  useSkillIntelligence,
  usePrepareTraceCandidate,
  useUpdateSkillClassification,
} from "./hooks/useSkillIntelligence";
import { fetchTraceCandidateTargets, submitTraceCandidateTarget } from "./api";
import {
  useSettings,
  useUpdateWorkspaceSkillSetPolicy,
  useWorkspaceMembers,
} from "./hooks/useSettings";
import { useLocalLibraryTransferActions } from "./local-library-transfer-actions";
import { LOCAL_ASSIGNED_SKILL_SETS } from "./assigned-skill-sets";
import {
  localSkillSetSuggestionReviewInput,
  useLocalProjectsIntelligence,
} from "./project-skill-intelligence";
import { projectCaptureCandidatesFromLibrary } from "./project-capture-candidates";
import { projectSkillOptionsFromLibrary } from "./project-skill-options";
import {
  MANAGED_CLOUD_SHARE_CAPABILITIES,
  remoteLibraryDestination,
  SELF_HOSTED_SHARE_CAPABILITIES,
} from "./remote-library-capabilities";
import {
  connectionDisplayName,
  connectionNames,
  isLocalSkillCategoryId,
  localMergeConnections,
  mapLocalLibraryInventory,
  resolveLocalMergeRequest,
} from "./local-library-model";
import type {
  ApplySkillSetRequest,
  DurableDashboardDecision,
  SkillSetManifest,
  SkillSetPlan,
  SkillSetReceipt,
  SkillSetRemoteApplyResult,
  SkillSetsResponse,
  CreateSkillSetRequest,
  UpdateSkillSetRequest,
} from "./types";

export function mapDurableDecision(decision: DurableDashboardDecision): DashboardDecisionModel {
  const common = {
    id: decision.approval_id,
    status: decision.status,
    createdAt: decision.created_at,
    updatedAt: decision.updated_at,
    expiresAt: decision.expires_at,
    decidedAt: decision.decided_at,
    failure: decision.failure,
    audit: decision.audit.map((entry) => ({ ...entry })),
    hasRecoveryReceipt: decision.receipt !== null,
  };
  if (decision.requested_action === "apply_source_merge") {
    return {
      ...common,
      kind: "source_merge",
      title: `Merge update for ${decision.skill_name}`,
      summary: `Review ${decision.targets.length} target${decision.targets.length === 1 ? "" : "s"} from ${decision.source}.`,
      skillName: decision.skill_name,
      source: decision.source,
      connection: decision.harness_id,
      model: decision.model,
      installedHash: decision.installed_hash,
      latestHash: decision.latest_hash,
      targets: decision.targets.map((target) => ({
        path: target.target_path,
        conflicts: [...target.conflict_files],
        summary: target.summary,
        mergedDiff: target.merged_diff,
      })),
    };
  }
  if (decision.requested_action === "quarantine_skill") {
    return {
      ...common,
      kind: "skill_removal",
      title: `Remove ${decision.skill_name}`,
      summary: `${decision.locations.length} installed location${decision.locations.length === 1 ? "" : "s"} will move to recoverable quarantine.`,
      skillName: decision.skill_name,
      locations: decision.locations.map((location) => ({
        connection: location.connection,
        originalPackagePath: location.original_package_path,
        originalSkillPath: location.original_skill_path,
        archiveDestination: location.archive_destination,
        packageVersionHash: location.package_version_hash,
        quarantineId: location.quarantine_id,
        recovery: location.recovery,
      })),
    };
  }
  if (decision.requested_action === "consolidate_skill_installations") {
    const projectTargets = decision.targets.filter(
      (target) => target.action === "replace_with_link",
    ).length;
    return {
      ...common,
      kind: "skill_consolidation",
      title: `Consolidate ${decision.skill_name}`,
      summary: `Archive ${decision.targets.length} displaced installation${decision.targets.length === 1 ? "" : "s"} and replace ${projectTargets} project cop${projectTargets === 1 ? "y" : "ies"} with managed Library links.`,
      skillName: decision.skill_name,
      canonicalContentHash: decision.canonical.content_hash,
      canonicalPackagePath: decision.canonical.library_package_path,
      targets: decision.targets.map((target) => ({
        action: target.action,
        connection: target.harness,
        projectRoot: target.project_root,
        originalPackagePath: target.original_package_path,
        originalContentHash: target.original_content_hash,
        archiveDestination: target.archive_destination,
      })),
      recoveryStatus: decision.receipt?.status ?? null,
    };
  }
  return {
    ...common,
    kind: "skill_set_conflict",
    title: `Replace conflicts for ${decision.skill_set_name}`,
    summary: `${decision.conflicts} conflicting project path${decision.conflicts === 1 ? "" : "s"} will be archived before replacement.`,
    skillSetId: decision.skill_set_id,
    projectRoot: decision.project_root,
    creates: decision.creates,
    unchanged: decision.unchanged,
    conflicts: decision.conflicts,
    impacts: decision.impacts.map((impact) => ({
      connection: impact.harness,
      skillName: impact.skill_name,
      targetPath: impact.target_path,
      replacementSourcePath: impact.replacement_source_path,
      currentFingerprint: impact.current_fingerprint,
      replacementFingerprint: impact.replacement_fingerprint,
      backupPath: impact.backup_path,
      rollback: impact.rollback,
    })),
    recoveryStatus: decision.receipt?.status ?? null,
  };
}

const LOCAL_FEATURES: DashboardHostModules["capability"]["features"] = {
  analytics: { access: "available" },
  registry: { access: "upgrade", href: "https://selftune.dev" },
  signals: { access: "upgrade", href: "https://selftune.dev" },
  proposals: { access: "upgrade", href: "https://selftune.dev" },
  runtimeStatus: { access: "available" },
};

function useLocalLibraryInventory() {
  const query = useLibrary();
  const intelligence = useSkillIntelligence();
  const portfolio = usePortfolio();
  const settings = useSettings();
  const analytics = useQuery({
    queryKey: ["analytics"],
    queryFn: fetchAnalytics,
    staleTime: 30_000,
  });
  const data = query.data
    ? mapLocalLibraryInventory(
        query.data,
        intelligence.data ?? null,
        portfolio.data ?? null,
        settings.data?.harnesses ?? [],
        analytics.data ?? null,
      )
    : null;

  return {
    data,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await Promise.all([
        query.refetch(),
        intelligence.refetch(),
        portfolio.refetch(),
        analytics.refetch(),
      ]);
    },
  };
}

function useLocalLibraryActions(): DashboardLibraryActions {
  const library = useLibrary();
  const intelligence = useSkillIntelligence();
  const settings = useSettings();
  const updateCategory = useUpdateSkillClassification();
  const transfer = useLocalLibraryTransferActions();
  const preview = usePreviewSkillSourceUpdate();
  const previewLicense = usePreviewLibrarySkillLicense();
  const applyLicense = useApplyLibrarySkillLicense();
  const apply = useApplySkillSourceUpdate();
  const prepare = usePrepareSkillSourceMerge();
  const applyMerge = useApplySkillSourceMerge();
  const prepareConsolidation = usePrepareSkillConsolidationDecision();
  const prepareRemoval = usePrepareSkillRemovalDecision();
  const decideDecision = useDecideDurableDecision();
  const archiveSkill = useQuarantinePortfolioSkill();
  const archiveSkills = useBulkQuarantinePortfolioSkills();
  const restoreSkill = useRestorePortfolioSkill();
  const harnesses = settings.data?.harnesses ?? [];
  const names = connectionNames(harnesses);

  return {
    previewLicenseDraft: {
      access: "available",
      isPending: previewLicense.isPending,
      execute: (input) => previewLicense.mutateAsync(input),
    },
    applyLicenseDraft: {
      access: "available",
      isPending: applyLicense.isPending,
      execute: (input) => applyLicense.mutateAsync(input),
    },
    updateCategory: {
      access: "available",
      isPending: updateCategory.isPending,
      async execute(input) {
        const classification = intelligence.data?.classifications.find(
          (candidate) => candidate.skill_id === input.skillId,
        );
        if (!classification) throw new Error("Refresh classifications and try again.");
        if (input.categoryId !== null && !isLocalSkillCategoryId(input.categoryId)) {
          throw new Error("Choose a recognized skill category.");
        }
        await updateCategory.mutateAsync({
          skill_id: input.skillId,
          skill_name: input.skillName,
          category: input.categoryId,
          inferred_category: classification.inferred_category,
          reason: input.categoryId === null ? null : "Assigned from the shared Skills Library.",
        });
      },
    },
    openLocation: {
      access: "available",
      async execute(path) {
        const openFolder = window.selftuneDesktop?.openFolder;
        if (openFolder) {
          await openFolder(path);
          return;
        }
        if (!navigator.clipboard) throw new Error("Folder access is unavailable in this host.");
        await navigator.clipboard.writeText(path);
      },
    },
    ...transfer,
    previewSourceUpdate: {
      access: "available",
      isPending: preview.isPending,
      async execute(skillId) {
        const result = await preview.mutateAsync(skillId);
        return {
          status: result.status === "current" ? "current" : "available",
          installedVersion: result.installed_hash.slice(0, 10),
          latestVersion: result.latest_hash.slice(0, 10),
          conflicts: result.conflicts,
          locations: result.locations.map((location) => ({
            path: location.package_path,
            canonicalTarget: location.canonical_target,
            localState: location.local_state,
            reason: location.reason,
          })),
          diffs: [
            ...(result.upstream_diff
              ? [
                  {
                    title: "Upstream changes",
                    description: "Recorded base compared with the latest source revision.",
                    diff: result.upstream_diff,
                  },
                ]
              : []),
            ...result.locations.flatMap((location) =>
              location.local_diff
                ? [
                    {
                      title: "Local changes",
                      description: location.canonical_target,
                      diff: location.local_diff,
                    },
                  ]
                : [],
            ),
          ],
        };
      },
    },
    applySourceUpdate: {
      access: "available",
      isPending: apply.isPending,
      async execute(skillId) {
        const result = await apply.mutateAsync({
          skillName: skillId,
          strategy: preview.data && preview.data.conflicts > 0 ? "take_upstream" : "abort",
        });
        return {
          installedVersion: result.installed_hash.slice(0, 10),
          receiptId: result.receipt_id.slice(0, 8),
        };
      },
    },
    mergeConnections: localMergeConnections(harnesses),
    prepareMerge: {
      access: "available",
      isPending: prepare.isPending,
      async execute(input) {
        const request = resolveLocalMergeRequest(input, harnesses);
        const result = await prepare.mutateAsync({
          skillName: request.skillName,
          harnessId: request.harnessId,
          model: request.model,
        });
        return {
          mergeId: result.merge_id,
          summary: `Prepared with ${request.connection.name}. Review every candidate before applying it.`,
          diffs: result.targets.map((target) => ({
            title: "Merged candidate",
            description: target.target_path,
            diff: target.merged_diff,
          })),
        };
      },
    },
    applyMerge: {
      access: "available",
      isPending: applyMerge.isPending,
      async execute(mergeId) {
        const result = await applyMerge.mutateAsync(mergeId);
        return {
          installedVersion: result.installed_hash.slice(0, 10),
          receiptId: result.receipt_id.slice(0, 8),
        };
      },
    },
    archive: {
      access: "available",
      isPending: archiveSkill.isPending,
      async execute(input) {
        await archiveSkill.mutateAsync(input);
      },
    },
    archiveMany: {
      access: "available",
      isPending: archiveSkills.isPending,
      async execute(inputs) {
        const result = await archiveSkills.mutateAsync(inputs);
        return {
          succeeded: result.receipts.length,
          failed: result.failures.length,
        };
      },
    },
    consolidate: {
      access: "available",
      isPending: prepareConsolidation.isPending || decideDecision.isPending,
      async execute(skillId) {
        const skill = library.data?.skills.find((candidate) => candidate.skillId === skillId);
        if (!skill) throw new Error("Refresh the Library and review this consolidation again.");
        const recommendation = recommendLibraryConsolidation(skill);
        if (!recommendation) {
          throw new Error("These installations are already consolidated or no longer match.");
        }
        const targetSkillPaths = recommendation.locations.flatMap((candidate) =>
          candidate.action === "replace_with_link" || candidate.action === "archive_copy"
            ? [candidate.location.skillPath]
            : [],
        );
        const prepared = await prepareConsolidation.mutateAsync({
          skillName: recommendation.skillName,
          canonicalSkillPath: recommendation.canonical.installedLocation.skillPath,
          targetSkillPaths,
        });
        return mapDurableDecision(
          await decideDecision.mutateAsync({
            decisionId: prepared.approval_id,
            action: "approve",
          }),
        );
      },
    },
    remove: {
      access: "available",
      async execute(skillId) {
        const skill = library.data?.skills.find((candidate) => candidate.skillId === skillId);
        if (!skill) throw new Error("Refresh the Library and try removing this skill again.");
        const locations = skill.locations
          .filter(
            (location) =>
              location.active &&
              location.sourceKind === "installed" &&
              location.scope !== "admin" &&
              location.scope !== "system",
          )
          .map((location) => ({
            skillPath: location.skillPath,
            connection: location.harness ? connectionDisplayName(location.harness, names) : null,
          }));
        if (locations.length === 0) throw new Error("This skill has no removable locations.");
        return mapDurableDecision(
          await prepareRemoval.mutateAsync({
            skillName: skill.name,
            locations,
          }),
        );
      },
    },
    decideRemoval: {
      access: "available",
      isPending: decideDecision.isPending,
      async execute(input) {
        return mapDurableDecision(await decideDecision.mutateAsync(input));
      },
    },
    restore: {
      access: "available",
      isPending: restoreSkill.isPending,
      async execute(restoreId) {
        await restoreSkill.mutateAsync(restoreId);
      },
    },
    create: {
      access: "unavailable",
      reason: "Add Local skills through a connected agent or the filesystem.",
    },
    primary: [],
  };
}

const LOCAL_LIBRARY: DashboardHostModules["skills"]["library"] = {
  access: "available",
  useInventory: useLocalLibraryInventory,
  useActions: useLocalLibraryActions,
};

export function mapLocalSkillSet(
  manifest: SkillSetManifest,
  policy?: NonNullable<SkillSetsResponse["workspace_policies"]>[number],
): ProjectSkillSetModel {
  return {
    id: manifest.set_id,
    name: manifest.name,
    description: manifest.description,
    connections: manifest.harnesses,
    skills: manifest.skills.map((skill) => ({
      name: skill.name,
      packagePath: skill.library_package_path,
      contentHash: skill.content_hash,
    })),
    revision: manifest.revision,
    revisionHash: manifest.revision_hash,
    updatedAt: manifest.updated_at,
    ownerScope: policy ? "workspace" : "personal",
    workspacePolicy: policy ? { action: policy.action, reason: policy.reason } : null,
  };
}

export function mapLocalSkillSetPlan(plan: SkillSetPlan): ProjectPlanModel {
  return {
    skillSetId: plan.set_id,
    skillSetName: plan.set_name,
    projectRoot: plan.project_root,
    creates: plan.creates,
    unchanged: plan.unchanged,
    conflicts: plan.conflicts,
    missingDependencies: plan.missing_dependencies,
    operations: plan.operations.map((operation) => ({
      connection: operation.harness,
      skillName: operation.skill_name,
      targetPath: operation.target_path,
      action: operation.action,
      reason: operation.reason,
    })),
  };
}

export function mapLocalSkillSetReceipt(
  receipt: SkillSetReceipt | SkillSetRemoteApplyResult,
): ProjectReceiptModel {
  return {
    id: receipt.receipt_id,
    skillSetId: receipt.set_id,
    skillSetName: receipt.set_name,
    projectRoot: receipt.project_root,
    status: receipt.status,
    operationCount: receipt.operations.length,
    dependenciesDownloaded:
      "dependencies_downloaded" in receipt ? receipt.dependencies_downloaded : 0,
  };
}

export function localProjectSkillSetInput(input: ProjectSkillSetInput): CreateSkillSetRequest {
  return {
    name: input.name,
    description: input.description,
    harnesses: input.connections,
    skills: input.skills.map((skill) =>
      skill.provenance === "catalog"
        ? {
            name: skill.name,
            catalog_id: skill.catalogId,
            source: skill.source,
            install_spec: skill.installSpec,
            download_url: skill.downloadUrl,
          }
        : { name: skill.name, package_path: skill.packagePath },
    ),
  };
}

export function localProjectSkillSetUpdateInput(
  input: ProjectSkillSetUpdateInput,
): UpdateSkillSetRequest {
  return {
    name: input.name,
    description: input.description,
    harnesses: input.connections,
    skills: input.skills.map((skill) => ({
      name: skill.name,
      package_path: skill.packagePath,
    })),
    set_id: input.id,
    parent_revision_hash: input.parentRevisionHash,
  };
}

export function localProjectSkillSetTargetInput(
  input: ProjectSkillSetTargetInput,
): ApplySkillSetRequest {
  const request: ApplySkillSetRequest = {
    set_id: input.skillSetId,
    project_root: input.projectRoot,
  };
  if (input.policyApproval) request.policy_approval = true;
  return request;
}

function useLocalProjectsInventory() {
  const skillSets = useSkillSets();
  const library = useLibrary();
  const settings = useSettings();
  const data: ProjectsInventoryModel | null =
    skillSets.data && library.data
      ? {
          skillSets: skillSets.data.sets.map((manifest) =>
            mapLocalSkillSet(
              manifest,
              skillSets.data.workspace_policies?.find(
                (policy) => policy.skill_set_id === manifest.set_id,
              ),
            ),
          ),
          receipts: skillSets.data.receipts.map(mapLocalSkillSetReceipt),
          captureCandidates: projectCaptureCandidatesFromLibrary(library.data),
          connectedHarnesses: (settings.data?.harnesses ?? [])
            .filter(
              (harness): harness is typeof harness & { id: ProjectConnectionId } =>
                harness.connected &&
                ["codex", "claude_code", "opencode", "openclaw", "pi"].includes(harness.id),
            )
            .map((harness) => ({
              id: harness.id,
              name: harness.name,
              icon: harness.icon,
            })),
          availableSkills: projectSkillOptionsFromLibrary(library.data),
        }
      : null;
  const error = skillSets.error ?? library.error;
  return {
    data,
    isLoading: skillSets.isLoading || library.isLoading,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    refresh: async () => {
      await Promise.all([skillSets.refetch(), library.refetch()]);
    },
  };
}

export function previewsCloudSharingGate(search: string, isDevelopment: boolean): boolean {
  return isDevelopment && new URLSearchParams(search).get("preview") === "cloud-sharing-gate";
}

interface LocalWorkspaceSkillSetPolicyInput {
  skillSetId: string;
  action: "require";
}

export function localWorkspaceSkillSetPolicyInput(
  skillSetId: string,
): LocalWorkspaceSkillSetPolicyInput {
  return {
    skillSetId,
    action: "require",
  };
}

function downloadBase64File(filename: string, content: string): void {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename.replace(/[^A-Za-z0-9._-]/g, "-") || "selftune-plugin.zip";
    anchor.click();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function useLocalProjectsActions(): DashboardProjectsActions {
  const create = useCreateSkillSet();
  const update = useUpdateSkillSet();
  const remove = useDeleteSkillSet();
  const derive = useDeriveSkillSet();
  const exportPlugin = useExportSkillSetPlugin();
  const previewPluginInstall = usePreviewSkillSetPluginInstall();
  const installPlugin = useInstallSkillSetPlugin();
  const previewPublish = usePreviewSkillSetPublish();
  const publishSet = usePublishSkillSet();
  const previewPack = usePreviewSkillSetPack();
  const importPack = useImportSkillSetPack();
  const shareSet = useShareSkillSet();
  const plan = usePreviewSkillSet();
  const apply = useApplySkillSet();
  const provision = useApplyProjectProvision();
  const previewProvision = usePreviewProjectProvision();
  const rollback = useRollbackSkillSet();
  const prepareConflict = usePrepareProjectConflictDecision();
  const decideDecision = useDecideDurableDecision();
  const chooseFolder = window.selftuneDesktop?.chooseFolder;
  const rollbackDecision = useRollbackDurableDecision();
  const reviewSuggestion = useReviewSkillSetSuggestion();
  const prepareTraceCandidate = usePrepareTraceCandidate();
  const settings = useSettings();
  const previewCloudSharingGate = previewsCloudSharingGate(
    window.location.search,
    import.meta.env.DEV,
  );
  const sharingDestination = remoteLibraryDestination(
    !previewCloudSharingGate && settings.data?.remote_library.configured === true,
    settings.data?.remote_library.url,
  );
  const remoteSharingConfigured = sharingDestination !== "unconfigured";
  const selfHostedSharingConfigured = sharingDestination === "self_hosted";
  const managedCloudConfigured = sharingDestination === "managed_cloud";
  const packInventory = useSkillSetPacks(selfHostedSharingConfigured);
  const revokePack = useRevokeSkillSetPack();
  const workspaceMembers = useWorkspaceMembers(selfHostedSharingConfigured);
  const updateWorkspacePolicy = useUpdateWorkspaceSkillSetPolicy();
  return {
    create: {
      access: "available",
      isPending: create.isPending,
      async execute(input) {
        return mapLocalSkillSet(await create.mutateAsync(localProjectSkillSetInput(input)));
      },
    },
    update: {
      access: "available",
      isPending: update.isPending,
      async execute(input) {
        return mapLocalSkillSet(await update.mutateAsync(localProjectSkillSetUpdateInput(input)));
      },
    },
    derive: {
      access: "available",
      isPending: derive.isPending,
      async execute(input) {
        return mapLocalSkillSet(
          await derive.mutateAsync({
            name: input.name,
            description: input.description,
            harnesses: input.connections,
            project_root: input.projectRoot,
          }),
        );
      },
    },
    export: {
      access: "available",
      label: "Export",
      formats: [
        {
          id: "claude",
          label: "Claude plugin",
          description: "Claude plugin manifest plus every pinned skill.",
        },
        {
          id: "openai",
          label: "OpenAI plugin",
          description: "Codex plugin manifest plus every pinned skill.",
        },
        {
          id: "agent-plugins-v1",
          label: "Agent Plugins 1.0",
          description: "Portable root plugin.json using the official versioned schema.",
        },
        {
          id: "all",
          label: "All plugin formats",
          description: "One archive with Claude, OpenAI, and Agent Plugins manifests.",
        },
      ],
      isPending: exportPlugin.isPending,
      async execute(input) {
        const format = input.format && input.format !== "portable" ? input.format : "all";
        const result = await exportPlugin.mutateAsync({
          set_id: input.skillSetId,
          target: format,
        });
        downloadBase64File(result.filename, result.content_base64);
        return { outputPath: result.filename };
      },
    },
    installPlugin: {
      preview: {
        access: "available",
        isPending: previewPluginInstall.isPending,
        execute: (skillSetId) => previewPluginInstall.mutateAsync(skillSetId),
      },
      execute: {
        access: "available",
        isPending: installPlugin.isPending,
        execute: (input) => installPlugin.mutateAsync(input),
      },
    },
    publishRelease: managedCloudConfigured
      ? {
          preview: {
            access: "available",
            isPending: previewPublish.isPending,
            execute: (skillSetId) => previewPublish.mutateAsync(skillSetId),
          },
          execute: {
            access: "available",
            isPending: publishSet.isPending,
            execute: (input) => publishSet.mutateAsync(input),
          },
        }
      : undefined,
    importPack: {
      preview: {
        access: "available",
        isPending: previewPack.isPending,
        async execute(packUrl) {
          const result = await previewPack.mutateAsync(packUrl);
          return {
            packUrl: result.packUrl,
            packId: result.preview.packId,
            name: result.preview.name,
            description: result.preview.description,
            mode: result.preview.mode,
            expiresAt: result.preview.expiresAt,
            skillSetRevisionSha256: result.preview.skillSetRevisionSha256,
            objectSha256: result.preview.objectSha256,
            components: result.preview.components.map((component) => ({ ...component })),
          };
        },
      },
      execute: {
        access: "available",
        isPending: importPack.isPending,
        async execute(input) {
          const result = await importPack.mutateAsync(input);
          return mapLocalSkillSet(result.manifest);
        },
      },
    },
    share: remoteSharingConfigured
      ? {
          access: "available",
          isPending: shareSet.isPending,
          capabilities:
            sharingDestination === "managed_cloud"
              ? MANAGED_CLOUD_SHARE_CAPABILITIES
              : SELF_HOSTED_SHARE_CAPABILITIES,
          execute: (input) => shareSet.mutateAsync(input),
        }
      : { access: "upgrade", href: "/settings?section=remote-library" },
    usePacks: selfHostedSharingConfigured
      ? () => ({
          data: packInventory.data?.packs ?? null,
          isLoading: packInventory.isLoading,
          error: packInventory.error instanceof Error ? packInventory.error.message : null,
          refresh: async () => {
            await packInventory.refetch();
          },
        })
      : undefined,
    revokePack: selfHostedSharingConfigured
      ? {
          access: "available",
          isPending: revokePack.isPending,
          execute: (packId) => revokePack.mutateAsync(packId),
        }
      : undefined,
    shareGatePreview: import.meta.env.DEV
      ? previewCloudSharingGate
        ? { href: "/projects", label: "Exit Cloud gate preview" }
        : {
            href: "/projects?preview=cloud-sharing-gate",
            label: "Preview Cloud gate",
          }
      : undefined,
    useShareRecipients: selfHostedSharingConfigured
      ? () =>
          workspaceMembers.data?.members
            .filter((member) => member.user_id !== workspaceMembers.data?.current_user_id)
            .map((member) => ({
              email: member.email,
              name: member.name,
              avatarUrl: member.avatar_url,
            })) ?? []
      : undefined,
    shareWithWorkspace: selfHostedSharingConfigured
      ? {
          access: "available",
          isPending: updateWorkspacePolicy.isPending,
          async execute(skillSetId) {
            await updateWorkspacePolicy.mutateAsync(localWorkspaceSkillSetPolicyInput(skillSetId));
          },
        }
      : undefined,
    remove: {
      access: "available",
      isPending: remove.isPending,
      execute: (skillSetId) => remove.mutateAsync(skillSetId),
    },
    plan: {
      access: "available",
      isPending: plan.isPending,
      async execute(input) {
        return mapLocalSkillSetPlan(await plan.mutateAsync(localProjectSkillSetTargetInput(input)));
      },
    },
    apply: {
      access: "available",
      isPending: apply.isPending,
      async execute(input) {
        return mapLocalSkillSetReceipt(
          await apply.mutateAsync(localProjectSkillSetTargetInput(input)),
        );
      },
    },
    provision: {
      chooseFolder: chooseFolder ? () => chooseFolder() : undefined,
      preview: {
        access: "available",
        isPending: previewProvision.isPending,
        execute: (input: ProjectProvisionInput) => previewProvision.mutateAsync(input),
      },
      execute: {
        access: "available",
        isPending: provision.isPending,
        execute: (input: ProjectProvisionInput) => provision.mutateAsync(input),
      },
    },
    resolveConflict: {
      access: "available",
      isPending: prepareConflict.isPending,
      async execute(input) {
        return mapDurableDecision(
          await prepareConflict.mutateAsync({
            skillSetId: input.skillSetId,
            projectRoot: input.projectRoot,
          }),
        );
      },
    },
    decideConflict: {
      access: "available",
      isPending: decideDecision.isPending,
      async execute(input) {
        return mapDurableDecision(await decideDecision.mutateAsync(input));
      },
    },
    rollbackConflict: {
      access: "available",
      isPending: rollbackDecision.isPending,
      async execute(decisionId) {
        return mapDurableDecision(await rollbackDecision.mutateAsync(decisionId));
      },
    },
    rollback: {
      access: "available",
      isPending: rollback.isPending,
      async execute(receiptId) {
        return mapLocalSkillSetReceipt(await rollback.mutateAsync({ receipt_id: receiptId }));
      },
    },
    reviewSuggestion: {
      access: "available",
      isPending: reviewSuggestion.isPending,
      async execute(input) {
        await reviewSuggestion.mutateAsync(localSkillSetSuggestionReviewInput(input));
      },
    },
    prepareTraceCandidate: {
      access: "available",
      isPending: prepareTraceCandidate.isPending,
      async execute(patternId) {
        const review = await prepareTraceCandidate.mutateAsync(patternId);
        return {
          draftId: review.draft_id,
          patternId: review.pattern_id,
          cohortFingerprint: review.cohort_fingerprint,
          targetRevision: review.target_revision,
          readiness: review.readiness,
          failureReason: review.failure_reason,
          evidence: {
            cohortEntries: review.evidence.cohort_entries,
            resolvedEntries: review.evidence.resolved_entries,
          },
          candidate: review.candidate
            ? {
                body: review.candidate.body,
                rationale: review.candidate.rationale,
                changedLines: review.candidate.diff.changed_lines,
                targetSection: review.candidate.diff.target_section,
                uncertainty: review.candidate.uncertainty,
              }
            : null,
        };
      },
    },
    traceCandidateTargets: {
      access: "available",
      isPending: false,
      async execute(draftId) {
        const result = await fetchTraceCandidateTargets(draftId);
        return {
          runId: result.run_id,
          blockers: result.blockers,
          targets: result.targets.map((target) => ({
            sourceId: target.source_id,
            snapshotId: target.snapshot_id,
            skillId: target.skill_id,
            suiteId: target.suite_id,
            suiteName: target.suite_name,
            manifestDigest: target.manifest_digest,
          })),
        };
      },
    },
    submitTraceCandidateTarget: {
      access: "available",
      isPending: false,
      async execute(input) {
        const receipt = await submitTraceCandidateTarget(input.draftId, {
          source_id: input.sourceId,
          snapshot_id: input.snapshotId,
          skill_id: input.skillId,
          suite_id: input.suiteId,
          manifest_digest: input.manifestDigest,
        });
        return { runId: receipt.run_id };
      },
    },
  };
}

const LOCAL_PROJECTS: DashboardHostModules["skillSets"]["projects"] = {
  access: "available",
  useInventory: useLocalProjectsInventory,
  useIntelligence: useLocalProjectsIntelligence,
  useActions: useLocalProjectsActions,
};

function useLocalPluginInventory() {
  const query = usePlugins();
  return {
    data: (query.data ?? null) satisfies PluginInventoryModel | null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}

function useLocalPluginActions(): DashboardPluginsActions {
  const manage = useManagePlugin();
  return {
    manage: {
      access: "available",
      isPending: manage.isPending,
      error: manage.error instanceof Error ? manage.error.message : null,
      execute: (input) => manage.mutateAsync(input),
    },
  };
}

const LOCAL_PLUGINS: NonNullable<DashboardHostModules["plugins"]["plugins"]> = {
  access: "available",
  useInventory: useLocalPluginInventory,
  useActions: useLocalPluginActions,
};

function useLocalDecisions() {
  const query = useDurableDecisions();
  return {
    data: query.data ? query.data.decisions.map(mapDurableDecision) : null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}

function useLocalDecisionActions(): DashboardDecisionsActions {
  const decide = useDecideDurableDecision();
  const rollback = useRollbackDurableDecision();
  return {
    decide: {
      access: "available",
      isPending: decide.isPending,
      async execute(input) {
        return mapDurableDecision(await decide.mutateAsync(input));
      },
    },
    rollback: {
      access: "available",
      isPending: rollback.isPending,
      async execute(decisionId) {
        return mapDurableDecision(await rollback.mutateAsync(decisionId));
      },
    },
  };
}

const LOCAL_DECISIONS: DashboardHostModules["skills"]["decisions"] = {
  access: "available",
  useDecisions: useLocalDecisions,
  useActions: useLocalDecisionActions,
};

const TEAM_COLLABORATION_QUERY_KEY = ["team-collaboration"];

async function localTeamCollaborationRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = init ? await fetch(path, init) : await fetch(path);
  } catch {
    throw new Error(
      "Team collaboration is unavailable because the local SelfTune service could not be reached.",
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      detail || `Team collaboration request failed (${response.status} ${response.statusText}).`,
    );
  }
  return response;
}

export async function fetchLocalTeamCollaboration(): Promise<TeamCollaborationSnapshotModel> {
  const response = await localTeamCollaborationRequest("/api/v2/team-collaboration");
  return response.json();
}

interface LocalTeamCollaborationAccess {
  currentRole: "viewer" | "member" | "admin" | "owner";
  readOnly: boolean;
}

export async function fetchLocalTeamCollaborationAccess(): Promise<LocalTeamCollaborationAccess> {
  const response = await localTeamCollaborationRequest("/api/v2/team-collaboration/access");
  return response.json();
}

export async function updateLocalTeamRolloutPolicy(
  entryId: string,
  policy: TeamRolloutPolicyModel,
): Promise<void> {
  await localTeamCollaborationRequest(
    `/api/v2/team-collaboration/registry/${encodeURIComponent(entryId)}/rollout-policy`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    },
  );
}

type LocalTeamContributionDecision = "adopt" | "reject" | "rollback";

export async function decideLocalTeamContribution(
  contributionId: string,
  decision: LocalTeamContributionDecision,
): Promise<void> {
  await localTeamCollaborationRequest(
    `/api/v2/team-collaboration/contributions/${encodeURIComponent(contributionId)}/${decision}`,
    { method: "POST" },
  );
}

function useLocalTeamCollaborationSnapshot() {
  const query = useQuery({
    queryKey: TEAM_COLLABORATION_QUERY_KEY,
    queryFn: fetchLocalTeamCollaboration,
    staleTime: 10_000,
  });
  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}

type LocalTeamCollaborationMutation =
  | { kind: "rollout"; entryId: string; policy: TeamRolloutPolicyModel }
  | { kind: "decision"; contributionId: string; decision: LocalTeamContributionDecision };

function useLocalTeamCollaborationActions(): DashboardTeamCollaborationActions {
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: ["team-collaboration", "access"],
    queryFn: fetchLocalTeamCollaborationAccess,
    staleTime: 10_000,
  });
  const mutation = useMutation({
    mutationFn: async (input: LocalTeamCollaborationMutation) => {
      if (input.kind === "rollout") {
        await updateLocalTeamRolloutPolicy(input.entryId, input.policy);
        return;
      }
      await decideLocalTeamContribution(input.contributionId, input.decision);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TEAM_COLLABORATION_QUERY_KEY }),
  });
  const role = access.data?.currentRole;
  const canManage = access.data?.readOnly === false && (role === "admin" || role === "owner");
  if (!canManage) {
    const reason = access.isLoading
      ? "Checking workspace permissions."
      : access.error
        ? "Workspace permissions could not be loaded from the connected Cloud workspace."
        : access.data?.readOnly
          ? "This Cloud workspace is read only, so collaboration changes are unavailable."
          : "Only workspace admins and owners can review suggestions or change rollout policies.";
    const rolloutUnavailable: DashboardTeamCollaborationActions["updateRolloutPolicy"] = {
      access: "unavailable",
      reason,
    };
    const decisionUnavailable: DashboardTeamCollaborationActions["adoptContribution"] = {
      access: "unavailable",
      reason,
    };
    return {
      updateRolloutPolicy: rolloutUnavailable,
      adoptContribution: decisionUnavailable,
      rejectContribution: decisionUnavailable,
      rollbackContribution: decisionUnavailable,
    };
  }
  return {
    updateRolloutPolicy: {
      access: "available",
      isPending: mutation.isPending,
      execute: ({ entryId, policy }) => mutation.mutateAsync({ kind: "rollout", entryId, policy }),
    },
    adoptContribution: {
      access: "available",
      isPending: mutation.isPending,
      execute: (contributionId) =>
        mutation.mutateAsync({ kind: "decision", contributionId, decision: "adopt" }),
    },
    rejectContribution: {
      access: "available",
      isPending: mutation.isPending,
      execute: (contributionId) =>
        mutation.mutateAsync({ kind: "decision", contributionId, decision: "reject" }),
    },
    rollbackContribution: {
      access: "available",
      isPending: mutation.isPending,
      execute: (contributionId) =>
        mutation.mutateAsync({ kind: "decision", contributionId, decision: "rollback" }),
    },
  };
}

const LOCAL_TEAM_COLLABORATION: NonNullable<
  DashboardHostModules["teamCollaboration"]["collaboration"]
> = {
  access: "available",
  useSnapshot: useLocalTeamCollaborationSnapshot,
  useActions: useLocalTeamCollaborationActions,
};

function localHostIdentity(host: Extract<DashboardHostKind, "local" | "selfhost">) {
  return {
    host,
    plan: "oss",
    features: LOCAL_FEATURES,
  } satisfies DashboardHostModules["capability"];
}

async function updateOverviewWatchlist(skills: string[]): Promise<string[]> {
  const response = await fetch("/api/actions/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skills }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const payload = z
    .object({ watched_skills: z.array(z.string()).optional() })
    .parse(await response.json());
  return payload.watched_skills ?? skills;
}

const LOCAL_MUTATIONS: NonNullable<DashboardHostModules["overview"]>["mutations"] = {
  updateOverviewWatchlist,
};

const CorrectionStudySignalSchema = z.object({
  candidate_id: z.string(),
  evidence_level: z.enum(["E0", "E0.5", "E1", "E2"]),
  observed_failure: z.string().optional(),
  correction_intent: z.string().optional(),
  proposed_change: z
    .object({ diff: z.string().optional(), summary: z.string().optional() })
    .nullable()
    .optional(),
  evaluation: z
    .object({ summary: z.string().optional(), regressions: z.array(z.string()).optional() })
    .nullable()
    .optional(),
  limitations: z.array(z.string()).optional(),
  manifest_digest: z.string().optional(),
  provenance: z.array(z.string()).optional(),
  terminal: z.boolean().optional(),
});

const CorrectionStudyPageSchema = z.object({
  items: z.array(CorrectionStudySignalSchema).optional(),
});

const LOCAL_CORRECTION_STUDIES: NonNullable<DashboardHostModules["skills"]["correctionStudies"]> = {
  access: "available",
  async list(limit = 25) {
    const response = await fetch(
      `/api/v2/correction-studies/reviews?limit=${Math.min(Math.max(1, limit), 128)}`,
    );
    if (!response.ok) throw new Error("Correction studies are unavailable.");
    const page = CorrectionStudyPageSchema.parse(await response.json());
    return (page.items ?? []).map((signal) => {
      const evidenceLevel = signal.evidence_level;
      const proposed = signal.proposed_change ?? null;
      const evaluation = signal.evaluation ?? null;
      const available = Boolean(signal.manifest_digest) && !signal.terminal;
      const availability = available
        ? { available: true as const }
        : {
            available: false as const,
            reason: "A terminal decision or missing manifest prevents review.",
          };
      return {
        candidateId: signal.candidate_id,
        evidenceLevel,
        observedFailure: signal.observed_failure ?? "Observed correction",
        correctionIntent: signal.correction_intent ?? "",
        proposedChange: proposed
          ? {
              diff: proposed.diff,
              summary: proposed.summary,
            }
          : null,
        evaluation: evaluation
          ? {
              summary: evaluation.summary ?? "Evaluation recorded",
              regressions: evaluation.regressions ?? [],
            }
          : null,
        limitations: signal.limitations ?? [
          "Review hypothesis only; no skill change is applied from this surface.",
        ],
        manifestDigest: signal.manifest_digest ?? "",
        provenance: signal.provenance ?? ["Candidate manifest"],
        actions: {
          accept: availability,
          edit: {
            available: false,
            reason: "Editing requires a distinct replacement candidate and re-evaluation.",
          },
          reject: availability,
          defer: availability,
        },
      };
    });
  },
  async recordDecision(input) {
    const response = await fetch("/api/v2/correction-studies/review-decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate_id: input.candidateId,
        action: input.action,
        reason: input.reason,
        manifest_digest: input.manifestDigest,
      }),
    });
    if (!response.ok) throw new Error("The correction review decision could not be recorded.");
    return { recorded: true, appliesSkill: false };
  },
};

export function createLocalDashboardModules(
  host: Extract<DashboardHostKind, "local" | "selfhost"> = "local",
  profiles?: ServerProfileController,
): DashboardHostModules {
  return {
    capability: localHostIdentity(host),
    skillSets: {
      library: LOCAL_LIBRARY,
      projects: LOCAL_PROJECTS,
      assignments: LOCAL_ASSIGNED_SKILL_SETS,
    },
    skills: {
      host,
      library: LOCAL_LIBRARY,
      decisions: LOCAL_DECISIONS,
      correctionStudies: LOCAL_CORRECTION_STUDIES,
    },
    plugins: { plugins: LOCAL_PLUGINS },
    recipientShares: {},
    teamCollaboration: { collaboration: LOCAL_TEAM_COLLABORATION },
    overview: { mutations: LOCAL_MUTATIONS },
    chrome: { profiles },
  };
}

export const localDashboardModules = createLocalDashboardModules();
export const selfHostDashboardModules = createLocalDashboardModules("selfhost");
export const LOCAL_CAPABILITIES = capabilitiesFromModule(localDashboardModules.capability);
export const SELF_HOST_CAPABILITIES = capabilitiesFromModule(selfHostDashboardModules.capability);
