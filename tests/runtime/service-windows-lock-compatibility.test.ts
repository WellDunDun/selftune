import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  createWindowsMutationLockFence,
  makeWindowsServiceLockCompatibility,
  serializeWindowsMutationLockFence,
  WINDOWS_USER_SERVICE_NAMESPACE,
  WindowsServiceLockCompatibilityError,
  WindowsServiceLockFileError,
  windowsLegacyServiceMutationLockPath,
  type WindowsServiceLockCompatibilityFileSystem,
  type WindowsServiceLockFileEvidence,
  type WindowsUserServiceMutationLockScope,
} from "../../apps/local/src/service/windows/lock-compatibility.js";

const scope: WindowsUserServiceMutationLockScope = {
  controlDir: "c:\\users\\test\\appdata\\local\\selftune\\service-control",
  namespace: WINDOWS_USER_SERVICE_NAMESPACE,
  userSid: "S-1-5-21-1000-2000-3000-4000",
};
const uuid = "12345678-1234-4123-8123-123456789abc";

class FileExists extends Error {
  readonly code = "EEXIST";
}

interface StoredFile {
  readonly contents: string;
  readonly identity: string;
  readonly regular: boolean;
  readonly symbolicLink: boolean;
}

function legacyPayload(input: { readonly pid?: number; readonly userSid?: string } = {}): string {
  return `${JSON.stringify({
    controlDir: scope.controlDir,
    namespace: scope.namespace,
    pid: input.pid ?? 303,
    startedAt: "2026-07-16T11:00:00.000Z",
    token: "PLACEHOLDER_WINDOWS_SERVICE_TOKEN",
    userSid: input.userSid ?? scope.userSid,
    version: 2,
  })}\n`;
}

function harness(
  options: {
    readonly alive?: boolean;
    readonly beforeLink?: (files: Map<string, StoredFile>, destination: string) => void;
    readonly inspectSequence?: ReadonlyArray<WindowsServiceLockFileEvidence | null>;
    readonly pidInspectionFails?: boolean;
    readonly repairExclusionHeld?: boolean;
    readonly replacementFails?: boolean;
    readonly typedFileFailures?: boolean;
  } = {},
) {
  const files = new Map<string, StoredFile>();
  const events: string[] = [];
  let identity = 0;
  let pidAlive = options.alive ?? false;
  const inspections = [...(options.inspectSequence ?? [])];
  const fileSystem: WindowsServiceLockCompatibilityFileSystem = {
    inspectFile: (path) =>
      Effect.sync(() => {
        if (inspections.length > 0) return inspections.shift() ?? null;
        const file = files.get(path);
        return file
          ? {
              identity: file.identity,
              regular: file.regular,
              symbolicLink: file.symbolicLink,
            }
          : null;
      }),
    linkFileExclusive: (source, destination) =>
      Effect.try({
        try: () => {
          events.push("link");
          options.beforeLink?.(files, destination);
          if (files.has(destination)) throw new FileExists();
          const file = files.get(source);
          if (!file) throw new Error("missing source");
          files.set(destination, file);
        },
        catch: (cause) =>
          options.typedFileFailures
            ? new WindowsServiceLockFileError({ message: "file exists", code: "EEXIST", cause })
            : cause,
      }),
    readUtf8File: (path) => Effect.succeed(files.get(path)?.contents ?? null),
    removeFile: (path) =>
      Effect.sync(() => {
        events.push("remove-temp");
        files.delete(path);
      }),
    replaceFileAtomic: (source, destination) =>
      Effect.try({
        try: () => {
          events.push("replace");
          if (options.replacementFails) throw new Error("replace failed");
          const file = files.get(source);
          if (!file) throw new Error("missing replacement source");
          files.set(destination, file);
          files.delete(source);
        },
        catch: (cause) => cause,
      }),
    writeUtf8FileSyncedExclusive: (path, contents, mode) =>
      Effect.try({
        try: () => {
          if (files.has(path)) throw new FileExists();
          events.push(`write-sync:${mode.toString(8)}`);
          identity += 1;
          files.set(path, {
            contents,
            identity: `file-${identity}`,
            regular: true,
            symbolicLink: false,
          });
        },
        catch: (cause) => cause,
      }),
  };
  const compatibility = makeWindowsServiceLockCompatibility({
    fileSystem,
    isPidAlive: () =>
      options.pidInspectionFails
        ? Effect.fail(new Error("access denied"))
        : Effect.sync(() => pidAlive),
    randomUuid: () => uuid,
    withRepairExclusion: (_scope, use) =>
      options.repairExclusionHeld
        ? Effect.fail(
            WindowsServiceLockCompatibilityError.make({
              message: "Another Windows service mutation is already in progress.",
              operation: "acquire-windows-service-lock-repair-exclusion",
            }),
          )
        : Effect.acquireUseRelease(
            Effect.sync(() => events.push("begin-sqlite-exclusion")),
            () => use,
            () => Effect.sync(() => events.push("end-sqlite-exclusion")),
          ),
  });
  const put = (path: string, contents: string, evidence: Partial<StoredFile> = {}) => {
    identity += 1;
    files.set(path, {
      contents,
      identity: evidence.identity ?? `file-${identity}`,
      regular: evidence.regular ?? true,
      symbolicLink: evidence.symbolicLink ?? false,
    });
  };
  return {
    compatibility,
    events,
    files,
    put,
    setPidAlive: (alive: boolean) => {
      pidAlive = alive;
    },
  };
}

describe("Windows service lock rollout compatibility", () => {
  it("rejects extra lock fields and noncanonical fence bytes without rewriting", async () => {
    const fence = serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope));
    for (const contents of [
      legacyPayload().replace('"version":2', '"version":2,"extra":true'),
      fence.replace('"version":3', '"version":3,"extra":true'),
      fence.trimEnd(),
      ` ${fence}`,
      "null",
      "[]",
      legacyPayload().replace('"pid":303', '"pid":"303"'),
    ]) {
      const test = harness();
      const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
      test.put(path, contents);
      await expect(Effect.runPromise(test.compatibility.diagnose(scope))).resolves.toMatchObject({
        _tag: "Refused",
        code: "malformed",
      });
      expect(test.files.get(path)?.contents).toBe(contents);
      expect(test.events).toEqual([]);
    }
  });

  it("continues accepting whitespace in legacy payloads", async () => {
    const test = harness();
    test.put(windowsLegacyServiceMutationLockPath(scope.controlDir), `  ${legacyPayload()}\n`);
    await expect(Effect.runPromise(test.compatibility.diagnose(scope))).resolves.toMatchObject({
      _tag: "LegacyStale",
      pid: 303,
    });
  });

  it("recognizes EEXIST through the typed filesystem failure when another fence wins", async () => {
    const contents = serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope));
    const test = harness({
      typedFileFailures: true,
      beforeLink: (files, destination) =>
        files.set(destination, {
          contents,
          identity: "concurrent-fence",
          regular: true,
          symbolicLink: false,
        }),
    });
    await Effect.runPromise(test.compatibility.ensureFence(scope));
    expect(test.events).toEqual(["write-sync:600", "link", "remove-temp"]);
  });

  it("publishes fully written exact v3 bytes before SQLite may proceed", async () => {
    const test = harness();
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);

    await Effect.runPromise(test.compatibility.ensureFence(scope));

    expect(test.files.get(path)?.contents).toBe(
      serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope)),
    );
    expect(test.events).toEqual(["write-sync:600", "link", "remove-temp"]);
    await expect(Effect.runPromise(test.compatibility.diagnose(scope))).resolves.toMatchObject({
      _tag: "FenceReady",
      path,
    });
  });

  it("accepts an exact existing fence without rewriting it", async () => {
    const test = harness();
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const contents = serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope));
    test.put(path, contents);

    await Effect.runPromise(test.compatibility.ensureFence(scope));

    expect(test.files.get(path)?.contents).toBe(contents);
    expect(test.events).toEqual([]);
  });

  it("refuses when an active old v2 writer wins the exclusive publication race", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const oldPayload = legacyPayload({ pid: 404 });
    const test = harness({
      alive: true,
      beforeLink: (files, destination) => {
        files.set(destination, {
          contents: oldPayload,
          identity: "old-v2-winner",
          regular: true,
          symbolicLink: false,
        });
      },
    });

    await expect(Effect.runPromise(test.compatibility.ensureFence(scope))).rejects.toMatchObject({
      message: expect.stringContaining("may still be active (PID 404)"),
      operation: "verify-windows-service-lock-compatibility",
    });
    expect(test.files.get(path)?.contents).toBe(oldPayload);
    expect(test.events).toEqual(["write-sync:600", "link", "remove-temp"]);
  });

  it("leaves a permanent fence that makes a later old v2 exclusive write lose", async () => {
    const test = harness();
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    await Effect.runPromise(test.compatibility.ensureFence(scope));

    expect(test.files.has(path)).toBe(true);
    expect(() => {
      if (test.files.has(path)) throw new FileExists();
      test.put(path, legacyPayload());
    }).toThrow(FileExists);
  });

  it("classifies stale and unverifiable v2 owners without deleting them", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const stale = harness({ alive: false });
    stale.put(path, legacyPayload());
    await expect(Effect.runPromise(stale.compatibility.diagnose(scope))).resolves.toMatchObject({
      _tag: "LegacyStale",
      pid: 303,
    });
    await expect(Effect.runPromise(stale.compatibility.ensureFence(scope))).rejects.toMatchObject({
      message: expect.stringContaining("selftune service repair-lock"),
    });
    expect(stale.files.get(path)?.contents).toBe(legacyPayload());

    const unknown = harness({ pidInspectionFails: true });
    unknown.put(path, legacyPayload());
    await expect(Effect.runPromise(unknown.compatibility.diagnose(scope))).resolves.toMatchObject({
      _tag: "LegacyActiveOrUnverifiable",
      reason: "the recorded PID could not be inspected",
    });
  });

  it("repairs only the exact stale generation while holding SQLite exclusion", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const test = harness({ alive: false });
    test.put(path, legacyPayload());
    const candidate = await Effect.runPromise(test.compatibility.diagnose(scope));
    if (candidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    test.events.length = 0;

    await Effect.runPromise(test.compatibility.repairStale(scope, candidate));

    expect(test.events).toEqual([
      "begin-sqlite-exclusion",
      "write-sync:600",
      "replace",
      "remove-temp",
      "end-sqlite-exclusion",
    ]);
    expect(test.files.get(path)?.contents).toBe(
      serializeWindowsMutationLockFence(createWindowsMutationLockFence(scope)),
    );
    expect([...test.files.keys()].filter((key) => key.includes(".repair-"))).toEqual([]);
  });

  it("reproves active state, payload, scope, and file identity under exclusion", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);

    const active = harness({ alive: false });
    active.put(path, legacyPayload());
    const activeCandidate = await Effect.runPromise(active.compatibility.diagnose(scope));
    if (activeCandidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    active.setPidAlive(true);
    await expect(
      Effect.runPromise(active.compatibility.repairStale(scope, activeCandidate)),
    ).rejects.toMatchObject({ operation: "reprove-windows-service-lock-repair" });

    const scopeDrift = harness({ alive: false });
    scopeDrift.put(path, legacyPayload());
    const scopeCandidate = await Effect.runPromise(scopeDrift.compatibility.diagnose(scope));
    if (scopeCandidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    scopeDrift.put(path, legacyPayload({ userSid: "S-1-5-21-9000-8000-7000-6000" }));
    await expect(
      Effect.runPromise(scopeDrift.compatibility.repairStale(scope, scopeCandidate)),
    ).rejects.toMatchObject({ operation: "reprove-windows-service-lock-repair" });

    const malformed = harness({ alive: false });
    malformed.put(path, legacyPayload());
    const malformedCandidate = await Effect.runPromise(malformed.compatibility.diagnose(scope));
    if (malformedCandidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    malformed.put(path, "{not-json\n");
    await expect(
      Effect.runPromise(malformed.compatibility.repairStale(scope, malformedCandidate)),
    ).rejects.toMatchObject({ operation: "reprove-windows-service-lock-repair" });

    const identityDrift = harness({ alive: false });
    const unchangedBytes = legacyPayload();
    identityDrift.put(path, unchangedBytes);
    const identityCandidate = await Effect.runPromise(identityDrift.compatibility.diagnose(scope));
    if (identityCandidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    identityDrift.put(path, unchangedBytes);
    await expect(
      Effect.runPromise(identityDrift.compatibility.repairStale(scope, identityCandidate)),
    ).rejects.toMatchObject({ operation: "reprove-windows-service-lock-repair" });

    for (const test of [active, malformed, scopeDrift, identityDrift]) {
      expect(test.events).not.toContain("replace");
    }
  });

  it("does not reprove or replace without SQLite exclusion", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const test = harness({ alive: false, repairExclusionHeld: true });
    test.put(path, legacyPayload());
    const candidate = await Effect.runPromise(test.compatibility.diagnose(scope));
    if (candidate._tag !== "LegacyStale") throw new Error("expected stale candidate");
    test.events.length = 0;

    await expect(
      Effect.runPromise(test.compatibility.repairStale(scope, candidate)),
    ).rejects.toMatchObject({ operation: "acquire-windows-service-lock-repair-exclusion" });
    expect(test.events).toEqual([]);
    expect(test.files.get(path)?.contents).toBe(legacyPayload());
  });

  it("cleans the temp and preserves v2 when atomic replacement fails", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const test = harness({ alive: false, replacementFails: true });
    const original = legacyPayload();
    test.put(path, original);
    const candidate = await Effect.runPromise(test.compatibility.diagnose(scope));
    if (candidate._tag !== "LegacyStale") throw new Error("expected stale candidate");

    await expect(
      Effect.runPromise(test.compatibility.repairStale(scope, candidate)),
    ).rejects.toMatchObject({ operation: "replace-windows-service-lock-with-fence" });
    expect(test.files.get(path)?.contents).toBe(original);
    expect([...test.files.keys()].filter((key) => key.includes(".repair-"))).toEqual([]);
  });

  it("fails closed on malformed, mismatched, unsafe, and unstable files", async () => {
    const path = windowsLegacyServiceMutationLockPath(scope.controlDir);
    const malformed = harness();
    malformed.put(path, "{not-json\n");
    await expect(
      Effect.runPromise(malformed.compatibility.ensureFence(scope)),
    ).rejects.toMatchObject({
      message: expect.stringContaining("malformed"),
    });
    await expect(Effect.runPromise(malformed.compatibility.diagnose(scope))).resolves.toMatchObject(
      {
        _tag: "Refused",
        code: "malformed",
      },
    );

    const mismatched = harness();
    mismatched.put(path, legacyPayload({ userSid: "S-1-5-21-9000-8000-7000-6000" }));
    await expect(
      Effect.runPromise(mismatched.compatibility.ensureFence(scope)),
    ).rejects.toMatchObject({
      message: expect.stringContaining("mismatched user-service scope"),
    });

    const unsafe = harness();
    unsafe.put(path, legacyPayload(), { symbolicLink: true });
    await expect(Effect.runPromise(unsafe.compatibility.ensureFence(scope))).rejects.toMatchObject({
      message: expect.stringContaining("regular non-symbolic file"),
    });

    const unstable = harness({
      inspectSequence: [
        { identity: "first", regular: true, symbolicLink: false },
        { identity: "second", regular: true, symbolicLink: false },
      ],
    });
    unstable.put(path, legacyPayload());
    await expect(
      Effect.runPromise(unstable.compatibility.ensureFence(scope)),
    ).rejects.toMatchObject({
      message: expect.stringContaining("changed during inspection"),
    });
    const typedUnstable = harness({
      inspectSequence: [
        { identity: "first", regular: true, symbolicLink: false },
        { identity: "second", regular: true, symbolicLink: false },
      ],
    });
    typedUnstable.put(path, legacyPayload());
    await expect(
      Effect.runPromise(typedUnstable.compatibility.diagnose(scope)),
    ).resolves.toMatchObject({
      _tag: "Refused",
      code: "changed-during-inspection",
    });
  });

  it("rejects an unsafe temporary UUID before touching the filesystem", async () => {
    const compatibility = makeWindowsServiceLockCompatibility({
      fileSystem: {
        inspectFile: () => Effect.succeed(null),
        linkFileExclusive: () => Effect.die("unexpected link"),
        readUtf8File: () => Effect.succeed(null),
        removeFile: () => Effect.die("unexpected remove"),
        replaceFileAtomic: () => Effect.die("unexpected replace"),
        writeUtf8FileSyncedExclusive: () => Effect.die("unexpected write"),
      },
      isPidAlive: () => Effect.succeed(false),
      randomUuid: () => "..\\escape",
      withRepairExclusion: (_scope, use) => use,
    });

    await expect(Effect.runPromise(compatibility.ensureFence(scope))).rejects.toMatchObject({
      operation: "generate-windows-service-lock-fence-temp",
    });
  });
});
