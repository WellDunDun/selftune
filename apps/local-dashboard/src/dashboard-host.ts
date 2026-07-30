// oxlint-disable max-lines -- Host capability composition is intentionally centralized here.
import {
  capabilitiesFromAdapter,
  type DashboardLibraryActions,
  type DashboardHostAdapter,
  type DashboardHostKind,
  type DashboardDecisionsActions,
  type DashboardProjectsActions,
  type ServerProfileController,
} from "@selftune/dashboard-core/host";
import type {
  AnalyticsModel,
  DashboardDecisionModel,
  OverviewModel,
  ProjectPlanModel,
  ProjectConnectionId,
  ProjectProvisionInput,
  ProjectReceiptModel,
  ProjectsInventoryModel,
  ProjectSkillSetInput,
  ProjectSkillSetModel,
  ProjectSkillSetTargetInput,
  ProjectSkillSetUpdateInput,
  RuntimeHealthModel,
  SkillsModel,
} from "@selftune/dashboard-core/models";
import { useQuery } from "@tanstack/react-query";
import { fetchAnalytics, fetchOverview } from "./api";
import {
  useApplySkillSourceMerge,
  useApplySkillSourceUpdate,
  useLibrary,
  usePrepareSkillSourceMerge,
  usePreviewSkillSourceUpdate,
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
  useDeriveSkillSet,
  useExportSkillSet,
  usePreviewSkillSet,
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
import { useSettings } from "./hooks/useSettings";
import {
  executeLocalShare,
  LOCAL_SHARE_CAPABILITIES,
  LOCAL_SHARE_LINK_ONLY,
  useLocalLibraryTransferActions,
} from "./local-library-transfer-actions";
import {
  localSkillSetSuggestionReviewInput,
  useLocalProjectsIntelligence,
} from "./project-skill-intelligence";
import { projectCaptureCandidatesFromLibrary } from "./project-capture-candidates";
import { projectSkillOptionsFromLibrary } from "./project-skill-options";
import { syncDestinationFromUrl } from "./lib/sync-destination";
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
  AnalyticsResponse,
  DurableDashboardDecision,
  HealthResponse,
  LibrarySnapshot,
  OverviewResponse,
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

const LOCAL_FEATURES: DashboardHostAdapter["features"] = {
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

const LOCAL_LIBRARY: DashboardHostAdapter["library"] = {
  access: "available",
  useInventory: useLocalLibraryInventory,
  useActions: useLocalLibraryActions,
};

const SELF_HOST_LIBRARY_READ_ONLY_REASON =
  "This Self-host dashboard exposes the Remote Library as read-only.";
const SELF_HOST_LIBRARY_ACTION_UNAVAILABLE: {
  readonly access: "unavailable";
  readonly reason: string;
} = {
  access: "unavailable",
  reason: SELF_HOST_LIBRARY_READ_ONLY_REASON,
};
const SELF_HOST_LIBRARY_ACTIONS: DashboardLibraryActions = {
  updateCategory: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  openLocation: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  previewSourceUpdate: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  applySourceUpdate: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  mergeConnections: [],
  prepareMerge: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  applyMerge: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  archive: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  remove: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  decideRemoval: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  restore: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  create: SELF_HOST_LIBRARY_ACTION_UNAVAILABLE,
  primary: [],
};

export function mapSelfHostLibraryInventory(snapshot: LibrarySnapshot) {
  const inventory = mapLocalLibraryInventory(snapshot, null, null, []);
  return {
    ...inventory,
    skills: inventory.skills.map((skill) => ({
      ...skill,
      detailHref: null,
    })),
  };
}

function useSelfHostLibraryInventory() {
  const query = useLibrary();
  return {
    data: query.data ? mapSelfHostLibraryInventory(query.data) : null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}

const SELF_HOST_LIBRARY: DashboardHostAdapter["library"] = {
  access: "available",
  useInventory: useSelfHostLibraryInventory,
  useActions: () => SELF_HOST_LIBRARY_ACTIONS,
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
  return {
    set_id: input.skillSetId,
    project_root: input.projectRoot,
    ...(input.policyApproval ? { policy_approval: true } : {}),
  };
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

function useLocalProjectsActions(): DashboardProjectsActions {
  const create = useCreateSkillSet();
  const update = useUpdateSkillSet();
  const derive = useDeriveSkillSet();
  const exportSet = useExportSkillSet();
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
  const cloudSharingConfigured = Boolean(
    !previewCloudSharingGate &&
    settings.data?.cloud_account.linked &&
    settings.data.remote_library.configured &&
    syncDestinationFromUrl(settings.data.remote_library.url ?? "") === "cloud",
  );
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
      requiresProjectRoot: true,
      label: "Save to Project",
      isPending: exportSet.isPending,
      async execute(input) {
        if (!input.projectRoot) throw new Error("Choose a project folder before exporting.");
        const result = await exportSet.mutateAsync({
          set_id: input.skillSetId,
          project_root: input.projectRoot,
        });
        return { outputPath: result.output_path };
      },
    },
    share: cloudSharingConfigured
      ? {
          access: "available",
          ...LOCAL_SHARE_CAPABILITIES,
          isPending: shareSet.isPending,
          execute: (input) => executeLocalShare(input, shareSet.mutateAsync),
        }
      : { access: "upgrade", href: "/settings?section=remote-library" },
    shareGatePreview: import.meta.env.DEV
      ? previewCloudSharingGate
        ? { href: "/projects", label: "Exit Cloud gate preview" }
        : {
            href: "/projects?preview=cloud-sharing-gate",
            label: "Preview Cloud gate",
          }
      : undefined,
    useShareRecipients: () => [],
    shareWithWorkspace: {
      access: "unavailable",
      reason: LOCAL_SHARE_LINK_ONLY,
    },
    remove: {
      access: "unavailable",
      reason: "Delete local Skill Sets from the SelfTune CLI.",
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
      chooseFolder: typeof chooseFolder === "function" ? () => chooseFolder() : undefined,
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

const LOCAL_PROJECTS: DashboardHostAdapter["projects"] = {
  access: "available",
  useInventory: useLocalProjectsInventory,
  useIntelligence: useLocalProjectsIntelligence,
  useActions: useLocalProjectsActions,
};

const SELF_HOST_PROJECTS_READ_ONLY_REASON =
  "This Self-host dashboard exposes shared Skill Sets as read-only.";
const SELF_HOST_PROJECTS_ACTION_UNAVAILABLE: {
  readonly access: "unavailable";
  readonly reason: string;
} = {
  access: "unavailable",
  reason: SELF_HOST_PROJECTS_READ_ONLY_REASON,
};
const SELF_HOST_PROJECTS_ACTIONS: DashboardProjectsActions = {
  create: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  update: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  derive: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  export: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  remove: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  plan: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  apply: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  resolveConflict: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  decideConflict: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  rollbackConflict: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  rollback: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
  reviewSuggestion: SELF_HOST_PROJECTS_ACTION_UNAVAILABLE,
};

function useSelfHostProjectsInventory() {
  const skillSets = useSkillSets();
  const library = useLibrary();
  const data: ProjectsInventoryModel | null =
    skillSets.data && library.data
      ? {
          skillSets: skillSets.data.sets.map((manifest) => ({
            ...mapLocalSkillSet(manifest),
            ownerScope: "workspace",
          })),
          receipts: [],
          captureCandidates: [],
          connectedHarnesses: [],
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

const SELF_HOST_PROJECTS: DashboardHostAdapter["projects"] = {
  access: "available",
  useInventory: useSelfHostProjectsInventory,
  useIntelligence: () => ({
    access: "unavailable",
    reason: "Skill Set intelligence runs on connected local agent data.",
  }),
  useActions: () => SELF_HOST_PROJECTS_ACTIONS,
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

const LOCAL_DECISIONS: DashboardHostAdapter["decisions"] = {
  access: "available",
  useDecisions: useLocalDecisions,
  useActions: useLocalDecisionActions,
};

const SELF_HOST_DECISIONS: DashboardHostAdapter["decisions"] = {
  access: "unavailable",
  reason: "Durable local decisions are unavailable on this read-only Self-host dashboard.",
};

function localHostIdentity(host: Extract<DashboardHostKind, "local" | "selfhost">) {
  return {
    host,
    plan: "oss",
    features: LOCAL_FEATURES,
  } satisfies Pick<DashboardHostAdapter, "host" | "plan" | "features">;
}

function mapOverviewModel(data: OverviewResponse): OverviewModel {
  return {
    version: data.version,
    summary: {
      totalSkills: data.skills.length,
      avgPassRate30d: data.skills.length
        ? data.skills.reduce((sum, skill) => sum + skill.pass_rate, 0) / data.skills.length
        : null,
      unmatchedCount30d: data.overview.unmatched_queries.length,
      sessionsCount30d: data.overview.counts.sessions,
      pendingCount: data.overview.pending_proposals.length,
      evidenceCount: data.overview.counts.evidence,
    },
    autonomy: {
      level: data.autonomy_status.level,
      summary: data.autonomy_status.summary,
      attentionRequired: data.autonomy_status.attention_required,
      skillsObserved: data.autonomy_status.skills_observed,
      pendingReviews: data.autonomy_status.pending_reviews,
      lastRunAt: data.autonomy_status.last_run,
    },
    skillCards: data.skills.map((skill) => ({
      name: skill.skill_name,
      scope: skill.skill_scope,
      platforms: skill.skill_scope ? [skill.skill_scope] : [],
      passRate: skill.pass_rate,
      checks: skill.total_checks,
      status:
        skill.pass_rate >= 0.8
          ? "HEALTHY"
          : skill.pass_rate >= 0.6
            ? "WARNING"
            : skill.total_checks > 0
              ? "CRITICAL"
              : "UNKNOWN",
      hasEvidence: skill.has_evidence,
      uniqueSessions: skill.unique_sessions,
      lastSeen: skill.last_seen,
    })),
    watchlist: data.trust_watchlist.map((entry) => ({
      skillName: entry.skill_name,
      bucket: entry.bucket,
      lastSeen: entry.last_seen,
      passRate: entry.pass_rate,
      checks: entry.checks,
    })),
    attention: data.attention_queue.map((item) => ({
      skillName: item.skill_name,
      severity: item.severity,
      title: item.category.replace(/_/g, " "),
      body: item.reason,
    })),
    decisions: data.recent_decisions.map((item) => ({
      skillName: item.skill_name,
      kind: item.kind,
      timestamp: item.timestamp,
      summary: item.summary,
    })),
    activity: data.overview.recent_activity.map((item) => ({
      id: `${item.session_id}:${item.timestamp}`,
      type: item.triggered ? "evolution" : "unmatched",
      skillName: item.skill_name,
      timestamp: item.timestamp,
      title: item.skill_name,
      summary: item.query,
    })),
    jobs: [],
    signals: null,
  };
}

function mapSkillsModel(data: OverviewResponse): SkillsModel {
  return {
    items: data.skills.map((skill) => ({
      name: skill.skill_name,
      platforms: skill.skill_scope ? [skill.skill_scope] : [],
      status:
        skill.pass_rate >= 0.8
          ? "HEALTHY"
          : skill.pass_rate >= 0.6
            ? "WARNING"
            : skill.total_checks > 0
              ? "CRITICAL"
              : "UNKNOWN",
      passRate: skill.pass_rate,
      totalChecks: skill.total_checks,
      uniqueSessions: skill.unique_sessions,
      evidenceCount: skill.has_evidence ? 1 : 0,
      lastSeen: skill.last_seen,
    })),
  };
}

function mapAnalyticsModel(data: AnalyticsResponse): AnalyticsModel {
  return {
    summary: {
      activeSkills: data.summary.active_skills,
      totalChecks30d: data.summary.total_checks_30d,
      totalEvolutions: data.summary.total_evolutions,
      avgImprovement: data.summary.avg_improvement,
    },
    passRateTrend: data.pass_rate_trend.map((point) => ({
      date: point.date,
      passRate: point.pass_rate,
      checkVolume: point.total_checks,
    })),
    skillRankings: data.skill_rankings.map((skill, index) => ({
      skillName: skill.skill_name,
      passRate: skill.pass_rate,
      totalChecks: skill.total_checks,
      rank: index + 1,
    })),
    dailyActivity: data.daily_activity.map((day) => ({
      date: day.date,
      checks: day.checks,
    })),
    evolutionImpact: data.evolution_impact.map((entry) => ({
      skillName: entry.skill_name,
      passRateBefore: entry.pass_rate_before,
      passRateAfter: entry.pass_rate_after,
      improvement: entry.pass_rate_after - entry.pass_rate_before,
    })),
  };
}

async function fetchRuntimeHealth(): Promise<RuntimeHealthModel> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as HealthResponse;
  return {
    workspaceRoot: payload.workspace_root,
    gitSha: payload.git_sha,
    dbPath: payload.db_path,
    processMode: payload.process_mode,
    watcherMode: payload.watcher_mode,
  };
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

  const payload = (await response.json()) as { watched_skills?: string[] };
  return Array.isArray(payload.watched_skills) ? payload.watched_skills : skills;
}

const LOCAL_AUTHENTICATION: DashboardHostAdapter["authentication"] = {
  useSession() {
    return {
      status: "authenticated",
      user: {
        name: "Admin Node",
        subtitle: "Active",
      },
    };
  },
};

const LOCAL_QUERIES: DashboardHostAdapter["queries"] = {
  async fetchOverview() {
    return mapOverviewModel(await fetchOverview());
  },
  async fetchSkills() {
    return mapSkillsModel(await fetchOverview());
  },
  async fetchAnalytics() {
    return mapAnalyticsModel(await fetchAnalytics());
  },
  fetchRuntimeHealth,
};

const LOCAL_NAVIGATION: DashboardHostAdapter["navigation"] = {
  upgrade: "https://selftune.dev/pricing",
  docs: "https://docs.selftune.dev",
  cloudDashboard: "https://selftune.dev",
  openUpgrade() {
    if (typeof window !== "undefined") {
      window.open("https://selftune.dev/pricing", "_blank", "noopener,noreferrer");
    }
  },
};

const LOCAL_MUTATIONS: DashboardHostAdapter["mutations"] = {
  updateOverviewWatchlist,
};

const LOCAL_PERMISSIONS: DashboardHostAdapter["permissions"] = {
  can(feature) {
    return LOCAL_FEATURES[feature]?.access === "available";
  },
};

const LOCAL_CORRECTION_STUDIES: NonNullable<DashboardHostAdapter["correctionStudies"]> = {
  access: "available",
  async list(limit = 25) {
    const response = await fetch(
      `/api/v2/correction-studies/reviews?limit=${Math.min(Math.max(1, limit), 128)}`,
    );
    if (!response.ok) throw new Error("Correction studies are unavailable.");
    const page = (await response.json()) as { items?: Array<Record<string, unknown>> };
    return (page.items ?? []).map((signal) => {
      const rawEvidence = String(signal.evidence_level);
      const evidenceLevel = ["E0", "E0.5", "E1", "E2"].includes(rawEvidence)
        ? (rawEvidence as "E0" | "E0.5" | "E1" | "E2")
        : "E0";
      const proposed =
        typeof signal.proposed_change === "object" && signal.proposed_change !== null
          ? (signal.proposed_change as Record<string, unknown>)
          : null;
      const evaluation =
        typeof signal.evaluation === "object" && signal.evaluation !== null
          ? (signal.evaluation as Record<string, unknown>)
          : null;
      const available = Boolean(signal.manifest_digest) && !signal.terminal;
      const availability = available
        ? { available: true as const }
        : {
            available: false as const,
            reason: "A terminal decision or missing manifest prevents review.",
          };
      return {
        candidateId: String(signal.candidate_id),
        evidenceLevel,
        observedFailure: String(signal.observed_failure ?? "Observed correction"),
        correctionIntent: String(signal.correction_intent ?? ""),
        proposedChange: proposed
          ? {
              diff: typeof proposed.diff === "string" ? proposed.diff : undefined,
              summary: typeof proposed.summary === "string" ? proposed.summary : undefined,
            }
          : null,
        evaluation: evaluation
          ? {
              summary: String(evaluation.summary ?? "Evaluation recorded"),
              regressions: Array.isArray(evaluation.regressions)
                ? evaluation.regressions.map(String)
                : [],
            }
          : null,
        limitations: Array.isArray(signal.limitations)
          ? signal.limitations.map(String)
          : ["Review hypothesis only; no skill change is applied from this surface."],
        manifestDigest: String(signal.manifest_digest ?? ""),
        provenance: Array.isArray(signal.provenance)
          ? signal.provenance.map(String)
          : ["Candidate manifest"],
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

const SELF_HOST_CORRECTION_STUDIES: NonNullable<DashboardHostAdapter["correctionStudies"]> = {
  access: "unavailable",
  reason: "Correction studies require connected local agent data.",
};

export function createLocalHostAdapter(
  host: Extract<DashboardHostKind, "local" | "selfhost"> = "local",
  profiles?: ServerProfileController,
): DashboardHostAdapter {
  const isSelfHost = host === "selfhost";
  return {
    ...localHostIdentity(host),
    authentication: LOCAL_AUTHENTICATION,
    queries: LOCAL_QUERIES,
    navigation: LOCAL_NAVIGATION,
    mutations: LOCAL_MUTATIONS,
    permissions: LOCAL_PERMISSIONS,
    library: isSelfHost ? SELF_HOST_LIBRARY : LOCAL_LIBRARY,
    projects: isSelfHost ? SELF_HOST_PROJECTS : LOCAL_PROJECTS,
    decisions: isSelfHost ? SELF_HOST_DECISIONS : LOCAL_DECISIONS,
    correctionStudies: isSelfHost ? SELF_HOST_CORRECTION_STUDIES : LOCAL_CORRECTION_STUDIES,
    profiles,
  };
}

export const localHostAdapter = createLocalHostAdapter();
export const selfHostAdapter = createLocalHostAdapter("selfhost");
export const LOCAL_CAPABILITIES = capabilitiesFromAdapter(localHostAdapter);
export const SELF_HOST_CAPABILITIES = capabilitiesFromAdapter(selfHostAdapter);
