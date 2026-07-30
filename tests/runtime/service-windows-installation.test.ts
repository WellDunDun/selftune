import { describe, expect, it } from "bun:test";

import {
  canonicalWindowsArgvIdentity,
  createWindowsServiceInstallationReceipt,
  decodeWindowsServiceInstallationReceipt,
  matchWindowsServiceInstallation,
  sha256Hex,
  windowsServiceInstallationReceiptPath,
  WINDOWS_SERVICE_INSTALLATION_RECEIPT_KIND,
  type WindowsServiceInstallationCreationInput,
  type WindowsServiceInstallationIdentity,
  type WindowsServiceInstallationMismatch,
} from "@selftune/local/service/windows/installation/model";

const nonce = "A".repeat(43);
const executableArgsPrefix = ["C:\\Program Files\\SelfTune\\cli\\selftune.ts"];
const serverControlDir = "C:\\Users\\Test\\.selftune\\server-control";
const artifacts = {
  launcher: {
    path: `${serverControlDir}\\run-daemon.vbs`,
    sha256: sha256Hex("launcher"),
  },
  taskDefinition: {
    path: `${serverControlDir}\\run-daemon.xml`,
    sha256: sha256Hex("task-definition"),
  },
  wrapper: {
    path: `${serverControlDir}\\run-daemon.cmd`,
    sha256: sha256Hex("wrapper"),
  },
};
const expectedArgv = [
  ...executableArgsPrefix,
  "daemon",
  "run",
  "--foreground",
  "--supervised",
  "--owner",
  "desktop",
  "--port",
  "7888",
  "--hostname",
  "127.0.0.1",
  "--runtime-mode",
  "standalone",
  "--spa-dir",
  "C:\\Program Files\\SelfTune\\dashboard",
  "--service-installation-nonce",
  nonce,
];

const creationInput: WindowsServiceInstallationCreationInput = {
  artifacts,
  boot: true,
  configDir: "C:\\Users\\Test\\.selftune",
  executableArgsPrefix,
  executablePath: "C:\\Program Files\\SelfTune\\selftune.exe",
  expectedArgv,
  installId: "11111111-1111-4111-8111-111111111111",
  installedAt: "2026-07-16T12:30:00.000Z",
  nonce,
  owner: "desktop",
  port: 7888,
  taskName: "SelfTuneDaemon",
  userSid: "S-1-5-21-1000-2000-3000-4000",
};

const identity: WindowsServiceInstallationIdentity = {
  argv: expectedArgv,
  configDir: creationInput.configDir,
  executablePath: creationInput.executablePath,
  owner: creationInput.owner,
  port: creationInput.port,
  taskName: creationInput.taskName,
  userSid: creationInput.userSid,
};

function replaceFlagValue(
  argv: ReadonlyArray<string>,
  flag: string,
  value: string,
): ReadonlyArray<string> {
  const index = argv.indexOf(flag);
  if (index < 0) return argv;
  return argv.map((argument, argumentIndex) => (argumentIndex === index + 1 ? value : argument));
}

describe("Windows service installation receipts", () => {
  it("hashes strings and bytes as lowercase SHA-256", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    expect(sha256Hex("abc")).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
  });

  it("creates and decodes a strict Schema-backed receipt", () => {
    const receipt = createWindowsServiceInstallationReceipt(creationInput);

    expect(receipt).toMatchObject({
      ...creationInput,
      kind: WINDOWS_SERVICE_INSTALLATION_RECEIPT_KIND,
      version: 1,
    });
    expect(decodeWindowsServiceInstallationReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(
      receipt,
    );
  });

  it("stores the receipt under the owner config server-control directory", () => {
    expect(windowsServiceInstallationReceiptPath("C:\\Users\\Test\\.selftune\\")).toBe(
      "C:\\Users\\Test\\.selftune\\server-control\\windows-service-installation.json",
    );
    expect(() => windowsServiceInstallationReceiptPath(".selftune")).toThrow(
      "absolute config path",
    );
  });

  it("rejects malformed identifiers, nonces, timestamps, SIDs, paths, and ports", () => {
    const invalidInputs: ReadonlyArray<WindowsServiceInstallationCreationInput> = [
      { ...creationInput, installId: "not-a-uuid" },
      { ...creationInput, nonce: "short" },
      { ...creationInput, installedAt: "2026-07-16" },
      { ...creationInput, userSid: "test-user" },
      { ...creationInput, configDir: ".selftune" },
      { ...creationInput, executablePath: "selftune.exe" },
      { ...creationInput, port: 0 },
      { ...creationInput, port: 65_536 },
    ];

    for (const input of invalidInputs) {
      expect(() => createWindowsServiceInstallationReceipt(input)).toThrow();
    }
  });

  it("requires three unique hashed artifacts under the config server-control directory", () => {
    const invalidInputs: ReadonlyArray<WindowsServiceInstallationCreationInput> = [
      {
        ...creationInput,
        artifacts: {
          ...artifacts,
          wrapper: { ...artifacts.wrapper, path: "run-daemon.cmd" },
        },
      },
      {
        ...creationInput,
        artifacts: {
          ...artifacts,
          wrapper: { ...artifacts.wrapper, path: "C:\\Other\\run-daemon.cmd" },
        },
      },
      {
        ...creationInput,
        artifacts: {
          ...artifacts,
          wrapper: {
            ...artifacts.wrapper,
            path: `${serverControlDir}\\..\\escaped.cmd`,
          },
        },
      },
      {
        ...creationInput,
        artifacts: {
          ...artifacts,
          wrapper: { ...artifacts.wrapper, sha256: artifacts.wrapper.sha256.toUpperCase() },
        },
      },
      {
        ...creationInput,
        artifacts: {
          ...artifacts,
          launcher: {
            ...artifacts.launcher,
            path: "c:/users/test/.SELFTUNE/server-control/RUN-DAEMON.CMD",
          },
        },
      },
    ];

    for (const input of invalidInputs) {
      expect(() => createWindowsServiceInstallationReceipt(input)).toThrow();
    }
  });

  it("rejects tampered boot and artifact evidence when decoding persisted data", () => {
    const receipt = createWindowsServiceInstallationReceipt(creationInput);

    expect(() => decodeWindowsServiceInstallationReceipt({ ...receipt, boot: "true" })).toThrow();
    expect(() =>
      decodeWindowsServiceInstallationReceipt({
        ...receipt,
        artifacts: {
          launcher: receipt.artifacts.launcher,
          wrapper: receipt.artifacts.wrapper,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeWindowsServiceInstallationReceipt({
        ...receipt,
        artifacts: {
          ...receipt.artifacts,
          taskDefinition: {
            ...receipt.artifacts.taskDefinition,
            sha256: "F".repeat(64),
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeWindowsServiceInstallationReceipt({
        ...receipt,
        artifacts: {
          ...receipt.artifacts,
          launcher: { ...receipt.artifacts.launcher, path: "C:\\Temp\\run-daemon.vbs" },
        },
      }),
    ).toThrow();
  });

  it("rejects missing, duplicate, attached, or mismatched installation nonces", () => {
    const nonceIndex = expectedArgv.indexOf("--service-installation-nonce");
    const withoutNonce = expectedArgv.filter(
      (_argument, index) => index !== nonceIndex && index !== nonceIndex + 1,
    );
    const invalidArgv = [
      withoutNonce,
      [...expectedArgv, "--service-installation-nonce", nonce],
      [...withoutNonce, `--service-installation-nonce=${nonce}`],
      replaceFlagValue(expectedArgv, "--service-installation-nonce", "B".repeat(43)),
    ];

    for (const argv of invalidArgv) {
      expect(() =>
        createWindowsServiceInstallationReceipt({ ...creationInput, expectedArgv: argv }),
      ).toThrow();
    }
  });

  it("rejects wrong daemon, supervision, owner, port, host, and mode arguments", () => {
    const daemonIndex = executableArgsPrefix.length;
    const invalidArgv = [
      expectedArgv.map((argument, index) => (index === daemonIndex ? "status" : argument)),
      expectedArgv.slice(1),
      expectedArgv.filter((argument) => argument !== "--supervised"),
      replaceFlagValue(expectedArgv, "--owner", "cli"),
      replaceFlagValue(expectedArgv, "--port", "9000"),
      replaceFlagValue(expectedArgv, "--hostname", "0.0.0.0"),
      replaceFlagValue(expectedArgv, "--runtime-mode", "dev-server"),
    ];

    for (const argv of invalidArgv) {
      expect(() =>
        createWindowsServiceInstallationReceipt({ ...creationInput, expectedArgv: argv }),
      ).toThrow();
    }
  });

  it("matches canonical Windows paths in receipt fields and argv", () => {
    const receipt = createWindowsServiceInstallationReceipt(creationInput);
    const equivalentIdentity: WindowsServiceInstallationIdentity = {
      ...identity,
      argv: expectedArgv.map((argument) =>
        argument === executableArgsPrefix[0]
          ? "c:/program files/selftune/CLI/selftune.ts"
          : argument === "C:\\Program Files\\SelfTune\\dashboard"
            ? "c:/program files/selftune/dashboard/"
            : argument,
      ),
      configDir: "c:/users/test/.SELFTUNE/",
      executablePath: "c:/PROGRAM FILES/selftune/SELFTUNE.exe",
      userSid: creationInput.userSid.toLowerCase(),
    };

    expect(matchWindowsServiceInstallation(receipt, equivalentIdentity)).toEqual({
      matches: true,
    });
    expect(
      canonicalWindowsArgvIdentity(equivalentIdentity.argv, receipt.executableArgsPrefix),
    ).toEqual(canonicalWindowsArgvIdentity(receipt.expectedArgv, receipt.executableArgsPrefix));
  });

  it("does not normalize absolute-looking values at arbitrary argv positions", () => {
    const receipt = createWindowsServiceInstallationReceipt({
      ...creationInput,
      expectedArgv: [...expectedArgv, "--label", "C:\\Build\\Release"],
    });
    const observedArgv = [...expectedArgv, "--label", "c:/build/release"];

    expect(canonicalWindowsArgvIdentity(observedArgv, receipt.executableArgsPrefix)).toContain(
      "c:/build/release",
    );
    expect(matchWindowsServiceInstallation(receipt, { ...identity, argv: observedArgv })).toEqual({
      matches: false,
      reason: "argv-mismatch",
    });
  });

  it("reports task, SID, config, owner, port, executable, and argv mismatches", () => {
    const receipt = createWindowsServiceInstallationReceipt(creationInput);
    const cases: ReadonlyArray<{
      readonly identity: WindowsServiceInstallationIdentity;
      readonly reason: WindowsServiceInstallationMismatch;
    }> = [
      { identity: { ...identity, taskName: "ForeignTask" }, reason: "task-name-mismatch" },
      { identity: { ...identity, userSid: "S-1-5-21-9999" }, reason: "user-sid-mismatch" },
      { identity: { ...identity, configDir: "C:\\Other" }, reason: "config-dir-mismatch" },
      { identity: { ...identity, owner: "cli" }, reason: "owner-mismatch" },
      { identity: { ...identity, port: 9000 }, reason: "port-mismatch" },
      {
        identity: { ...identity, executablePath: "C:\\Other\\selftune.exe" },
        reason: "executable-path-mismatch",
      },
      { identity: { ...identity, argv: [...expectedArgv, "--extra"] }, reason: "argv-mismatch" },
    ];

    for (const entry of cases) {
      expect(matchWindowsServiceInstallation(receipt, entry.identity)).toEqual({
        matches: false,
        reason: entry.reason,
      });
    }
  });

  it("reports observed nonce and required-service argv tampering precisely", () => {
    const receipt = createWindowsServiceInstallationReceipt(creationInput);
    const nonceIndex = expectedArgv.indexOf("--service-installation-nonce");
    const withoutNonce = expectedArgv.filter(
      (_argument, index) => index !== nonceIndex && index !== nonceIndex + 1,
    );

    expect(matchWindowsServiceInstallation(receipt, { ...identity, argv: withoutNonce })).toEqual({
      matches: false,
      reason: "installation-nonce-missing",
    });
    expect(
      matchWindowsServiceInstallation(receipt, {
        ...identity,
        argv: [...expectedArgv, "--service-installation-nonce", nonce],
      }),
    ).toEqual({ matches: false, reason: "installation-nonce-duplicate" });
    expect(
      matchWindowsServiceInstallation(receipt, {
        ...identity,
        argv: replaceFlagValue(expectedArgv, "--service-installation-nonce", "B".repeat(43)),
      }),
    ).toEqual({ matches: false, reason: "installation-nonce-mismatch" });
    expect(
      matchWindowsServiceInstallation(receipt, {
        ...identity,
        argv: replaceFlagValue(expectedArgv, "--hostname", "0.0.0.0"),
      }),
    ).toEqual({ matches: false, reason: "required-service-argv-mismatch" });
  });
});
