/* oxlint-disable max-lines, no-await-in-loop -- assignment integrity and durable lifecycle steps are deliberately explicit */
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, platform as nodePlatform } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  canonicalHostedSkillSetUpdatePolicy,
  decodePortableSkillSetEnvelope,
  type HostedInstallerAgent,
  type HostedSkillSetAssignment,
  type HostedSkillSetAssignmentListReceipt,
  type HostedSkillSetAssignmentPackageMetadata,
  type HostedSkillSetInstallationReceiptRequest,
  type HostedSkillSetInstallationReceiptResponse,
  type HostedSkillSetReceiptFailureCode,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";

import {
  installLocalSubject,
  InstallerMaterializationError,
  InstallerPlanningError,
  makeInstallAuthorizationAuthority,
  planLocalInstall,
  recoverLocalInstallOperations,
  rollbackLocalInstalls,
  type InstallerAgent,
  type InstallerMaterializationAuthorities,
  type InstallerOsObservationAuthority,
  type InstallerPlanningAuthorities,
  type InstallerPlatform,
  type InstallSubject,
  type LocalInstallRequest,
  type RootObservation,
} from "./installer/index.js";
import type { TeamContributionAssignmentContext } from "./team-contribution.js";

const STATE_VERSION = 1 as const;
const STATE_DIRECTORY = "team-assignments";
const STATE_FILE = "state-v1.json";
const PACKAGE_CACHE_DIRECTORY = "verified-packages";
const SUPPORTED_AGENTS = new Set<InstallerAgent>([
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "pi",
]);

export class TeamSkillSetAssignmentError extends Error {
  readonly name = "TeamSkillSetAssignmentError";

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface HostedAssignmentPackage {
  readonly bytes: Uint8Array;
  readonly metadata: HostedSkillSetAssignmentPackageMetadata;
}

export interface TeamSkillSetAssignmentHostedClient {
  readonly listSkillSetAssignments: (input?: {
    readonly limit?: number;
  }) => Promise<HostedSkillSetAssignmentListReceipt>;
  readonly downloadSkillSetAssignmentPackage: (
    assignmentId: string,
  ) => Promise<HostedAssignmentPackage>;
  readonly submitSkillSetInstallationReceipt: (
    input: HostedSkillSetInstallationReceiptRequest,
  ) => Promise<HostedSkillSetInstallationReceiptResponse>;
}

export interface TeamAssignmentInstallChoice {
  readonly assignmentId: string;
  readonly scope?: "global" | "project";
  readonly projectRoot?: string;
  readonly targetAgents?: ReadonlyArray<InstallerAgent>;
}

export interface TeamAssignmentInstallPreview {
  readonly ready: boolean;
  readonly assignmentId: string;
  readonly requestId: string;
  readonly releaseId: string;
  readonly releaseName: string;
  readonly releaseSequence: number;
  readonly publisherName: string | null;
  readonly skillSetRevisionSha256: string;
  readonly envelopeSha256: string;
  readonly scope: "global" | "project";
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly licenseExpression: string;
    readonly revisionSha256: string;
    readonly packagePaths: ReadonlyArray<string>;
  }>;
  readonly tools: ReadonlyArray<InstallerAgent>;
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly status: "passed" | "needs_review" | "blocked" | "not_recorded";
    readonly title: string;
    readonly detail: string;
  }>;
  readonly conflicts: ReadonlyArray<{
    readonly code: string;
    readonly title: string;
    readonly detail: string;
    readonly packagePath: string | null;
    readonly blocking: boolean;
  }>;
}

export interface TeamAssignmentInstallInput {
  readonly assignmentId: string;
  readonly requestId: string;
  readonly expectedReleaseId: string;
  readonly expectedSkillSetRevisionSha256: string;
  readonly expectedEnvelopeSha256: string;
  readonly confirmInstall: true;
}

export interface TeamAssignmentInstallReceipt {
  readonly assignmentId: string;
  readonly requestId: string;
  readonly releaseId: string;
  readonly receiptId: string;
  readonly installedAt: string;
  readonly status: "current";
  readonly receiptPending: boolean;
  readonly syncStatus: "synced" | "pending" | "failed";
}

export interface TeamAssignmentRollbackInput {
  readonly assignmentId: string;
  readonly receiptId: string;
  readonly confirmRollback: true;
}

export interface TeamAssignmentRollbackReceipt {
  readonly assignmentId: string;
  readonly requestId: string;
  readonly releaseId: string;
  readonly receiptId: string;
  readonly rolledBackAt: string;
  readonly status: "rolled_back";
  readonly receiptPending: boolean;
  readonly syncStatus: "synced" | "pending" | "failed";
}

export interface TeamAssignmentListItem {
  readonly assignment: HostedSkillSetAssignment;
  readonly localStatus: "unknown" | "current" | "failed" | "rolled_back";
  readonly localReceiptId: string | null;
  readonly receiptPending: boolean;
  readonly syncStatus: "synced" | "pending" | "failed";
  readonly canInstall: boolean;
  readonly canRollback: boolean;
}

export type TeamAutomaticUpdateBlocker =
  | "policy_not_automatic"
  | "local_conflict"
  | "stale_base"
  | "readiness_not_ready"
  | "local_policy_evidence_missing"
  | "release_not_promoted"
  | "dependency_lock_mismatch"
  | "recipient_review_required";

export interface TeamAutomaticUpdateEvidence {
  readonly hasLocalConflict: boolean;
  readonly hasCurrentBase: boolean;
  readonly hasLocalPolicyEvidence: boolean;
  readonly dependencyLockMatches: boolean;
  readonly recipientReviewRequired: boolean;
}

export function evaluateTeamAutomaticUpdate(
  assignment: HostedSkillSetAssignment,
  evidence: TeamAutomaticUpdateEvidence,
): { readonly automatic: boolean; readonly blockers: readonly TeamAutomaticUpdateBlocker[] } {
  const blockers: TeamAutomaticUpdateBlocker[] = [];
  if (canonicalHostedSkillSetUpdatePolicy(assignment.update_policy) !== "automatic")
    blockers.push("policy_not_automatic");
  if (evidence.hasLocalConflict) blockers.push("local_conflict");
  if (!evidence.hasCurrentBase) blockers.push("stale_base");
  if (assignment.readiness.status !== "ready") blockers.push("readiness_not_ready");
  if (!evidence.hasLocalPolicyEvidence) blockers.push("local_policy_evidence_missing");
  if (assignment.release_lifecycle !== "promoted") blockers.push("release_not_promoted");
  if (!evidence.dependencyLockMatches) blockers.push("dependency_lock_mismatch");
  if (evidence.recipientReviewRequired) blockers.push("recipient_review_required");
  return { automatic: blockers.length === 0, blockers };
}

interface StoredPreview {
  readonly confirmationRequestId: string;
  readonly assignmentId: string;
  readonly assignmentRequestId: string;
  readonly releaseId: string;
  readonly skillSetRevisionSha256: string;
  readonly envelopeSha256: string;
  readonly scope: "global" | "project";
  readonly projectRoot: string | null;
  readonly targetAgents: ReadonlyArray<InstallerAgent>;
  readonly previewToken: string;
  readonly expectedReceiptIds: ReadonlyArray<string>;
  readonly expectedChangedReceiptIds: ReadonlyArray<string>;
  readonly changedSkillCount: number;
  readonly blockedSkillCount: number;
  readonly previewedAt: number;
}

interface StoredPendingInstall {
  readonly assignmentId: string;
  readonly assignmentRequestId: string;
  readonly installRequestId: string;
  readonly releaseId: string;
  readonly skillSetRevisionSha256: string;
  readonly envelopeSha256: string;
  readonly receiptId: string;
  readonly expectedReceiptIds: ReadonlyArray<string>;
  readonly expectedChangedReceiptIds: ReadonlyArray<string>;
  readonly scope: "global" | "project";
  readonly targetAgents: ReadonlyArray<InstallerAgent>;
  readonly changedSkillCount: number;
  readonly installedAt: number;
  readonly lifecycleSequence: number;
}

interface StoredBinding {
  readonly assignmentId: string;
  readonly assignmentRequestId: string;
  readonly installRequestId: string;
  readonly releaseId: string;
  readonly skillSetRevisionSha256: string;
  readonly envelopeSha256: string;
  readonly receiptId: string;
  readonly robustReceiptIds: ReadonlyArray<string>;
  readonly scope: "global" | "project";
  readonly targetAgents: ReadonlyArray<InstallerAgent>;
  readonly changedSkillCount: number;
  readonly lifecycleSequence: number;
  readonly failureCode: HostedSkillSetReceiptFailureCode | null;
  readonly state: "current" | "rolled_back" | "failed";
  readonly installedAt: number;
  readonly rolledBackAt: number | null;
}

interface StoredPendingRollback {
  readonly assignmentId: string;
  readonly binding: StoredBinding;
  readonly rolledBackAt: number;
  readonly lifecycleSequence: number;
}

interface StoredOutboxItem {
  readonly request: HostedSkillSetInstallationReceiptRequest;
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly deliveredAt: number | null;
  readonly terminalFailureAt: number | null;
  readonly hostedReceiptId: string | null;
}

interface TeamAssignmentState {
  readonly version: typeof STATE_VERSION;
  readonly previews: Record<string, StoredPreview>;
  readonly pendingInstalls: Record<string, StoredPendingInstall>;
  readonly pendingRollbacks: Record<string, StoredPendingRollback>;
  readonly bindings: Record<string, StoredBinding>;
  readonly outbox: Record<string, StoredOutboxItem>;
}

function emptyState(): TeamAssignmentState {
  return {
    version: STATE_VERSION,
    previews: {},
    pendingInstalls: {},
    pendingRollbacks: {},
    bindings: {},
    outbox: {},
  };
}

function digest(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function fail(code: string, message: string, retryable = false): never {
  throw new TeamSkillSetAssignmentError(code, message, retryable);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function validateState(input: unknown): TeamAssignmentState {
  if (
    !isRecord(input) ||
    input.version !== STATE_VERSION ||
    !isRecord(input.previews) ||
    !isRecord(input.bindings) ||
    !isRecord(input.outbox)
  )
    return fail("ASSIGNMENT_STATE_CORRUPT", "The local team assignment state is invalid.");
  return {
    ...(input as unknown as TeamAssignmentState),
    pendingInstalls: isRecord(input.pendingInstalls)
      ? (input.pendingInstalls as Record<string, StoredPendingInstall>)
      : {},
    pendingRollbacks: isRecord(input.pendingRollbacks)
      ? (input.pendingRollbacks as Record<string, StoredPendingRollback>)
      : {},
  };
}

function makeStateStore(configRoot: string) {
  const directory = join(configRoot, STATE_DIRECTORY);
  const path = join(directory, STATE_FILE);
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<TeamAssignmentState> => {
    try {
      return validateState(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (cause) {
      if (cause instanceof TeamSkillSetAssignmentError) throw cause;
      if (isRecord(cause) && cause.code === "ENOENT") return emptyState();
      return fail("ASSIGNMENT_STATE_CORRUPT", "The local team assignment state could not be read.");
    }
  };
  const save = async (state: TeamAssignmentState): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  };
  const exclusive = <A>(run: (state: TeamAssignmentState) => Promise<A>): Promise<A> => {
    const next = queue.then(async () => run(await load()));
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => exclusive(async (state) => state),
    update: (
      update: (state: TeamAssignmentState) => TeamAssignmentState | Promise<TeamAssignmentState>,
    ) =>
      exclusive(async (state) => {
        const changed = await update(state);
        await save(changed);
        return changed;
      }),
  } as const;
}

function installerError(cause: unknown): TeamSkillSetAssignmentError {
  if (cause instanceof TeamSkillSetAssignmentError) return cause;
  if (cause instanceof InstallerPlanningError || cause instanceof InstallerMaterializationError)
    return new TeamSkillSetAssignmentError(cause.code, cause.message);
  return new TeamSkillSetAssignmentError(
    "ASSIGNMENT_INSTALL_FAILED",
    cause instanceof Error ? cause.message : "The team assignment operation failed.",
  );
}

function exactArray(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function verifyPackage(
  assignment: HostedSkillSetAssignment,
  downloaded: HostedAssignmentPackage,
) {
  const { metadata, bytes } = downloaded;
  if (
    metadata.assignment_id !== assignment.assignment_id ||
    metadata.release_id !== assignment.release_id ||
    metadata.envelope_sha256 !== assignment.envelope_sha256 ||
    metadata.byte_length !== assignment.byte_length ||
    bytes.byteLength !== assignment.byte_length ||
    digest(bytes) !== assignment.envelope_sha256
  )
    return fail(
      "PACKAGE_BINDING_MISMATCH",
      "The downloaded package does not match the assigned release.",
    );
  const decoded = await Effect.runPromise(decodePortableSkillSetEnvelope(bytes)).catch((cause) =>
    fail(
      "PACKAGE_BINDING_MISMATCH",
      cause instanceof Error ? cause.message : "The assigned package is not a canonical envelope.",
    ),
  );
  if (
    decoded.portableSkillSetEnvelopeSha256 !== assignment.envelope_sha256 ||
    decoded.envelope.sourceManifest.skillSetId !== assignment.skill_set_id ||
    decoded.envelope.skillSetRevisionSha256 !== assignment.skill_set_revision_sha256 ||
    decoded.envelope.components.length !== assignment.components.length ||
    !exactArray(decoded.envelope.sourceManifest.harnesses, assignment.harnesses)
  )
    return fail(
      "PACKAGE_BINDING_MISMATCH",
      "The portable envelope is not bound to the assigned Skill Set revision.",
    );
  for (const [index, component] of decoded.envelope.components.entries()) {
    const summary = assignment.components[index];
    if (
      !summary ||
      summary.name !== component.logicalSkillId ||
      summary.license_expression !== component.terms.licenseExpression
    )
      return fail(
        "PACKAGE_BINDING_MISMATCH",
        "The portable envelope contents differ from the reviewed assignment summary.",
      );
  }
  return decoded;
}

function selectedAgents(
  assignment: HostedSkillSetAssignment,
  requested?: ReadonlyArray<InstallerAgent>,
): ReadonlyArray<InstallerAgent> {
  const agents: ReadonlyArray<string> = requested ?? assignment.harnesses;
  if (
    agents.length === 0 ||
    new Set(agents).size !== agents.length ||
    agents.some(
      (agent) =>
        !SUPPORTED_AGENTS.has(agent as InstallerAgent) || !assignment.harnesses.includes(agent),
    )
  )
    return fail(
      "ASSIGNMENT_TARGET_MISMATCH",
      "Install targets must be unique supported tools included in the assigned release.",
    );
  return agents.map((agent) => agent as InstallerAgent);
}

function installerAgentLabel(agent: InstallerAgent): string {
  switch (agent) {
    case "claude_code":
      return "Claude Code";
    case "openclaw":
      return "OpenClaw";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
  }
}

function packageSubject(
  assignment: HostedSkillSetAssignment,
  decoded: Awaited<ReturnType<typeof verifyPackage>>,
) {
  const packages = new Map<
    string,
    {
      readonly sealedBytes: Uint8Array;
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly bytes: Uint8Array;
      }>;
    }
  >();
  const skills = decoded.envelope.components.map((component, index) => {
    const packaged = decoded.components[index];
    if (!packaged)
      return fail("PACKAGE_BINDING_MISMATCH", "The assigned component package is missing.");
    const sealedBytes = new TextEncoder().encode(JSON.stringify(component.package));
    const objectId = `assignment:${assignment.assignment_id}:${component.logicalSkillId}`;
    const files = packaged.package.files.map((file) => ({
      path: file.path,
      bytes: file.content,
    }));
    packages.set(objectId, { sealedBytes, files });
    return {
      name: component.logicalSkillId,
      logicalSkillId: component.logicalSkillId,
      logicalVersion: component.sourceRevisionSha256,
      distributionId: assignment.release_id,
      shareId: `assignment:${assignment.assignment_id}`,
      handoffId: `release:${assignment.release_id}`,
      sealedPackageSha256: component.sealedPackageObjectSha256,
      signature: {
        algorithm: "selftune-hosted-release-v1",
        keyId: assignment.release_id,
        value: assignment.envelope_sha256,
      },
      license: {
        spdxExpression: component.terms.licenseExpression,
        licenseFile: component.terms.licenseFile,
        notices: component.terms.notices,
      },
      consent: {
        consentId: assignment.assignment_id,
        recipientPrincipalId: assignment.assignment_id,
        recordedAt: new Date(assignment.assigned_at).toISOString(),
        action: "install_with_selftune" as const,
        disclosureSha256: assignment.envelope_sha256,
        termsAccepted: true as const,
        contributorSignals: "not_granted" as const,
        contributorSignalRecipientOwnerId: null,
        contributorSignalAllowedFields: [],
        lifecycleReporting: "not_granted" as const,
        lifecycleAllowedFields: [],
      },
      source: { kind: "remote_sealed" as const, objectId },
      files: files.map((file) => ({
        path: file.path,
        sha256: digest(file.bytes),
        byteLength: file.bytes.byteLength,
        kind: "file" as const,
      })),
    };
  });
  const subject: InstallSubject = {
    kind: "skill_set",
    skillSetId: assignment.skill_set_id,
    logicalVersion: assignment.skill_set_revision_sha256,
    sealedPackageSha256: assignment.envelope_sha256,
    skills,
  };
  return { subject, packages } as const;
}

function bootstrapToken(
  assignment: HostedSkillSetAssignment,
  request: Omit<LocalInstallRequest, "installBootstrapToken">,
): string {
  return `assignment_bootstrap_${digest(
    JSON.stringify({
      assignmentId: assignment.assignment_id,
      requestId: assignment.request_id,
      releaseId: assignment.release_id,
      envelopeSha256: assignment.envelope_sha256,
      request,
    }),
  )}`;
}

function installerContext(
  assignment: HostedSkillSetAssignment,
  decoded: Awaited<ReturnType<typeof verifyPackage>>,
  choice: {
    readonly scope: "global" | "project";
    readonly projectRoot: string | null;
    readonly targetAgents: ReadonlyArray<InstallerAgent>;
  },
  basePlanning: Omit<InstallerPlanningAuthorities, "authorization">,
  baseMaterialization: Omit<InstallerMaterializationAuthorities, "packages">,
) {
  const packaged = packageSubject(assignment, decoded);
  const withoutToken = {
    scope: choice.scope,
    ...(choice.projectRoot === null ? {} : { projectRoot: choice.projectRoot }),
    targetAgents: choice.targetAgents,
    unmanagedPolicy: "cancel" as const,
  };
  const token = bootstrapToken(assignment, withoutToken);
  const request: LocalInstallRequest = {
    installBootstrapToken: token,
    ...withoutToken,
  };
  return {
    request,
    planning: {
      ...basePlanning,
      authorization: makeInstallAuthorizationAuthority((candidate) =>
        candidate === token
          ? Effect.succeed({ subject: packaged.subject })
          : Effect.fail(
              InstallerPlanningError.make({
                code: "INSTALL_AUTHORIZATION_INVALID",
                message: "The assignment install authorization no longer matches.",
                path: null,
              }),
            ),
      ),
    } satisfies InstallerPlanningAuthorities,
    materialization: {
      ...baseMaterialization,
      packages: {
        load: (skill) => {
          if (skill.source.kind !== "remote_sealed")
            return Effect.fail(
              InstallerMaterializationError.make({
                code: "ASSIGNMENT_PACKAGE_SOURCE_INVALID",
                message: "Team assignments require a sealed hosted package source.",
                path: null,
              }),
            );
          const value = packaged.packages.get(skill.source.objectId);
          return value
            ? Effect.succeed(value)
            : Effect.fail(
                InstallerMaterializationError.make({
                  code: "ASSIGNMENT_PACKAGE_SOURCE_MISSING",
                  message: "A verified assignment component package is missing.",
                  path: null,
                }),
              );
        },
      },
    } satisfies InstallerMaterializationAuthorities,
  } as const;
}

function receiptRequest(input: {
  readonly binding: StoredBinding;
  readonly result: "current" | "failed" | "rolled_back";
  readonly occurredAt: number;
  readonly blockedSkillCount: number;
  readonly failureCode: HostedSkillSetReceiptFailureCode | null;
}): HostedSkillSetInstallationReceiptRequest {
  const requestId = `${input.result}_v1_${digest(
    `${input.binding.receiptId}:${input.binding.releaseId}:${input.binding.lifecycleSequence}:${input.result}`,
  ).slice(0, 32)}`;
  const common = {
    request_id: requestId,
    assignment_id: input.binding.assignmentId,
    release_id: input.binding.releaseId,
    lifecycle_sequence: input.binding.lifecycleSequence,
    coarse_scope: input.binding.scope,
    target_agents: input.binding.targetAgents as ReadonlyArray<HostedInstallerAgent>,
    changed_skill_count: input.binding.changedSkillCount,
    blocked_skill_count: input.blockedSkillCount,
    occurred_at: input.occurredAt,
  };
  if (input.result === "failed") {
    return {
      ...common,
      result: "failed",
      rollback_pointer: null,
      failure_code: input.failureCode ?? "INSTALL_FAILED",
    };
  }
  return {
    ...common,
    result: input.result,
    rollback_pointer: input.binding.receiptId,
    failure_code: null,
  };
}

function lifecycleFailureCode(
  cause: TeamSkillSetAssignmentError,
): HostedSkillSetReceiptFailureCode {
  if (cause.code === "PACKAGE_BINDING_MISMATCH") return "PACKAGE_INTEGRITY_FAILED";
  if (cause.code.includes("CONFLICT")) return "INSTALL_CONFLICT";
  if (
    cause.code === "STALE_ASSIGNMENT_PREVIEW" ||
    cause.code === "INSTALL_TARGET_CHANGED" ||
    cause.code === "INSTALL_NOOP_RECEIPT_CHANGED" ||
    cause.code === "INSTALL_PLAN_CHANGED"
  )
    return "LOCAL_STATE_CHANGED";
  if (cause.code.includes("ROLLBACK_FAILED") || cause.code.includes("RECOVERY"))
    return "RECOVERY_FAILED";
  return "INSTALL_FAILED";
}

function nextLifecycleSequence(
  assignment: HostedSkillSetAssignment,
  state: TeamAssignmentState,
): number {
  return (
    Math.max(
      assignment.observed.lifecycle_sequence ?? 0,
      state.bindings[assignment.assignment_id]?.lifecycleSequence ?? 0,
      ...Object.values(state.outbox)
        .filter((item) => item.request.assignment_id === assignment.assignment_id)
        .map((item) => item.request.lifecycle_sequence),
    ) + 1
  );
}

function currentReceiptSyncStatus(
  state: TeamAssignmentState,
  binding: StoredBinding,
): "synced" | "pending" | "failed" {
  const current = Object.values(state.outbox).find(
    (item) =>
      item.request.assignment_id === binding.assignmentId &&
      item.request.release_id === binding.releaseId &&
      item.request.result === binding.state &&
      item.request.lifecycle_sequence === binding.lifecycleSequence,
  );
  if (!current || current.deliveredAt !== null) return "synced";
  return current.terminalFailureAt ? "failed" : "pending";
}

function withoutKey<A>(values: Record<string, A>, key: string): Record<string, A> {
  const next = { ...values };
  delete next[key];
  return next;
}

function currentBinding(pending: StoredPendingInstall): StoredBinding {
  return {
    assignmentId: pending.assignmentId,
    assignmentRequestId: pending.assignmentRequestId,
    installRequestId: pending.installRequestId,
    releaseId: pending.releaseId,
    skillSetRevisionSha256: pending.skillSetRevisionSha256,
    envelopeSha256: pending.envelopeSha256,
    receiptId: pending.receiptId,
    robustReceiptIds: pending.expectedReceiptIds,
    scope: pending.scope,
    targetAgents: pending.targetAgents,
    changedSkillCount: pending.changedSkillCount,
    lifecycleSequence: pending.lifecycleSequence,
    failureCode: null,
    state: "current",
    installedAt: pending.installedAt,
    rolledBackAt: null,
  };
}

function failedBinding(
  pending: StoredPendingInstall,
  failureCode: HostedSkillSetReceiptFailureCode,
): StoredBinding {
  return {
    ...currentBinding(pending),
    receiptId: `failure_v1_${digest(
      `${pending.assignmentId}:${pending.releaseId}:${pending.lifecycleSequence}`,
    ).slice(0, 32)}`,
    robustReceiptIds: [],
    changedSkillCount: 0,
    failureCode,
    state: "failed",
  };
}

function persistLifecycle(
  state: TeamAssignmentState,
  binding: StoredBinding,
  result: "current" | "failed" | "rolled_back",
  occurredAt: number,
  blockedSkillCount: number,
): TeamAssignmentState {
  const outbound = receiptRequest({
    binding,
    result,
    occurredAt,
    blockedSkillCount,
    failureCode: binding.failureCode,
  });
  return {
    ...state,
    pendingInstalls: withoutKey(state.pendingInstalls, binding.assignmentId),
    pendingRollbacks: withoutKey(state.pendingRollbacks, binding.assignmentId),
    bindings: { ...state.bindings, [binding.assignmentId]: binding },
    outbox: {
      ...state.outbox,
      [outbound.request_id]: state.outbox[outbound.request_id] ?? {
        request: outbound,
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        terminalFailureAt: null,
        hostedReceiptId: null,
      },
    },
  };
}

export interface TeamSkillSetAssignmentRuntimeOptions {
  readonly configRoot: string;
  readonly hosted: TeamSkillSetAssignmentHostedClient;
  readonly planning: Omit<InstallerPlanningAuthorities, "authorization">;
  readonly materialization: Omit<InstallerMaterializationAuthorities, "packages">;
  readonly now?: () => number;
  /** Test seam that simulates process loss after SQLite commit and before JSON finalization. */
  readonly afterInstallerCommit?: () => Promise<void> | void;
  /** Test seam that simulates process loss after aggregate Undo commits. */
  readonly afterRollbackCommit?: () => Promise<void> | void;
}

export function makeTeamSkillSetAssignmentRuntime(options: TeamSkillSetAssignmentRuntimeOptions) {
  const stateStore = makeStateStore(options.configRoot);
  const now = options.now ?? Date.now;
  let lifecycleQueue: Promise<unknown> = Promise.resolve();
  const serialized = <A>(run: () => Promise<A>): Promise<A> => {
    const next = lifecycleQueue.then(run);
    lifecycleQueue = next.catch(() => undefined);
    return next;
  };

  const currentAssignment = async (assignmentId: string) => {
    const listed = await options.hosted.listSkillSetAssignments({ limit: 100 });
    const matches = listed.assignments.filter(
      (assignment) => assignment.assignment_id === assignmentId,
    );
    if (matches.length !== 1)
      return fail(
        "ASSIGNMENT_UNAVAILABLE",
        "The assignment is missing, revoked, or no longer available to this device.",
      );
    return matches[0]!;
  };

  const cacheVerifiedPackage = async (assignment: HostedSkillSetAssignment, bytes: Uint8Array) => {
    const directory = join(options.configRoot, STATE_DIRECTORY, PACKAGE_CACHE_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${assignment.release_id}-${assignment.envelope_sha256}.json`);
    try {
      const existing = new Uint8Array(await readFile(path));
      if (
        existing.byteLength === bytes.byteLength &&
        digest(existing) === assignment.envelope_sha256
      )
        return;
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "ENOENT") throw cause;
    }
    const temporary = join(directory, `.package-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  };

  const finalizeCurrentInstallUnlocked = async (pending: StoredPendingInstall) => {
    const binding = currentBinding(pending);
    await stateStore.update(async (state) =>
      state.pendingInstalls[pending.assignmentId]
        ? persistLifecycle(state, binding, "current", pending.installedAt, 0)
        : state,
    );
    return binding;
  };

  const recordFailedInstallUnlocked = async (
    pending: StoredPendingInstall,
    failureCode: HostedSkillSetReceiptFailureCode,
  ) => {
    const binding = failedBinding(pending, failureCode);
    await stateStore.update(async (state) =>
      persistLifecycle(
        state,
        binding,
        "failed",
        now(),
        Math.max(1, pending.expectedChangedReceiptIds.length),
      ),
    );
    return binding;
  };

  const reconcilePendingInstallsUnlocked = async () => {
    let state = await stateStore.read();
    if (
      Object.keys(state.pendingInstalls).length > 0 ||
      Object.keys(state.pendingRollbacks).length > 0
    ) {
      await Effect.runPromise(
        recoverLocalInstallOperations(
          options.planning.commitLock,
          options.materialization as InstallerMaterializationAuthorities,
        ),
      ).catch((cause) => Promise.reject(installerError(cause)));
      state = await stateStore.read();
    }
    let recovered = 0;
    for (const pending of Object.values(state.pendingInstalls)) {
      const receipts = await Promise.all(
        pending.expectedReceiptIds.map((receiptId) =>
          Effect.runPromise(options.materialization.receipts.readReceipt(receiptId)).catch(
            (cause) => Promise.reject(installerError(cause)),
          ),
        ),
      );
      const activeIds = new Set(
        receipts
          .filter((receipt) => receipt?.state === "active")
          .map((receipt) => receipt!.receiptId),
      );
      const complete = pending.expectedReceiptIds.every((receiptId) => activeIds.has(receiptId));
      if (complete) {
        await finalizeCurrentInstallUnlocked(pending);
        recovered += 1;
        continue;
      }
      const committedChangedReceipts = pending.expectedChangedReceiptIds.filter((receiptId) =>
        activeIds.has(receiptId),
      );
      if (committedChangedReceipts.length === 0) {
        await stateStore.update(async (latest) => ({
          ...latest,
          pendingInstalls: withoutKey(latest.pendingInstalls, pending.assignmentId),
        }));
        continue;
      }
      await recordFailedInstallUnlocked(pending, "RECOVERY_FAILED");
    }
    state = await stateStore.read();
    for (const pending of Object.values(state.pendingRollbacks)) {
      const receipts = await Promise.all(
        pending.binding.robustReceiptIds.map((receiptId) =>
          Effect.runPromise(options.materialization.receipts.readReceipt(receiptId)).catch(
            (cause) => Promise.reject(installerError(cause)),
          ),
        ),
      );
      if (receipts.every((receipt) => receipt?.state === "removed")) {
        const rolledBackBinding: StoredBinding = {
          ...pending.binding,
          lifecycleSequence: pending.lifecycleSequence,
          failureCode: null,
          state: "rolled_back",
          rolledBackAt: pending.rolledBackAt,
        };
        await stateStore.update(async (latest) =>
          persistLifecycle(latest, rolledBackBinding, "rolled_back", pending.rolledBackAt, 0),
        );
        recovered += 1;
        continue;
      }
      if (receipts.every((receipt) => receipt?.state === "active")) {
        await stateStore.update(async (latest) => ({
          ...latest,
          pendingRollbacks: withoutKey(latest.pendingRollbacks, pending.assignmentId),
        }));
        continue;
      }
      return fail(
        "ASSIGNMENT_ROLLBACK_RECOVERY_FAILED",
        "Undo could not reconcile every receipt-owned install. SelfTune left the assignment blocked for review.",
      );
    }
    return recovered;
  };

  const flushPendingReceiptsUnlocked = async () => {
    await reconcilePendingInstallsUnlocked();
    const state = await stateStore.read();
    let sent = 0;
    for (const item of Object.values(state.outbox).filter(
      (candidate) => candidate.deliveredAt === null,
    )) {
      const attemptedAt = now();
      try {
        const response = await options.hosted.submitSkillSetInstallationReceipt(item.request);
        if (
          response.assignment_id !== item.request.assignment_id ||
          response.release_id !== item.request.release_id ||
          response.lifecycle_sequence !== item.request.lifecycle_sequence ||
          response.status !== item.request.result
        )
          return fail(
            "RECEIPT_BINDING_MISMATCH",
            "Cloud returned a receipt for a different assignment lifecycle event.",
          );
        await stateStore.update(async (latest) => ({
          ...latest,
          outbox: {
            ...latest.outbox,
            [item.request.request_id]: {
              ...(latest.outbox[item.request.request_id] ?? item),
              attempts: item.attempts + 1,
              lastAttemptAt: attemptedAt,
              deliveredAt: attemptedAt,
              terminalFailureAt: null,
              hostedReceiptId: response.receipt_id,
            },
          },
        }));
        sent += 1;
      } catch (cause) {
        const terminalFailure = isRecord(cause) && cause.retryable === false;
        await stateStore.update(async (latest) => ({
          ...latest,
          outbox: {
            ...latest.outbox,
            [item.request.request_id]: {
              ...(latest.outbox[item.request.request_id] ?? item),
              attempts: item.attempts + 1,
              lastAttemptAt: attemptedAt,
              terminalFailureAt: terminalFailure
                ? attemptedAt
                : ((latest.outbox[item.request.request_id] ?? item).terminalFailureAt ?? null),
            },
          },
        }));
      }
    }
    const latest = await stateStore.read();
    return {
      sent,
      pending: Object.values(latest.outbox).filter((item) => item.deliveredAt === null).length,
    };
  };

  const listAssignments = () =>
    serialized(async (): Promise<ReadonlyArray<TeamAssignmentListItem>> => {
      await reconcilePendingInstallsUnlocked();
      const [listed, state] = await Promise.all([
        options.hosted.listSkillSetAssignments({ limit: 100 }),
        stateStore.read(),
      ]);
      return listed.assignments.map((assignment) => {
        const binding = state.bindings[assignment.assignment_id];
        const syncStatus = binding ? currentReceiptSyncStatus(state, binding) : "synced";
        const pending = syncStatus === "pending";
        const localStatus = binding ? binding.state : assignment.observed.status;
        return {
          assignment,
          localStatus,
          localReceiptId: binding?.receiptId ?? assignment.observed.receipt_id,
          receiptPending: pending,
          syncStatus,
          canInstall:
            assignment.readiness.status === "ready" &&
            (!binding ||
              binding.state !== "current" ||
              binding.releaseId !== assignment.release_id),
          canRollback: binding?.state === "current",
        };
      });
    });

  const previewInstall = (input: TeamAssignmentInstallChoice) =>
    serialized(async (): Promise<TeamAssignmentInstallPreview> => {
      await reconcilePendingInstallsUnlocked();
      const assignment = await currentAssignment(input.assignmentId);
      if (assignment.readiness.status !== "ready")
        return fail(
          "ASSIGNMENT_NOT_READY",
          "This release needs review before it can be installed.",
        );
      const scope = input.scope ?? "global";
      const projectRoot = scope === "project" ? (input.projectRoot ?? null) : null;
      if (scope === "project" && !projectRoot)
        return fail("PROJECT_ROOT_REQUIRED", "Choose a project before previewing this install.");
      const targetAgents = selectedAgents(assignment, input.targetAgents);
      const downloaded = await options.hosted.downloadSkillSetAssignmentPackage(
        assignment.assignment_id,
      );
      const decoded = await verifyPackage(assignment, downloaded);
      const context = installerContext(
        assignment,
        decoded,
        { scope, projectRoot, targetAgents },
        options.planning,
        options.materialization,
      );
      const plan = await Effect.runPromise(
        planLocalInstall(context.request, context.planning),
      ).catch((cause) => Promise.reject(installerError(cause)));
      const changedSkillCount = new Set(
        plan.receipts
          .filter((receipt) => !receipt.noOp)
          .map((receipt) => receipt.skill.logicalSkillId),
      ).size;
      const stored: StoredPreview = {
        confirmationRequestId: `install_preview_v1_${digest(plan.previewToken).slice(0, 32)}`,
        assignmentId: assignment.assignment_id,
        assignmentRequestId: assignment.request_id,
        releaseId: assignment.release_id,
        skillSetRevisionSha256: assignment.skill_set_revision_sha256,
        envelopeSha256: assignment.envelope_sha256,
        scope,
        projectRoot,
        targetAgents,
        previewToken: plan.previewToken,
        expectedReceiptIds: plan.receipts.map((receipt) => receipt.receiptId),
        expectedChangedReceiptIds: plan.receipts
          .filter((receipt) => !receipt.noOp)
          .map((receipt) => receipt.receiptId),
        changedSkillCount,
        blockedSkillCount: plan.conflicts.length,
        previewedAt: now(),
      };
      await stateStore.update(async (state) => ({
        ...state,
        previews: { ...state.previews, [stored.confirmationRequestId]: stored },
      }));
      return {
        ready: plan.ready,
        assignmentId: assignment.assignment_id,
        requestId: stored.confirmationRequestId,
        releaseId: assignment.release_id,
        releaseName: assignment.name,
        releaseSequence: assignment.sequence,
        publisherName: assignment.publisher_name,
        skillSetRevisionSha256: assignment.skill_set_revision_sha256,
        envelopeSha256: assignment.envelope_sha256,
        scope,
        skills: decoded.envelope.components.map((component, index) => ({
          name: component.logicalSkillId,
          licenseExpression: component.terms.licenseExpression,
          revisionSha256: component.sourceRevisionSha256,
          packagePaths: decoded.components[index]?.package.files.map((file) => file.path) ?? [],
        })),
        tools: targetAgents,
        checks: [
          {
            id: "install_destination",
            status: "passed",
            title: scope === "global" ? "Installs for all projects" : "Installs for one project",
            detail: `This installs on this device for ${targetAgents.map(installerAgentLabel).join(", ")}.`,
          },
          {
            id: "assignment_binding",
            status: "passed",
            title: "Release identity verified",
            detail: "The downloaded bytes match this exact assigned release.",
          },
          {
            id: "portable_envelope",
            status: "passed",
            title: "Portable Skill Set verified",
            detail: "Every packaged file and distribution term passed canonical validation.",
          },
          {
            id: "local_install_plan",
            status: plan.ready ? "passed" : "blocked",
            title: plan.ready ? "Install locations are ready" : "Local conflicts block install",
            detail: plan.ready
              ? "SelfTune rechecks these locations after confirmation."
              : "Resolve the listed local conflicts before installing.",
          },
        ],
        conflicts: plan.conflicts.map((conflict) => ({
          code: conflict.code,
          title: "Local install conflict",
          detail: conflict.details,
          packagePath: null,
          blocking: true,
        })),
      };
    });

  const install = (input: TeamAssignmentInstallInput) =>
    serialized(async (): Promise<TeamAssignmentInstallReceipt> => {
      if (input.confirmInstall !== true)
        return fail("INSTALL_CONFIRMATION_REQUIRED", "Confirm the reviewed install first.");
      await reconcilePendingInstallsUnlocked();
      const [assignment, state] = await Promise.all([
        currentAssignment(input.assignmentId),
        stateStore.read(),
      ]);
      const preview = state.previews[input.requestId];
      if (
        !preview ||
        preview.assignmentId !== input.assignmentId ||
        preview.assignmentRequestId !== assignment.request_id ||
        preview.releaseId !== input.expectedReleaseId ||
        preview.skillSetRevisionSha256 !== input.expectedSkillSetRevisionSha256 ||
        preview.envelopeSha256 !== input.expectedEnvelopeSha256 ||
        assignment.release_id !== input.expectedReleaseId ||
        assignment.skill_set_revision_sha256 !== input.expectedSkillSetRevisionSha256 ||
        assignment.envelope_sha256 !== input.expectedEnvelopeSha256
      )
        return fail(
          "STALE_ASSIGNMENT_PREVIEW",
          "The assignment changed after preview. Review the current release again.",
        );
      const existing = state.bindings[assignment.assignment_id];
      if (
        existing?.state === "current" &&
        existing.releaseId === assignment.release_id &&
        existing.envelopeSha256 === assignment.envelope_sha256
      ) {
        await flushPendingReceiptsUnlocked();
        const latest = await stateStore.read();
        const syncStatus = currentReceiptSyncStatus(latest, existing);
        return {
          assignmentId: existing.assignmentId,
          requestId: existing.installRequestId,
          releaseId: existing.releaseId,
          receiptId: existing.receiptId,
          installedAt: new Date(existing.installedAt).toISOString(),
          status: "current",
          receiptPending: syncStatus === "pending",
          syncStatus,
        };
      }
      const installedAt = now();
      const receiptId = `rollback_v1_${digest(
        `${assignment.assignment_id}:${assignment.release_id}:${preview.previewToken}`,
      ).slice(0, 32)}`;
      const pending: StoredPendingInstall = {
        assignmentId: assignment.assignment_id,
        assignmentRequestId: assignment.request_id,
        installRequestId: input.requestId,
        releaseId: assignment.release_id,
        skillSetRevisionSha256: assignment.skill_set_revision_sha256,
        envelopeSha256: assignment.envelope_sha256,
        receiptId,
        expectedReceiptIds: preview.expectedReceiptIds,
        expectedChangedReceiptIds: preview.expectedChangedReceiptIds,
        scope: preview.scope,
        targetAgents: preview.targetAgents,
        changedSkillCount: preview.changedSkillCount,
        installedAt,
        lifecycleSequence: nextLifecycleSequence(assignment, state),
      };
      let decoded: Awaited<ReturnType<typeof verifyPackage>>;
      try {
        const downloaded = await options.hosted.downloadSkillSetAssignmentPackage(
          assignment.assignment_id,
        );
        decoded = await verifyPackage(assignment, downloaded);
        await cacheVerifiedPackage(assignment, downloaded.bytes);
      } catch (cause) {
        const error = installerError(cause);
        await recordFailedInstallUnlocked(pending, lifecycleFailureCode(error));
        await flushPendingReceiptsUnlocked();
        throw error;
      }
      const context = installerContext(
        assignment,
        decoded,
        {
          scope: preview.scope,
          projectRoot: preview.projectRoot,
          targetAgents: preview.targetAgents,
        },
        options.planning,
        options.materialization,
      );
      await stateStore.update(async (latest) => ({
        ...latest,
        pendingInstalls: {
          ...latest.pendingInstalls,
          [pending.assignmentId]: pending,
        },
      }));
      let receipts: ReadonlyArray<{ readonly receiptId: string }>;
      try {
        receipts = await Effect.runPromise(
          installLocalSubject(
            context.request,
            preview.previewToken,
            context.planning,
            context.materialization,
          ),
        );
      } catch (cause) {
        const error = installerError(cause);
        await recordFailedInstallUnlocked(pending, lifecycleFailureCode(error));
        await flushPendingReceiptsUnlocked();
        throw error;
      }
      if (
        !exactArray(
          receipts.map((receipt) => receipt.receiptId),
          pending.expectedReceiptIds,
        )
      )
        return fail(
          "INSTALL_RECEIPT_BINDING_MISMATCH",
          "The installer receipts do not match the confirmed assignment preview.",
        );
      await options.afterInstallerCommit?.();
      const binding = await finalizeCurrentInstallUnlocked(pending);
      await flushPendingReceiptsUnlocked();
      const latest = await stateStore.read();
      const syncStatus = currentReceiptSyncStatus(latest, binding);
      return {
        assignmentId: binding.assignmentId,
        requestId: binding.installRequestId,
        releaseId: binding.releaseId,
        receiptId: binding.receiptId,
        installedAt: new Date(binding.installedAt).toISOString(),
        status: "current",
        receiptPending: syncStatus === "pending",
        syncStatus,
      };
    });

  const rollback = (input: TeamAssignmentRollbackInput) =>
    serialized(async (): Promise<TeamAssignmentRollbackReceipt> => {
      if (input.confirmRollback !== true)
        return fail("ROLLBACK_CONFIRMATION_REQUIRED", "Confirm Undo install first.");
      await reconcilePendingInstallsUnlocked();
      const state = await stateStore.read();
      const binding = state.bindings[input.assignmentId];
      if (!binding || binding.receiptId !== input.receiptId || binding.state !== "current")
        return fail(
          "ROLLBACK_BINDING_MISMATCH",
          "This Undo request does not match the active assignment install receipt.",
        );
      const pendingRollback: StoredPendingRollback = {
        assignmentId: binding.assignmentId,
        binding,
        rolledBackAt: now(),
        lifecycleSequence: binding.lifecycleSequence + 1,
      };
      await stateStore.update(async (latest) => ({
        ...latest,
        pendingRollbacks: {
          ...latest.pendingRollbacks,
          [binding.assignmentId]: pendingRollback,
        },
      }));
      const results = await Effect.runPromise(
        rollbackLocalInstalls(
          binding.robustReceiptIds,
          options.planning.commitLock,
          options.materialization as InstallerMaterializationAuthorities,
        ),
      ).catch((cause) => Promise.reject(installerError(cause)));
      if (results.some((result) => result.status !== "rolled_back")) {
        await stateStore.update(async (latest) => ({
          ...latest,
          pendingRollbacks: withoutKey(latest.pendingRollbacks, binding.assignmentId),
        }));
        return fail(
          "ROLLBACK_LOCAL_DRIFT",
          "Installed files changed after installation, so Undo was blocked without modifying them.",
        );
      }
      await options.afterRollbackCommit?.();
      const rolledBackAt = pendingRollback.rolledBackAt;
      const rolledBackBinding: StoredBinding = {
        ...binding,
        lifecycleSequence: pendingRollback.lifecycleSequence,
        failureCode: null,
        state: "rolled_back",
        rolledBackAt,
      };
      await stateStore.update(async (latest) =>
        persistLifecycle(latest, rolledBackBinding, "rolled_back", rolledBackAt, 0),
      );
      await flushPendingReceiptsUnlocked();
      const latest = await stateStore.read();
      const syncStatus = currentReceiptSyncStatus(latest, rolledBackBinding);
      return {
        assignmentId: binding.assignmentId,
        requestId: binding.installRequestId,
        releaseId: binding.releaseId,
        receiptId: binding.receiptId,
        rolledBackAt: new Date(rolledBackAt).toISOString(),
        status: "rolled_back",
        receiptPending: syncStatus === "pending",
        syncStatus,
      };
    });

  const contributionContext = (assignmentId: string) =>
    serialized(async (): Promise<TeamContributionAssignmentContext> => {
      await reconcilePendingInstallsUnlocked();
      const [assignment, state] = await Promise.all([
        currentAssignment(assignmentId),
        stateStore.read(),
      ]);
      const binding = state.bindings[assignmentId];
      if (!binding || binding.state !== "current" || binding.releaseId !== assignment.release_id)
        return fail(
          "CONTRIBUTION_ASSIGNMENT_NOT_CURRENT",
          "Install the current assignment before contributing an update.",
        );
      const cachePath = join(
        options.configRoot,
        STATE_DIRECTORY,
        PACKAGE_CACHE_DIRECTORY,
        `${assignment.release_id}-${assignment.envelope_sha256}.json`,
      );
      const baseEnvelopeBytes = new Uint8Array(
        await readFile(cachePath).catch(() =>
          fail(
            "CONTRIBUTION_BASE_UNAVAILABLE",
            "The cached verified base release is unavailable. Reinstall the current assignment first.",
          ),
        ),
      );
      await verifyPackage(assignment, {
        bytes: baseEnvelopeBytes,
        metadata: {
          assignment_id: assignment.assignment_id,
          release_id: assignment.release_id,
          envelope_sha256: assignment.envelope_sha256,
          byte_length: assignment.byte_length,
        },
      });
      const receipts = await Promise.all(
        binding.robustReceiptIds.map((receiptId) =>
          Effect.runPromise(options.materialization.receipts.readReceipt(receiptId)).catch(
            (cause) => Promise.reject(installerError(cause)),
          ),
        ),
      );
      const installedCopies = receipts.flatMap((receipt) =>
        receipt?.state === "active"
          ? [
              {
                receiptId: receipt.receiptId,
                agent: receipt.agent,
                skillName: receipt.logicalSkillId,
                targetPath: receipt.targetPath,
              },
            ]
          : [],
      );
      if (installedCopies.length !== binding.robustReceiptIds.length)
        return fail(
          "CONTRIBUTION_INSTALL_CHANGED",
          "The installed assignment changed locally. Reinstall it before contributing.",
        );
      return {
        assignmentId: assignment.assignment_id,
        assignmentRequestId: assignment.request_id,
        skillSetId: assignment.skill_set_id,
        releaseId: assignment.release_id,
        memberDeviceBinding: digest(
          `${assignment.assignment_id}:${assignment.request_id}:${binding.receiptId}`,
        ),
        baseEnvelopeBytes,
        installedCopies,
      };
    });

  return {
    listAssignments,
    previewInstall,
    install,
    rollback,
    flushPendingReceipts: () => serialized(flushPendingReceiptsUnlocked),
    contributionContext,
  } as const;
}

function platform(): InstallerPlatform {
  const current = nodePlatform();
  if (current === "darwin" || current === "linux" || current === "win32") return current;
  return fail("INSTALL_PLATFORM_UNSUPPORTED", "This operating system is not supported.");
}

function fileKind(stat: Awaited<ReturnType<typeof lstat>>, current: InstallerPlatform) {
  if (stat.isSymbolicLink())
    return current === "win32" ? ("reparse" as const) : ("symlink" as const);
  if (stat.isDirectory()) return "directory" as const;
  if (stat.isFile()) return "file" as const;
  return "special" as const;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function ancestors(
  path: string,
  current: InstallerPlatform,
): Promise<RootObservation["ancestors"]> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  const values: Array<RootObservation["ancestors"][number]> = [];
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!(await exists(cursor))) break;
    const kind = fileKind(await lstat(cursor), current);
    if (kind === "directory") values.push({ path: cursor, kind });
    else if (kind === "symlink" || kind === "reparse")
      values.push({ path: cursor, kind, resolvedPath: await realpath(cursor) });
    else break;
  }
  return values;
}

async function rootObservation(
  requestedPath: string,
  current: InstallerPlatform,
): Promise<RootObservation> {
  const stat = await lstat(requestedPath);
  return {
    requestedPath,
    canonicalPath: await realpath(requestedPath),
    exists: true,
    writable: await writable(requestedPath),
    kind: fileKind(stat, current),
    ancestors: await ancestors(requestedPath, current),
  };
}

async function nearestParent(path: string, current: InstallerPlatform): Promise<RootObservation> {
  let cursor = dirname(path);
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("No existing install parent was found.");
    cursor = parent;
  }
  return rootObservation(cursor, current);
}

async function inspectFiles(root: string) {
  const files: Array<{ path: string; sha256: string; kind: "file" }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile())
        files.push({
          path: relativePath,
          sha256: digest(await readFile(absolutePath)),
          kind: "file",
        });
      else throw new Error(`Unsafe special file at ${absolutePath}`);
    }
  };
  await visit(root, "");
  return files;
}

export interface NodeInstallerOsObservationOptions {
  readonly homeDirectory?: string;
  readonly configDirectory?: string | null;
}

/** Read-only OS authority. All assignment filesystem writes remain inside the robust materializer. */
export function makeNodeInstallerOsObservationAuthority(
  options: NodeInstallerOsObservationOptions = {},
): InstallerOsObservationAuthority {
  const current = platform();
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const configDirectory = options.configDirectory ? resolve(options.configDirectory) : null;
  const planningFailure = (cause: unknown) =>
    InstallerPlanningError.make({
      code: "INSTALL_OBSERVATION_FAILED",
      message:
        cause instanceof Error ? cause.message : "Local install paths could not be observed.",
      path: null,
    });
  return {
    observeEnvironment: ({ scope, projectRoot }) =>
      Effect.tryPromise({
        try: async () => {
          const selected = scope === "global" ? homeDirectory : resolve(projectRoot ?? "");
          if (!isAbsolute(selected)) throw new Error("The selected install root is not absolute.");
          return {
            platform: current,
            homeDirectory,
            configDirectory,
            selectedRoot: await rootObservation(selected, current),
            authorizedGlobalRoots: [
              {
                canonicalPath: await realpath(homeDirectory),
                source: "home" as const,
                agents: "all" as const,
              },
              ...(configDirectory
                ? [
                    {
                      canonicalPath: await realpath(configDirectory),
                      source: "config" as const,
                      agents: "all" as const,
                    },
                  ]
                : []),
            ],
          };
        },
        catch: planningFailure,
      }),
    observePaths: ({ destinationPaths, localSourcePaths }) =>
      Effect.tryPromise({
        try: async () => ({
          destinations: await Promise.all(
            destinationPaths.map(async (targetPath) => {
              const present = await exists(targetPath);
              const parent = await nearestParent(targetPath, current);
              if (!present)
                return {
                  targetPath,
                  kind: "missing" as const,
                  writable: parent.writable,
                  files: [],
                  ancestors: await ancestors(dirname(targetPath), current),
                  nearestExistingParent: parent,
                };
              const stat = await lstat(targetPath);
              const kind = fileKind(stat, current);
              return {
                targetPath,
                kind,
                writable: await writable(targetPath),
                files: kind === "directory" ? await inspectFiles(targetPath) : [],
                ancestors: await ancestors(targetPath, current),
                nearestExistingParent: parent,
              };
            }),
          ),
          localSources: await Promise.all(
            localSourcePaths.map(async (requestedPath) => ({
              requestedPath,
              canonicalPath: await realpath(requestedPath),
              exists: true,
              kind: fileKind(await lstat(requestedPath), current),
              temporary: false,
              immutableSnapshot: false,
              contentSha256: "0".repeat(64),
              ancestors: await ancestors(requestedPath, current),
            })),
          ),
        }),
        catch: planningFailure,
      }),
  };
}
