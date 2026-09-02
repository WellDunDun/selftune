import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const PackageIdentifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
const SemanticVersion = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
);
const VersionRange = Schema.String.check(
  Schema.isPattern(
    /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Capability = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,127}$/));
const Harness = Schema.Literals(["claude_code", "codex", "opencode", "openclaw", "pi"]);

export class SkillSetPackageDependency extends Schema.Class<SkillSetPackageDependency>(
  "SkillSetPackageDependency",
)({
  package_id: PackageIdentifier,
  version_range: VersionRange,
}) {}

export class SkillSetPackageConflict extends Schema.Class<SkillSetPackageConflict>(
  "SkillSetPackageConflict",
)({
  package_id: PackageIdentifier,
}) {}

export class SkillSetPackageMetadata extends Schema.Class<SkillSetPackageMetadata>(
  "SkillSetPackageMetadata",
)({
  package_id: PackageIdentifier,
  version: SemanticVersion,
  revision_sha256: Sha256,
  dependencies: Schema.Struct({
    requires: Schema.Array(SkillSetPackageDependency),
    optional: Schema.Array(SkillSetPackageDependency),
    conflicts: Schema.Array(SkillSetPackageConflict),
  }),
  compatibility: Schema.Struct({
    harnesses: Schema.Array(Harness).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    required_capabilities: Schema.Array(Capability).check(Schema.isMaxLength(100)),
  }),
  provides: Schema.Array(Capability).check(Schema.isMaxLength(100)),
}) {}

export const SkillSetDependencyLockEntry = Schema.Struct({
  package_id: PackageIdentifier,
  version: SemanticVersion,
  revision_sha256: Sha256,
  dependency_kind: Schema.Literals(["root", "required", "optional"]),
});
export type SkillSetDependencyLockEntry = typeof SkillSetDependencyLockEntry.Type;

export const SkillSetDependencyCurrentLockEntry = Schema.Struct({
  package_id: PackageIdentifier,
  version: SemanticVersion,
  revision_sha256: Sha256,
});

export const SkillSetDependencyResolutionInput = Schema.Struct({
  roots: Schema.Array(PackageIdentifier).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  available_packages: Schema.Array(SkillSetPackageMetadata).check(Schema.isMaxLength(5_000)),
  environment: Schema.Struct({
    harness: Harness,
    capabilities: Schema.Array(Capability).check(Schema.isMaxLength(500)),
  }),
  current_lock: Schema.Array(SkillSetDependencyCurrentLockEntry).check(Schema.isMaxLength(5_000)),
});
export type SkillSetDependencyResolutionInput = typeof SkillSetDependencyResolutionInput.Type;

const SkillSetDependencyImpact = Schema.Struct({
  added: Schema.Array(Schema.String),
  changed: Schema.Array(
    Schema.Struct({
      package_id: PackageIdentifier,
      from: SemanticVersion,
      to: SemanticVersion,
    }),
  ),
  removed: Schema.Array(Schema.String),
  unchanged: Schema.Array(Schema.String),
});

export const SkillSetDependencyResolution = Schema.Struct({
  lock: Schema.Struct({ entries: Schema.Array(SkillSetDependencyLockEntry) }),
  impact: SkillSetDependencyImpact,
});
export type SkillSetDependencyResolution = typeof SkillSetDependencyResolution.Type;

/** Canonical dependency evidence sealed into a portable Skill Set release. */
export const SkillSetDependencyEnvelope = Schema.Struct({
  roots: Schema.Array(PackageIdentifier).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  available_packages: Schema.Array(SkillSetPackageMetadata).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  environment: Schema.Struct({
    harness: Harness,
    capabilities: Schema.Array(Capability).check(Schema.isMaxLength(500)),
  }),
  lock: Schema.Struct({
    entries: Schema.Array(SkillSetDependencyLockEntry).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
    ),
  }),
});
export type SkillSetDependencyEnvelope = typeof SkillSetDependencyEnvelope.Type;

export const SkillSetDependencyErrorReason = Schema.Literals([
  "invalid_metadata",
  "missing_dependency",
  "dependency_cycle",
  "incompatible_package",
  "package_conflict",
]);
export type SkillSetDependencyErrorReason = typeof SkillSetDependencyErrorReason.Type;

export class SkillSetDependencyError extends Schema.TaggedErrorClass<SkillSetDependencyError>()(
  "SkillSetDependencyError",
  {
    reason: SkillSetDependencyErrorReason,
    package_id: Schema.NullOr(PackageIdentifier),
    message: Schema.String.check(Schema.isMaxLength(320)),
  },
) {}

type DependencyKind = SkillSetDependencyLockEntry["dependency_kind"];

function failure(
  reason: SkillSetDependencyErrorReason,
  packageId: string | null,
  message: string,
): SkillSetDependencyError {
  return SkillSetDependencyError.make({
    reason,
    package_id: packageId,
    message: message.slice(0, 320),
  });
}

function versionParts(version: string): ReadonlyArray<number> {
  return version.split(".").map(Number);
}

function compareVersion(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function satisfies(version: string, range: string): boolean {
  const [minimumToken, maximumToken] = range.split(" ");
  const minimum = minimumToken?.slice(2) ?? "";
  const maximum = maximumToken?.slice(1) ?? "";
  return compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
}

function packageKey(entry: { readonly package_id: string; readonly version: string }): string {
  return `${entry.package_id}@${entry.version}`;
}

function dependencyKind(current: DependencyKind, incoming: DependencyKind): DependencyKind {
  if (current === "root" || incoming === "root") return "root";
  if (current === "required" || incoming === "required") return "required";
  return "optional";
}

function isCompatible(
  candidate: SkillSetPackageMetadata,
  harness: typeof Harness.Type,
  capabilities: ReadonlySet<string>,
): boolean {
  return (
    candidate.compatibility.harnesses.includes(harness) &&
    candidate.compatibility.required_capabilities.every((capability) =>
      capabilities.has(capability),
    )
  );
}

export const resolveSkillSetDependencies = Effect.fn("resolveSkillSetDependencies")(function* (
  unknownInput: SkillSetDependencyResolutionInput,
) {
  const decoded = yield* Schema.decodeUnknownEffect(SkillSetDependencyResolutionInput)(
    unknownInput,
  ).pipe(
    Effect.mapError(() =>
      failure("invalid_metadata", null, "Skill Set dependency metadata is invalid"),
    ),
  );
  const capabilities = new Set(decoded.environment.capabilities);
  const byPackage = new Map<string, Array<SkillSetPackageMetadata>>();
  for (const candidate of decoded.available_packages) {
    const versions = byPackage.get(candidate.package_id) ?? [];
    versions.push(candidate);
    byPackage.set(candidate.package_id, versions);
  }
  for (const versions of byPackage.values()) {
    versions.sort(
      (left, right) =>
        compareVersion(right.version, left.version) ||
        right.revision_sha256.localeCompare(left.revision_sha256),
    );
  }

  type Selection = Map<
    string,
    {
      readonly metadata: SkillSetPackageMetadata;
      readonly kind: DependencyKind;
    }
  >;
  interface PendingDependency {
    readonly packageId: string;
    readonly range: string | null;
    readonly kind: DependencyKind;
    readonly path: ReadonlyArray<string>;
  }
  type SearchResult =
    | { readonly status: "resolved"; readonly selected: Selection }
    | { readonly status: "failed"; readonly error: SkillSetDependencyError };

  const search = (pending: ReadonlyArray<PendingDependency>, selected: Selection): SearchResult => {
    const [request, ...remaining] = pending;
    if (!request) {
      for (const { metadata } of selected.values()) {
        for (const conflict of metadata.dependencies.conflicts) {
          if (selected.has(conflict.package_id)) {
            return {
              status: "failed",
              error: failure(
                "package_conflict",
                metadata.package_id,
                `${metadata.package_id}@${metadata.version} conflicts with ${conflict.package_id}`,
              ),
            };
          }
        }
      }
      return { status: "resolved", selected };
    }

    const cycleStart = request.path.indexOf(request.packageId);
    if (cycleStart >= 0) {
      const cycle = [...request.path.slice(cycleStart), request.packageId].join(" -> ");
      return {
        status: "failed",
        error: failure(
          "dependency_cycle",
          request.packageId,
          `Dependency cycle detected: ${cycle}`,
        ),
      };
    }

    const existing = selected.get(request.packageId);
    if (existing) {
      if (request.range !== null && !satisfies(existing.metadata.version, request.range)) {
        if (request.kind === "optional") return search(remaining, selected);
        return {
          status: "failed",
          error: failure(
            "incompatible_package",
            request.packageId,
            `${request.packageId}@${existing.metadata.version} does not satisfy ${request.range}`,
          ),
        };
      }
      const promoted = dependencyKind(existing.kind, request.kind);
      if (promoted === existing.kind) return search(remaining, selected);
      const next = new Map(selected);
      next.set(request.packageId, {
        metadata: existing.metadata,
        kind: promoted,
      });
      return search(remaining, next);
    }

    const versions = byPackage.get(request.packageId) ?? [];
    const matching = versions.filter(
      (candidate) => request.range === null || satisfies(candidate.version, request.range),
    );
    const candidates = matching.filter((candidate) =>
      isCompatible(candidate, decoded.environment.harness, capabilities),
    );
    let branchFailure: SkillSetDependencyError | undefined;
    for (const candidate of candidates) {
      const next = new Map(selected);
      next.set(request.packageId, { metadata: candidate, kind: request.kind });
      const path = [...request.path, request.packageId];
      const dependencies: Array<PendingDependency> = [
        ...candidate.dependencies.requires.map((dependency) => ({
          packageId: dependency.package_id,
          range: dependency.version_range,
          kind: "required" as const,
          path,
        })),
        ...candidate.dependencies.optional.map((dependency) => ({
          packageId: dependency.package_id,
          range: dependency.version_range,
          kind: "optional" as const,
          path,
        })),
      ];
      const result = search([...dependencies, ...remaining], next);
      if (result.status === "resolved") return result;
      branchFailure = result.error;
    }

    if (request.kind === "optional") return search(remaining, selected);
    if (branchFailure) return { status: "failed", error: branchFailure };
    return {
      status: "failed",
      error:
        matching.length > 0
          ? failure(
              "incompatible_package",
              request.packageId,
              `${request.packageId} is incompatible with the target environment`,
            )
          : failure(
              "missing_dependency",
              request.packageId,
              request.range === null
                ? `Required package ${request.packageId} is unavailable`
                : `Required package ${request.packageId} matching ${request.range} is unavailable`,
            ),
    };
  };

  // oxlint-disable-next-line unicorn/no-array-sort -- the spread preserves decoded input.
  const roots = [...decoded.roots].sort().map((packageId) => ({
    packageId,
    range: null,
    kind: "root" as const,
    path: [],
  }));
  const resolution = search(roots, new Map());
  if (resolution.status === "failed") return yield* Effect.fail(resolution.error);
  const selected = resolution.selected;

  const unsortedEntries = [...selected.values()].map(({ metadata, kind }) => ({
    package_id: metadata.package_id,
    version: metadata.version,
    revision_sha256: metadata.revision_sha256,
    dependency_kind: kind,
  }));
  // oxlint-disable-next-line unicorn/no-array-sort -- this is an encoder-owned projection.
  const entries = unsortedEntries.sort((left, right) =>
    left.package_id.localeCompare(right.package_id),
  );
  const current = new Map(decoded.current_lock.map((entry) => [entry.package_id, entry]));
  const next = new Map(entries.map((entry) => [entry.package_id, entry]));
  const added = entries.filter((entry) => !current.has(entry.package_id)).map(packageKey);
  const changed = entries
    .filter((entry) => {
      const prior = current.get(entry.package_id);
      return prior !== undefined && prior.revision_sha256 !== entry.revision_sha256;
    })
    .map((entry) => ({
      package_id: entry.package_id,
      from: current.get(entry.package_id)?.version ?? entry.version,
      to: entry.version,
    }));
  const unchanged = entries
    .filter((entry) => current.get(entry.package_id)?.revision_sha256 === entry.revision_sha256)
    .map(packageKey);
  const removed = decoded.current_lock
    .filter((entry) => !next.has(entry.package_id))
    .map(packageKey);
  // oxlint-disable-next-line unicorn/no-array-sort -- this is an encoder-owned projection.
  removed.sort();

  return { lock: { entries }, impact: { added, changed, removed, unchanged } };
});
