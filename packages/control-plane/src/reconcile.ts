import {
  LibraryLocation,
  LibraryRevision,
  LibrarySkill,
  LibrarySnapshot,
  type LibraryObservation,
  type SkillLifecycle,
  type SkillUpdateStatus,
} from "./domain";

const normalizeSkillId = (name: string): string => name.trim().toLocaleLowerCase("en-US");

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const locationKey = (location: LibraryObservation): string =>
  [
    location.harness ?? "",
    location.sourceKind,
    location.scope,
    location.packagePath,
    location.skillPath,
    location.projectRoot ?? "",
  ].join("\u0000");

const toLocation = (observation: LibraryObservation) =>
  LibraryLocation.make({
    sourceKind: observation.sourceKind,
    packagePath: observation.packagePath,
    skillPath: observation.skillPath,
    harness: observation.harness,
    scope: observation.scope,
    projectRoot: observation.projectRoot,
    active: observation.active,
    modifiedAt: observation.modifiedAt,
    lastUsedAt: observation.lastUsedAt,
    origin: observation.origin,
    updateStatus: observation.updateStatus,
  });

const latestTimestamp = (values: ReadonlyArray<string | null>): string | null =>
  values
    .filter((value): value is string => value !== null)
    .sort((left, right) => compareText(right, left))[0] ?? null;

const updateStatusFor = (observations: ReadonlyArray<LibraryObservation>): SkillUpdateStatus => {
  const statuses = new Set(observations.map((item) => item.updateStatus));
  if (statuses.has("available")) return "available";
  if (statuses.has("current")) return "current";
  if (statuses.has("unknown")) return "unknown";
  return "untracked";
};

const lifecycleFor = (observations: ReadonlyArray<LibraryObservation>): SkillLifecycle => {
  if (observations.some((item) => item.sourceKind === "installed" && item.active)) {
    return "active";
  }
  if (observations.some((item) => item.sourceKind === "draft")) {
    return "draft";
  }
  if (observations.every((item) => item.sourceKind === "archived")) {
    return "archived";
  }
  return "library";
};

const preferredName = (observations: ReadonlyArray<LibraryObservation>): string =>
  [...observations].map((item) => item.skillName.trim()).sort(compareText)[0] ?? "";

export const buildLibrarySnapshot = (
  observations: ReadonlyArray<LibraryObservation>,
): LibrarySnapshot => {
  const bySkill = new Map<string, Array<LibraryObservation>>();

  for (const observation of observations) {
    const skillId = normalizeSkillId(observation.skillName);
    if (skillId.length === 0) continue;
    const current = bySkill.get(skillId) ?? [];
    current.push(observation);
    bySkill.set(skillId, current);
  }

  const skills = [...bySkill.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([skillId, skillObservations]) => {
      const distinctLocations = new Map<string, LibraryObservation>();
      for (const observation of skillObservations) {
        distinctLocations.set(locationKey(observation), observation);
      }
      const sortedObservations = [...distinctLocations.values()].sort((left, right) =>
        compareText(locationKey(left), locationKey(right)),
      );

      const byRevision = new Map<string, Array<LibraryObservation>>();
      for (const observation of sortedObservations) {
        if (observation.contentHash === null) continue;
        const current = byRevision.get(observation.contentHash) ?? [];
        current.push(observation);
        byRevision.set(observation.contentHash, current);
      }

      const revisions = [...byRevision.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([contentHash, revisionObservations]) =>
          LibraryRevision.make({
            contentHash,
            locations: revisionObservations.map(toLocation),
          }),
        );

      const origins = [
        ...new Map(
          sortedObservations
            .map((item) => item.origin)
            .filter((origin) => origin !== null)
            .map((origin) => [
              `${origin.kind}\u0000${origin.label}\u0000${origin.url ?? ""}`,
              origin,
            ]),
        ).values(),
      ].sort((left, right) => compareText(left.label, right.label));

      return LibrarySkill.make({
        skillId,
        name: preferredName(skillObservations),
        lifecycle: lifecycleFor(skillObservations),
        revisions,
        locations: sortedObservations.map(toLocation),
        lastUsedAt: latestTimestamp(sortedObservations.map((item) => item.lastUsedAt)),
        lastModifiedAt:
          latestTimestamp(sortedObservations.map((item) => item.modifiedAt)) ??
          "1970-01-01T00:00:00.000Z",
        origins,
        updateStatus: updateStatusFor(sortedObservations),
      });
    });

  const counts = {
    total: skills.length,
    active: skills.filter((skill) => skill.lifecycle === "active").length,
    library: skills.filter((skill) => skill.lifecycle === "library").length,
    draft: skills.filter((skill) => skill.lifecycle === "draft").length,
    archived: skills.filter((skill) => skill.lifecycle === "archived").length,
  };
  const generatedAt =
    observations
      .map((item) => item.modifiedAt)
      .sort((left, right) => compareText(right, left))[0] ?? "1970-01-01T00:00:00.000Z";

  return LibrarySnapshot.make({ generatedAt, skills, counts });
};
