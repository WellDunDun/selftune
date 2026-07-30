import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  parseWindowsTcpListeningScan,
  planWindowsListenerRecovery,
  recoverAuthorizedWindowsListener,
  verifyAuthorizedWindowsListenerRunning,
  verifyWindowsListenerAbsent,
  type WindowsListenerRecoveryDependencies,
  type WindowsListenerRecoveryInput,
  type WindowsRecoveryCommandResult,
} from "@selftune/local/service/windows/runtime/recovery";
import type { WindowsRuntimeAuthorization } from "@selftune/local/service/windows/runtime/contract";

const header = `Active Connections

  Proto  Local Address          Foreign Address        State           PID`;

const recoveryInput: WindowsListenerRecoveryInput = {
  configDir: "C:\\Users\\test\\.selftune",
  port: 7888,
  releasePollIntervalMs: 10,
  releaseTimeoutMs: 20,
};

const authenticatedHealth = {
  config_dir: "c:/users/test/.selftune/",
  host: "127.0.0.1",
  ok: true,
  owner_executable_path: "c:/PROGRAM FILES/SelfTune/selftune.exe",
  pid: 4242,
  port: 7888,
  process_mode: "standalone",
  runtime_instance_id: "11111111-1111-4111-8111-111111111111",
  runtime_owner: "desktop",
  runtime_supervision: "os-service",
  service_installation_nonce: "installation-nonce",
  service: "selftune-dashboard",
  version: "0.3.0",
};
const { service_installation_nonce: _installationNonce, ...healthWithoutInstallationNonce } =
  authenticatedHealth;
const { owner_executable_path: _ownerExecutablePath, ...healthWithoutExecutablePath } =
  authenticatedHealth;

const recoveryTiming = {
  releasePollIntervalMs: recoveryInput.releasePollIntervalMs,
  releaseTimeoutMs: recoveryInput.releaseTimeoutMs,
};

const nonceBoundAuthorization: WindowsRuntimeAuthorization = {
  _tag: "NonceBound",
  configDir: recoveryInput.configDir,
  executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
  installationNonce: "installation-nonce",
  owner: "desktop",
  port: recoveryInput.port,
};

const exactLegacyAuthorization: WindowsRuntimeAuthorization = {
  _tag: "ExactLegacy",
  configDir: recoveryInput.configDir,
  executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
  owner: "desktop",
  port: recoveryInput.port,
};

class TestRecoveryFailure extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.operation = operation;
  }
}

function listening(pid = 4242): string {
  return `TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       ${pid}`;
}

function commandResult(code: number, stdout = "", stderr = ""): WindowsRecoveryCommandResult {
  return { code, stderr, stdout };
}

function recoveryHarness(options: {
  readonly health?: ReadonlyArray<unknown>;
  readonly healthFailure?: TestRecoveryFailure;
  readonly netstat: ReadonlyArray<string>;
  readonly shutdownFailure?: TestRecoveryFailure;
  readonly shutdownOutcome?: "accepted" | "instance-mismatch" | "rejected" | "transport-ambiguous";
}) {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly command: string }> = [];
  const shutdowns: Array<{ readonly instanceId: string; readonly port: number }> = [];
  const sleeps: number[] = [];
  let healthIndex = 0;
  let netstatIndex = 0;
  const dependencies: WindowsListenerRecoveryDependencies<TestRecoveryFailure> = {
    makeFailure: (operation, cause) => new TestRecoveryFailure(operation, cause),
    readAuthToken: () => Effect.succeed("owner-token"),
    requestHealth: () => {
      if (options.healthFailure) return Effect.fail(options.healthFailure);
      const health = options.health?.[healthIndex] ?? authenticatedHealth;
      healthIndex += 1;
      return Effect.succeed(health);
    },
    requestShutdown: (port, _token, instanceId) => {
      if (options.shutdownFailure) return Effect.fail(options.shutdownFailure);
      shutdowns.push({ instanceId, port });
      return Effect.succeed(options.shutdownOutcome ?? "accepted");
    },
    run: (command, args) =>
      Effect.sync(() => {
        calls.push({ args, command });
        const stdout = options.netstat[netstatIndex];
        netstatIndex += 1;
        if (stdout === undefined) throw new Error("Unexpected netstat rescan.");
        return commandResult(0, stdout);
      }),
    sleep: (milliseconds) =>
      Effect.sync(() => {
        sleeps.push(milliseconds);
      }),
  };
  return { calls, dependencies, shutdowns, sleeps };
}

describe("Windows service listener recovery", () => {
  it("verifies a nonce-bound runtime without requesting shutdown", async () => {
    const test = recoveryHarness({ netstat: [listening(), listening()] });

    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, test.dependencies),
      ),
    ).toEqual({
      _tag: "Ready",
      instanceId: authenticatedHealth.runtime_instance_id,
      owner: authenticatedHealth.runtime_owner,
      ownerExecutablePath: authenticatedHealth.owner_executable_path,
      ownerVersion: authenticatedHealth.version,
      pid: 4242,
      port: 7888,
    });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("returns display identity from the second authenticated health response", async () => {
    const freshHealth = {
      ...authenticatedHealth,
      owner_executable_path: "C:\\Program Files\\SelfTune\\selftune.exe",
      version: "0.4.0",
    };
    const test = recoveryHarness({
      health: [{ ...authenticatedHealth, version: "0.3.0" }, freshHealth],
      netstat: [listening(), listening()],
    });

    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, test.dependencies),
      ),
    ).toMatchObject({
      _tag: "Ready",
      owner: freshHealth.runtime_owner,
      ownerExecutablePath: freshHealth.owner_executable_path,
      ownerVersion: freshHealth.version,
    });
  });

  it("verifies an explicitly authorized exact legacy runtime with no nonce", async () => {
    const legacyHealth = { ...authenticatedHealth, service_installation_nonce: null };
    const test = recoveryHarness({
      health: [legacyHealth, legacyHealth],
      netstat: [listening(), listening()],
    });

    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(exactLegacyAuthorization, test.dependencies),
      ),
    ).toMatchObject({ _tag: "Ready", pid: 4242 });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("refuses a nonce-bearing runtime under exact legacy authorization", async () => {
    const test = recoveryHarness({ netstat: [listening()] });
    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(exactLegacyAuthorization, test.dependencies),
      ),
    ).toMatchObject({
      _tag: "NotReady",
      reason: "health-installation-nonce-unexpected",
    });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("refuses authorized runtimes with the wrong owner, executable, or nonce", async () => {
    const cases = [
      {
        health: { ...authenticatedHealth, runtime_owner: "cli" },
        reason: "health-owner-mismatch",
      },
      {
        health: {
          ...authenticatedHealth,
          owner_executable_path: "C:\\Program Files\\Other\\selftune.exe",
        },
        reason: "health-executable-mismatch",
      },
      {
        health: { ...authenticatedHealth, service_installation_nonce: "replacement" },
        reason: "health-installation-nonce-mismatch",
      },
    ];

    const results = await Promise.all(
      cases.map(async ({ health, reason }) => {
        const test = recoveryHarness({ health: [health], netstat: [listening()] });
        const outcome = await Effect.runPromise(
          verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, test.dependencies),
        );
        return { outcome, reason, shutdowns: test.shutdowns };
      }),
    );

    for (const result of results) {
      expect(result.outcome).toMatchObject({ _tag: "NotReady", reason: result.reason });
      expect(result.shutdowns).toHaveLength(0);
    }
  });

  it("revalidates the authorized identity after rescanning the listener", async () => {
    const ownerChanged = recoveryHarness({
      health: [authenticatedHealth, { ...authenticatedHealth, runtime_owner: "cli" }],
      netstat: [listening(), listening()],
    });
    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, ownerChanged.dependencies),
      ),
    ).toMatchObject({ _tag: "NotReady", reason: "health-owner-mismatch" });

    const pathChanged = recoveryHarness({
      health: [
        authenticatedHealth,
        {
          ...authenticatedHealth,
          owner_executable_path: "C:\\Program Files\\Other\\selftune.exe",
        },
      ],
      netstat: [listening(), listening()],
    });
    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, pathChanged.dependencies),
      ),
    ).toMatchObject({ _tag: "NotReady", reason: "health-executable-mismatch" });
  });

  it("reports absent and replaced listeners as not ready", async () => {
    const absent = recoveryHarness({ netstat: [""] });
    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, absent.dependencies),
      ),
    ).toEqual({
      _tag: "NotReady",
      candidatePids: [],
      port: 7888,
      reason: "listener-absent",
    });

    const replaced = recoveryHarness({ netstat: [listening(), listening(5000)] });
    expect(
      await Effect.runPromise(
        verifyAuthorizedWindowsListenerRunning(nonceBoundAuthorization, replaced.dependencies),
      ),
    ).toMatchObject({
      _tag: "NotReady",
      candidatePids: [5000],
      reason: "listener-changed-during-verification",
    });
    expect(replaced.shutdowns).toHaveLength(0);
  });

  it("recovers only a nonce-bound authorized runtime", async () => {
    const test = recoveryHarness({ netstat: [listening(), listening(), ""] });
    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(nonceBoundAuthorization, test.dependencies, {
          releasePollIntervalMs: 10,
          releaseTimeoutMs: 20,
        }),
      ),
    ).toMatchObject({ outcome: "stopped", pid: 4242 });
    expect(test.shutdowns).toHaveLength(1);
  });

  it("parses exact IPv4 and IPv6 loopback TCP listeners", () => {
    const scan = parseWindowsTcpListeningScan(
      `${header}
  TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       4242
  TCP    [::1]:7888             [::]:0                 LISTENING       4242
  TCP    127.0.0.1:7888         127.0.0.1:50000        ESTABLISHED     4242
  UDP    127.0.0.1:7888         *:*                                     4242
  TCP    127.0.0.1:7889         0.0.0.0:0              LISTENING       5000`,
      7888,
    );

    expect(scan).toEqual({
      listeners: [
        { address: "127.0.0.1", family: "ipv4", pid: 4242, port: 7888 },
        { address: "::1", family: "ipv6", pid: 4242, port: 7888 },
      ],
      port: 7888,
      rejected: [],
    });
    expect(planWindowsListenerRecovery(scan)).toEqual({
      decision: "authenticate-health",
      families: ["ipv4", "ipv6"],
      pid: 4242,
      port: 7888,
    });
  });

  it("identifies listeners without depending on the localized state label", () => {
    const scan = parseWindowsTcpListeningScan(
      `${header}
  TCP    127.0.0.1:7888         0.0.0.0:0              ABHOREN         4242
  TCP    127.0.0.1:7888         127.0.0.1:50000        HERGESTELLT     5000`,
      7888,
    );

    expect(scan.listeners).toEqual([
      { address: "127.0.0.1", family: "ipv4", pid: 4242, port: 7888 },
    ]);
  });

  it("refuses wildcard and non-loopback bindings on the target port", () => {
    const wildcard = parseWindowsTcpListeningScan(
      `${header}
  TCP    0.0.0.0:7888           0.0.0.0:0              LISTENING       4242
  TCP    [::]:7888              [::]:0                 LISTENING       4242`,
      7888,
    );
    expect(wildcard.rejected.map(({ family, reason }) => ({ family, reason }))).toEqual([
      { family: "ipv4", reason: "wildcard-binding" },
      { family: "ipv6", reason: "wildcard-binding" },
    ]);
    expect(planWindowsListenerRecovery(wildcard)).toMatchObject({
      decision: "refuse",
      reason: "wildcard-binding",
    });

    const external = parseWindowsTcpListeningScan(
      `TCP    192.168.1.10:7888     0.0.0.0:0              LISTENING       4242`,
      7888,
    );
    expect(planWindowsListenerRecovery(external)).toMatchObject({
      decision: "refuse",
      reason: "non-loopback-binding",
    });
  });

  it("refuses ambiguous PIDs while accepting duplicate dual-stack rows for one PID", () => {
    const ambiguous = parseWindowsTcpListeningScan(
      `${header}
  TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       4100
  TCP    [::1]:7888             [::]:0                 LISTENING       4200`,
      7888,
    );
    expect(planWindowsListenerRecovery(ambiguous)).toEqual({
      candidatePids: [4100, 4200],
      decision: "refuse",
      port: 7888,
      reason: "ambiguous-pids",
    });

    const duplicate = parseWindowsTcpListeningScan(
      `${header}
  TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       4242`,
      7888,
    );
    expect(duplicate.listeners).toHaveLength(1);
  });

  it("requires valid PIDs and matching authenticated health before termination", () => {
    const invalid = parseWindowsTcpListeningScan(
      `TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       unknown`,
      7888,
    );
    expect(planWindowsListenerRecovery(invalid)).toMatchObject({
      decision: "refuse",
      reason: "invalid-pid",
    });

    const scan = parseWindowsTcpListeningScan(
      `TCP    127.0.0.1:7888         0.0.0.0:0              LISTENING       4242`,
      7888,
    );
    expect(planWindowsListenerRecovery(scan, { pid: 5000, port: 7888 })).toMatchObject({
      decision: "refuse",
      reason: "authenticated-pid-mismatch",
    });
    expect(planWindowsListenerRecovery(scan, { pid: 4242, port: 9000 })).toMatchObject({
      decision: "refuse",
      reason: "authenticated-port-mismatch",
    });
    expect(planWindowsListenerRecovery(scan, { pid: 4242, port: 7888 })).toEqual({
      decision: "terminate-authenticated-listener",
      families: ["ipv4"],
      pid: 4242,
      port: 7888,
    });
  });

  it("returns no listener when the target port has no exact loopback binding", () => {
    const scan = parseWindowsTcpListeningScan(header, 7888);
    expect(planWindowsListenerRecovery(scan)).toEqual({
      decision: "no-listener",
      port: 7888,
    });
  });

  it("verifies final listener absence without health or shutdown side effects", async () => {
    const absent = recoveryHarness({ netstat: ["", "", ""] });
    expect(
      await Effect.runPromise(verifyWindowsListenerAbsent(recoveryInput, absent.dependencies)),
    ).toEqual({ outcome: "absent", port: 7888 });
    expect(absent.shutdowns).toHaveLength(0);
    expect(absent.sleeps).toEqual([10, 10]);

    const replaced = recoveryHarness({ netstat: [listening(5000)] });
    expect(
      await Effect.runPromise(verifyWindowsListenerAbsent(recoveryInput, replaced.dependencies)),
    ).toEqual({
      candidatePids: [5000],
      outcome: "refused",
      port: 7888,
      reason: "listener-still-present",
    });
    expect(replaced.shutdowns).toHaveLength(0);

    const delayedSuccessor = recoveryHarness({ netstat: ["", listening(5000)] });
    expect(
      await Effect.runPromise(
        verifyWindowsListenerAbsent(recoveryInput, delayedSuccessor.dependencies),
      ),
    ).toMatchObject({
      candidatePids: [5000],
      outcome: "refused",
      reason: "listener-still-present",
    });
    expect(delayedSuccessor.shutdowns).toHaveLength(0);
  });

  it("stops only a freshly re-authenticated matching listener", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening(), ""],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toEqual({
      instanceId: authenticatedHealth.runtime_instance_id,
      outcome: "stopped",
      pid: 4242,
      port: 7888,
    });
    expect(test.shutdowns).toEqual([
      { instanceId: authenticatedHealth.runtime_instance_id, port: 7888 },
    ]);
  });

  it("stops a runtime only when both health reads match the nonce-bound authorization", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening(), ""],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "stopped", pid: 4242 });
    expect(test.shutdowns).toHaveLength(1);
  });

  it("refuses health that does not match the nonce-bound authorization", async () => {
    const cases = [
      {
        health: { ...authenticatedHealth, service_installation_nonce: null },
        reason: "health-installation-nonce-missing",
      },
      {
        health: healthWithoutInstallationNonce,
        reason: "health-installation-nonce-missing",
      },
      {
        health: { ...authenticatedHealth, service_installation_nonce: "foreign-installation" },
        reason: "health-installation-nonce-mismatch",
      },
      {
        health: { ...authenticatedHealth, runtime_owner: null },
        reason: "health-owner-missing",
      },
      {
        health: { ...authenticatedHealth, runtime_owner: "cli" },
        reason: "health-owner-mismatch",
      },
      {
        health: healthWithoutExecutablePath,
        reason: "health-executable-missing",
      },
      {
        health: {
          ...authenticatedHealth,
          owner_executable_path: "C:\\Program Files\\Other\\selftune.exe",
        },
        reason: "health-executable-mismatch",
      },
    ];

    const results = await Promise.all(
      cases.map(async ({ health, reason }) => {
        const test = recoveryHarness({ health: [health], netstat: [listening()] });
        const outcome = await Effect.runPromise(
          recoverAuthorizedWindowsListener(
            nonceBoundAuthorization,
            test.dependencies,
            recoveryTiming,
          ),
        );
        return { outcome, reason, shutdowns: test.shutdowns };
      }),
    );

    for (const result of results) {
      expect(result.outcome).toMatchObject({ outcome: "refused", reason: result.reason });
      expect(result.shutdowns).toHaveLength(0);
    }
  });

  it("refuses authorized identity changes between health reads", async () => {
    const replacements = [
      {
        health: { ...authenticatedHealth, service_installation_nonce: "replacement-nonce" },
        reason: "health-installation-nonce-mismatch",
      },
      {
        health: healthWithoutInstallationNonce,
        reason: "health-installation-nonce-missing",
      },
      {
        health: { ...authenticatedHealth, runtime_owner: "cli" },
        reason: "health-owner-mismatch",
      },
      {
        health: {
          ...authenticatedHealth,
          owner_executable_path: "C:\\Program Files\\Other\\selftune.exe",
        },
        reason: "health-executable-mismatch",
      },
      {
        health: healthWithoutExecutablePath,
        reason: "health-executable-missing",
      },
    ];

    const results = await Promise.all(
      replacements.map(async ({ health, reason }) => {
        const test = recoveryHarness({
          health: [authenticatedHealth, health],
          netstat: [listening(), listening()],
        });
        const outcome = await Effect.runPromise(
          recoverAuthorizedWindowsListener(
            nonceBoundAuthorization,
            test.dependencies,
            recoveryTiming,
          ),
        );
        return { outcome, reason, shutdowns: test.shutdowns };
      }),
    );

    for (const result of results) {
      expect(result.outcome).toMatchObject({ outcome: "refused", reason: result.reason });
      expect(result.shutdowns).toHaveLength(0);
    }
  });

  it("refuses direct and desktop-child runtimes", async () => {
    const results = await Promise.all(
      ["none", "desktop-child"].map(async (runtime_supervision) => {
        const test = recoveryHarness({
          health: [{ ...authenticatedHealth, runtime_supervision }],
          netstat: [listening()],
        });
        const outcome = await Effect.runPromise(
          recoverAuthorizedWindowsListener(
            nonceBoundAuthorization,
            test.dependencies,
            recoveryTiming,
          ),
        );
        return { outcome, shutdowns: test.shutdowns };
      }),
    );
    for (const result of results) {
      expect(result.outcome).toMatchObject({
        outcome: "refused",
        reason: "health-supervision-mismatch",
      });
      expect(result.shutdowns).toHaveLength(0);
    }
  });

  it("returns an explicit refused outcome when authenticated health is unavailable", async () => {
    const test = recoveryHarness({
      healthFailure: new TestRecoveryFailure("health", "unreachable"),
      netstat: [listening()],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "health-unavailable" });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("refuses mismatched canonical runtime identity", async () => {
    const test = recoveryHarness({
      health: [
        {
          ...authenticatedHealth,
          owner_executable_path: "selftune.exe",
        },
      ],
      netstat: [listening()],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "health-executable-mismatch" });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("requires every authenticated runtime identity field before termination", async () => {
    const cases = [
      {
        health: { ...authenticatedHealth, service: "foreign-dashboard" },
        reason: "health-service-mismatch",
      },
      { health: { ...authenticatedHealth, pid: 5000 }, reason: "health-pid-mismatch" },
      { health: { ...authenticatedHealth, port: 9000 }, reason: "health-port-mismatch" },
      {
        health: { ...authenticatedHealth, process_mode: "dev-server" },
        reason: "health-mode-mismatch",
      },
      {
        health: { ...authenticatedHealth, runtime_owner: "foreign" },
        reason: "health-owner-mismatch",
      },
      {
        health: { ...authenticatedHealth, runtime_owner: null },
        reason: "health-owner-missing",
      },
      { health: { ...authenticatedHealth, host: "localhost" }, reason: "health-host-mismatch" },
      {
        health: { ...authenticatedHealth, runtime_instance_id: null },
        reason: "health-instance-id-missing",
      },
      {
        health: { ...authenticatedHealth, config_dir: "C:\\Users\\other\\.selftune" },
        reason: "health-config-mismatch",
      },
      { health: {}, reason: "health-invalid" },
    ];
    const results = await Promise.all(
      cases.map(async ({ health, reason }) => {
        const test = recoveryHarness({ health: [health], netstat: [listening()] });
        const outcome = await Effect.runPromise(
          recoverAuthorizedWindowsListener(
            nonceBoundAuthorization,
            test.dependencies,
            recoveryTiming,
          ),
        );
        return { outcome, reason, shutdowns: test.shutdowns };
      }),
    );

    for (const result of results) {
      expect(result.outcome).toMatchObject({ outcome: "refused", reason: result.reason });
      expect(result.shutdowns).toHaveLength(0);
    }
  });

  it("refuses when the listener changes during authorized verification", async () => {
    const test = recoveryHarness({ netstat: [listening(), listening(5000)] });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "listener-changed-during-verification" });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("refuses when fresh authentication observes a replacement runtime instance", async () => {
    const test = recoveryHarness({
      health: [
        authenticatedHealth,
        { ...authenticatedHealth, runtime_instance_id: "replacement-instance" },
      ],
      netstat: [listening(), listening()],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "health-instance-id-mismatch" });
    expect(test.shutdowns).toHaveLength(0);
  });

  it("refuses when the authenticated instance rejects shutdown", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening()],
      shutdownOutcome: "rejected",
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "shutdown-refused" });
  });

  it("accepts an ambiguous shutdown transport when the instance releases the listener", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening(), ""],
      shutdownFailure: new TestRecoveryFailure("shutdown", "connection closed"),
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "stopped", pid: 4242 });
  });

  it("returns a refused failure outcome when the PID does not release before timeout", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening(), listening(), listening(), listening()],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({ outcome: "refused", reason: "listener-release-timeout" });
    expect(test.sleeps).toEqual([10, 10]);
  });

  it("does not report success when another listener replaces the killed PID", async () => {
    const test = recoveryHarness({
      netstat: [listening(), listening(), listening(5000)],
    });

    expect(
      await Effect.runPromise(
        recoverAuthorizedWindowsListener(
          nonceBoundAuthorization,
          test.dependencies,
          recoveryTiming,
        ),
      ),
    ).toMatchObject({
      candidatePids: [5000],
      outcome: "refused",
      reason: "listener-changed-after-termination",
    });
  });
});
