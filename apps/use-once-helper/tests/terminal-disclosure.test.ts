import { describe, expect, test } from "bun:test";

import type { InteractiveTerminalPort, UseOncePreview } from "../src";
import { makeTerminalDisclosure } from "../src";

function preview(): UseOncePreview {
  return {
    status: "preview",
    issueId: "10000000-0000-4000-8000-000000000001",
    invitationId: "10000000-0000-4000-8000-000000000002",
    shareId: "10000000-0000-4000-8000-000000000003",
    distributionId: "10000000-0000-4000-8000-000000000004",
    sealedObjectId: "10000000-0000-4000-8000-000000000005",
    packagedSha256: "1".repeat(64),
    supportedAgent: "codex",
    issuedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T01:00:00.000Z",
    package: {
      displayName: "Skill\u001b[2J\u202Ename",
      version: "1.0.0",
      format: "selftune-portable-package-v2",
    },
    publisher: { name: "Publisher" },
    rightsHolder: { kind: "organization", name: "Rights holder" },
    license: {
      expression: "MIT",
      kind: "spdx",
      licenseEvidenceSha256: "2".repeat(64),
      bundledTerms: { path: "LICENSE", sha256: "7".repeat(64) },
    },
    provenance: {
      kind: "github_verified",
      sourceRepository: "https://github.com/example/skill",
      sourceRef: "main",
      sourceTreeHash: "3".repeat(64),
    },
    terms: {
      disclosureSha256: "4".repeat(64),
      summary: "Terms summary",
      issueAcceptance: "accepted_at_issue",
    },
    contributorSignals: {
      _tag: "signals_unavailable",
      signalDisclosureSha256: "5".repeat(64),
      signalRecipientOrganizationId: null,
      allowedFields: [],
      capability: "not_capable",
      defaultState: "off",
      contributorConsent: "not_applicable",
      enabled: false,
    },
    lifecycleReporting: {
      _tag: "used_once_status",
      lifecycleDisclosureSha256: "6".repeat(64),
      consent: "not_granted",
      senderVisibleUsedOnceStatus: "disabled",
    },
    helperContributorSignals: {
      _tag: "portable_unverified",
      signalDisclosureSha256: "5".repeat(64),
      allowedFields: ["trigger"],
      defaultState: "off",
      trustedTelemetry: "not_authorized",
    },
    persistence: "ephemeral_use_once",
    persistentInstall: "not_authorized",
    trustedTelemetry: "not_authorized",
    contentRetrieval: "repeatable_exact_object_before_consume",
    previewMutation: "none",
    usedOnceReporting: "not_emitted",
    consumeRequired: true,
    authorityLimits: {
      localPath: "not_provided",
      command: "not_provided",
      url: "not_provided",
      bytes: "not_provided",
      credential: "not_provided",
      installAuthority: "not_authorized",
    },
  };
}

describe("interactive disclosure", () => {
  test("shows every authority disclosure safely and requires the exact phrase", async () => {
    const lines: string[] = [];
    const terminal: InteractiveTerminalPort = {
      interactive: true,
      write: (line) => lines.push(line),
      readLine: async () => "USE ONCE",
    };
    const disclosure = makeTerminalDisclosure(terminal);
    const input = preview();
    const verified = {
      preview: input,
      bundledTerms: {
        path: "LICENSE",
        sha256: "7".repeat(64),
        content: "Full\u202E license\u2028text",
      },
    };
    await disclosure.show(verified);
    expect(lines).toEqual([
      "Skill: Skill name 1.0.0",
      "Package format: selftune-portable-package-v2",
      `Package SHA-256: ${"1".repeat(64)}`,
      "Publisher: Publisher",
      "Rights holder: Rights holder (organization)",
      "License: MIT (spdx)",
      `License evidence SHA-256: ${"2".repeat(64)}`,
      `Bundled terms: LICENSE (${"7".repeat(64)})`,
      "--- verified bundled terms ---",
      "Full  license text",
      "--- end verified bundled terms ---",
      "Terms: Terms summary",
      `Terms identity: ${"4".repeat(64)}; accepted_at_issue`,
      "Provenance kind: github_verified",
      "Provenance repository: https://github.com/example/skill",
      "Provenance ref: main",
      `Provenance tree hash: ${"3".repeat(64)}`,
      `Share contributor disclosure: ${"5".repeat(64)}; signals_unavailable`,
      "Share contributor recipient: not provided; fields: none",
      "Share contributor policy: not_capable; default off; consent not_applicable; enabled false",
      `Helper contributor disclosure: ${"5".repeat(64)}; portable_unverified; fields: trigger`,
      "Helper contributor policy: default off; trusted telemetry not_authorized",
      `Used-once lifecycle disclosure: ${"6".repeat(64)}; consent not_granted; sender status disabled`,
      "Persistence: temporary files only; no skill install or local receipt",
    ]);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(lines.join("\n")).not.toContain("u".repeat(43));
    expect(await disclosure.confirm(verified)).toEqual({
      termsDisclosureSha256: input.terms.disclosureSha256,
      termsAcceptance: "accepted",
      executionConsent: "granted",
    });
  });

  test("fails confirmation closed for non-interactive input", async () => {
    const disclosure = makeTerminalDisclosure({
      interactive: false,
      write: () => undefined,
      readLine: async () => "USE ONCE",
    });
    expect(await disclosure.confirm({ preview: preview(), bundledTerms: null })).toBeNull();
  });

  test("strips adversarial OSC input with repeated introducers in one bounded output", async () => {
    const lines: string[] = [];
    const disclosure = makeTerminalDisclosure({
      interactive: false,
      write: (line) => lines.push(line),
      readLine: async () => "",
    });
    const basePreview = preview();
    const input: UseOncePreview = {
      ...basePreview,
      package: {
        ...basePreview.package,
        displayName: `visible\u001b]${"\u001b]payload".repeat(20_000)}\u0007safe`,
      },
    };

    await disclosure.show({ preview: input, bundledTerms: null });

    expect(lines[0]).toBe("Skill: visiblesafe 1.0.0");
    expect(lines[0]).not.toContain("\u001b");
  });

  test("preserves greedy OSC termination while scanning nested terminators linearly", async () => {
    const lines: string[] = [];
    const disclosure = makeTerminalDisclosure({
      interactive: false,
      write: (line) => lines.push(line),
      readLine: async () => "",
    });
    const basePreview = preview();
    const input: UseOncePreview = {
      ...basePreview,
      package: {
        ...basePreview.package,
        displayName: "A\u001b]outer\u001b\\hidden\u0007Z|B\u001b]outer\u001b\\hidden\u001b\\Y",
      },
    };

    await disclosure.show({ preview: input, bundledTerms: null });

    expect(lines[0]).toBe("Skill: AZ|BY 1.0.0");
    expect(lines[0]).not.toContain("hidden");
  });

  test("continues stripping complete CSI after an unterminated OSC introducer", async () => {
    const lines: string[] = [];
    const disclosure = makeTerminalDisclosure({
      interactive: false,
      write: (line) => lines.push(line),
      readLine: async () => "",
    });
    const basePreview = preview();
    const input: UseOncePreview = {
      ...basePreview,
      package: {
        ...basePreview.package,
        displayName: "A\u001b]unfinished\u001b[31mRED",
      },
    };

    await disclosure.show({ preview: input, bundledTerms: null });

    expect(lines[0]).toBe("Skill: A ]unfinishedRED 1.0.0");
  });
});
