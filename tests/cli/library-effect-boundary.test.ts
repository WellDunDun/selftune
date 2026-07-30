import { afterEach, describe, expect, test } from "bun:test";
import { CatalogMemory, SyncPreferences } from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectLocalObjectsEffect } from "../../packages/runtime/remote-library/collect.js";
import { previewRemoteLibrarySyncEffect } from "../../packages/runtime/remote-library/effect-sync.js";
import type { LibraryCatalogOptions } from "../../packages/runtime/library/catalog.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-library-effect-boundary-"));
  roots.push(root);
  return root;
}

function readRuntimeSource(relativePath: string): string {
  return readFileSync(join(import.meta.dir, "../../packages/runtime", relativePath), "utf8");
}

const disabledPreferences = SyncPreferences.make({
  releasedSkills: false,
  drafts: false,
  skillSets: false,
  metadata: false,
  decisionHistory: false,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Library Effect execution boundary", () => {
  test("collects and previews local objects through the caller-owned Catalog service", async () => {
    const root = temporaryRoot();
    const configRoot = join(root, "config");
    const catalogOptions: LibraryCatalogOptions = {
      searchDirs: [join(root, "skills")],
      skillSetConfigRoot: configRoot,
      quarantineRoot: join(root, "quarantine"),
      usageRows: [],
      sourceMetadata: { homeDir: root, updateMode: "cache-first" },
    };

    const objects = await Effect.runPromise(
      collectLocalObjectsEffect({
        configRoot,
        preferences: disabledPreferences,
        catalogOptions,
      }).pipe(Effect.provide(CatalogMemory)),
    );
    expect(objects).toEqual([]);

    const preview = await Effect.runPromise(
      previewRemoteLibrarySyncEffect({
        configRoot,
        preferences: disabledPreferences,
        catalogOptions,
      }).pipe(Effect.provide(CatalogMemory)),
    );
    expect(preview).toEqual({ artifacts: [], totalBytes: 0 });
  });

  test("keeps catalog collection and remote sync inside the active Effect runtime", () => {
    const catalogSource = readRuntimeSource("library/catalog.ts");
    const collectSource = readRuntimeSource("remote-library/collect.ts");
    const metadataSource = readRuntimeSource("source-management/metadata-adapter.ts");
    const syncSource = readRuntimeSource("remote-library/effect-sync.ts");
    const observationsEffectSource = catalogSource.slice(
      catalogSource.indexOf("export const collectLibraryObservationsEffect"),
      catalogSource.indexOf("export function collectLibraryObservations"),
    );
    const catalogEffectSource = catalogSource.slice(
      catalogSource.indexOf("export const loadLibraryCatalogEffect"),
      catalogSource.indexOf("export async function loadLibraryCatalog"),
    );
    const metadataEffectSource = metadataSource.slice(
      metadataSource.indexOf("export const resolveInstalledSkillMetadataEffect"),
      metadataSource.indexOf("export function resolveInstalledSkillMetadata"),
    );

    expect(observationsEffectSource).not.toMatch(/\bresolveInstalledSkillMetadata\s*\(/);
    expect(catalogEffectSource).not.toMatch(/\bcollectLibraryObservations\s*\(/);
    for (const source of [observationsEffectSource, catalogEffectSource, metadataEffectSource]) {
      expect(source).not.toMatch(
        /ManagedRuntime|Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/,
      );
    }
    expect(collectSource).not.toMatch(
      /ManagedRuntime|Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/,
    );
    expect(syncSource).toContain("collectLocalObjectsEffect");
    expect(syncSource).not.toMatch(/\bcollectLocalObjects\s*\(/);
    expect(syncSource).not.toMatch(
      /ManagedRuntime|Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/,
    );
  });

  test("keeps catalog and synthesis programs off Promise compatibility workflows", () => {
    const programSource = readRuntimeSource("library/programs.ts");
    const effectSynthesisSource = readRuntimeSource("library/effect-synthesis.ts");
    const synthesisSource = readRuntimeSource("library/synthesis-programs.ts");

    expect(programSource).toContain("loadLibraryCatalogEffect");
    expect(programSource).not.toMatch(/\bloadLibraryCatalog\s*\(/);
    expect(programSource).not.toMatch(/\bpromiseOperation\b/);
    expect(synthesisSource).not.toMatch(/\brunPromiseOperation\b/);
    expect(synthesisSource).not.toMatch(
      /\b(?:scan|review|draft|evaluate|release)SynthesisCandidate\s*\(/,
    );
    expect(effectSynthesisSource).toContain("CandidateStore");
    expect(effectSynthesisSource).toContain("Catalog");
    expect(effectSynthesisSource).not.toMatch(/\bcreateControlPlaneRuntime\s*\(/);
    expect(effectSynthesisSource).not.toMatch(/\bloadLibraryCatalog\s*\(/);
    expect(effectSynthesisSource).not.toMatch(
      /\b(?:draftSynthesisCandidate|releaseSynthesisCandidate)\b/,
    );
    expect(effectSynthesisSource).not.toContain("skipControlPlaneMutation");
    expect(readRuntimeSource("synthesis.ts")).not.toContain("skipControlPlaneMutation");
    for (const source of [programSource, synthesisSource, effectSynthesisSource]) {
      expect(source).not.toMatch(
        /ManagedRuntime|Effect\.(?:runPromise|runSync|runFork)\b|\bcatchCause\b/,
      );
    }
  });
});
