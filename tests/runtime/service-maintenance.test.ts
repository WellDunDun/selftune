import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServiceManager, type WindowsServiceBackend } from "@selftune/local/service-contract";
import { runServiceMaintenanceCommand } from "@selftune/local/service/maintenance/command";
import type { WindowsServiceLockCompatibilityDiagnostic } from "@selftune/local/service/windows/lock-compatibility";

const path = "c:\\users\\test\\appdata\\local\\selftune\\service-control\\lock";
const stale: WindowsServiceLockCompatibilityDiagnostic = {
  _tag: "LegacyStale",
  fileIdentity: "file-1",
  generation: "a".repeat(64),
  path,
  pid: 404,
  startedAt: "2026-07-16T11:00:00.000Z",
};
const fenced: WindowsServiceLockCompatibilityDiagnostic = {
  _tag: "FenceReady",
  fence: {
    controlDir: "c:\\users\\test\\appdata\\local\\selftune\\service-control",
    kind: "sqlite-ownership-fence",
    namespace: "selftune-user-service-v1",
    userSid: "S-1-5-21-1000-2000-3000-4000",
    version: 3,
  },
  path,
};

function run(
  action: "doctor" | "repair-lock",
  diagnose: WindowsServiceLockCompatibilityDiagnostic,
  repaired: WindowsServiceLockCompatibilityDiagnostic = fenced,
) {
  let repairCalls = 0;
  const backend: WindowsServiceBackend = {
    automated: true,
    diagnoseMutationLock: () => Effect.succeed(diagnose),
    inspectInstallation: () => Effect.die("unused inspect"),
    install: () => Effect.die("unused install"),
    platform: "win32",
    repairMutationLock: () =>
      Effect.sync(() => {
        repairCalls += 1;
        return repaired;
      }),
    restart: () => Effect.die("unused restart"),
    start: () => Effect.die("unused start"),
    status: () => Effect.die("unused status"),
    stop: () => Effect.die("unused stop"),
    uninstall: () => Effect.die("unused uninstall"),
    withMutationLock: (_descriptor, use) => use,
  };
  const layer = Layer.succeed(ServiceManager)({
    backend,
    runtime: {
      status: () => Effect.die("unused runtime status"),
      stop: () => Effect.die("unused runtime stop"),
    },
    windowsRecovery: {
      recoverAuthorized: () => Effect.die("unused recovery"),
      verifyAbsent: () => Effect.die("unused absence"),
      verifyRunning: () => Effect.die("unused readiness"),
    },
  });
  return {
    effect: runServiceMaintenanceCommand(action).pipe(Effect.provide(layer)),
    repairCalls: () => repairCalls,
  };
}

describe("service lock maintenance", () => {
  it("maps every diagnostic without exposing internal authority", async () => {
    const cases: ReadonlyArray<
      readonly [WindowsServiceLockCompatibilityDiagnostic, string, boolean]
    > = [
      [{ _tag: "Absent", path }, "ready_to_fence", true],
      [fenced, "fenced", true],
      [
        {
          _tag: "LegacyActiveOrUnverifiable",
          fileIdentity: "file-2",
          generation: "b".repeat(64),
          path,
          pid: 405,
          reason: "the recorded PID is present",
          startedAt: "2026-07-16T11:01:00.000Z",
        },
        "legacy_active_or_unverifiable",
        false,
      ],
      [stale, "legacy_stale_repairable", false],
      [
        {
          _tag: "Refused",
          code: "changed-during-inspection",
          path,
          reason: "the existing file changed during inspection",
        },
        "changed_during_inspection",
        false,
      ],
      [
        { _tag: "Refused", code: "malformed", path, reason: "the file is malformed" },
        "invalid_blocking_file",
        false,
      ],
    ];

    await Promise.all(
      cases.map(async ([diagnostic, state, ok]) => {
        const test = run("doctor", diagnostic);
        const result = await Effect.runPromise(test.effect);
        expect(result).toMatchObject({
          action: "doctor",
          diagnostic: { state },
          ok,
          platform: "win32",
        });
        expect(JSON.stringify(result)).not.toContain(path);
        expect(JSON.stringify(result)).not.toContain("fileIdentity");
        expect(JSON.stringify(result)).not.toContain("generation");
        expect(result).not.toHaveProperty("result");
      }),
    );
  });

  it("repairs only an in-memory stale diagnosis and requires a fenced result", async () => {
    const repair = run("repair-lock", stale);
    await expect(Effect.runPromise(repair.effect)).resolves.toMatchObject({
      diagnostic: { state: "fenced" },
      ok: true,
      result: "repaired",
    });
    expect(repair.repairCalls()).toBe(1);

    const blocked = run("repair-lock", {
      _tag: "LegacyActiveOrUnverifiable",
      fileIdentity: "file-2",
      generation: "b".repeat(64),
      path,
      pid: 405,
      reason: "the recorded PID is present",
      startedAt: "2026-07-16T11:01:00.000Z",
    });
    await expect(Effect.runPromise(blocked.effect)).resolves.toMatchObject({ ok: false });
    expect(blocked.repairCalls()).toBe(0);
  });

  it("treats maintenance as not applicable outside Windows", async () => {
    const backend = {
      automated: true,
      install: () => Effect.die("unused"),
      platform: "darwin" as const,
      restart: () => Effect.die("unused"),
      start: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
      stop: () => Effect.die("unused"),
      uninstall: () => Effect.die("unused"),
    };
    const layer = Layer.succeed(ServiceManager)({
      backend,
      runtime: {
        status: () => Effect.die("unused"),
        stop: () => Effect.die("unused"),
      },
      windowsRecovery: {
        recoverAuthorized: () => Effect.die("unused"),
        verifyAbsent: () => Effect.die("unused"),
        verifyRunning: () => Effect.die("unused"),
      },
    });

    await expect(
      Effect.runPromise(runServiceMaintenanceCommand("doctor").pipe(Effect.provide(layer))),
    ).resolves.toMatchObject({
      diagnostic: { state: "not_applicable" },
      ok: true,
      platform: "darwin",
      result: "not_needed",
    });
  });
});
