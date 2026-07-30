import { Buffer } from "node:buffer";

import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  expectAbsentWindowsServiceInstallationReceipt,
  expectWindowsServiceInstallationReceipt,
  makeWindowsServiceInstallationStore,
  parseLocalAppDataOutput,
  parseResolvedWindowsAccountSid,
  parseWhoamiUserCsv,
  type WindowsInstallationCommandResult,
  type WindowsInstallationFileSystem,
  type WindowsServiceInstallationReceiptInput,
} from "@selftune/local/service/windows/installation/store";
import {
  createWindowsServiceInstallationReceipt,
  sha256Hex,
  type WindowsServiceInstallationReceipt,
  windowsServiceInstallationReceiptPath,
} from "@selftune/local/service/windows/installation/model";

const configDir = "C:\\Users\\Test\\.selftune";
const userSid = "S-1-5-21-1000-2000-3000-4000";
const localAppData = "C:\\Users\\Test\\AppData\\Local";
const userServiceControlDir = "c:\\users\\test\\appdata\\local\\selftune\\service-control";
const receiptPath = windowsServiceInstallationReceiptPath(configDir);
const serverControlDir = "C:\\Users\\Test\\.selftune\\server-control";
const replacementInstallId = "20202020-2020-4020-9020-202020202020";
const successorInstallId = "30303030-3030-4030-8030-303030303030";
const replacementNonce = "replacementNonce_abcdefghijklmnopqrstuvwxyz123";
const successorNonce = "successorNonce_abcdefghijklmnopqrstuvwxyz12345";
const input: WindowsServiceInstallationReceiptInput = {
  artifacts: {
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
  },
  boot: true,
  configDir,
  executableArgsPrefix: ["C:\\SelfTune\\selftune.ts"],
  executablePath: "C:\\Program Files\\Bun\\bun.exe",
  expectedArgvWithoutNonce: [
    "C:\\SelfTune\\selftune.ts",
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
  ],
  owner: "desktop",
  port: 7888,
  taskName: "SelfTuneDaemon",
};

interface HarnessOptions {
  readonly accountSidCode?: number;
  readonly accountSidOutput?: string;
  readonly aclCode?: number;
  readonly aclOutput?: string;
  readonly invalidRandomLength?: boolean;
  readonly localAppDataCode?: number;
  readonly localAppDataOutput?: string;
  readonly receiptRemoveFailure?: boolean;
  readonly replaceReceiptAfterRename?: string;
  readonly replaceReceiptBeforeGenerationRead?: string;
  readonly renameFailure?: boolean;
  readonly whoamiCode?: number;
  readonly whoamiOutput?: string;
}

function commandResult(code = 0, stdout = "", stderr = ""): WindowsInstallationCommandResult {
  return { code, stderr, stdout };
}

function installationHarness(options: HarnessOptions = {}) {
  const files = new Map<string, string>();
  const calls: Array<
    | {
        readonly args: ReadonlyArray<string>;
        readonly command: string;
        readonly type: "process";
      }
    | { readonly path: string; readonly type: "mkdir" | "remove" }
    | { readonly from: string; readonly to: string; readonly type: "rename" }
    | {
        readonly contents: string;
        readonly options: { readonly flag: "wx"; readonly mode: number };
        readonly path: string;
        readonly type: "write";
      }
  > = [];
  const randomLengths: number[] = [];
  let receiptReadReplaced = false;
  const fileSystem: WindowsInstallationFileSystem = {
    makeDirectory: (path) =>
      Effect.sync(() => {
        calls.push({ path, type: "mkdir" });
      }),
    readUtf8File: (path) =>
      Effect.sync(() => {
        if (
          path === receiptPath &&
          !receiptReadReplaced &&
          options.replaceReceiptBeforeGenerationRead !== undefined
        ) {
          receiptReadReplaced = true;
          files.set(path, options.replaceReceiptBeforeGenerationRead);
        }
        return files.get(path) ?? null;
      }),
    removeFile: (path) =>
      Effect.try({
        try: () => {
          calls.push({ path, type: "remove" });
          if (options.receiptRemoveFailure && path === receiptPath) {
            throw new Error("remove denied");
          }
          files.delete(path);
        },
        catch: (cause) => cause,
      }),
    rename: (from, to) =>
      Effect.try({
        try: () => {
          calls.push({ from, to, type: "rename" });
          if (options.renameFailure) throw new Error("rename denied");
          const contents = files.get(from);
          if (contents === undefined) throw new Error("missing temp file");
          files.set(to, contents);
          files.delete(from);
          if (to === receiptPath && options.replaceReceiptAfterRename !== undefined) {
            files.set(to, options.replaceReceiptAfterRename);
          }
        },
        catch: (cause) => cause,
      }),
    writeUtf8File: (path, contents, writeOptions) =>
      Effect.try({
        try: () => {
          calls.push({ contents, options: writeOptions, path, type: "write" });
          if (files.has(path)) throw new Error("exclusive create failed");
          files.set(path, contents);
        },
        catch: (cause) => cause,
      }),
  };
  const store = makeWindowsServiceInstallationStore({
    clock: { now: () => Effect.succeed(new Date("2026-07-16T12:30:00.000Z")) },
    fileSystem,
    process: {
      execute: (command, args) =>
        Effect.sync(() => {
          calls.push({ args, command, type: "process" });
          if (command.endsWith("whoami.exe")) {
            return commandResult(
              options.whoamiCode ?? 0,
              options.whoamiOutput ?? `"WORKGROUP\\Test","${userSid}"\r\n`,
              options.whoamiCode ? "whoami denied" : "",
            );
          }
          const commandIndex = args.indexOf("-Command");
          const script = commandIndex >= 0 ? (args[commandIndex + 1] ?? "") : "";
          if (script.includes("SELFTUNE_RESOLVED_ACCOUNT_SID_V1:")) {
            return commandResult(
              options.accountSidCode ?? 0,
              options.accountSidOutput ?? `SELFTUNE_RESOLVED_ACCOUNT_SID_V1:${userSid}\r\n`,
              options.accountSidCode ? "account lookup denied" : "",
            );
          }
          if (script.includes("LocalApplicationData")) {
            return commandResult(
              options.localAppDataCode ?? 0,
              options.localAppDataOutput ??
                `SELFTUNE_LOCAL_APP_DATA_V1:${Buffer.from(localAppData, "utf8").toString("base64")}\r\n`,
              options.localAppDataCode ? "known folder denied" : "",
            );
          }
          return commandResult(
            options.aclCode ?? 0,
            options.aclOutput ?? "SELFTUNE_ACL_VERIFIED_V1\r\n",
            options.aclCode ? "acl denied" : "",
          );
        }),
    },
    random: {
      bytes: (length) =>
        Effect.sync(() => {
          randomLengths.push(length);
          return new Uint8Array(options.invalidRandomLength ? length - 1 : length).fill(length);
        }),
    },
    systemRoot: "D:\\Windows",
  });
  return { calls, files, randomLengths, store };
}

function withGeneration(
  receipt: WindowsServiceInstallationReceipt,
  installId: string,
  nonce: string,
): WindowsServiceInstallationReceipt {
  return createWindowsServiceInstallationReceipt({
    ...receipt,
    expectedArgv: [...receipt.expectedArgv.slice(0, -1), nonce],
    installId,
    nonce,
  });
}

describe("Windows service installation store", () => {
  it("parses only one unambiguous base64 LocalApplicationData record", () => {
    const encoded = Buffer.from(localAppData, "utf8").toString("base64");
    expect(parseLocalAppDataOutput(`SELFTUNE_LOCAL_APP_DATA_V1:${encoded}\r\n`)).toBe(localAppData);
    expect(parseLocalAppDataOutput(`noise\nSELFTUNE_LOCAL_APP_DATA_V1:${encoded}`)).toBeNull();
    expect(parseLocalAppDataOutput("SELFTUNE_LOCAL_APP_DATA_V1:not base64")).toBeNull();
    expect(parseLocalAppDataOutput("SELFTUNE_LOCAL_APP_DATA_V1:")).toBeNull();
  });

  it("parses the structured whoami CSV record and rejects ambiguous output", () => {
    expect(parseWhoamiUserCsv(`\ufeff"DOMAIN\\Doe, Jane","${userSid}"\r\n`)).toBe(userSid);
    expect(parseWhoamiUserCsv(`"DOMAIN\\Doe ""JJ""","${userSid}"`)).toBe(userSid);
    expect(parseWhoamiUserCsv(`"DOMAIN\\User","not-a-sid"`)).toBeNull();
    expect(
      parseWhoamiUserCsv(`"DOMAIN\\User","${userSid}"\n"OTHER\\User","S-1-5-21-2"`),
    ).toBeNull();
    expect(parseWhoamiUserCsv(`"unterminated,${userSid}`)).toBeNull();
    expect(parseResolvedWindowsAccountSid(`SELFTUNE_RESOLVED_ACCOUNT_SID_V1:${userSid}\r\n`)).toBe(
      userSid,
    );
    expect(parseResolvedWindowsAccountSid("noise")).toBeNull();
  });

  it("resolves whoami from System32 and fails closed on command or parse errors", async () => {
    const valid = installationHarness();
    await expect(Effect.runPromise(valid.store.resolveCurrentUserSid())).resolves.toBe(userSid);
    const resolveWindowsAccountSid = valid.store.resolveWindowsAccountSid;
    if (resolveWindowsAccountSid === undefined) {
      throw new Error("Expected the live store to resolve Windows account identifiers.");
    }
    await expect(Effect.runPromise(resolveWindowsAccountSid("runneradmin"))).resolves.toBe(userSid);
    expect(valid.calls[0]).toEqual({
      args: ["/user", "/fo", "csv", "/nh"],
      command: "D:\\Windows\\System32\\whoami.exe",
      type: "process",
    });
    const accountResolution = valid.calls[1];
    expect(accountResolution?.type).toBe("process");
    if (accountResolution?.type !== "process") {
      throw new Error("Expected a Windows account-resolution process call.");
    }
    expect(accountResolution.args.at(-1)).toContain(
      Buffer.from("runneradmin", "utf8").toString("base64"),
    );
    expect(accountResolution.args.join(" ")).not.toContain("runneradmin");

    const unknownAccount = installationHarness({ accountSidCode: 1 });
    const resolveUnknownAccount = unknownAccount.store.resolveWindowsAccountSid;
    if (resolveUnknownAccount === undefined) {
      throw new Error("Expected the live store to resolve Windows account identifiers.");
    }
    await expect(Effect.runPromise(resolveUnknownAccount("unknown"))).resolves.toBeNull();

    const malformedAccount = installationHarness({ accountSidOutput: "unstructured" });
    const resolveMalformedAccount = malformedAccount.store.resolveWindowsAccountSid;
    if (resolveMalformedAccount === undefined) {
      throw new Error("Expected the live store to resolve Windows account identifiers.");
    }
    await expect(Effect.runPromise(resolveMalformedAccount("runneradmin"))).rejects.toMatchObject({
      operation: "resolve-windows-account-sid",
    });
    await expect(
      Effect.runPromise(resolveWindowsAccountSid(`${userSid.toLowerCase()}`)),
    ).resolves.toBe(userSid);
    await expect(Effect.runPromise(resolveWindowsAccountSid("bad\naccount"))).resolves.toBeNull();

    const denied = installationHarness({ whoamiCode: 5 });
    await expect(Effect.runPromise(denied.store.createReceipt(input))).rejects.toMatchObject({
      operation: "resolve-user-sid",
    });
    expect(denied.randomLengths).toEqual([]);

    const malformed = installationHarness({
      whoamiOutput: "localized free-form text",
    });
    await expect(Effect.runPromise(malformed.store.createReceipt(input))).rejects.toMatchObject({
      operation: "resolve-user-sid",
    });
  });

  it("creates deterministic schema-validated identity fields through clock and random seams", async () => {
    const test = installationHarness();
    const receipt = await Effect.runPromise(test.store.createReceipt(input));

    expect(test.randomLengths).toEqual([16, 32]);
    expect(receipt).toMatchObject({
      artifacts: input.artifacts,
      boot: true,
      installId: "10101010-1010-4010-9010-101010101010",
      installedAt: "2026-07-16T12:30:00.000Z",
      userSid,
    });
    expect(receipt.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receipt.expectedArgv.slice(-2)).toEqual(["--service-installation-nonce", receipt.nonce]);

    const invalidRandom = installationHarness({ invalidRandomLength: true });
    await expect(Effect.runPromise(invalidRandom.store.createReceipt(input))).rejects.toMatchObject(
      { operation: "create-receipt" },
    );
  });

  it("hardens server-control for the current SID and SYSTEM before an atomic write", async () => {
    const test = installationHarness();
    const receipt = await Effect.runPromise(
      test.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
    );
    const temporaryPath = `${receiptPath}.${receipt.installId}.tmp`;

    expect(test.calls.slice(0, 2)).toEqual([
      {
        args: ["/user", "/fo", "csv", "/nh"],
        command: "D:\\Windows\\System32\\whoami.exe",
        type: "process",
      },
      { path: "C:\\Users\\Test\\.selftune\\server-control", type: "mkdir" },
    ]);
    expect(test.calls[2]).toMatchObject({
      command: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      type: "process",
    });
    const aclCall = test.calls[2];
    expect(aclCall?.type).toBe("process");
    if (aclCall?.type !== "process") throw new Error("Expected ACL process call.");
    expect(aclCall.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(aclCall.args[5]).toBe("-Command");
    expect(aclCall.args[6]).toContain(Buffer.from(serverControlDir, "utf8").toString("base64"));
    expect(aclCall.args[6]).toContain(userSid);
    expect(aclCall.args[6]).toContain("ReparsePoint");
    expect(aclCall.args[6]).toContain("AreAccessRulesProtected");
    expect(aclCall.args[6]).toContain("GetAccessRules");
    expect(aclCall.args[6]).toContain(
      "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1",
    );
    expect(aclCall.args[6]).toContain(
      "Import-Module -Name $securityModule -Force -ErrorAction Stop",
    );
    expect(aclCall.args[6]?.indexOf("Import-Module")).toBeLessThan(
      aclCall.args[6]?.indexOf("Set-Acl") ?? -1,
    );
    expect(test.calls.slice(3)).toEqual([
      {
        contents: `${JSON.stringify(receipt)}\n`,
        options: { flag: "wx", mode: 0o600 },
        path: temporaryPath,
        type: "write",
      },
      { from: temporaryPath, to: receiptPath, type: "rename" },
    ]);
    expect(test.files.has(temporaryPath)).toBe(false);
    await expect(Effect.runPromise(test.store.readReceipt(configDir))).resolves.toEqual(receipt);
  });

  it("prepares the protected server-control root before external artifact writes", async () => {
    const test = installationHarness();

    await expect(Effect.runPromise(test.store.prepareServerControl(configDir))).resolves.toBe(
      serverControlDir,
    );
    expect(test.calls.map((call) => call.type)).toEqual(["process", "mkdir", "process"]);
    expect(test.calls.some((call) => call.type === "write")).toBe(false);
  });

  it("prepares one SID-bound user-service scope independent of target config", async () => {
    const first = installationHarness();
    const second = installationHarness();

    const [firstScope, secondScope] = await Promise.all([
      Effect.runPromise(first.store.prepareUserServiceControl()),
      Effect.runPromise(second.store.prepareUserServiceControl()),
    ]);

    expect(firstScope).toEqual({
      controlDir: userServiceControlDir,
      namespace: "selftune-user-service-v1",
      userSid,
    });
    expect(secondScope).toEqual(firstScope);
    expect(first.calls.map((call) => call.type)).toEqual([
      "process",
      "process",
      "mkdir",
      "process",
    ]);
    const folderCall = first.calls[1];
    expect(folderCall?.type).toBe("process");
    if (folderCall?.type !== "process") throw new Error("Expected Known Folder process call.");
    expect(folderCall.command).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(folderCall.args.at(-1)).toContain("LocalApplicationData");
    expect(folderCall.args.at(-1)).not.toContain("$env:");
    const aclCall = first.calls[3];
    expect(aclCall?.type).toBe("process");
    if (aclCall?.type !== "process") throw new Error("Expected ACL process call.");
    expect(aclCall.args.at(-1)).toContain(
      Buffer.from(userServiceControlDir, "utf8").toString("base64"),
    );
    expect(aclCall.args.at(-1)).toContain(userSid);
  });

  it("resolves the fixed current-user service scope without creating state", async () => {
    const test = installationHarness();

    await expect(Effect.runPromise(test.store.resolveUserServiceControl())).resolves.toEqual({
      controlDir: userServiceControlDir,
      namespace: "selftune-user-service-v1",
      userSid,
    });
    expect(test.calls.map((call) => call.type)).toEqual(["process", "process"]);
    expect(test.calls.some((call) => call.type === "mkdir")).toBe(false);
  });

  it("fails closed on malformed or non-absolute Known Folder output", async () => {
    const cases = [
      "",
      "localized free-form text",
      "SELFTUNE_LOCAL_APP_DATA_V1:not-base64",
      `SELFTUNE_LOCAL_APP_DATA_V1:${Buffer.from("relative\\path", "utf8").toString("base64")}`,
    ];

    const results = await Promise.all(
      cases.map(async (localAppDataOutput) => {
        const test = installationHarness({ localAppDataOutput });
        const failure = await Effect.runPromise(
          Effect.flip(test.store.prepareUserServiceControl()),
        );
        return { calls: test.calls, failure };
      }),
    );

    for (const result of results) {
      expect(result.failure).toMatchObject({ operation: "resolve-local-app-data" });
      expect(result.calls.some((call) => call.type === "mkdir")).toBe(false);
    }

    const denied = installationHarness({ localAppDataCode: 5 });
    await expect(Effect.runPromise(denied.store.prepareUserServiceControl())).rejects.toMatchObject(
      { operation: "resolve-local-app-data" },
    );
    expect(denied.calls.some((call) => call.type === "mkdir")).toBe(false);
  });

  it("fails closed when user-service ACL or reparse verification fails", async () => {
    const denied = installationHarness({ aclCode: 5 });
    await expect(Effect.runPromise(denied.store.prepareUserServiceControl())).rejects.toMatchObject(
      { operation: "harden-user-service-control-acl" },
    );

    const reparse = installationHarness({ aclCode: 42 });
    await expect(
      Effect.runPromise(reparse.store.prepareUserServiceControl()),
    ).rejects.toMatchObject({
      message: expect.stringContaining("exit 42"),
      operation: "harden-user-service-control-acl",
    });
  });

  it("fails closed before writing when ACL hardening fails", async () => {
    const test = installationHarness({ aclCode: 5 });

    await expect(
      Effect.runPromise(
        test.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
      ),
    ).rejects.toMatchObject({ operation: "harden-server-control-acl" });
    expect(test.calls.some((call) => call.type === "write")).toBe(false);
    expect(test.files.has(receiptPath)).toBe(false);
  });

  it("rejects a reparse-point server-control root reported by the ACL verifier", async () => {
    const test = installationHarness({ aclCode: 42 });

    await expect(
      Effect.runPromise(test.store.prepareServerControl(configDir)),
    ).rejects.toMatchObject({
      message: expect.stringContaining("exit 42"),
      operation: "harden-server-control-acl",
    });
    expect(test.calls.some((call) => call.type === "write")).toBe(false);
  });

  it("fails closed when ACL execution succeeds without read-back verification", async () => {
    const test = installationHarness({ aclOutput: "" });

    await expect(
      Effect.runPromise(test.store.prepareServerControl(configDir)),
    ).rejects.toMatchObject({
      operation: "verify-server-control-acl",
    });
    expect(test.calls.some((call) => call.type === "write")).toBe(false);
  });

  it("refuses to write a receipt owned by a different current user SID", async () => {
    const source = installationHarness();
    const receipt = await Effect.runPromise(source.store.createReceipt(input));
    const foreignUser = installationHarness({
      whoamiOutput: '"WORKGROUP\\Other","S-1-5-21-9000-8000-7000-6000"',
    });

    await expect(
      Effect.runPromise(
        foreignUser.store.writeReceipt(receipt, expectAbsentWindowsServiceInstallationReceipt()),
      ),
    ).rejects.toMatchObject({ operation: "verify-receipt-user-sid" });
    expect(foreignUser.calls.some((call) => call.type === "mkdir" || call.type === "write")).toBe(
      false,
    );
  });

  it("decodes receipts through the checked schema and rejects corrupt persisted data", async () => {
    const test = installationHarness();
    await expect(Effect.runPromise(test.store.readReceipt(configDir))).resolves.toBeNull();
    test.files.set(receiptPath, '{"kind":"forged"}');

    await expect(Effect.runPromise(test.store.readReceipt(configDir))).rejects.toMatchObject({
      operation: "decode-receipt",
    });

    const receipt = await Effect.runPromise(test.store.createReceipt(input));
    test.files.set(
      receiptPath,
      JSON.stringify({
        ...receipt,
        artifacts: {
          ...receipt.artifacts,
          wrapper: { ...receipt.artifacts.wrapper, sha256: "F".repeat(64) },
        },
      }),
    );
    await expect(Effect.runPromise(test.store.readReceipt(configDir))).rejects.toMatchObject({
      operation: "decode-receipt",
    });
    await expect(Effect.runPromise(test.store.readReceipt("relative"))).rejects.toMatchObject({
      operation: "resolve-receipt-path",
    });
  });

  it("keeps an existing receipt when promotion fails and removes only the temp file", async () => {
    const original = installationHarness();
    const receipt = await Effect.runPromise(
      original.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
    );
    const replacement = installationHarness({ renameFailure: true });
    replacement.files.set(receiptPath, original.files.get(receiptPath) ?? "");

    await expect(
      Effect.runPromise(
        replacement.store.writeReceipt(receipt, expectWindowsServiceInstallationReceipt(receipt)),
      ),
    ).rejects.toMatchObject({ operation: "promote-receipt" });
    expect(replacement.files.get(receiptPath)).toBe(original.files.get(receiptPath));
    expect(
      [...replacement.files.keys()].some((path) => path.endsWith(`.${receipt.installId}.tmp`)),
    ).toBe(false);
  });

  it("rejects a stale writer before promotion when the prior generation changed", async () => {
    const source = installationHarness();
    const prior = await Effect.runPromise(source.store.createReceipt(input));
    const replacement = withGeneration(prior, replacementInstallId, replacementNonce);
    const successor = withGeneration(prior, successorInstallId, successorNonce);
    const test = installationHarness({
      replaceReceiptBeforeGenerationRead: `${JSON.stringify(successor)}\n`,
    });
    test.files.set(receiptPath, `${JSON.stringify(prior)}\n`);

    await expect(
      Effect.runPromise(
        test.store.writeReceipt(replacement, expectWindowsServiceInstallationReceipt(prior)),
      ),
    ).rejects.toMatchObject({ operation: "verify-prior-receipt-generation" });
    expect(test.files.get(receiptPath)).toBe(`${JSON.stringify(successor)}\n`);
    expect(test.calls.some((call) => call.type === "rename")).toBe(false);
    expect([...test.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("treats every immutable receipt field as part of the persisted generation", async () => {
    const source = installationHarness();
    const prior = await Effect.runPromise(source.store.createReceipt(input));
    const drifted = { ...prior, installedAt: "2026-07-16T12:31:00.000Z" };
    const replacement = withGeneration(prior, replacementInstallId, replacementNonce);
    const test = installationHarness({
      replaceReceiptBeforeGenerationRead: `${JSON.stringify(drifted)}\n`,
    });
    test.files.set(receiptPath, `${JSON.stringify(prior)}\n`);

    await expect(
      Effect.runPromise(
        test.store.writeReceipt(replacement, expectWindowsServiceInstallationReceipt(prior)),
      ),
    ).rejects.toMatchObject({ operation: "verify-prior-receipt-generation" });
    expect(test.calls.some((call) => call.type === "rename")).toBe(false);
    expect(test.files.get(receiptPath)).toBe(`${JSON.stringify(drifted)}\n`);
  });

  it("detects a successor promoted after its own rename and leaves that generation intact", async () => {
    const source = installationHarness();
    const prior = await Effect.runPromise(source.store.createReceipt(input));
    const replacement = withGeneration(prior, replacementInstallId, replacementNonce);
    const successor = withGeneration(prior, successorInstallId, successorNonce);
    const test = installationHarness({
      replaceReceiptAfterRename: `${JSON.stringify(successor)}\n`,
    });
    test.files.set(receiptPath, `${JSON.stringify(prior)}\n`);

    await expect(
      Effect.runPromise(
        test.store.writeReceipt(replacement, expectWindowsServiceInstallationReceipt(prior)),
      ),
    ).rejects.toMatchObject({ operation: "verify-promoted-receipt-generation" });
    expect(test.files.get(receiptPath)).toBe(`${JSON.stringify(successor)}\n`);
    expect([...test.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("rejects a stale remover before cleanup touches installation artifacts", async () => {
    const source = installationHarness();
    const prior = await Effect.runPromise(source.store.createReceipt(input));
    const successor = withGeneration(prior, successorInstallId, successorNonce);
    const test = installationHarness();
    test.files.set(receiptPath, `${JSON.stringify(successor)}\n`);
    let cleanupStarted = false;

    await expect(
      Effect.runPromise(
        test.store.removeReceiptAfterCleanup(
          configDir,
          expectWindowsServiceInstallationReceipt(prior),
          Effect.sync(() => {
            cleanupStarted = true;
          }),
        ),
      ),
    ).rejects.toMatchObject({ operation: "verify-receipt-generation-before-cleanup" });
    expect(cleanupStarted).toBe(false);
    expect(test.files.get(receiptPath)).toBe(`${JSON.stringify(successor)}\n`);
    expect(test.calls.some((call) => call.type === "remove" && call.path === receiptPath)).toBe(
      false,
    );
  });

  it("rejects a stale remover when cleanup observes a newer generation", async () => {
    const test = installationHarness();
    const prior = await Effect.runPromise(
      test.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
    );
    const successor = withGeneration(prior, successorInstallId, successorNonce);

    await expect(
      Effect.runPromise(
        test.store.removeReceiptAfterCleanup(
          configDir,
          expectWindowsServiceInstallationReceipt(prior),
          Effect.sync(() => {
            test.files.set(receiptPath, `${JSON.stringify(successor)}\n`);
          }),
        ),
      ),
    ).rejects.toMatchObject({ operation: "verify-receipt-generation-before-remove" });
    expect(test.files.get(receiptPath)).toBe(`${JSON.stringify(successor)}\n`);
    expect(test.calls.some((call) => call.type === "remove" && call.path === receiptPath)).toBe(
      false,
    );
  });

  it("preserves the receipt when cleanup fails and removes it only after cleanup succeeds", async () => {
    const test = installationHarness();
    const receipt = await Effect.runPromise(
      test.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
    );
    class CleanupFailure extends Error {}

    await expect(
      Effect.runPromise(
        test.store.removeReceiptAfterCleanup(
          configDir,
          expectWindowsServiceInstallationReceipt(receipt),
          Effect.fail(new CleanupFailure("task cleanup failed")),
        ),
      ),
    ).rejects.toBeInstanceOf(CleanupFailure);
    expect(test.files.has(receiptPath)).toBe(true);
    expect(test.calls.some((call) => call.type === "remove" && call.path === receiptPath)).toBe(
      false,
    );

    await Effect.runPromise(
      test.store.removeReceiptAfterCleanup(
        configDir,
        expectWindowsServiceInstallationReceipt(receipt),
        Effect.void,
      ),
    );
    expect(test.files.has(receiptPath)).toBe(false);

    const denied = installationHarness({ receiptRemoveFailure: true });
    const deniedReceipt = await Effect.runPromise(
      denied.store.persistReceipt(input, expectAbsentWindowsServiceInstallationReceipt()),
    );
    await expect(
      Effect.runPromise(
        denied.store.removeReceiptAfterCleanup(
          configDir,
          expectWindowsServiceInstallationReceipt(deniedReceipt),
          Effect.void,
        ),
      ),
    ).rejects.toMatchObject({ operation: "remove-receipt" });
    expect(denied.files.has(receiptPath)).toBe(true);
  });
});
