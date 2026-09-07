import { describe, expect, test } from "bun:test";

import {
  buildCompareLine,
  decodeReleaseNotesManifest,
  extractSection,
  parseArgs,
  renderReleaseNotes,
} from "../../scripts/render-release-notes";

const manifestEntries = [
  {
    label: "2026-04-08",
    description: "v0.2.20 to v0.2.23",
    tags: ["OSS", "CLI"],
    rss: {
      title: "April 2026 — multi-platform hooks and replay validation",
      description: "Curated release summary",
    },
    bullets: ["Added replay validation improvements.", "Expanded platform support."],
    versionRange: {
      from: "0.2.20",
      to: "0.2.23",
    },
  },
];

describe("render-release-notes", () => {
  test("decodes release metadata before rendering", () => {
    const manifest = { docsUrl: "https://docs.selftune.dev/changelog", entries: manifestEntries };
    expect(decodeReleaseNotesManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => decodeReleaseNotesManifest("not json")).toThrow();
    expect(() =>
      decodeReleaseNotesManifest(JSON.stringify({ ...manifest, entries: [{}] })),
    ).toThrow();
    expect(() =>
      decodeReleaseNotesManifest(
        JSON.stringify({
          ...manifest,
          entries: [
            {
              ...manifestEntries[0],
              bullets: [42],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  test("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--verison", "0.2.23"])).toThrow("Unknown release notes argument");
    expect(() => parseArgs(["--version"])).toThrow("Missing value");
    expect(() => parseArgs(["--version", "--output", "release.md"])).toThrow("Missing value");
    expect(parseArgs(["--previousTag", "v0.2.22"])).toEqual({ previousTag: "v0.2.22" });
  });

  test("renders the curated Mintlify changelog entry for any version inside the mapped range", () => {
    const body = renderReleaseNotes({
      changelog: "# Changelog\n",
      docsUrl: "https://docs.selftune.dev/changelog",
      entries: manifestEntries,
      previousTag: "v0.2.22",
      version: "0.2.23",
    });

    expect(body).toContain("## April 2026 — multi-platform hooks and replay validation");
    expect(body).toContain("Curated release summary");
    expect(body).toContain("- Added replay validation improvements.");
    expect(body).toContain(
      "**Full Changelog**: https://github.com/selftune-dev/selftune/compare/v0.2.22...v0.2.23",
    );
  });

  test("falls back to the package changelog when no curated entry matches", () => {
    const body = renderReleaseNotes({
      changelog: `# Changelog

## [Unreleased]

### Added

- Pending release note fallback
`,
      docsUrl: "https://docs.selftune.dev/changelog",
      entries: manifestEntries,
      previousTag: "v0.2.23",
      version: "0.2.24",
    });

    expect(body).toContain("falls back to the package changelog's Unreleased section");
    expect(body).toContain("### Added");
    expect(body).toContain("- Pending release note fallback");
  });

  test("normalizes dashed CLI flags", () => {
    expect(
      parseArgs(["--version", "0.2.23", "--previous-tag", "v0.2.22", "--output", "release.md"]),
    ).toEqual({
      output: "release.md",
      previousTag: "v0.2.22",
      version: "0.2.23",
    });
  });

  test("extractSection reads markdown sections without consuming the next heading", () => {
    const section = extractSection(
      `# Changelog

## [0.2.23]

- First

## [0.2.22]

- Second
`,
      "0.2.23",
    );

    expect(section).toContain("- First");
    expect(section).not.toContain("- Second");
  });

  test("buildCompareLine omits output without a previous tag", () => {
    expect(buildCompareLine("0.2.23")).toBe("");
  });
});
