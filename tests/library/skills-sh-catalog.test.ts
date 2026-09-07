import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import {
  materializeSkillsShCatalogEntry,
  searchSkillsShCatalog,
  type SkillsShCatalogFetch,
  type SkillsShCatalogMaterializeInput,
  type SkillsShCatalogMaterializationProgress,
} from "../../packages/library/src/skills-sh-catalog.js";

function jsonResponse(body: typeof Schema.Json.Type, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("skills.sh catalog discovery", () => {
  test("returns authoritative install and download identities", async () => {
    let requestedUrl = "";
    const fetcher: SkillsShCatalogFetch = async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        skills: [
          {
            id: "flutter/skills/flutter-add-widget-test",
            name: "flutter-add-widget-test",
            source: "flutter/skills",
            installs: 22_000,
          },
        ],
      });
    };

    const entries = await Effect.runPromise(
      searchSkillsShCatalog("  flutter widget  ", { fetcher, limit: 5 }),
    );

    expect(requestedUrl).toBe("https://skills.sh/api/search?q=flutter+widget&limit=5");
    expect(entries).toEqual([
      {
        catalog_id: "flutter/skills/flutter-add-widget-test",
        name: "flutter-add-widget-test",
        source: "flutter/skills",
        owner: "flutter",
        repository: "skills",
        install_spec: "flutter/skills@flutter-add-widget-test",
        details_url: "https://skills.sh/flutter/skills/flutter-add-widget-test",
        download_url: "https://skills.sh/api/download/flutter/skills/flutter-add-widget-test",
        installs: 22_000,
      },
    ]);
  });

  test("derives source identity from the catalog id and removes duplicate results", async () => {
    const fetcher: SkillsShCatalogFetch = async () =>
      jsonResponse({
        skills: [
          { id: "mattpocock/skills/tdd", name: "tdd", source: null, installs: 10 },
          { id: "mattpocock/skills/tdd", name: "tdd", source: "mattpocock/skills", installs: 12 },
          { id: "not-installable", name: "invented", source: null, installs: 999 },
        ],
      });

    const entries = await Effect.runPromise(searchSkillsShCatalog("test driven", { fetcher }));

    expect(entries.map((entry) => [entry.install_spec, entry.installs])).toEqual([
      ["mattpocock/skills@tdd", 12],
    ]);
  });

  test("validates the query and endpoint before performing network I/O", async () => {
    let requests = 0;
    const fetcher: SkillsShCatalogFetch = async () => {
      requests += 1;
      return jsonResponse({ skills: [] });
    };

    const queryFailure = await Effect.runPromise(
      Effect.flip(searchSkillsShCatalog("x", { fetcher })),
    );
    const endpointFailure = await Effect.runPromise(
      Effect.flip(
        searchSkillsShCatalog("flutter", {
          apiBaseUrl: "http://catalog.example.test",
          fetcher,
        }),
      ),
    );

    expect(queryFailure).toMatchObject({ _tag: "SkillsShCatalogInputError" });
    expect(endpointFailure).toMatchObject({ _tag: "SkillsShCatalogInputError" });
    expect(requests).toBe(0);
  });

  test("reports HTTP and schema failures as typed errors", async () => {
    const httpFailure = await Effect.runPromise(
      Effect.flip(
        searchSkillsShCatalog("flutter", {
          fetcher: async () => jsonResponse({ error: "busy" }, 503),
        }),
      ),
    );
    const decodeFailure = await Effect.runPromise(
      Effect.flip(
        searchSkillsShCatalog("flutter", {
          fetcher: async () => jsonResponse({ skills: [{ id: 42 }] }),
        }),
      ),
    );

    expect(httpFailure).toMatchObject({ _tag: "SkillsShCatalogHttpError", status: 503 });
    expect(decodeFailure).toMatchObject({ _tag: "SkillsShCatalogDecodeError" });
  });

  test.each(["{broken", "null", "[]", '{"skills":false}'])(
    "classifies malformed catalog JSON: %s",
    async (body) => {
      const failure = await Effect.runPromise(
        Effect.flip(
          searchSkillsShCatalog("flutter", {
            fetcher: async () => new Response(body),
          }),
        ),
      );
      expect(failure).toMatchObject({ _tag: "SkillsShCatalogDecodeError" });
    },
  );

  test("rejects oversized responses before decoding", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        searchSkillsShCatalog("flutter", {
          fetcher: async () =>
            new Response("{}", {
              headers: { "content-length": String(1024 * 1024 + 1) },
            }),
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "SkillsShCatalogDecodeError",
      message: "Catalog response exceeds the 1 MiB size limit",
    });
  });
});

const catalogEntry: SkillsShCatalogMaterializeInput = {
  catalog_id: "flutter/skills/flutter-add-widget-test",
  name: "Flutter Add Widget Test",
  source: "flutter/skills",
  install_spec: "flutter/skills@flutter-add-widget-test",
  download_url: "https://skills.sh/api/download/flutter/skills/flutter-add-widget-test",
};

function downloadPayload(
  overrides: Partial<{
    id: string;
    source: string;
    slug: string;
    hash: string | null;
    files: Array<{ path: string; contents: string; type?: string; mode?: string | number }> | null;
  }> = {},
) {
  return {
    hash: "a".repeat(64),
    files: [
      { path: "SKILL.md", contents: "---\nname: flutter-add-widget-test\n---\n# Flutter\n" },
      { path: "references/widget.md", contents: "# Widget reference\n" },
    ],
    ...overrides,
  };
}

describe("skills.sh catalog materialization", () => {
  test("atomically materializes a real content-addressed package", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-skills-sh-"));
    const progress: SkillsShCatalogMaterializationProgress[] = [];
    try {
      const result = await Effect.runPromise(
        materializeSkillsShCatalogEntry(catalogEntry, {
          configRoot,
          fetcher: async () => jsonResponse(downloadPayload()),
          onProgress: (event) => progress.push(event),
        }),
      );

      expect(result).toMatchObject({
        name: "flutter-add-widget-test",
        display_name: "Flutter Add Widget Test",
        upstream_revision: "a".repeat(64),
        catalog_hash: "a".repeat(64),
        catalog_hash_verified: false,
        file_count: 2,
        reused: false,
      });
      expect(result.package_path).toBe(
        join(configRoot, "library", "packages", result.content_hash, result.name),
      );
      expect(readFileSync(join(result.package_path, "SKILL.md"), "utf8")).toContain("# Flutter");
      expect(readFileSync(join(result.package_path, "references", "widget.md"), "utf8")).toBe(
        "# Widget reference\n",
      );
      expect(progress.map((event) => event.stage)).toEqual([
        "fetching",
        "validating",
        "staging",
        "complete",
      ]);
      expect(readdirSync(join(configRoot, "library", "packages"))).not.toContainEqual(
        expect.stringContaining(".stage-"),
      );
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test("deduplicates repeated downloads against the verified canonical revision", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-skills-sh-dedupe-"));
    try {
      const options = {
        configRoot,
        fetcher: async () => jsonResponse(downloadPayload()),
      };
      const first = await Effect.runPromise(materializeSkillsShCatalogEntry(catalogEntry, options));
      const second = await Effect.runPromise(
        materializeSkillsShCatalogEntry(catalogEntry, options),
      );

      expect(second.package_path).toBe(first.package_path);
      expect(second.content_hash).toBe(first.content_hash);
      expect(second.reused).toBe(true);
      expect(readdirSync(join(configRoot, "library", "packages"))).toEqual([first.content_hash]);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["absolute paths", [{ path: "/SKILL.md", contents: "bad" }]],
    ["traversal", [{ path: "../SKILL.md", contents: "bad" }]],
    ["backslashes", [{ path: "refs\\SKILL.md", contents: "bad" }]],
    ["Windows alternate streams", [{ path: "SKILL.md:payload", contents: "bad" }]],
    ["Windows device aliases", [{ path: "CON/SKILL.md", contents: "bad" }]],
    ["NUL bytes", [{ path: "SKILL.md\0.txt", contents: "bad" }]],
    ["empty segments", [{ path: "refs//SKILL.md", contents: "bad" }]],
    ["symlink types", [{ path: "SKILL.md", contents: "target", type: "symlink" }]],
    ["symlink modes", [{ path: "SKILL.md", contents: "target", mode: "120000" }]],
    [
      "case-colliding duplicates",
      [
        { path: "SKILL.md", contents: "first" },
        { path: "skill.md", contents: "second" },
      ],
    ],
  ])("rejects %s before writing package files", async (_label, files) => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-skills-sh-path-"));
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          materializeSkillsShCatalogEntry(catalogEntry, {
            configRoot,
            fetcher: async () => jsonResponse(downloadPayload({ files })),
          }),
        ),
      );
      expect(failure).toMatchObject({ _tag: "SkillsShCatalogPathError" });
      expect(readdirSync(configRoot)).toEqual([]);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test("requires an exact root SKILL.md and enforces decoded package bounds", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-skills-sh-bounds-"));
    try {
      const missingRoot = await Effect.runPromise(
        Effect.flip(
          materializeSkillsShCatalogEntry(catalogEntry, {
            configRoot,
            fetcher: async () =>
              jsonResponse(
                downloadPayload({ files: [{ path: "nested/SKILL.md", contents: "x" }] }),
              ),
          }),
        ),
      );
      const oversizedFile = await Effect.runPromise(
        Effect.flip(
          materializeSkillsShCatalogEntry(catalogEntry, {
            configRoot,
            fetcher: async () =>
              jsonResponse(
                downloadPayload({
                  files: [
                    { path: "SKILL.md", contents: "ok" },
                    { path: "large.txt", contents: "x".repeat(1024 * 1024 + 1) },
                  ],
                }),
              ),
          }),
        ),
      );
      const tooManyFiles = Array.from({ length: 129 }, (_, index) => ({
        path: index === 0 ? "SKILL.md" : `references/${index}.md`,
        contents: "x",
      }));
      const fileCount = await Effect.runPromise(
        Effect.flip(
          materializeSkillsShCatalogEntry(catalogEntry, {
            configRoot,
            fetcher: async () => jsonResponse(downloadPayload({ files: tooManyFiles })),
          }),
        ),
      );

      expect(missingRoot).toMatchObject({ _tag: "SkillsShCatalogPathError" });
      expect(oversizedFile).toMatchObject({ _tag: "SkillsShCatalogDownloadDecodeError" });
      expect(fileCount).toMatchObject({ _tag: "SkillsShCatalogDownloadDecodeError" });
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test("reports fetch, HTTP, decode, and identity failures with distinct tags", async () => {
    const fetchFailure = await Effect.runPromise(
      Effect.flip(
        materializeSkillsShCatalogEntry(catalogEntry, {
          fetcher: async () => {
            throw new Error("offline");
          },
        }),
      ),
    );
    const httpFailure = await Effect.runPromise(
      Effect.flip(
        materializeSkillsShCatalogEntry(catalogEntry, {
          fetcher: async () => jsonResponse({ error: "busy" }, 503),
        }),
      ),
    );
    const decodeFailure = await Effect.runPromise(
      Effect.flip(
        materializeSkillsShCatalogEntry(catalogEntry, {
          fetcher: async () => jsonResponse({ files: "nope" }),
        }),
      ),
    );
    const identityFailure = await Effect.runPromise(
      Effect.flip(
        materializeSkillsShCatalogEntry(catalogEntry, {
          fetcher: async () => jsonResponse(downloadPayload({ source: "other/repo" })),
        }),
      ),
    );

    expect(fetchFailure).toMatchObject({ _tag: "SkillsShCatalogFetchError" });
    expect(httpFailure).toMatchObject({
      _tag: "SkillsShCatalogDownloadHttpError",
      status: 503,
    });
    expect(decodeFailure).toMatchObject({ _tag: "SkillsShCatalogDownloadDecodeError" });
    expect(identityFailure).toMatchObject({ _tag: "SkillsShCatalogIntegrityError" });
  });

  test.each([
    [
      "a different HTTPS host",
      { download_url: "https://example.test/api/download/flutter/skills/flutter-add-widget-test" },
    ],
    [
      "the authenticated v1 endpoint",
      { download_url: "https://skills.sh/api/v1/skills/flutter/skills/flutter-add-widget-test" },
    ],
    ["a mismatched install spec", { install_spec: "flutter/skills@different-skill" }],
  ])("rejects %s before network I/O", async (_label, override) => {
    let requests = 0;
    const failure = await Effect.runPromise(
      Effect.flip(
        materializeSkillsShCatalogEntry(
          { ...catalogEntry, ...override },
          {
            fetcher: async () => {
              requests += 1;
              return jsonResponse(downloadPayload());
            },
          },
        ),
      ),
    );

    expect(failure).toMatchObject({ _tag: "SkillsShCatalogPathError" });
    expect(requests).toBe(0);
  });

  test("detects corruption in an existing immutable catalog revision", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "selftune-skills-sh-corrupt-"));
    try {
      const options = {
        configRoot,
        fetcher: async () => jsonResponse(downloadPayload()),
      };
      const first = await Effect.runPromise(materializeSkillsShCatalogEntry(catalogEntry, options));
      writeFileSync(join(first.package_path, "SKILL.md"), "corrupted\n");

      const failure = await Effect.runPromise(
        Effect.flip(materializeSkillsShCatalogEntry(catalogEntry, options)),
      );
      expect(failure).toMatchObject({ _tag: "SkillsShCatalogIntegrityError" });
      expect(
        readdirSync(join(configRoot, "library", "packages")).filter((path) =>
          path.startsWith(".stage-"),
        ),
      ).toEqual([]);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });
});
