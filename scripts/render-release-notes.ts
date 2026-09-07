import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";

const ReleaseNotesManifestSchema = Schema.Struct({
  docsUrl: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      tags: Schema.Array(Schema.String),
      rss: Schema.Struct({
        title: Schema.NullOr(Schema.String),
        description: Schema.NullOr(Schema.String),
      }),
      bullets: Schema.Array(Schema.String),
      versionRange: Schema.NullOr(Schema.Struct({ from: Schema.String, to: Schema.String })),
    }),
  ),
});

export type ReleaseNotesManifest = typeof ReleaseNotesManifestSchema.Type;
export const decodeReleaseNotesManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReleaseNotesManifestSchema),
);

interface ReleaseNotesArguments {
  output?: string;
  previousTag?: string;
  version?: string;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    throw new Error("Missing required --version argument");
  }

  const manifestPath = resolve(import.meta.dir, "../.github/release-notes.json");
  const changelogPath = resolve(import.meta.dir, "../CHANGELOG.md");
  const outputPath = resolve(process.cwd(), args.output ?? ".github/release-body.md");
  const manifest = decodeReleaseNotesManifest(readFileSync(manifestPath, "utf8"));
  const changelog = readFileSync(changelogPath, "utf8");
  const body = renderReleaseNotes({
    changelog,
    docsUrl: manifest.docsUrl,
    entries: manifest.entries,
    previousTag: args.previousTag,
    version: args.version,
  });

  writeFileSync(outputPath, body);
  console.log(`Wrote release notes: ${outputPath}`);
}

export function parseArgs(argv: string[]) {
  const parsed: ReleaseNotesArguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith("--")) continue;
    const key = normalizeArgKey(part.slice(2));
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value === "" ? undefined : value;
    index += 1;
  }
  return parsed;
}

export function renderReleaseNotes({
  changelog,
  docsUrl,
  entries,
  previousTag,
  version,
}: {
  changelog: string;
  docsUrl: string;
  entries: ReleaseNotesManifest["entries"];
  previousTag?: string;
  version: string;
}) {
  const entry = entries.find((candidate) => matchesVersion(version, candidate.versionRange));
  return entry
    ? renderCuratedReleaseBody(version, entry, docsUrl, previousTag)
    : renderFallbackReleaseBody(version, changelog, docsUrl, previousTag);
}

export function matchesVersion(version: string, range: { from: string; to: string } | null) {
  if (!range) return false;
  return compareVersions(version, range.from) >= 0 && compareVersions(version, range.to) <= 0;
}

export function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function renderCuratedReleaseBody(
  version: string,
  entry: ReleaseNotesManifest["entries"][number],
  docsUrl: string,
  previousTag?: string,
) {
  const lines = [
    `## ${entry.rss.title ?? `selftune ${version}`}`,
    "",
    entry.rss.description ?? entry.description,
    "",
    "### Highlights",
    ...entry.bullets.map((bullet) => `- ${bullet}`),
    "",
    `**Docs changelog window:** ${entry.description}`,
    `**Tags:** ${entry.tags.join(", ")}`,
    `**Full docs changelog:** ${docsUrl}`,
  ];

  const compareLine = buildCompareLine(version, previousTag);
  if (compareLine) {
    lines.push(compareLine);
  }

  return `${lines.join("\n")}\n`;
}

export function renderFallbackReleaseBody(
  version: string,
  changelog: string,
  docsUrl: string,
  previousTag?: string,
) {
  const exactSection = extractSection(changelog, version);
  const unreleasedSection = extractSection(changelog, "Unreleased");
  const section = exactSection || unreleasedSection;
  const lines = [
    `## selftune ${version}`,
    "",
    exactSection
      ? "Curated docs release notes were not found for this version, so this release falls back to the package changelog."
      : "Curated docs release notes were not found for this version, so this release falls back to the package changelog's Unreleased section.",
    "",
  ];

  if (section) {
    lines.push("### Changelog");
    lines.push("");
    lines.push(section.trim());
    lines.push("");
  }

  lines.push(`**Full docs changelog:** ${docsUrl}`);
  const compareLine = buildCompareLine(version, previousTag);
  if (compareLine) {
    lines.push(compareLine);
  }

  return `${lines.join("\n")}\n`;
}

export function extractSection(changelog: string, section: string) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, "m").exec(changelog);
  if (!headingMatch) return "";

  const headingEnd = headingMatch.index + headingMatch[0].length;
  const afterHeading = changelog.slice(headingEnd).replace(/^\r?\n/, "");
  const nextHeadingIndex = afterHeading.search(/^## \[/m);
  const sectionBody =
    nextHeadingIndex >= 0 ? afterHeading.slice(0, nextHeadingIndex) : afterHeading;
  return sectionBody.trim();
}

export function buildCompareLine(version: string, previousTag?: string) {
  if (!previousTag) return "";
  return `**Full Changelog**: https://github.com/selftune-dev/selftune/compare/${previousTag}...v${version}`;
}

function normalizeArgKey(key: string) {
  switch (key) {
    case "output":
      return "output";
    case "version":
      return "version";
    case "previous-tag":
    case "previousTag":
      return "previousTag";
    default:
      throw new Error(`Unknown release notes argument --${key}`);
  }
}
