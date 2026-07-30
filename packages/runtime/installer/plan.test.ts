/* oxlint-disable max-lines */
import { describe, expect, test } from "bun:test";
import { Effect, Semaphore } from "effect";

import {
  confirmAndCommitLocalInstall,
  installerRegistryRoot,
  installerSkillDestination,
  makeInstallAuthorizationAuthority,
  planLocalInstall as planLocalInstallEffect,
  suggestInstallerAgents,
  type DestinationObservation,
  type InstallSubject,
  type InstallableSkill,
  type InstallerPathObservations,
  type InstallerPlanningAuthorities,
  InstallerPlanningError,
  type LocalInstallRequest,
  type ObservedFile,
  type RootObservation,
  type StoredInstallReceipt,
} from "./index.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);

function skill(overrides: Partial<InstallableSkill> = {}): InstallableSkill {
  return {
    name: "research-assistant",
    logicalSkillId: "skill_01",
    logicalVersion: "1.2.0",
    distributionId: "dist_01",
    shareId: "share_01",
    handoffId: "handoff_01",
    sealedPackageSha256: H1,
    signature: { algorithm: "ed25519", keyId: "owner-key-1", value: "signature-value" },
    license: {
      spdxExpression: "MIT",
      licenseFile: { path: "LICENSE", sha256: H2 },
      notices: [{ path: "NOTICE", sha256: H3 }],
    },
    consent: {
      consentId: "consent_01",
      recipientPrincipalId: "recipient_01",
      recordedAt: "2026-07-21T12:00:00.000Z",
      action: "install_with_selftune",
      disclosureSha256: H4,
      termsAccepted: true,
      contributorSignals: "not_granted",
      contributorSignalRecipientOwnerId: null,
      contributorSignalAllowedFields: [],
      lifecycleReporting: "not_granted",
      lifecycleAllowedFields: [],
    },
    source: { kind: "remote_sealed", objectId: "object_01" },
    files: [
      { path: "SKILL.md", sha256: H1, byteLength: 120, kind: "file" },
      { path: "LICENSE", sha256: H2, byteLength: 42, kind: "file" },
      { path: "NOTICE", sha256: H3, byteLength: 36, kind: "file" },
    ],
    ...overrides,
  };
}

type TestObservedFile = Omit<ObservedFile, "durableSnapshotRef"> & {
  readonly durableSnapshotRef?: string;
};
type TestDestination = Omit<DestinationObservation, "files"> & {
  readonly files: ReadonlyArray<TestObservedFile>;
  readonly ownership:
    | { readonly kind: "unmanaged" }
    | {
        readonly kind: "receipt_owned";
        readonly receiptId: string;
        readonly sealedPackageSha256: string;
        readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
      };
};
interface TestObservations {
  readonly platform: "darwin" | "linux" | "win32";
  readonly homeDirectory: string;
  readonly projectRoot?: RootObservation;
  readonly globalRoot?: RootObservation;
  readonly destinations: ReadonlyArray<TestDestination>;
  readonly localSources?: InstallerPathObservations["localSources"];
  readonly receipts?: ReadonlyArray<StoredInstallReceipt>;
}
type TestRequest = Omit<LocalInstallRequest, "installBootstrapToken"> & {
  readonly subject: InstallSubject;
  readonly installBootstrapToken?: string;
};

function destination(
  targetPath: string,
  overrides: Partial<TestDestination> = {},
): TestDestination {
  const separator = targetPath.includes("\\") ? "\\" : "/";
  const parentPath = targetPath.slice(0, targetPath.lastIndexOf(separator));
  return {
    targetPath,
    kind: "missing",
    writable: true,
    ownership: { kind: "unmanaged" },
    files: [],
    ancestors: [],
    nearestExistingParent: {
      requestedPath: parentPath,
      canonicalPath: parentPath,
      exists: true,
      writable: true,
      kind: "directory",
      ancestors: [],
    },
    ...overrides,
  };
}

function observations(
  destinations?: ReadonlyArray<TestDestination>,
  localSources?: InstallerPathObservations["localSources"],
): TestObservations {
  const target = "/work/project/.agents/skills/research-assistant";
  return {
    platform: "linux",
    homeDirectory: "/home/daniel",
    projectRoot: {
      requestedPath: "/work/project",
      canonicalPath: "/work/project",
      exists: true,
      writable: true,
      kind: "directory",
      ancestors: [
        { path: "/work", kind: "directory" },
        { path: "/work/project", kind: "directory" },
      ],
    },
    globalRoot: {
      requestedPath: "/home/daniel",
      canonicalPath: "/home/daniel",
      exists: true,
      writable: true,
      kind: "directory",
      ancestors: [{ path: "/home/daniel", kind: "directory" }],
    },
    destinations: destinations ?? [destination(target)],
    localSources,
  };
}

function request(overrides: Partial<TestRequest> = {}): TestRequest {
  return {
    subject: { kind: "standalone", skill: skill() },
    scope: "project",
    projectRoot: "/work/project",
    targetAgents: ["codex"],
    unmanagedPolicy: "cancel",
    ...overrides,
  };
}

function fixtureAuthorities(
  installRequest: TestRequest,
  installObservations: TestObservations,
): InstallerPlanningAuthorities {
  const subjectSkills =
    installRequest.subject.kind === "standalone"
      ? [installRequest.subject.skill]
      : installRequest.subject.skills;
  const convertedDestinations: DestinationObservation[] = installObservations.destinations.map(
    ({ ownership: _ownership, files, ...observed }) => ({
      ...observed,
      files: files.map(({ durableSnapshotRef: _durableSnapshotRef, ...file }) => file),
    }),
  );
  const derivedReceipts = installObservations.destinations.flatMap((observed) => {
    if (observed.ownership.kind !== "receipt_owned") return [];
    const targetSkill =
      subjectSkills.find((candidate) => observed.targetPath.includes(candidate.name)) ??
      subjectSkills[0]!;
    const registryRoot = observed.targetPath.slice(
      0,
      observed.targetPath.lastIndexOf(observed.targetPath.includes("\\") ? "\\" : "/"),
    );
    return [
      {
        receiptId: observed.ownership.receiptId,
        state: "active" as const,
        agent: installRequest.targetAgents[0]!,
        scope: installRequest.scope,
        projectRoot:
          installRequest.scope === "project"
            ? (installObservations.projectRoot?.canonicalPath ?? null)
            : null,
        registryRoot,
        targetPath: observed.targetPath,
        skillName: targetSkill.name,
        logicalSkillId: targetSkill.logicalSkillId,
        sealedPackageSha256: observed.ownership.sealedPackageSha256,
        files: observed.ownership.files.map((file) => ({
          ...file,
          durableSnapshotRef: `receipt-snapshot:${file.path}:${file.sha256}`,
        })),
      },
    ];
  });
  return {
    authorization: makeInstallAuthorizationAuthority(() =>
      Effect.succeed({ subject: installRequest.subject }),
    ),
    os: {
      observeEnvironment: ({ scope }) => {
        const selectedRoot =
          scope === "project" ? installObservations.projectRoot : installObservations.globalRoot;
        return selectedRoot
          ? Effect.succeed({
              platform: installObservations.platform,
              homeDirectory: installObservations.homeDirectory,
              configDirectory: null,
              selectedRoot,
              authorizedGlobalRoots:
                scope === "global"
                  ? [
                      {
                        canonicalPath: selectedRoot.canonicalPath,
                        source: "home" as const,
                        agents: "all" as const,
                      },
                    ]
                  : [],
            })
          : Effect.fail(
              InstallerPlanningError.make({
                code: "ROOT_OBSERVATION_MISSING",
                message: "Missing test root.",
                path: null,
              }),
            );
      },
      observePaths: () =>
        Effect.succeed({
          destinations: convertedDestinations,
          localSources: installObservations.localSources ?? [],
        }),
    },
    receipts: {
      readReceipts: () => Effect.succeed(installObservations.receipts ?? derivedReceipts),
    },
    commitLock: {
      withExclusiveCommit: (commit) =>
        commit({
          fenceId: "test-fence",
          assertValid: Effect.succeed(undefined),
        }),
    },
  };
}

function planLocalInstall(installRequest: TestRequest, installObservations: TestObservations) {
  const choices = {
    installBootstrapToken: installRequest.installBootstrapToken ?? "bootstrap_test",
    scope: installRequest.scope,
    projectRoot: installRequest.projectRoot,
    targetAgents: installRequest.targetAgents,
    strategy: installRequest.strategy,
    unmanagedPolicy: installRequest.unmanagedPolicy,
  };
  const publicRequest =
    "customPath" in installRequest
      ? { ...choices, customPath: installRequest.customPath }
      : "targetRoot" in installRequest
        ? { ...choices, targetRoot: installRequest.targetRoot }
        : choices;
  return planLocalInstallEffect(
    publicRequest,
    fixtureAuthorities(installRequest, installObservations),
  );
}

async function failure(
  installRequest: TestRequest,
  installObservations: TestObservations,
): Promise<InstallerPlanningError> {
  return Effect.runPromise(Effect.flip(planLocalInstall(installRequest, installObservations)));
}

describe("installer path table", () => {
  test.each([
    ["linux", "/repo", "codex", "/repo/.agents/skills"],
    ["darwin", "/Users/dan/repo", "claude_code", "/Users/dan/repo/.claude/skills"],
    ["linux", "/repo", "opencode", "/repo/.opencode/skills"],
    ["darwin", "/repo", "openclaw", "/repo/.openclaw/skills"],
    ["linux", "/repo", "pi", "/repo/.pi/agent/skills"],
    ["win32", "C:\\work\\repo", "codex", "C:\\work\\repo\\.agents\\skills"],
    ["win32", "C:\\Users\\dan", "pi", "C:\\Users\\dan\\.pi\\agent\\skills"],
  ] as const)("derives %s %s registry roots", (platform, root, agent, expected) => {
    expect(installerRegistryRoot(platform, root, agent)).toBe(expected);
  });

  test("derives only the validated skill name below the registry", () => {
    expect(installerSkillDestination("linux", "/repo/.agents/skills", "writer")).toBe(
      "/repo/.agents/skills/writer",
    );
  });

  test("detection suggests without selecting", () => {
    expect(
      suggestInstallerAgents([
        { agent: "pi", evidence: [".pi"] },
        { agent: "codex", evidence: [".codex/config.toml"] },
        { agent: "opencode", evidence: [] },
      ]),
    ).toEqual([
      { agent: "codex", evidence: [".codex/config.toml"], selected: false },
      { agent: "pi", evidence: [".pi"], selected: false },
    ]);
  });
});

describe("local install planning", () => {
  test.each([
    ["darwin", "/Users/dan", "openclaw", "/Users/dan/.openclaw/skills/research-assistant"],
    ["win32", "C:\\Users\\dan", "pi", "C:\\Users\\dan\\.pi\\agent\\skills\\research-assistant"],
  ] as const)("plans an injected %s global root", async (platform, home, agent, targetPath) => {
    const rootObservation = {
      requestedPath: home,
      canonicalPath: home,
      exists: true,
      writable: true,
      kind: "directory" as const,
      ancestors: [{ path: home, kind: "directory" as const }],
    };
    const plan = await Effect.runPromise(
      planLocalInstall(
        request({ scope: "global", projectRoot: undefined, targetAgents: [agent] }),
        {
          platform,
          homeDirectory: home,
          globalRoot: rootObservation,
          destinations: [destination(targetPath)],
        },
      ),
    );
    expect(plan.receipts[0]?.targetPath).toBe(targetPath);
    expect(plan.receipts[0]?.projectRoot).toBeNull();
  });

  test("plans a remote sealed standalone skill as a copy with full receipt and journal intents", async () => {
    const plan = await Effect.runPromise(planLocalInstall(request(), observations()));

    expect(plan.ready).toBe(true);
    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "create_file",
      "create_file",
      "create_file",
    ]);
    expect(plan.receipts).toHaveLength(1);
    expect(plan.receipts[0]).toMatchObject({
      agent: "codex",
      strategy: "copy",
      targetPath: "/work/project/.agents/skills/research-assistant",
      skill: {
        distributionId: "dist_01",
        shareId: "share_01",
        handoffId: "handoff_01",
        logicalVersion: "1.2.0",
        sealedPackageSha256: H1,
        license: { spdxExpression: "MIT" },
        consent: { action: "install_with_selftune", termsAccepted: true },
      },
    });
    expect(plan.journal?.state).toBe("planned");
    expect(plan.journal?.steps).toHaveLength(3);
    expect(plan.previewToken).toBe(`preview_v1_${plan.previewFingerprint}`);
  });

  test("is deterministic for the same request and observations", async () => {
    const first = await Effect.runPromise(planLocalInstall(request(), observations()));
    const second = await Effect.runPromise(planLocalInstall(request(), observations()));
    expect(second).toEqual(first);
  });

  test("binds the exact owner telemetry recipient and allowed fields without enabling lifecycle reporting", async () => {
    const shared = skill({
      consent: {
        ...skill().consent,
        contributorSignals: "granted",
        contributorSignalRecipientOwnerId: "owner_01",
        contributorSignalAllowedFields: ["outcome", "skill_version"],
      },
    });
    const plan = await Effect.runPromise(
      planLocalInstall(request({ subject: { kind: "standalone", skill: shared } }), observations()),
    );
    expect(plan.receipts[0]?.skill.consent).toMatchObject({
      contributorSignals: "granted",
      contributorSignalRecipientOwnerId: "owner_01",
      contributorSignalAllowedFields: ["outcome", "skill_version"],
      lifecycleReporting: "not_granted",
      lifecycleAllowedFields: [],
    });
  });

  test("requires explicit agent selection", async () => {
    expect((await failure(request({ targetAgents: [] }), observations())).code).toBe(
      "EXPLICIT_AGENT_REQUIRED",
    );
  });

  test("rejects arbitrary target path fields at runtime", async () => {
    const withCustomPath = { ...request(), customPath: "/elsewhere" };
    expect((await failure(withCustomPath, observations())).code).toBe("CUSTOM_PATH_FORBIDDEN");
  });

  test("forbids symlinks for remote and temporary sources", async () => {
    expect((await failure(request({ strategy: "symlink" }), observations())).code).toBe(
      "SYMLINK_SOURCE_FORBIDDEN",
    );
    const temporary = skill({
      source: { kind: "temporary", absolutePath: "/tmp/unpacked" },
      consent: { ...skill().consent, action: "local_authoring" },
    });
    expect(
      (
        await failure(
          request({ subject: { kind: "standalone", skill: temporary }, strategy: "symlink" }),
          observations(),
        )
      ).code,
    ).toBe("TEMPORARY_SOURCE_FORBIDDEN");
  });

  test("allows an explicitly selected symlink only for immutable local authoring", async () => {
    const local = skill({
      source: {
        kind: "local_authoring_immutable",
        absolutePath: "/work/sources/research-assistant",
        sourceSha256: H2,
      },
      consent: { ...skill().consent, action: "local_authoring" },
    });
    const plan = await Effect.runPromise(
      planLocalInstall(
        request({ subject: { kind: "standalone", skill: local }, strategy: "symlink" }),
        observations(undefined, [
          {
            requestedPath: "/work/sources/research-assistant",
            canonicalPath: "/work/sources/research-assistant",
            exists: true,
            kind: "directory",
            temporary: false,
            immutableSnapshot: true,
            contentSha256: H2,
            ancestors: [{ path: "/work/sources/research-assistant", kind: "directory" }],
          },
        ]),
      ),
    );
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "create_symlink",
        sourcePath: "/work/sources/research-assistant",
      }),
    ]);
  });

  test("rejects a local-authoring claim that points into a temporary directory", async () => {
    const local = skill({
      source: {
        kind: "local_authoring_immutable",
        absolutePath: "/tmp/unpacked/research-assistant",
        sourceSha256: H2,
      },
      consent: { ...skill().consent, action: "local_authoring" },
    });
    expect(
      (
        await failure(
          request({ subject: { kind: "standalone", skill: local }, strategy: "symlink" }),
          observations(),
        )
      ).code,
    ).toBe("LOCAL_SOURCE_UNSAFE");
  });

  test("blocks unmanaged destinations under cancel", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const plan = await Effect.runPromise(
      planLocalInstall(
        request(),
        observations([
          destination(target, {
            kind: "directory",
            files: [{ path: "SKILL.md", sha256: H4, kind: "file" }],
          }),
        ]),
      ),
    );
    expect(plan).toMatchObject({ ready: false, operations: [], receipts: [], journal: null });
    expect(plan.conflicts[0]?.code).toBe("UNMANAGED_DESTINATION");
  });

  test("uses a deterministic observed side-by-side destination without merging", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const side = `/work/project/.agents/skills/research-assistant--${H1.slice(0, 12)}`;
    const plan = await Effect.runPromise(
      planLocalInstall(
        request({ unmanagedPolicy: "side_by_side" }),
        observations([destination(target, { kind: "directory" }), destination(side)]),
      ),
    );
    expect(plan.ready).toBe(true);
    expect(plan.receipts[0]?.targetPath).toBe(side);
    expect(plan.operations.every((operation) => operation.targetPath === side)).toBe(true);
  });

  test("plans backups before replacing an unmanaged destination", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const backup = `${target}.selftune-backup-${H1.slice(0, 12)}`;
    const plan = await Effect.runPromise(
      planLocalInstall(
        request({ unmanagedPolicy: "replace_with_backup" }),
        observations([
          destination(target, {
            kind: "directory",
            files: [
              { path: "SKILL.md", sha256: H4, kind: "file" },
              { path: "old.txt", sha256: H4, kind: "file" },
            ],
          }),
          destination(backup),
        ]),
      ),
    );
    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "backup_destination",
      "create_file",
      "create_file",
      "replace_file",
      "delete_file",
    ]);
    expect(plan.receipts[0]?.backupPath).toContain(".selftune-backup-");
  });

  test("blocks receipt-owned drift", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const plan = await Effect.runPromise(
      planLocalInstall(
        request(),
        observations([
          destination(target, {
            kind: "directory",
            ownership: {
              kind: "receipt_owned",
              receiptId: "receipt_old",
              sealedPackageSha256: H4,
              files: [{ path: "SKILL.md", sha256: H1 }],
            },
            files: [{ path: "SKILL.md", sha256: H2, kind: "file" }],
          }),
        ]),
      ),
    );
    expect(plan.ready).toBe(false);
    expect(plan.conflicts[0]?.code).toBe("MANAGED_DRIFT");
  });

  test("expands a Skill Set over explicitly selected agents and rejects component collisions", async () => {
    const second = skill({ name: "writer", logicalSkillId: "skill_02", sealedPackageSha256: H2 });
    const targets = [
      "/work/project/.agents/skills/research-assistant",
      "/work/project/.agents/skills/writer",
      "/work/project/.claude/skills/research-assistant",
      "/work/project/.claude/skills/writer",
    ].map((target) => destination(target));
    const setRequest = request({
      subject: {
        kind: "skill_set",
        skillSetId: "set_01",
        logicalVersion: "3.0.0",
        sealedPackageSha256: H3,
        skills: [skill(), second],
      },
      targetAgents: ["claude_code", "codex"],
    });
    const plan = await Effect.runPromise(planLocalInstall(setRequest, observations(targets)));
    expect(plan.receipts).toHaveLength(4);
    expect(plan.receipts[0]?.skillSet).toEqual({
      skillSetId: "set_01",
      logicalVersion: "3.0.0",
      sealedPackageSha256: H3,
    });
    expect(plan.receipts.map((receipt) => `${receipt.agent}:${receipt.skill.name}`)).toEqual([
      "codex:research-assistant",
      "codex:writer",
      "claude_code:research-assistant",
      "claude_code:writer",
    ]);

    const collision = skill({ name: "RESEARCH-ASSISTANT", logicalSkillId: "skill_03" });
    expect(
      (
        await failure(
          request({
            subject: {
              kind: "skill_set",
              skillSetId: "set_02",
              logicalVersion: "1",
              sealedPackageSha256: H3,
              skills: [skill(), collision],
            },
          }),
          observations(),
        )
      ).code,
    ).toBe("SKILL_SET_COMPONENT_COLLISION");
  });

  test("changes the preview fingerprint when observed state changes", async () => {
    const first = await Effect.runPromise(planLocalInstall(request(), observations()));
    const target = "/work/project/.agents/skills/research-assistant";
    const backup = `${target}.selftune-backup-${H1.slice(0, 12)}`;
    const second = await Effect.runPromise(
      planLocalInstall(
        request({ unmanagedPolicy: "replace_with_backup" }),
        observations([
          destination(target, {
            kind: "directory",
            files: [{ path: "SKILL.md", sha256: H4, kind: "file" }],
          }),
          destination(backup),
        ]),
      ),
    );
    expect(second.previewFingerprint).not.toBe(first.previewFingerprint);
    expect(second.previewToken).not.toBe(first.previewToken);
  });
});

describe("installer adversarial validation", () => {
  test("requires license and notice evidence to match the sealed file manifest", async () => {
    const badLicense = skill({
      license: {
        spdxExpression: "MIT",
        licenseFile: { path: "LICENSE", sha256: H4 },
        notices: [{ path: "NOTICE", sha256: H3 }],
      },
    });
    expect(
      (
        await failure(
          request({ subject: { kind: "standalone", skill: badLicense } }),
          observations(),
        )
      ).code,
    ).toBe("LICENSE_EVIDENCE_MISMATCH");
  });

  test.each([
    [
      "duplicate agents",
      request({ targetAgents: ["codex", "codex"] }),
      observations(),
      "DUPLICATE_AGENT_DESTINATION",
    ],
    [
      "filesystem root",
      request({ projectRoot: "/" }),
      {
        ...observations(),
        projectRoot: {
          requestedPath: "/",
          canonicalPath: "/",
          exists: true,
          writable: true,
          kind: "directory" as const,
          ancestors: [],
        },
      },
      "ROOT_TOO_BROAD",
    ],
    [
      "home project root",
      request({ projectRoot: "/home/daniel" }),
      { ...observations(), projectRoot: observations().globalRoot },
      "ROOT_TOO_BROAD",
    ],
    [
      "nonexistent root",
      request(),
      { ...observations(), projectRoot: { ...observations().projectRoot!, exists: false } },
      "ROOT_UNAVAILABLE",
    ],
    [
      "unwritable root",
      request(),
      { ...observations(), projectRoot: { ...observations().projectRoot!, writable: false } },
      "ROOT_UNAVAILABLE",
    ],
    [
      "ancestor escape",
      request(),
      {
        ...observations(),
        projectRoot: {
          ...observations().projectRoot!,
          ancestors: [{ path: "/work/link", kind: "symlink" as const, resolvedPath: "/outside" }],
        },
      },
      "ANCESTOR_ESCAPE",
    ],
  ] as const)("rejects %s", async (_label, installRequest, installObservations, code) => {
    expect((await failure(installRequest, installObservations)).code).toBe(code);
  });

  test.each([
    ["../escape", "UNSAFE_PACKAGE_PATH"],
    ["docs\\escape.md", "UNSAFE_PACKAGE_PATH"],
    ["stream:secret", "UNSAFE_PACKAGE_PATH"],
    ["CON/readme.md", "UNSAFE_PACKAGE_PATH"],
    ["Cafe\u0301.md", "NON_CANONICAL_UNICODE"],
  ] as const)("rejects unsafe package path %s", async (path, code) => {
    const unsafe = skill({ files: [{ path, sha256: H1, byteLength: 1, kind: "file" }] });
    expect(
      (await failure(request({ subject: { kind: "standalone", skill: unsafe } }), observations()))
        .code,
    ).toBe(code);
  });

  test("rejects special files and portable case collisions", async () => {
    const special = skill({
      files: [{ path: "pipe", sha256: H1, byteLength: 0, kind: "special" }],
    });
    expect(
      (await failure(request({ subject: { kind: "standalone", skill: special } }), observations()))
        .code,
    ).toBe("SPECIAL_FILE_FORBIDDEN");

    const colliding = skill({
      files: [
        { path: "Docs/readme.md", sha256: H1, byteLength: 1, kind: "file" },
        { path: "docs/README.md", sha256: H2, byteLength: 1, kind: "file" },
      ],
      license: { spdxExpression: "MIT", licenseFile: null, notices: [] },
    });
    expect(
      (
        await failure(
          request({ subject: { kind: "standalone", skill: colliding } }),
          observations(),
        )
      ).code,
    ).toBe("PACKAGE_PATH_COLLISION");
  });

  test("rejects special entries observed in an existing destination", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    expect(
      (
        await failure(
          request({ unmanagedPolicy: "replace_with_backup" }),
          observations([
            destination(target, {
              kind: "directory",
              files: [{ path: "pipe", sha256: H1, kind: "special" }],
            }),
            destination(`${target}.selftune-backup-${H1.slice(0, 12)}`),
          ]),
        )
      ).code,
    ).toBe("SPECIAL_FILE_FORBIDDEN");
  });

  test("rejects a target registry ancestor that escapes through a symlink", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    expect(
      (
        await failure(
          request(),
          observations([
            destination(target, {
              ancestors: [
                {
                  path: "/work/project/.agents",
                  kind: "symlink",
                  resolvedPath: "/outside/agents",
                },
              ],
            }),
          ]),
        )
      ).code,
    ).toBe("ANCESTOR_ESCAPE");
  });
});

describe("installer authority and confirmation boundaries", () => {
  const publicRequest: LocalInstallRequest = {
    installBootstrapToken: "bootstrap_valid",
    scope: "project",
    projectRoot: "/work/project",
    targetAgents: ["codex"],
    unmanagedPolicy: "cancel",
  };

  test("cannot bypass bootstrap verification by attaching raw skill authority", async () => {
    const fixture = request();
    const authorities = fixtureAuthorities(fixture, observations());
    const rejectingAuthorities: InstallerPlanningAuthorities = {
      ...authorities,
      authorization: makeInstallAuthorizationAuthority((token) =>
        token === "bootstrap_valid"
          ? Effect.succeed({ subject: fixture.subject })
          : Effect.fail(
              InstallerPlanningError.make({
                code: "INSTALL_AUTHORIZATION_REJECTED",
                message: "Opaque bootstrap authorization rejected.",
                path: null,
              }),
            ),
      ),
    };
    const forgedRequest = {
      ...publicRequest,
      installBootstrapToken: "forged",
      subject: { kind: "standalone" as const, skill: skill() },
    };
    const rejected = await Effect.runPromise(
      Effect.flip(planLocalInstallEffect(forgedRequest, rejectingAuthorities)),
    );
    expect(rejected.code).toBe("INSTALL_AUTHORIZATION_REJECTED");
  });

  test("rejects caller-supplied global, home, config, or custom roots", async () => {
    const fixture = request({ scope: "global", projectRoot: undefined });
    const fixtureObservations = observations([
      destination("/home/daniel/.agents/skills/research-assistant"),
    ]);
    const authorities = fixtureAuthorities(fixture, fixtureObservations);
    const rejectedRoots = await Promise.all(
      [
        { globalRoot: "/tmp" },
        { homeDirectory: "/tmp" },
        { configRoot: "/tmp" },
        { customPath: "/tmp" },
      ].map((injected) =>
        Effect.runPromise(
          Effect.flip(
            planLocalInstallEffect(
              {
                ...publicRequest,
                scope: "global",
                projectRoot: undefined,
                ...injected,
              },
              authorities,
            ),
          ),
        ),
      ),
    );
    for (const rejected of rejectedRoots) {
      expect(rejected.code).toBe("CUSTOM_PATH_FORBIDDEN");
    }
  });

  test("rejects a broad global root returned by the OS observation authority", async () => {
    const fixture = request({ scope: "global", projectRoot: undefined });
    const base = fixtureAuthorities(
      fixture,
      observations([destination("/tmp/.agents/skills/research-assistant")]),
    );
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      os: {
        ...base.os,
        observeEnvironment: () =>
          Effect.succeed({
            platform: "linux",
            homeDirectory: "/home/daniel",
            configDirectory: null,
            selectedRoot: {
              requestedPath: "/tmp",
              canonicalPath: "/tmp",
              exists: true,
              writable: true,
              kind: "directory",
              ancestors: [{ path: "/tmp", kind: "directory" }],
            },
            authorizedGlobalRoots: [
              {
                canonicalPath: "/home/daniel",
                source: "home",
                agents: "all",
              },
            ],
          }),
      },
    };
    const rejected = await Effect.runPromise(
      Effect.flip(
        planLocalInstallEffect(
          { ...publicRequest, scope: "global", projectRoot: undefined },
          authorities,
        ),
      ),
    );
    expect(rejected.code).toBe("ROOT_TOO_BROAD");
  });

  test("rejects an arbitrary global root not enumerated by the OS authority", async () => {
    const fixture = request({ scope: "global", projectRoot: undefined });
    const arbitraryRoot = "/srv/arbitrary";
    const base = fixtureAuthorities(
      fixture,
      observations([destination(`${arbitraryRoot}/.agents/skills/research-assistant`)]),
    );
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      os: {
        ...base.os,
        observeEnvironment: () =>
          Effect.succeed({
            platform: "linux",
            homeDirectory: "/home/daniel",
            configDirectory: "/home/daniel/.config",
            selectedRoot: {
              requestedPath: arbitraryRoot,
              canonicalPath: arbitraryRoot,
              exists: true,
              writable: true,
              kind: "directory",
              ancestors: [{ path: arbitraryRoot, kind: "directory" }],
            },
            authorizedGlobalRoots: [
              { canonicalPath: "/home/daniel", source: "home", agents: "all" },
              {
                canonicalPath: "/home/daniel/.config",
                source: "config",
                agents: "all",
              },
            ],
          }),
      },
    };
    const rejected = await Effect.runPromise(
      Effect.flip(
        planLocalInstallEffect(
          { ...publicRequest, scope: "global", projectRoot: undefined },
          authorities,
        ),
      ),
    );
    expect(rejected.code).toBe("GLOBAL_ROOT_UNAUTHORIZED");
    expect(rejected.path).toBe(arbitraryRoot);
  });

  test("accepts an enumerated global root only for its selected agents", async () => {
    const fixture = request({ scope: "global", projectRoot: undefined });
    const agentRoot = "/srv/codex-global";
    const base = fixtureAuthorities(
      fixture,
      observations([destination(`${agentRoot}/.agents/skills/research-assistant`)]),
    );
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      os: {
        ...base.os,
        observeEnvironment: () =>
          Effect.succeed({
            platform: "linux",
            homeDirectory: "/home/daniel",
            configDirectory: null,
            selectedRoot: {
              requestedPath: agentRoot,
              canonicalPath: agentRoot,
              exists: true,
              writable: true,
              kind: "directory",
              ancestors: [{ path: agentRoot, kind: "directory" }],
            },
            authorizedGlobalRoots: [
              { canonicalPath: agentRoot, source: "agent", agents: ["codex"] },
            ],
          }),
      },
    };
    const globalRequest: LocalInstallRequest = {
      ...publicRequest,
      scope: "global",
      projectRoot: undefined,
    };
    const accepted = await Effect.runPromise(planLocalInstallEffect(globalRequest, authorities));
    expect(accepted.ready).toBe(true);

    const rejected = await Effect.runPromise(
      Effect.flip(
        planLocalInstallEffect(
          { ...globalRequest, targetAgents: ["codex", "claude_code"] },
          authorities,
        ),
      ),
    );
    expect(rejected.code).toBe("GLOBAL_ROOT_UNAUTHORIZED");
  });

  test("ignores forged observed ownership and trusts only the receipt authority", async () => {
    const fixture = request();
    const target = "/work/project/.agents/skills/research-assistant";
    const base = fixtureAuthorities(fixture, observations([destination(target)]));
    const forgedDestination: DestinationObservation & {
      readonly ownership: {
        readonly kind: "receipt_owned";
        readonly receiptId: string;
        readonly sealedPackageSha256: string;
        readonly files: ReadonlyArray<never>;
      };
    } = {
      targetPath: target,
      kind: "directory",
      writable: true,
      files: [],
      ancestors: [],
      nearestExistingParent: destination(target).nearestExistingParent,
      ownership: {
        kind: "receipt_owned" as const,
        receiptId: "forged",
        sealedPackageSha256: H1,
        files: [],
      },
    };
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      os: {
        ...base.os,
        observePaths: () =>
          Effect.succeed({
            destinations: [forgedDestination],
            localSources: [],
          }),
      },
      receipts: { readReceipts: () => Effect.succeed([]) },
    };
    const plan = await Effect.runPromise(planLocalInstallEffect(publicRequest, authorities));
    expect(plan.ready).toBe(false);
    expect(plan.conflicts[0]?.code).toBe("UNMANAGED_DESTINATION");
  });

  test("rejects duplicate active SQLite receipts before planning operations", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const receipt: StoredInstallReceipt = {
      receiptId: "receipt_a",
      state: "active",
      agent: "codex",
      scope: "project",
      projectRoot: "/work/project",
      registryRoot: "/work/project/.agents/skills",
      targetPath: target,
      skillName: "research-assistant",
      logicalSkillId: "skill_01",
      sealedPackageSha256: H1,
      files: [],
    };
    const rejected = await failure(request(), {
      ...observations([destination(target)]),
      receipts: [receipt, { ...receipt, receiptId: "receipt_b" }],
    });
    expect(rejected.code).toBe("RECEIPT_INVARIANT");
  });

  test("uses verified canonical symlink source paths and rejects temp realpaths or overlap", async () => {
    const local = skill({
      source: {
        kind: "local_authoring_immutable",
        absolutePath: "/work/source-link",
        sourceSha256: H2,
      },
      consent: { ...skill().consent, action: "local_authoring" },
    });
    const localRequest = request({
      subject: { kind: "standalone", skill: local },
      strategy: "symlink",
    });
    const verifiedSource = {
      requestedPath: "/work/source-link",
      canonicalPath: "/durable/sources/research-assistant",
      exists: true,
      kind: "directory" as const,
      temporary: false,
      immutableSnapshot: true,
      contentSha256: H2,
      ancestors: [
        {
          path: "/work/source-link",
          kind: "symlink" as const,
          resolvedPath: "/durable/sources/research-assistant",
        },
      ],
    };
    const plan = await Effect.runPromise(
      planLocalInstall(localRequest, observations(undefined, [verifiedSource])),
    );
    expect(plan.operations[0]).toMatchObject({
      kind: "create_symlink",
      sourcePath: "/durable/sources/research-assistant",
    });

    const tempRejected = await failure(
      localRequest,
      observations(undefined, [
        { ...verifiedSource, canonicalPath: "/tmp/research-assistant", temporary: false },
      ]),
    );
    expect(tempRejected.code).toBe("LOCAL_SOURCE_UNVERIFIED");

    const overlapRejected = await failure(
      localRequest,
      observations(undefined, [
        {
          ...verifiedSource,
          canonicalPath: "/work/project/.agents/skills/research-assistant/source",
          ancestors: [
            {
              path: "/work/source-link",
              kind: "symlink",
              resolvedPath: "/work/project/.agents/skills/research-assistant/source",
            },
          ],
        },
      ]),
    );
    expect(overlapRejected.code).toBe("SOURCE_DESTINATION_OVERLAP");
  });

  test.each([
    "bad<name.md",
    "bad\u0001name.md",
    "café.md",
    "COM¹.txt",
    "lpt².log",
    "docs/COM³/readme.md",
  ])("rejects non-portable package path %s through the canonical schema", async (path) => {
    const invalid = skill({
      files: [{ path, sha256: H1, byteLength: 1, kind: "file" }],
      license: { spdxExpression: "MIT", licenseFile: null, notices: [] },
    });
    expect(
      (await failure(request({ subject: { kind: "standalone", skill: invalid } }), observations()))
        .code,
    ).toBe("UNSAFE_PACKAGE_PATH");
  });

  test("rejects file-to-descendant portable collisions", async () => {
    const invalid = skill({
      files: [
        { path: "docs", sha256: H1, byteLength: 1, kind: "file" },
        { path: "docs/readme.md", sha256: H2, byteLength: 1, kind: "file" },
      ],
      license: { spdxExpression: "MIT", licenseFile: null, notices: [] },
    });
    expect(
      (await failure(request({ subject: { kind: "standalone", skill: invalid } }), observations()))
        .code,
    ).toBe("PACKAGE_PATH_COLLISION");
  });

  test("requires a writable existing nearest parent for a missing destination", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const rejected = await failure(
      request(),
      observations([
        destination(target, {
          nearestExistingParent: {
            requestedPath: "/work/project/.agents/skills",
            canonicalPath: "/work/project/.agents/skills",
            exists: true,
            writable: false,
            kind: "directory",
            ancestors: [],
          },
        }),
      ]),
    );
    expect(rejected.code).toBe("NEAREST_PARENT_UNAVAILABLE");
  });

  test("journal rollback references durable snapshots rather than hashes", async () => {
    const target = "/work/project/.agents/skills/research-assistant";
    const plan = await Effect.runPromise(
      planLocalInstall(
        request(),
        observations([
          destination(target, {
            kind: "directory",
            ownership: {
              kind: "receipt_owned",
              receiptId: "receipt_old",
              sealedPackageSha256: H4,
              files: [{ path: "SKILL.md", sha256: H4 }],
            },
            files: [
              {
                path: "SKILL.md",
                sha256: H4,
                kind: "file",
                durableSnapshotRef: "cas://snapshot/skill-old",
              },
            ],
          }),
        ]),
      ),
    );
    const replace = plan.operations.find((operation) => operation.kind === "replace_file");
    expect(replace).toMatchObject({
      previousSnapshotRef: `receipt-snapshot:SKILL.md:${H4}`,
    });
    expect(
      plan.journal?.steps.find((step) => step.operation.kind === "replace_file")?.rollback,
    ).toEqual({
      kind: "restore_snapshot",
      snapshotRef: `receipt-snapshot:SKILL.md:${H4}`,
    });
  });

  test("confirmation replans under the exclusive commit lock and rejects changed evidence", async () => {
    const fixture = request();
    const base = fixtureAuthorities(fixture, observations());
    let environmentReads = 0;
    let lockEntries = 0;
    let commitCalled = false;
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      os: {
        ...base.os,
        observeEnvironment: () => {
          environmentReads += 1;
          return Effect.succeed({
            platform: "linux",
            homeDirectory: "/home/daniel",
            configDirectory: null,
            selectedRoot: {
              ...observations().projectRoot!,
              ancestors:
                environmentReads === 1
                  ? [{ path: "/work/project", kind: "directory" }]
                  : [
                      { path: "/work", kind: "directory" },
                      { path: "/work/project", kind: "directory" },
                    ],
            },
            authorizedGlobalRoots: [],
          });
        },
      },
      commitLock: {
        withExclusiveCommit: (commit) => {
          lockEntries += 1;
          return commit({
            fenceId: `test-fence-${lockEntries}`,
            assertValid: Effect.succeed(undefined),
          });
        },
      },
    };
    const preview = await Effect.runPromise(planLocalInstallEffect(publicRequest, authorities));
    const rejected = await Effect.runPromise(
      Effect.flip(
        confirmAndCommitLocalInstall(publicRequest, preview.previewToken, authorities, () =>
          Effect.sync(() => {
            commitCalled = true;
            return "committed";
          }),
        ),
      ),
    );
    expect(rejected.code).toBe("STALE_PREVIEW");
    expect(lockEntries).toBe(1);
    expect(environmentReads).toBe(2);
    expect(commitCalled).toBe(false);
  });

  test("keeps the exclusive fence held through the materializer commit callback", async () => {
    const fixture = request();
    const base = fixtureAuthorities(fixture, observations());
    let held = false;
    let callbackObservedFence = false;
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      commitLock: {
        withExclusiveCommit: (commit) =>
          Effect.suspend(() => {
            held = true;
            return commit({
              fenceId: "exclusive-fence",
              assertValid: Effect.sync(() => {
                expect(held).toBe(true);
              }),
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  held = false;
                }),
              ),
            );
          }),
      },
    };
    const preview = await Effect.runPromise(planLocalInstallEffect(publicRequest, authorities));
    const committed = await Effect.runPromise(
      confirmAndCommitLocalInstall(publicRequest, preview.previewToken, authorities, ({ fence }) =>
        Effect.sync(() => {
          callbackObservedFence = held && fence.fenceId === "exclusive-fence";
          return "committed";
        }),
      ),
    );
    expect(committed).toBe("committed");
    expect(callbackObservedFence).toBe(true);
    expect(held).toBe(false);
  });

  test("serializes concurrent confirmation and materializer commits", async () => {
    const fixture = request();
    const base = fixtureAuthorities(fixture, observations());
    const semaphore = Semaphore.makeUnsafe(1);
    let fenceSequence = 0;
    let activeCommits = 0;
    let maximumActiveCommits = 0;
    const authorities: InstallerPlanningAuthorities = {
      ...base,
      commitLock: {
        withExclusiveCommit: (commit) =>
          semaphore.withPermit(
            Effect.suspend(() => {
              fenceSequence += 1;
              return commit({
                fenceId: `exclusive-fence-${fenceSequence}`,
                assertValid: Effect.succeed(undefined),
              });
            }),
          ),
      },
    };
    const preview = await Effect.runPromise(planLocalInstallEffect(publicRequest, authorities));
    const commit = confirmAndCommitLocalInstall(
      publicRequest,
      preview.previewToken,
      authorities,
      ({ fence }) =>
        Effect.sync(() => {
          activeCommits += 1;
          maximumActiveCommits = Math.max(maximumActiveCommits, activeCommits);
        }).pipe(
          Effect.flatMap(() => Effect.sleep("10 millis")),
          Effect.map(() => fence.fenceId),
          Effect.ensuring(
            Effect.sync(() => {
              activeCommits -= 1;
            }),
          ),
        ),
    );
    const results = await Effect.runPromise(
      Effect.all([commit, commit], { concurrency: "unbounded" }),
    );
    expect(results).toHaveLength(2);
    expect(new Set(results).size).toBe(2);
    expect(maximumActiveCommits).toBe(1);
    expect(activeCommits).toBe(0);
  });
});
