import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createHarnessRegistry,
  HarnessRegistryError,
  type HarnessPackageContribution,
} from "@selftune/harness-core/descriptor";
import {
  createHarnessSourceRegistry,
  HarnessSourceRegistryError,
  type HarnessSourceAdapter,
} from "@selftune/harness-core/source-adapter";
import { harnessRegistry } from "@selftune/harness-registry";
import { harnessSourceRegistry } from "@selftune/harness-registry/source";

function fixtureContribution(id: string): HarnessPackageContribution {
  return {
    presentation: {
      id,
      name: "Fixture Agent",
      description: "A fixture harness.",
      icon: {
        src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
        fit: "contain",
        inset: "sm",
      },
      documentation_url: "https://example.com/fixture",
    },
    runtime: {
      id,
      detectConnection: () => ({
        detected: true,
        connected: true,
        import_available: true,
        hooks_supported: false,
        hooks_installed: false,
        config_path: "/secret/fixture/config.json",
        connected_detail: "Session import available",
      }),
      sourceMerge: {
        invocation: (model) => ({ agent: "fixture-agent", model: model ?? undefined }),
      },
    },
  };
}

function fixtureSourceAdapter(id: string): HarnessSourceAdapter {
  return {
    id,
    phase: "fixture",
    sync: () => ({
      available: true,
      scanned: 2,
      synced: 1,
      skipped: 1,
      authoritativeFiles: ["/fixture/session.jsonl"],
    }),
  };
}

describe("harness registry", () => {
  test("keeps source ingestion behind the explicit source entrypoint", () => {
    const registrySourceDir = join(import.meta.dir, "../../packages/harnesses/registry/src");
    const mainEntrypoint = readFileSync(join(registrySourceDir, "index.ts"), "utf8");
    const sourceEntrypoint = readFileSync(join(registrySourceDir, "source.ts"), "utf8");
    const orchestrationRoot = join(import.meta.dir, "../../packages/orchestration/src");
    const genericSync = readFileSync(join(orchestrationRoot, "sync.ts"), "utf8");
    const liveSourceSync = readFileSync(join(orchestrationRoot, "sync/live-source.ts"), "utf8");

    expect(mainEntrypoint).not.toContain("source-sync");
    expect(mainEntrypoint).not.toContain("harnessSourceRegistry");
    expect(sourceEntrypoint).toContain("source-sync");
    expect(sourceEntrypoint).toContain("harnessSourceRegistry");
    expect(genericSync).not.toContain("@selftune/harness-registry/source");
    expect(liveSourceSync).toContain("@selftune/harness-registry/source");

    for (const harness of ["claude-code", "codex", "opencode", "openclaw", "pi"]) {
      const descriptor = readFileSync(
        join(import.meta.dir, `../../packages/harnesses/${harness}/src/descriptor.ts`),
        "utf8",
      );
      expect(descriptor).not.toContain("source-sync");
    }
  });

  test("rejects duplicate package identities", () => {
    expect(() =>
      createHarnessRegistry([fixtureContribution("fixture"), fixtureContribution("fixture")]),
    ).toThrow(HarnessRegistryError);
  });

  test("rejects renderer metadata that could expose a local path", () => {
    const contribution = fixtureContribution("fixture");
    contribution.presentation.icon.src = "/Users/example/.secrets/fixture.svg";

    expect(() => createHarnessRegistry([contribution])).toThrow(HarnessRegistryError);
  });

  test("serializes only allowlisted client-safe presentation and capability metadata", () => {
    const contribution = fixtureContribution("fixture");
    Object.assign(contribution.runtime, {
      apiKey: "secret-token",
      environment: { HOME: "/secret/home" },
    });

    const registry = createHarnessRegistry([contribution]);
    const payload = registry.clientDescriptors();
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual([
      {
        id: "fixture",
        name: "Fixture Agent",
        description: "A fixture harness.",
        icon: {
          src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
          fit: "contain",
          inset: "sm",
        },
        documentation_url: "https://example.com/fixture",
        source_merge: { model_override: true },
      },
    ]);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("/secret/");
    expect(serialized).not.toContain("detectConnection");
    expect(serialized).not.toContain("invocation");
  });

  test("creates an injectable source-only registry without presentation descriptors", () => {
    const adapter = fixtureSourceAdapter("fixture");
    const registry = createHarnessSourceRegistry([adapter]);

    expect(registry.adapters).toEqual([adapter]);
    expect(registry.get("fixture")).toBe(adapter);
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("rejects a source adapter without a named phase", () => {
    const adapter = fixtureSourceAdapter("fixture");
    const invalidAdapter = { ...adapter, phase: " " };

    expect(() => createHarnessSourceRegistry([invalidAdapter])).toThrow(HarnessSourceRegistryError);
  });

  test("rejects duplicate source-adapter identities", () => {
    expect(() =>
      createHarnessSourceRegistry([
        fixtureSourceAdapter("fixture"),
        fixtureSourceAdapter("fixture"),
      ]),
    ).toThrow(HarnessSourceRegistryError);
  });

  test("keeps the main registry lightweight and aggregates source adapters separately", () => {
    expect(harnessRegistry.contributions.map(({ runtime }) => runtime.id)).toEqual([
      "claude_code",
      "codex",
      "cline",
      "opencode",
      "openclaw",
      "pi",
    ]);
    expect(harnessSourceRegistry.adapters.map(({ id }) => id)).toEqual([
      "claude_code",
      "codex",
      "opencode",
      "openclaw",
      "pi",
    ]);
  });
});
