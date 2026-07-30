/* oxlint-disable max-lines */
import { createHash } from "node:crypto";
import { PortablePackagePath } from "@selftune/control-plane/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { INSTALLER_AGENTS } from "./agents.js";
import {
  canonicalizeInstallerPath,
  installerPathKey,
  installerRegistryRoot,
  installerSkillDestination,
  isAbsoluteInstallerPath,
  isBroadProjectRoot,
  isBroadSystemRoot,
  isFilesystemRoot,
  isPathInside,
} from "./paths.js";
import {
  InstallerPlanningError,
  type DestinationObservation,
  type InstallAuthorizationAuthority,
  type InstallAuthorizationClaims,
  type InstallableSkill,
  type InstallerConflict,
  type InstallerCommitFence,
  type InstallerEnvironmentObservation,
  type InstallerPathObservations,
  type InstallerPlanningAuthorities,
  type JournalStepIntent,
  type LocalInstallPlan,
  type LocalInstallRequest,
  type OperationJournalIntent,
  type PlannedFileOperation,
  type ReceiptIntent,
  type RootObservation,
  type StoredInstallReceipt,
  type VerifiedInstallAuthorization,
} from "./types.js";

interface ResolvedInstallerObservations
  extends InstallerEnvironmentObservation, InstallerPathObservations {
  readonly receipts: ReadonlyArray<StoredInstallReceipt>;
}

interface OwnedDestination extends DestinationObservation {
  readonly receipt: StoredInstallReceipt | null;
}

const SHA256 = /^[a-f0-9]{64}$/i;
const SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function error(code: string, message: string, path: string | null = null): InstallerPlanningError {
  return InstallerPlanningError.make({ code, message, path });
}

function stableSkill(skill: InstallableSkill): object {
  return {
    name: skill.name,
    logicalSkillId: skill.logicalSkillId,
    logicalVersion: skill.logicalVersion,
    distributionId: skill.distributionId,
    shareId: skill.shareId,
    handoffId: skill.handoffId,
    sealedPackageSha256: skill.sealedPackageSha256,
    signature: skill.signature,
    license: {
      spdxExpression: skill.license.spdxExpression,
      licenseFile: skill.license.licenseFile,
      notices: skill.license.notices.toSorted((a, b) => a.path.localeCompare(b.path)),
    },
    consent: {
      consentId: skill.consent.consentId,
      recipientPrincipalId: skill.consent.recipientPrincipalId,
      recordedAt: skill.consent.recordedAt,
      action: skill.consent.action,
      disclosureSha256: skill.consent.disclosureSha256,
      termsAccepted: skill.consent.termsAccepted,
      contributorSignals: skill.consent.contributorSignals,
      contributorSignalRecipientOwnerId: skill.consent.contributorSignalRecipientOwnerId,
      contributorSignalAllowedFields: skill.consent.contributorSignalAllowedFields.toSorted(),
      lifecycleReporting: skill.consent.lifecycleReporting,
      lifecycleAllowedFields: skill.consent.lifecycleAllowedFields.toSorted(),
    },
    source: skill.source,
    files: skill.files.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

function stableRoot(root: RootObservation): object {
  return {
    requestedPath: root.requestedPath,
    canonicalPath: root.canonicalPath,
    exists: root.exists,
    writable: root.writable,
    kind: root.kind,
    ancestors: root.ancestors.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

function stableDestination(destination: DestinationObservation): object {
  return {
    targetPath: destination.targetPath,
    kind: destination.kind,
    writable: destination.writable,
    files: destination.files.toSorted((a, b) => a.path.localeCompare(b.path)),
    ancestors: destination.ancestors.toSorted((a, b) => a.path.localeCompare(b.path)),
    nearestExistingParent: stableRoot(destination.nearestExistingParent),
  };
}

function validateIdentifier(value: string, label: string): InstallerPlanningError | null {
  return value.trim().length === 0
    ? error("MISSING_EVIDENCE", `${label} must be non-empty.`)
    : null;
}

function validateRelativePath(pathValue: string): InstallerPlanningError | null {
  if (pathValue !== pathValue.normalize("NFC")) {
    return error(
      "NON_CANONICAL_UNICODE",
      "Package paths must use NFC Unicode normalization.",
      pathValue,
    );
  }
  if (!Schema.is(PortablePackagePath)(pathValue)) {
    return error(
      "UNSAFE_PACKAGE_PATH",
      "Package path was rejected by the canonical PortablePackagePath schema.",
      pathValue,
    );
  }
  return null;
}

function validateSkill(skill: InstallableSkill): InstallerPlanningError | null {
  if (
    !SKILL_NAME.test(skill.name) ||
    WINDOWS_RESERVED.test(skill.name) ||
    skill.name !== skill.name.normalize("NFC")
  ) {
    return error(
      "INVALID_SKILL_NAME",
      "Skill names must be portable ASCII directory names.",
      skill.name,
    );
  }
  for (const [label, value] of [
    ["logicalSkillId", skill.logicalSkillId],
    ["logicalVersion", skill.logicalVersion],
    ["distributionId", skill.distributionId],
    ["shareId", skill.shareId],
    ["handoffId", skill.handoffId],
    ["signature.algorithm", skill.signature.algorithm],
    ["signature.keyId", skill.signature.keyId],
    ["signature.value", skill.signature.value],
    ["license.spdxExpression", skill.license.spdxExpression],
    ["consent.disclosureSha256", skill.consent.disclosureSha256],
    ["consent.consentId", skill.consent.consentId],
    ["consent.recipientPrincipalId", skill.consent.recipientPrincipalId],
  ] as const) {
    const problem = validateIdentifier(value, label);
    if (problem) return problem;
  }
  if (!SHA256.test(skill.sealedPackageSha256) || !SHA256.test(skill.consent.disclosureSha256)) {
    return error("INVALID_HASH", "Package and consent evidence must use full SHA-256 digests.");
  }
  if (
    skill.consent.termsAccepted !== true ||
    !["install_with_selftune", "local_authoring"].includes(skill.consent.action) ||
    !["granted", "not_granted"].includes(skill.consent.contributorSignals) ||
    !["granted", "not_granted"].includes(skill.consent.lifecycleReporting)
  ) {
    return error(
      "INVALID_CONSENT_EVIDENCE",
      "Consent must be explicit and use a supported action and reporting choice.",
    );
  }
  const recordedAt = Date.parse(skill.consent.recordedAt);
  if (Number.isNaN(recordedAt) || new Date(recordedAt).toISOString() !== skill.consent.recordedAt) {
    return error("INVALID_CONSENT_EVIDENCE", "Consent must include an ISO-8601 recording time.");
  }
  const ownerFields = skill.consent.contributorSignalAllowedFields;
  const lifecycleFields = skill.consent.lifecycleAllowedFields;
  if (
    new Set(ownerFields).size !== ownerFields.length ||
    new Set(lifecycleFields).size !== lifecycleFields.length ||
    ownerFields.some((field) => field.trim().length === 0) ||
    lifecycleFields.some((field) => field.trim().length === 0) ||
    (skill.consent.contributorSignals === "not_granted" &&
      (skill.consent.contributorSignalRecipientOwnerId !== null || ownerFields.length !== 0)) ||
    (skill.consent.contributorSignals === "granted" &&
      (!skill.consent.contributorSignalRecipientOwnerId || ownerFields.length === 0)) ||
    (skill.consent.lifecycleReporting === "not_granted" && lifecycleFields.length !== 0) ||
    (skill.consent.lifecycleReporting === "granted" && lifecycleFields.length === 0)
  ) {
    return error(
      "INVALID_TELEMETRY_CONSENT",
      "Telemetry recipients and allowed fields must exactly match each explicit consent choice.",
    );
  }
  if (skill.source.kind === "remote_sealed" && skill.consent.action !== "install_with_selftune") {
    return error(
      "CONSENT_ACTION_MISMATCH",
      "Remote sealed packages require install_with_selftune consent.",
    );
  }
  if (
    skill.source.kind === "local_authoring_immutable" &&
    skill.consent.action !== "local_authoring"
  ) {
    return error(
      "CONSENT_ACTION_MISMATCH",
      "Local authoring sources require local_authoring consent.",
    );
  }
  if (skill.source.kind === "temporary") {
    return error(
      "TEMPORARY_SOURCE_FORBIDDEN",
      "Temporary sources cannot be installed.",
      skill.source.absolutePath,
    );
  }
  if (skill.source.kind === "local_authoring_immutable") {
    const sourcePath = skill.source.absolutePath.replaceAll("\\", "/");
    const isAbsolute = sourcePath.startsWith("/") || /^[A-Za-z]:\//.test(sourcePath);
    const isTemporary = /(?:^|\/)(?:tmp|temp)(?:\/|$)/i.test(sourcePath);
    if (!isAbsolute || isTemporary || !SHA256.test(skill.source.sourceSha256)) {
      return error(
        "LOCAL_SOURCE_UNSAFE",
        "Local authoring symlink sources must be absolute, immutable, hashed, and outside temporary directories.",
        skill.source.absolutePath,
      );
    }
  }
  if (skill.files.length === 0)
    return error("EMPTY_PACKAGE", "A sealed package must contain files.");
  const keys = new Set<string>();
  for (const file of skill.files) {
    const pathProblem = validateRelativePath(file.path);
    if (pathProblem) return pathProblem;
    if (file.kind !== "file") {
      return error("SPECIAL_FILE_FORBIDDEN", "Packages may contain regular files only.", file.path);
    }
    if (
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0
    ) {
      return error(
        "INVALID_FILE_EVIDENCE",
        "Every package file needs a SHA-256 digest and valid length.",
        file.path,
      );
    }
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (
      keys.has(key) ||
      [...keys].some((existing) => key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`))
    )
      return error(
        "PACKAGE_PATH_COLLISION",
        "Package files collide by case, Unicode normalization, or file/descendant layout.",
        file.path,
      );
    keys.add(key);
  }
  for (const evidence of [skill.license.licenseFile, ...skill.license.notices]) {
    if (evidence === null) continue;
    const pathProblem = validateRelativePath(evidence.path);
    if (pathProblem) return pathProblem;
    if (!SHA256.test(evidence.sha256))
      return error(
        "INVALID_LICENSE_EVIDENCE",
        "License evidence needs SHA-256 digests.",
        evidence.path,
      );
    const packageFile = skill.files.find((file) => file.path === evidence.path);
    if (!packageFile || packageFile.sha256 !== evidence.sha256) {
      return error(
        "LICENSE_EVIDENCE_MISMATCH",
        "License and notice evidence must match a sealed package file.",
        evidence.path,
      );
    }
  }
  return null;
}

function validateAuthorizationClaims(
  claims: InstallAuthorizationClaims,
): InstallerPlanningError | null {
  const skills =
    claims.subject.kind === "standalone" ? [claims.subject.skill] : claims.subject.skills;
  if (skills.length === 0) return error("EMPTY_SKILL_SET", "A Skill Set must contain skills.");
  const names = new Set<string>();
  const logicalIds = new Set<string>();
  for (const skill of skills) {
    const problem = validateSkill(skill);
    if (problem) return problem;
    const name = skill.name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(name) || logicalIds.has(skill.logicalSkillId)) {
      return error(
        "SKILL_SET_COMPONENT_COLLISION",
        "Skill Set components collide by name or logical identity.",
        skill.name,
      );
    }
    names.add(name);
    logicalIds.add(skill.logicalSkillId);
  }
  if (
    claims.subject.kind === "skill_set" &&
    (!SHA256.test(claims.subject.sealedPackageSha256) ||
      claims.subject.skillSetId.length === 0 ||
      claims.subject.logicalVersion.length === 0)
  ) {
    return error(
      "INVALID_SKILL_SET_EVIDENCE",
      "Skill Set identity, version, and package hash are required.",
    );
  }
  return null;
}

/** Wraps the trusted bootstrap exchange. Raw claims never enter the planner request. */
export function makeInstallAuthorizationAuthority(
  exchange: (
    installBootstrapToken: string,
  ) => Effect.Effect<InstallAuthorizationClaims, InstallerPlanningError>,
): InstallAuthorizationAuthority {
  return {
    verify: (installBootstrapToken) =>
      exchange(installBootstrapToken).pipe(
        Effect.flatMap((claims) => {
          const problem = validateAuthorizationClaims(claims);
          if (problem) return Effect.fail(problem);
          return Effect.succeed({
            subject: claims.subject,
          } as VerifiedInstallAuthorization);
        }),
      ),
  };
}

function validateRoot(
  root: RootObservation | undefined,
  platform: InstallerEnvironmentObservation["platform"],
  home: string,
  project: boolean,
): InstallerPlanningError | null {
  if (!root)
    return error("ROOT_OBSERVATION_MISSING", "The selected install root was not observed.");
  if (!root.exists || !root.writable || root.kind !== "directory") {
    return error(
      "ROOT_UNAVAILABLE",
      "The selected root must be an existing writable directory.",
      root.requestedPath,
    );
  }
  if (
    !isAbsoluteInstallerPath(platform, root.requestedPath) ||
    !isAbsoluteInstallerPath(platform, root.canonicalPath) ||
    !isAbsoluteInstallerPath(platform, home)
  ) {
    return error(
      "ROOT_NOT_ABSOLUTE",
      "Install roots and the home directory must be absolute paths.",
      root.requestedPath,
    );
  }
  const canonical = canonicalizeInstallerPath(platform, root.canonicalPath);
  if (
    isFilesystemRoot(platform, canonical) ||
    (project
      ? isBroadProjectRoot(platform, canonical, home)
      : isBroadSystemRoot(platform, canonical))
  ) {
    return error(
      "ROOT_TOO_BROAD",
      "Filesystem, home, and broad system directories cannot be project roots.",
      canonical,
    );
  }
  for (const ancestor of root.ancestors) {
    if (ancestor.kind === "directory") continue;
    if (!ancestor.resolvedPath) {
      return error(
        "ANCESTOR_ESCAPE",
        "Symlink and reparse ancestors require a verified resolution.",
        ancestor.path,
      );
    }
    const resolved = canonicalizeInstallerPath(platform, ancestor.resolvedPath);
    if (
      installerPathKey(platform, resolved) !== installerPathKey(platform, canonical) &&
      !isPathInside(platform, resolved, canonical)
    ) {
      return error(
        "ANCESTOR_ESCAPE",
        "An ancestor resolves outside the selected root.",
        ancestor.path,
      );
    }
  }
  return null;
}

function validateAuthorizedGlobalRoot(
  request: LocalInstallRequest,
  environment: InstallerEnvironmentObservation,
): InstallerPlanningError | null {
  if (request.scope !== "global") return null;
  const selectedKey = installerPathKey(
    environment.platform,
    environment.selectedRoot.canonicalPath,
  );
  const candidateKeys = new Set<string>();
  let selectedIsAuthorized = false;
  for (const candidate of environment.authorizedGlobalRoots) {
    if (
      candidate.canonicalPath !== candidate.canonicalPath.normalize("NFC") ||
      !isAbsoluteInstallerPath(environment.platform, candidate.canonicalPath) ||
      isFilesystemRoot(environment.platform, candidate.canonicalPath) ||
      isBroadSystemRoot(environment.platform, candidate.canonicalPath)
    ) {
      return error(
        "GLOBAL_ROOT_AUTHORITY_INVALID",
        "OS-authorized global roots must be canonical, absolute, and narrowly scoped.",
        candidate.canonicalPath,
      );
    }
    const candidateKey = installerPathKey(environment.platform, candidate.canonicalPath);
    if (candidateKeys.has(candidateKey)) {
      return error(
        "GLOBAL_ROOT_AUTHORITY_INVALID",
        "OS-authorized global roots must be unique by portable path identity.",
        candidate.canonicalPath,
      );
    }
    candidateKeys.add(candidateKey);
    const scopedAgents = candidate.agents === "all" ? null : candidate.agents;
    if (
      (candidate.source === "agent" &&
        (scopedAgents === null ||
          scopedAgents.length === 0 ||
          new Set(scopedAgents).size !== scopedAgents.length)) ||
      (candidate.source !== "agent" && scopedAgents !== null)
    ) {
      return error(
        "GLOBAL_ROOT_AUTHORITY_INVALID",
        "Agent roots require a non-empty unique agent list; home and config roots apply to all agents.",
        candidate.canonicalPath,
      );
    }
    if (
      (candidate.source === "home" &&
        installerPathKey(environment.platform, candidate.canonicalPath) !==
          installerPathKey(environment.platform, environment.homeDirectory)) ||
      (candidate.source === "config" &&
        (environment.configDirectory === null ||
          installerPathKey(environment.platform, candidate.canonicalPath) !==
            installerPathKey(environment.platform, environment.configDirectory)))
    ) {
      return error(
        "GLOBAL_ROOT_AUTHORITY_INVALID",
        "Home and config candidates must match their canonical OS observations.",
        candidate.canonicalPath,
      );
    }
    const appliesToTargets =
      candidate.agents === "all" ||
      request.targetAgents.every((agent) => candidate.agents.includes(agent));
    if (candidateKey === selectedKey && appliesToTargets) selectedIsAuthorized = true;
  }
  return selectedIsAuthorized
    ? null
    : error(
        "GLOBAL_ROOT_UNAUTHORIZED",
        "Selected global root is not the canonical home/config root or an enumerated root for every target agent.",
        environment.selectedRoot.canonicalPath,
      );
}

function findDestination(
  observations: ResolvedInstallerObservations,
  targetPath: string,
): OwnedDestination | undefined {
  const key = installerPathKey(observations.platform, targetPath);
  const destination = observations.destinations.find(
    (observation) => installerPathKey(observations.platform, observation.targetPath) === key,
  );
  if (!destination) return undefined;
  const active = observations.receipts.find(
    (receipt) =>
      receipt.state === "active" &&
      installerPathKey(observations.platform, receipt.targetPath) === key,
  );
  return { ...destination, receipt: active ?? null };
}

function fileMap(
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.sha256]));
}

function hasManagedDrift(destination: OwnedDestination): boolean {
  if (!destination.receipt) return false;
  const expected = fileMap(destination.receipt.files);
  const actual = destination.files.filter((file) => file.kind === "file");
  if (actual.length !== expected.size) return true;
  return actual.some((file) => expected.get(file.path) !== file.sha256);
}

function validateDestinationAncestors(
  observations: ResolvedInstallerObservations,
  destination: DestinationObservation,
  canonicalRoot: string,
): InstallerPlanningError | null {
  for (const ancestor of destination.ancestors) {
    if (ancestor.kind === "directory") continue;
    if (!ancestor.resolvedPath) {
      return error(
        "ANCESTOR_ESCAPE",
        "Destination symlink and reparse ancestors require a verified resolution.",
        ancestor.path,
      );
    }
    const resolved = canonicalizeInstallerPath(observations.platform, ancestor.resolvedPath);
    if (
      installerPathKey(observations.platform, resolved) !==
        installerPathKey(observations.platform, canonicalRoot) &&
      !isPathInside(observations.platform, canonicalRoot, resolved)
    ) {
      return error(
        "ANCESTOR_ESCAPE",
        "A destination ancestor resolves outside the selected install root.",
        ancestor.path,
      );
    }
  }
  return null;
}

interface ExpectedDestination {
  readonly agent: ReceiptIntent["agent"];
  readonly registryRoot: string;
  readonly targetPath: string;
  readonly skill: InstallableSkill;
}

function validateObservedDestination(
  observations: ResolvedInstallerObservations,
  destination: DestinationObservation,
  canonicalRoot: string,
): InstallerPlanningError | null {
  if (
    installerPathKey(observations.platform, destination.targetPath) ===
      installerPathKey(observations.platform, canonicalRoot) ||
    !isPathInside(observations.platform, canonicalRoot, destination.targetPath) ||
    destination.targetPath !== destination.targetPath.normalize("NFC") ||
    !isAbsoluteInstallerPath(observations.platform, destination.targetPath)
  ) {
    return error(
      "DESTINATION_ESCAPE",
      "A destination resolves outside the selected root.",
      destination.targetPath,
    );
  }
  if (destination.kind === "missing" && destination.files.length > 0) {
    return error(
      "DESTINATION_INVARIANT",
      "A missing destination cannot contain observed files.",
      destination.targetPath,
    );
  }
  const keys = new Set<string>();
  for (const file of destination.files) {
    const pathProblem = validateRelativePath(file.path);
    if (pathProblem) return pathProblem;
    if (file.kind !== "file" || !SHA256.test(file.sha256)) {
      return error(
        file.kind !== "file" ? "SPECIAL_FILE_FORBIDDEN" : "DESTINATION_INVARIANT",
        "Observed files must be regular and hashed.",
        file.path,
      );
    }
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (
      keys.has(key) ||
      [...keys].some((existing) => key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`))
    ) {
      return error(
        "DESTINATION_INVARIANT",
        "Observed files contain a portable path collision.",
        file.path,
      );
    }
    keys.add(key);
  }
  const parent = destination.nearestExistingParent;
  if (!parent.exists || !parent.writable || parent.kind !== "directory") {
    return error(
      "NEAREST_PARENT_UNAVAILABLE",
      "The nearest existing destination parent must be a writable directory.",
      parent.requestedPath,
    );
  }
  const canonicalParent = canonicalizeInstallerPath(observations.platform, parent.canonicalPath);
  if (
    !isAbsoluteInstallerPath(observations.platform, canonicalParent) ||
    !isPathInside(observations.platform, canonicalParent, destination.targetPath) ||
    (installerPathKey(observations.platform, canonicalParent) !==
      installerPathKey(observations.platform, canonicalRoot) &&
      !isPathInside(observations.platform, canonicalRoot, canonicalParent))
  ) {
    return error(
      "NEAREST_PARENT_ESCAPE",
      "The nearest existing destination parent does not contain the target within the selected root.",
      parent.canonicalPath,
    );
  }
  for (const ancestor of parent.ancestors) {
    if (ancestor.kind === "directory") continue;
    if (!ancestor.resolvedPath) {
      return error(
        "NEAREST_PARENT_ESCAPE",
        "Nearest-parent symlink and reparse evidence must include canonical resolution.",
        ancestor.path,
      );
    }
    const resolved = canonicalizeInstallerPath(observations.platform, ancestor.resolvedPath);
    if (
      installerPathKey(observations.platform, resolved) !==
        installerPathKey(observations.platform, canonicalParent) &&
      !isPathInside(observations.platform, resolved, canonicalParent)
    ) {
      return error(
        "NEAREST_PARENT_ESCAPE",
        "A nearest-parent ancestor resolves outside its canonical parent.",
        ancestor.path,
      );
    }
  }
  return validateDestinationAncestors(observations, destination, canonicalRoot);
}

function validateStoredReceipts(
  observations: ResolvedInstallerObservations,
  expected: ReadonlyArray<ExpectedDestination>,
  request: LocalInstallRequest,
  canonicalRoot: string,
): InstallerPlanningError | null {
  const expectedByPath = new Map(
    expected.map((item) => [installerPathKey(observations.platform, item.targetPath), item]),
  );
  const receiptIds = new Set<string>();
  const activePaths = new Set<string>();
  for (const receipt of observations.receipts) {
    if (receipt.receiptId.trim().length === 0 || receiptIds.has(receipt.receiptId)) {
      return error(
        "RECEIPT_INVARIANT",
        "Receipt identifiers must be non-empty and unique.",
        receipt.targetPath,
      );
    }
    receiptIds.add(receipt.receiptId);
    if (!["active", "superseded", "removed"].includes(receipt.state)) {
      return error("RECEIPT_INVARIANT", "Receipt state is invalid.", receipt.targetPath);
    }
    const targetKey = installerPathKey(observations.platform, receipt.targetPath);
    const expectedTarget = expectedByPath.get(targetKey);
    if (!expectedTarget) {
      return error(
        "RECEIPT_INVARIANT",
        "Receipt authority returned an unrequested target.",
        receipt.targetPath,
      );
    }
    if (
      receipt.targetPath !== receipt.targetPath.normalize("NFC") ||
      receipt.registryRoot !== receipt.registryRoot.normalize("NFC") ||
      !isAbsoluteInstallerPath(observations.platform, receipt.targetPath) ||
      !isAbsoluteInstallerPath(observations.platform, receipt.registryRoot) ||
      receipt.registryRoot !== expectedTarget.registryRoot ||
      receipt.targetPath !== expectedTarget.targetPath ||
      receipt.agent !== expectedTarget.agent ||
      receipt.scope !== request.scope ||
      receipt.projectRoot !== (request.scope === "project" ? canonicalRoot : null) ||
      receipt.skillName !== expectedTarget.skill.name ||
      receipt.logicalSkillId !== expectedTarget.skill.logicalSkillId ||
      !SHA256.test(receipt.sealedPackageSha256)
    ) {
      return error(
        "RECEIPT_INVARIANT",
        "Receipt path, agent, scope, or skill binding is inconsistent.",
        receipt.targetPath,
      );
    }
    if (receipt.state === "active") {
      if (activePaths.has(targetKey)) {
        return error(
          "RECEIPT_INVARIANT",
          "Only one active receipt may own a destination.",
          receipt.targetPath,
        );
      }
      activePaths.add(targetKey);
    }
    const fileKeys = new Set<string>();
    for (const file of receipt.files) {
      const pathProblem = validateRelativePath(file.path);
      if (pathProblem) return pathProblem;
      const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
      if (
        !SHA256.test(file.sha256) ||
        file.durableSnapshotRef.trim().length === 0 ||
        fileKeys.has(key) ||
        [...fileKeys].some(
          (existing) => key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`),
        )
      ) {
        return error(
          "RECEIPT_INVARIANT",
          "Receipt files contain invalid evidence or collisions.",
          file.path,
        );
      }
      fileKeys.add(key);
    }
  }
  return null;
}

function stableReceipt(receipt: StoredInstallReceipt): object {
  return {
    receiptId: receipt.receiptId,
    state: receipt.state,
    agent: receipt.agent,
    scope: receipt.scope,
    projectRoot: receipt.projectRoot,
    registryRoot: receipt.registryRoot,
    targetPath: receipt.targetPath,
    skillName: receipt.skillName,
    logicalSkillId: receipt.logicalSkillId,
    sealedPackageSha256: receipt.sealedPackageSha256,
    files: receipt.files.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

function copyOperations(
  skill: InstallableSkill,
  destination: OwnedDestination,
  targetPath: string,
  backupPath: string | null,
): ReadonlyArray<PlannedFileOperation> {
  const rollbackReference = (path: string): string => {
    const receiptFile = destination.receipt?.files.find((file) => file.path === path);
    return receiptFile?.durableSnapshotRef ?? `backup://${backupPath}/${path}`;
  };
  const current = new Map(
    destination.files.filter((file) => file.kind === "file").map((file) => [file.path, file]),
  );
  const desired = fileMap(skill.files);
  const backup: PlannedFileOperation[] =
    backupPath === null
      ? []
      : [
          {
            kind: "backup_destination",
            targetPath,
            relativePath: ".",
            backupPath,
            mode: "copy",
            expectedFiles: destination.files
              .filter((file) => file.kind === "file")
              .toSorted((a, b) => a.path.localeCompare(b.path))
              .map((file) => ({
                path: file.path,
                sha256: file.sha256,
                durableSnapshotRef: `backup://${backupPath}/${file.path}`,
              })),
          },
        ];
  const writes: PlannedFileOperation[] = [];
  for (const file of skill.files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    const before = current.get(file.path);
    if (before?.sha256 === file.sha256) continue;
    if (before === undefined) {
      writes.push({
        kind: "create_file",
        targetPath,
        relativePath: file.path,
        expectedBeforeSha256: null,
        afterSha256: file.sha256,
      });
    } else {
      writes.push({
        kind: "replace_file",
        targetPath,
        relativePath: file.path,
        expectedBeforeSha256: before.sha256,
        previousSnapshotRef: rollbackReference(file.path),
        afterSha256: file.sha256,
      });
    }
  }
  const deletes: PlannedFileOperation[] = destination.files
    .filter((file) => file.kind === "file" && !desired.has(file.path))
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      kind: "delete_file" as const,
      targetPath,
      relativePath: file.path,
      expectedBeforeSha256: file.sha256,
      previousSnapshotRef: rollbackReference(file.path),
      afterSha256: null,
    }));
  return [...backup, ...writes, ...deletes];
}

function rollbackFor(operation: PlannedFileOperation): JournalStepIntent["rollback"] {
  if (operation.kind === "backup_destination")
    return { kind: "retain_backup", backupPath: operation.backupPath };
  if (operation.kind === "create_file" || operation.kind === "create_symlink")
    return { kind: "delete_created" };
  if (operation.kind === "replace_file" || operation.kind === "delete_file") {
    return { kind: "restore_snapshot", snapshotRef: operation.previousSnapshotRef };
  }
  return { kind: "restore_previous_files", files: operation.expectedBeforeFiles };
}

const planResolvedInstall = Effect.fn("selftune.runtime.installer.planResolved")(function* (
  request: LocalInstallRequest,
  authorization: VerifiedInstallAuthorization,
  observations: ResolvedInstallerObservations,
) {
  if (
    "customPath" in request ||
    "targetRoot" in request ||
    "globalRoot" in request ||
    "homeDirectory" in request ||
    "configRoot" in request
  ) {
    return yield* Effect.fail(
      error("CUSTOM_PATH_FORBIDDEN", "Custom target paths are not supported in v1."),
    );
  }
  if (!["project", "global"].includes(request.scope)) {
    return yield* Effect.fail(
      error("UNSUPPORTED_SCOPE", "Only project and global installs are supported."),
    );
  }
  if (!["cancel", "side_by_side", "replace_with_backup"].includes(request.unmanagedPolicy)) {
    return yield* Effect.fail(
      error("UNSUPPORTED_CONFLICT_POLICY", "The unmanaged conflict policy is not supported."),
    );
  }
  if (request.strategy !== undefined && !["copy", "symlink"].includes(request.strategy)) {
    return yield* Effect.fail(
      error("UNSUPPORTED_STRATEGY", "Only copy and symlink strategies are supported."),
    );
  }
  if (request.targetAgents.length === 0) {
    return yield* Effect.fail(
      error("EXPLICIT_AGENT_REQUIRED", "At least one target agent must be explicitly selected."),
    );
  }
  if (
    !["project", "global"].includes(request.scope) ||
    !["cancel", "side_by_side", "replace_with_backup"].includes(request.unmanagedPolicy) ||
    (request.strategy !== undefined && !["copy", "symlink"].includes(request.strategy))
  ) {
    return yield* Effect.fail(
      error("UNSUPPORTED_INSTALL_CHOICE", "Scope, strategy, or conflict policy is unsupported."),
    );
  }
  if (
    request.targetAgents.some((agent) => !INSTALLER_AGENTS.includes(agent)) ||
    new Set(request.targetAgents).size !== request.targetAgents.length
  ) {
    return yield* Effect.fail(
      error("DUPLICATE_AGENT_DESTINATION", "Target agents must be supported and unique."),
    );
  }
  const agents = request.targetAgents.toSorted(
    (left, right) => INSTALLER_AGENTS.indexOf(left) - INSTALLER_AGENTS.indexOf(right),
  );
  if (agents.some((agent) => !INSTALLER_AGENTS.includes(agent))) {
    return yield* Effect.fail(
      error("UNSUPPORTED_AGENT", "Every target must be a supported SelfTune agent."),
    );
  }
  if (new Set(agents).size !== agents.length) {
    return yield* Effect.fail(
      error("DUPLICATE_AGENT_DESTINATION", "Each target agent may be selected only once."),
    );
  }
  const root = observations.selectedRoot;
  if (request.scope === "project") {
    if (!request.projectRoot || !root) {
      return yield* Effect.fail(
        error(
          "PROJECT_ROOT_REQUIRED",
          "Project installs require a chosen and observed project folder.",
        ),
      );
    }
    if (
      installerPathKey(observations.platform, request.projectRoot) !==
      installerPathKey(observations.platform, root.requestedPath)
    ) {
      return yield* Effect.fail(
        error(
          "PROJECT_ROOT_MISMATCH",
          "The observation does not describe the chosen project folder.",
        ),
      );
    }
  } else if (request.projectRoot !== undefined) {
    return yield* Effect.fail(
      error("PROJECT_ROOT_NOT_ALLOWED", "Global installs do not accept a project root."),
    );
  }
  const rootProblem = validateRoot(
    root,
    observations.platform,
    observations.homeDirectory,
    request.scope === "project",
  );
  if (rootProblem) return yield* Effect.fail(rootProblem);
  const canonicalRoot = canonicalizeInstallerPath(observations.platform, root.canonicalPath);

  const subject = authorization.subject;
  const skills = subject.kind === "standalone" ? [subject.skill] : [...subject.skills];
  if (skills.length === 0)
    return yield* Effect.fail(error("EMPTY_SKILL_SET", "A Skill Set must contain skills."));
  const nameKeys = new Set<string>();
  const logicalIds = new Set<string>();
  for (const skill of skills) {
    const problem = validateSkill(skill);
    if (problem) return yield* Effect.fail(problem);
    if (skill.source.kind === "local_authoring_immutable") {
      const localSource = skill.source;
      if (!isAbsoluteInstallerPath(observations.platform, localSource.absolutePath)) {
        return yield* Effect.fail(
          error(
            "LOCAL_SOURCE_UNSAFE",
            "The local authoring source must be absolute for the selected platform.",
            localSource.absolutePath,
          ),
        );
      }
      const sourceObservation = observations.localSources.find(
        (source) =>
          installerPathKey(observations.platform, source.requestedPath) ===
          installerPathKey(observations.platform, localSource.absolutePath),
      );
      if (
        !sourceObservation ||
        !sourceObservation.exists ||
        sourceObservation.kind !== "directory" ||
        sourceObservation.temporary ||
        /(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)/i.test(sourceObservation.canonicalPath) ||
        !isAbsoluteInstallerPath(observations.platform, sourceObservation.canonicalPath) ||
        !sourceObservation.immutableSnapshot ||
        sourceObservation.contentSha256 !== localSource.sourceSha256 ||
        sourceObservation.ancestors.length === 0
      ) {
        return yield* Effect.fail(
          error(
            "LOCAL_SOURCE_UNVERIFIED",
            "Symlink sources require an observed durable immutable directory with the exact source hash.",
            localSource.absolutePath,
          ),
        );
      }
      for (const ancestor of sourceObservation.ancestors) {
        if (ancestor.kind === "directory") continue;
        if (!ancestor.resolvedPath) {
          return yield* Effect.fail(
            error(
              "LOCAL_SOURCE_UNVERIFIED",
              "Every source symlink or reparse ancestor requires canonical resolution evidence.",
              ancestor.path,
            ),
          );
        }
        const resolved = canonicalizeInstallerPath(observations.platform, ancestor.resolvedPath);
        const canonicalSource = canonicalizeInstallerPath(
          observations.platform,
          sourceObservation.canonicalPath,
        );
        if (
          installerPathKey(observations.platform, resolved) !==
            installerPathKey(observations.platform, canonicalSource) &&
          !isPathInside(observations.platform, resolved, canonicalSource)
        ) {
          return yield* Effect.fail(
            error(
              "LOCAL_SOURCE_UNVERIFIED",
              "A source ancestor does not resolve to the verified canonical source.",
              ancestor.path,
            ),
          );
        }
      }
    }
    const nameKey = skill.name.normalize("NFC").toLocaleLowerCase("en-US");
    if (nameKeys.has(nameKey) || logicalIds.has(skill.logicalSkillId)) {
      return yield* Effect.fail(
        error(
          "SKILL_SET_COMPONENT_COLLISION",
          "Skill Set components collide by name or logical identity.",
          skill.name,
        ),
      );
    }
    nameKeys.add(nameKey);
    logicalIds.add(skill.logicalSkillId);
  }
  if (subject.kind === "skill_set") {
    if (
      !SHA256.test(subject.sealedPackageSha256) ||
      subject.skillSetId.length === 0 ||
      subject.logicalVersion.length === 0
    ) {
      return yield* Effect.fail(
        error(
          "INVALID_SKILL_SET_EVIDENCE",
          "Skill Set identity, version, and package hash are required.",
        ),
      );
    }
  }

  const strategy = request.strategy ?? "copy";
  if (
    strategy === "symlink" &&
    skills.some((skill) => skill.source.kind !== "local_authoring_immutable")
  ) {
    return yield* Effect.fail(
      error(
        "SYMLINK_SOURCE_FORBIDDEN",
        "Symlinks require an explicit immutable local-authoring source.",
      ),
    );
  }

  const expectedDestinations: ExpectedDestination[] = [];
  for (const agent of agents) {
    const registryRoot = installerRegistryRoot(observations.platform, canonicalRoot, agent);
    for (const skill of skills) {
      expectedDestinations.push({
        agent,
        registryRoot,
        targetPath: installerSkillDestination(observations.platform, registryRoot, skill.name),
        skill,
      });
      if (request.unmanagedPolicy === "side_by_side") {
        expectedDestinations.push({
          agent,
          registryRoot,
          targetPath: installerSkillDestination(
            observations.platform,
            registryRoot,
            `${skill.name}--${skill.sealedPackageSha256.slice(0, 12)}`,
          ),
          skill,
        });
      }
    }
  }
  const receiptProblem = validateStoredReceipts(
    observations,
    expectedDestinations,
    request,
    canonicalRoot,
  );
  if (receiptProblem) return yield* Effect.fail(receiptProblem);
  const observedDestinationKeys = new Set<string>();
  for (const destination of observations.destinations) {
    const key = installerPathKey(observations.platform, destination.targetPath);
    if (observedDestinationKeys.has(key)) {
      return yield* Effect.fail(
        error(
          "DESTINATION_INVARIANT",
          "Destination observations must be unique by portable path identity.",
          destination.targetPath,
        ),
      );
    }
    observedDestinationKeys.add(key);
    const destinationProblem = validateObservedDestination(
      observations,
      destination,
      canonicalRoot,
    );
    if (destinationProblem) return yield* Effect.fail(destinationProblem);
  }
  const draftOperations: PlannedFileOperation[] = [];
  const conflicts: InstallerConflict[] = [];
  const draftReceipts: Array<Omit<ReceiptIntent, "receiptId" | "previewFingerprint">> = [];
  const destinationKeys = new Set<string>();

  for (const agent of agents) {
    const registryRoot = installerRegistryRoot(observations.platform, canonicalRoot, agent);
    for (const skill of skills.toSorted((a, b) => a.name.localeCompare(b.name))) {
      let targetPath = installerSkillDestination(observations.platform, registryRoot, skill.name);
      let destination = findDestination(observations, targetPath);
      if (!destination)
        return yield* Effect.fail(
          error(
            "DESTINATION_OBSERVATION_MISSING",
            "Every derived destination must be observed.",
            targetPath,
          ),
        );
      if (!destination.writable && destination.kind !== "missing") {
        return yield* Effect.fail(
          error("DESTINATION_UNWRITABLE", "The destination is not writable.", targetPath),
        );
      }
      if (["file", "special", "reparse", "symlink"].includes(destination.kind)) {
        return yield* Effect.fail(
          error(
            "UNSAFE_DESTINATION",
            "Destination must be missing, a directory, or an owned symlink.",
            targetPath,
          ),
        );
      }
      const unsafeObservedFile = destination.files.find((file) => file.kind !== "file");
      if (unsafeObservedFile) {
        return yield* Effect.fail(
          error(
            "SPECIAL_FILE_FORBIDDEN",
            "Observed destinations may contain regular files only.",
            unsafeObservedFile.path,
          ),
        );
      }
      let backupPath: string | null = null;
      if (destination.kind !== "missing" && destination.receipt === null) {
        if (request.unmanagedPolicy === "cancel") {
          conflicts.push({
            code: "UNMANAGED_DESTINATION",
            agent,
            targetPath,
            details: "Existing destination is not owned by a SelfTune receipt.",
          });
          continue;
        }
        if (request.unmanagedPolicy === "side_by_side") {
          targetPath = installerSkillDestination(
            observations.platform,
            registryRoot,
            `${skill.name}--${skill.sealedPackageSha256.slice(0, 12)}`,
          );
          destination = findDestination(observations, targetPath);
          if (!destination)
            return yield* Effect.fail(
              error(
                "DESTINATION_OBSERVATION_MISSING",
                "The side-by-side destination must be observed.",
                targetPath,
              ),
            );
          if (destination.kind !== "missing") {
            return yield* Effect.fail(
              error(
                "SIDE_BY_SIDE_COLLISION",
                "The deterministic side-by-side destination already exists.",
                targetPath,
              ),
            );
          }
        } else {
          backupPath = `${targetPath}.selftune-backup-${skill.sealedPackageSha256.slice(0, 12)}`;
          const backupDestination = findDestination(observations, backupPath);
          if (!backupDestination) {
            return yield* Effect.fail(
              error(
                "DESTINATION_OBSERVATION_MISSING",
                "The deterministic backup destination must be observed.",
                backupPath,
              ),
            );
          }
          if (backupDestination.kind !== "missing") {
            return yield* Effect.fail(
              error(
                "BACKUP_DESTINATION_COLLISION",
                "The deterministic backup destination already exists.",
                backupPath,
              ),
            );
          }
          const backupAncestorProblem = validateDestinationAncestors(
            observations,
            backupDestination,
            canonicalRoot,
          );
          if (backupAncestorProblem) return yield* Effect.fail(backupAncestorProblem);
        }
      }
      const ancestorProblem = validateDestinationAncestors(
        observations,
        destination,
        canonicalRoot,
      );
      if (ancestorProblem) return yield* Effect.fail(ancestorProblem);
      if (hasManagedDrift(destination)) {
        conflicts.push({
          code: "MANAGED_DRIFT",
          agent,
          targetPath,
          details: "Installed files differ from their receipt hashes.",
        });
        continue;
      }
      const destinationKey = installerPathKey(observations.platform, targetPath);
      if (destinationKeys.has(destinationKey)) {
        return yield* Effect.fail(
          error(
            "DUPLICATE_AGENT_DESTINATION",
            "Two selections resolve to the same destination.",
            targetPath,
          ),
        );
      }
      destinationKeys.add(destinationKey);

      const localSourcePath =
        skill.source.kind === "local_authoring_immutable" ? skill.source.absolutePath : null;
      const verifiedLocalSource =
        localSourcePath === null
          ? undefined
          : observations.localSources.find(
              (source) =>
                installerPathKey(observations.platform, source.requestedPath) ===
                installerPathKey(observations.platform, localSourcePath),
            );
      if (verifiedLocalSource) {
        const canonicalSource = canonicalizeInstallerPath(
          observations.platform,
          verifiedLocalSource.canonicalPath,
        );
        if (
          installerPathKey(observations.platform, canonicalSource) === destinationKey ||
          isPathInside(observations.platform, canonicalSource, targetPath) ||
          isPathInside(observations.platform, targetPath, canonicalSource)
        ) {
          return yield* Effect.fail(
            error(
              "SOURCE_DESTINATION_OVERLAP",
              "The verified local source and destination must be separate trees.",
              targetPath,
            ),
          );
        }
      }

      const operationStart = draftOperations.length;
      if (strategy === "copy") {
        draftOperations.push(...copyOperations(skill, destination, targetPath, backupPath));
      } else if (skill.source.kind === "local_authoring_immutable") {
        if (!verifiedLocalSource) {
          return yield* Effect.fail(
            error(
              "LOCAL_SOURCE_UNVERIFIED",
              "The canonical local source observation is unavailable.",
              skill.source.absolutePath,
            ),
          );
        }
        if (backupPath !== null) {
          draftOperations.push({
            kind: "backup_destination",
            targetPath,
            relativePath: ".",
            backupPath,
            mode: "copy",
            expectedFiles: destination.files
              .toSorted((a, b) => a.path.localeCompare(b.path))
              .map((file) => ({
                path: file.path,
                sha256: file.sha256,
                durableSnapshotRef: `backup://${backupPath}/${file.path}`,
              })),
          });
        }
        if (destination.kind === "missing") {
          draftOperations.push({
            kind: "create_symlink",
            targetPath,
            relativePath: ".",
            expectedBeforeSha256: null,
            afterSha256: skill.source.sourceSha256,
            sourcePath: canonicalizeInstallerPath(
              observations.platform,
              verifiedLocalSource.canonicalPath,
            ),
          });
        } else {
          draftOperations.push({
            kind: "replace_with_symlink",
            targetPath,
            relativePath: ".",
            expectedBeforeFiles: destination.files
              .toSorted((a, b) => a.path.localeCompare(b.path))
              .map((file) => ({
                path: file.path,
                sha256: file.sha256,
                durableSnapshotRef:
                  destination.receipt?.files.find((receiptFile) => receiptFile.path === file.path)
                    ?.durableSnapshotRef ?? `backup://${backupPath}/${file.path}`,
              })),
            afterSha256: skill.source.sourceSha256,
            sourcePath: canonicalizeInstallerPath(
              observations.platform,
              verifiedLocalSource.canonicalPath,
            ),
          });
        }
      }
      const noOp =
        strategy === "copy" &&
        destination.receipt !== null &&
        destination.receipt.sealedPackageSha256 === skill.sealedPackageSha256 &&
        draftOperations.length === operationStart;
      draftReceipts.push({
        subjectKind: subject.kind,
        skillSet:
          subject.kind === "skill_set"
            ? {
                skillSetId: subject.skillSetId,
                logicalVersion: subject.logicalVersion,
                sealedPackageSha256: subject.sealedPackageSha256,
              }
            : null,
        agent,
        platform: observations.platform,
        scope: request.scope,
        projectRoot: request.scope === "project" ? canonicalRoot : null,
        registryRoot,
        targetPath,
        strategy,
        unmanagedPolicy: request.unmanagedPolicy,
        backupPath,
        existingReceiptId: noOp ? (destination.receipt?.receiptId ?? null) : null,
        noOp,
        expectedBefore: {
          kind: destination.kind === "missing" ? "missing" : "directory",
          files: destination.files.toSorted((left, right) => left.path.localeCompare(right.path)),
        },
        updatePolicy: "replan_exact_hash",
        removalPolicy: "receipt_owned_files_only",
        skill,
      });
    }
  }

  const blocked = conflicts.length > 0;
  const fingerprintBasis = JSON.stringify({
    version: 1,
    platform: observations.platform,
    homeDirectory: observations.homeDirectory,
    configDirectory: observations.configDirectory,
    authorizedGlobalRoots: observations.authorizedGlobalRoots
      .toSorted((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))
      .map((candidate) => ({
        canonicalPath: candidate.canonicalPath,
        source: candidate.source,
        agents:
          candidate.agents === "all"
            ? "all"
            : candidate.agents.toSorted(
                (a, b) => INSTALLER_AGENTS.indexOf(a) - INSTALLER_AGENTS.indexOf(b),
              ),
      })),
    selectedRoot: stableRoot(observations.selectedRoot),
    subject:
      subject.kind === "standalone"
        ? { kind: "standalone", skill: stableSkill(subject.skill) }
        : {
            kind: "skill_set",
            skillSetId: subject.skillSetId,
            logicalVersion: subject.logicalVersion,
            sealedPackageSha256: subject.sealedPackageSha256,
            skills: skills.toSorted((a, b) => a.name.localeCompare(b.name)).map(stableSkill),
          },
    scope: request.scope,
    canonicalRoot,
    agents,
    strategy,
    unmanagedPolicy: request.unmanagedPolicy,
    operations: blocked ? [] : draftOperations,
    conflicts,
    observedDestinations: observations.destinations
      .toSorted((a, b) => a.targetPath.localeCompare(b.targetPath))
      .map(stableDestination),
    observedLocalSources: (observations.localSources ?? [])
      .toSorted((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))
      .map((source) => ({
        requestedPath: source.requestedPath,
        canonicalPath: source.canonicalPath,
        exists: source.exists,
        kind: source.kind,
        temporary: source.temporary,
        immutableSnapshot: source.immutableSnapshot,
        contentSha256: source.contentSha256,
        ancestors: source.ancestors.toSorted((a, b) => a.path.localeCompare(b.path)),
      })),
    observedReceipts: observations.receipts
      .toSorted((a, b) => a.receiptId.localeCompare(b.receiptId))
      .map(stableReceipt),
  });
  const previewFingerprint = digest(fingerprintBasis);
  const previewToken = `preview_v1_${previewFingerprint}`;
  if (blocked) {
    return {
      ready: false,
      previewFingerprint,
      previewToken,
      operations: [],
      conflicts,
      receipts: [],
      journal: null,
    } satisfies LocalInstallPlan;
  }
  const receipts: ReceiptIntent[] = draftReceipts.map((receipt, index) => ({
    ...receipt,
    receiptId:
      receipt.existingReceiptId ??
      `receipt_v1_${digest(`${previewFingerprint}:${index}:${receipt.targetPath}`).slice(0, 32)}`,
    previewFingerprint,
  }));
  const steps: JournalStepIntent[] = draftOperations.map((operation, index) => ({
    sequence: index,
    operation,
    rollback: rollbackFor(operation),
  }));
  const journal: OperationJournalIntent = {
    journalId: `journal_v1_${digest(`${previewFingerprint}:journal`).slice(0, 32)}`,
    state: "planned",
    previewFingerprint,
    receiptIds: receipts.map((receipt) => receipt.receiptId),
    steps,
  };
  return {
    ready: true,
    previewFingerprint,
    previewToken,
    operations: draftOperations,
    conflicts: [],
    receipts,
    journal,
  } satisfies LocalInstallPlan;
});

function candidatePaths(
  request: LocalInstallRequest,
  authorization: VerifiedInstallAuthorization,
  environment: InstallerEnvironmentObservation,
): ReadonlyArray<string> {
  const skills =
    authorization.subject.kind === "standalone"
      ? [authorization.subject.skill]
      : authorization.subject.skills;
  const root = canonicalizeInstallerPath(
    environment.platform,
    environment.selectedRoot.canonicalPath,
  );
  const paths: string[] = [];
  for (const agent of request.targetAgents) {
    if (!INSTALLER_AGENTS.includes(agent)) continue;
    const registryRoot = installerRegistryRoot(environment.platform, root, agent);
    for (const skill of skills) {
      const target = installerSkillDestination(environment.platform, registryRoot, skill.name);
      paths.push(target);
      if (request.unmanagedPolicy === "side_by_side") {
        paths.push(
          installerSkillDestination(
            environment.platform,
            registryRoot,
            `${skill.name}--${skill.sealedPackageSha256.slice(0, 12)}`,
          ),
        );
      }
      if (request.unmanagedPolicy === "replace_with_backup") {
        paths.push(`${target}.selftune-backup-${skill.sealedPackageSha256.slice(0, 12)}`);
      }
    }
  }
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = installerPathKey(environment.platform, path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const planLocalInstall = Effect.fn("selftune.runtime.installer.plan")(function* (
  request: LocalInstallRequest,
  authorities: InstallerPlanningAuthorities,
) {
  if (
    "customPath" in request ||
    "targetRoot" in request ||
    "globalRoot" in request ||
    "homeDirectory" in request ||
    "configRoot" in request
  ) {
    return yield* Effect.fail(
      error("CUSTOM_PATH_FORBIDDEN", "Custom target paths are not supported in v1."),
    );
  }
  if (request.targetAgents.length === 0) {
    return yield* Effect.fail(
      error("EXPLICIT_AGENT_REQUIRED", "At least one target agent must be explicitly selected."),
    );
  }
  const authorization = yield* authorities.authorization.verify(request.installBootstrapToken);
  const environment = yield* authorities.os.observeEnvironment({
    scope: request.scope,
    projectRoot: request.projectRoot,
  });
  const earlyRootProblem = validateRoot(
    environment.selectedRoot,
    environment.platform,
    environment.homeDirectory,
    request.scope === "project",
  );
  if (earlyRootProblem) return yield* Effect.fail(earlyRootProblem);
  const globalRootProblem = validateAuthorizedGlobalRoot(request, environment);
  if (globalRootProblem) return yield* Effect.fail(globalRootProblem);
  if (
    (request.scope === "project" &&
      (!request.projectRoot ||
        installerPathKey(environment.platform, request.projectRoot) !==
          installerPathKey(environment.platform, environment.selectedRoot.requestedPath))) ||
    (request.scope === "global" && request.projectRoot !== undefined)
  ) {
    return yield* Effect.fail(
      error(
        "PROJECT_ROOT_MISMATCH",
        "The OS observation does not match the selected scope and project.",
      ),
    );
  }
  const destinations = candidatePaths(request, authorization, environment);
  const skills =
    authorization.subject.kind === "standalone"
      ? [authorization.subject.skill]
      : authorization.subject.skills;
  const localSources = skills.flatMap((skill) =>
    skill.source.kind === "local_authoring_immutable" ? [skill.source.absolutePath] : [],
  );
  const pathObservations = yield* authorities.os.observePaths({
    platform: environment.platform,
    destinationPaths: destinations,
    localSourcePaths: localSources,
  });
  const requestedDestinationPaths = new Set(destinations);
  const observedDestinationPaths = new Set(
    pathObservations.destinations.map((destination) => destination.targetPath),
  );
  if (
    pathObservations.destinations.length !== destinations.length ||
    destinations.some((destination) => !observedDestinationPaths.has(destination)) ||
    pathObservations.destinations.some(
      (destination) => !requestedDestinationPaths.has(destination.targetPath),
    )
  ) {
    return yield* Effect.fail(
      error(
        "DESTINATION_OBSERVATION_MISMATCH",
        "OS observations must exactly and uniquely match every derived destination path.",
      ),
    );
  }
  const receipts = yield* authorities.receipts.readReceipts(destinations);
  return yield* planResolvedInstall(request, authorization, {
    ...environment,
    ...pathObservations,
    receipts,
  });
});

/** Replans and executes the materializer commit before the exclusive fence is released. */
export function confirmAndCommitLocalInstall<A, E, R>(
  request: LocalInstallRequest,
  previewToken: string,
  authorities: InstallerPlanningAuthorities,
  commit: (input: {
    readonly plan: LocalInstallPlan;
    readonly fence: InstallerCommitFence;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InstallerPlanningError, R> {
  return authorities.commitLock.withExclusiveCommit((fence) =>
    planLocalInstall(request, authorities).pipe(
      Effect.flatMap((freshPlan) => {
        if (!freshPlan.ready) {
          return Effect.fail(
            error("PREVIEW_NO_LONGER_READY", "Fresh observations now contain install conflicts."),
          );
        }
        if (freshPlan.previewToken !== previewToken) {
          return Effect.fail(
            error(
              "STALE_PREVIEW",
              "The filesystem, receipt, authorization, or root evidence changed after preview.",
            ),
          );
        }
        return fence.assertValid.pipe(Effect.flatMap(() => commit({ plan: freshPlan, fence })));
      }),
    ),
  );
}
