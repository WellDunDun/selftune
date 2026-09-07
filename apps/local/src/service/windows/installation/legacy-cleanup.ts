import { isDeepStrictEqual } from "node:util";
import { win32 } from "node:path";

import * as Schema from "effect/Schema";

import { canonicalWindowsPathIdentity, type WindowsServiceInstallationArtifacts } from "./model.js";

export const WINDOWS_SERVICE_LEGACY_CLEANUP_FILENAME = "windows-service-legacy-cleanup.json";
export const WINDOWS_SERVICE_LEGACY_CLEANUP_KIND = "selftune-windows-legacy-cleanup";

const WindowsAbsolutePath = Schema.String.check(
  Schema.makeFilter((path) => win32.isAbsolute(path), {
    expected: "an absolute Windows path",
  }),
);
const WindowsUserSid = Schema.String.check(
  Schema.makeFilter((sid) => /^S-\d(?:-\d+)+$/.test(sid) && sid === sid.toUpperCase(), {
    expected: "a canonical uppercase Windows user SID",
  }),
);
const CanonicalIsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { expected: "a canonical ISO 8601 UTC timestamp" },
  ),
);
const Sha256Hex = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    expected: "a lowercase 64-character SHA-256 digest",
  }),
);
const ServicePort = Schema.Number.check(
  Schema.makeFilter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535, {
    expected: "a valid TCP service port",
  }),
);
const Artifact = Schema.Struct({
  path: WindowsAbsolutePath,
  sha256: Sha256Hex,
});
const Artifacts = Schema.Struct({
  launcher: Artifact,
  taskDefinition: Artifact,
  wrapper: Artifact,
});
const RuntimeIdentity = Schema.Struct({
  configDir: WindowsAbsolutePath,
  executablePath: WindowsAbsolutePath,
  owner: Schema.Literals(["desktop", "cli"]),
  port: ServicePort,
});

class WindowsServiceLegacyCleanupJournalModel extends Schema.Class<WindowsServiceLegacyCleanupJournalModel>(
  "WindowsServiceLegacyCleanupJournal",
)({
  artifacts: Artifacts,
  boot: Schema.Boolean,
  cleanupId: Schema.String.check(Schema.isUUID(4)),
  configDir: WindowsAbsolutePath,
  createdAt: CanonicalIsoTimestamp,
  initiatedBy: Schema.Literals(["install", "uninstall"]),
  kind: Schema.Literal(WINDOWS_SERVICE_LEGACY_CLEANUP_KIND),
  runtimeIdentity: RuntimeIdentity,
  taskName: Schema.Literal("SelfTuneDaemon"),
  userSid: WindowsUserSid,
  version: Schema.Literal(1),
  wscriptPath: Schema.Literal("wscript.exe"),
}) {}

function validJournalPaths(journal: WindowsServiceLegacyCleanupJournalModel): boolean {
  const configIdentity = canonicalWindowsPathIdentity(journal.configDir);
  if (
    configIdentity === null ||
    canonicalWindowsPathIdentity(journal.runtimeIdentity.configDir) !== configIdentity
  ) {
    return false;
  }
  const controlDir = win32.join(journal.configDir, "server-control");
  const expected = {
    launcher: canonicalWindowsPathIdentity(win32.join(controlDir, "run-daemon.vbs")),
    taskDefinition: canonicalWindowsPathIdentity(win32.join(controlDir, "run-daemon.xml")),
    wrapper: canonicalWindowsPathIdentity(win32.join(controlDir, "run-daemon.cmd")),
  };
  return (
    canonicalWindowsPathIdentity(journal.artifacts.launcher.path) === expected.launcher &&
    canonicalWindowsPathIdentity(journal.artifacts.taskDefinition.path) ===
      expected.taskDefinition &&
    canonicalWindowsPathIdentity(journal.artifacts.wrapper.path) === expected.wrapper
  );
}

export const WindowsServiceLegacyCleanupJournalSchema =
  WindowsServiceLegacyCleanupJournalModel.check(
    Schema.makeFilter(validJournalPaths, {
      expected: "a fixed-name legacy SelfTune installation under the journal config directory",
    }),
  );

export type WindowsServiceLegacyCleanupJournal =
  typeof WindowsServiceLegacyCleanupJournalSchema.Type;

export interface WindowsServiceLegacyCleanupJournalInput {
  readonly artifacts: WindowsServiceInstallationArtifacts;
  readonly boot: boolean;
  readonly configDir: string;
  readonly initiatedBy: "install" | "uninstall";
  readonly runtimeIdentity: {
    readonly configDir: string;
    readonly executablePath: string;
    readonly owner: "desktop" | "cli";
    readonly port: number;
  };
  readonly taskName: "SelfTuneDaemon";
  readonly userSid: string;
  readonly wscriptPath: "wscript.exe";
}

export type WindowsServiceLegacyCleanupExpectation =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Present";
      readonly journal: WindowsServiceLegacyCleanupJournal;
    };
export type PresentWindowsServiceLegacyCleanupExpectation = Extract<
  WindowsServiceLegacyCleanupExpectation,
  { readonly _tag: "Present" }
>;

export function expectAbsentWindowsServiceLegacyCleanup(): WindowsServiceLegacyCleanupExpectation {
  return { _tag: "Absent" };
}

export function expectWindowsServiceLegacyCleanup(
  journal: WindowsServiceLegacyCleanupJournal,
): PresentWindowsServiceLegacyCleanupExpectation {
  return { _tag: "Present", journal };
}

export function matchesWindowsServiceLegacyCleanupExpectation(
  journal: WindowsServiceLegacyCleanupJournal | null,
  expectation: WindowsServiceLegacyCleanupExpectation,
): boolean {
  return expectation._tag === "Absent"
    ? journal === null
    : journal !== null && isDeepStrictEqual(journal, expectation.journal);
}

export function createWindowsServiceLegacyCleanupJournal(
  input: WindowsServiceLegacyCleanupJournalInput,
  metadata: { readonly cleanupId: string; readonly createdAt: string },
): WindowsServiceLegacyCleanupJournal {
  return Schema.decodeUnknownSync(WindowsServiceLegacyCleanupJournalSchema)({
    ...input,
    ...metadata,
    kind: WINDOWS_SERVICE_LEGACY_CLEANUP_KIND,
    version: 1,
  });
}

export const decodeWindowsServiceLegacyCleanupJournal = Schema.decodeUnknownSync(
  WindowsServiceLegacyCleanupJournalSchema,
);

export function windowsServiceLegacyCleanupPath(configDir: string): string {
  if (!win32.isAbsolute(configDir)) {
    throw new Error("Windows legacy cleanup journal requires an absolute config path.");
  }
  return win32.join(
    win32.normalize(configDir),
    "server-control",
    WINDOWS_SERVICE_LEGACY_CLEANUP_FILENAME,
  );
}
