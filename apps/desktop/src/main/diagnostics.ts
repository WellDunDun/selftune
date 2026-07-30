import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as Sentry from "@sentry/electron/main";
import { app, crashReporter, dialog, shell } from "electron";
import log from "electron-log/main.js";

declare const __SELFTUNE_SENTRY_DSN__: string;

const sentryDsn =
  typeof __SELFTUNE_SENTRY_DSN__ === "string"
    ? __SELFTUNE_SENTRY_DSN__
    : (process.env.SELFTUNE_DESKTOP_SENTRY_DSN ?? "");
const doNotTrack =
  process.env.DO_NOT_TRACK === "1" || process.env.DO_NOT_TRACK?.toLowerCase() === "true";
export function hasExplicitNativeCrashConsent(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isUnavailableLogStream(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "EIO" || cause.code === "EPIPE")
  );
}

const nativeCrashConsent = hasExplicitNativeCrashConsent(
  process.env.SELFTUNE_DESKTOP_NATIVE_CRASH_REPORTING,
);

export const errorReportingEnabled = sentryDsn.length > 0 && !doNotTrack;
export const nativeCrashReportingEnabled = errorReportingEnabled && nativeCrashConsent;
export const diagnosticsRunId = randomUUID().replaceAll("-", "").slice(0, 12);

export interface PreparedDiagnosticsEntry {
  readonly name: string;
  readonly inputBytes: number;
  readonly text: string;
}

export interface PrepareDiagnosticsOptions {
  readonly desktopLogDir: string;
  readonly daemonLogDir: string;
  readonly configDir: string;
  readonly homeDir?: string;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
}

interface DiagnosticsCandidate {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

const MAX_EXPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_EXPORT_FILES = 100;
const MAX_EXPORT_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const REDACTED_SECRET = "[REDACTED]";
const REDACTED_HOME = "[HOME]";
const REDACTED_CONFIG = "[CONFIG_DIR]";
const TEXT_LOG_SUFFIXES = [".jsonl", ".log", ".ndjson", ".txt"];
const NATIVE_CRASH_INTEGRATIONS = new Set(["ElectronMinidump", "SentryMinidump"]);

function isTextLogName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return TEXT_LOG_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function collectRecentLogFiles(
  directory: string,
  prefix: string,
  cutoff: number,
  maxFileBytes: number,
): DiagnosticsCandidate[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          return collectRecentLogFiles(path, `${prefix}/${entry.name}`, cutoff, maxFileBytes);
        }
        if (!entry.isFile() || !isTextLogName(entry.name)) return [];
        const info = statSync(path);
        if (info.size > maxFileBytes || info.mtimeMs < cutoff) return [];
        return [
          {
            name: `${prefix}/${entry.name}`,
            path,
            size: info.size,
            modifiedAt: info.mtimeMs,
          },
        ];
      });
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelySecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "dsn" ||
    normalized === "password" ||
    normalized === "passphrase" ||
    normalized === "privatekey" ||
    normalized === "clientsecret" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret")
  );
}

function pathRedactions(
  sensitivePaths: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  const [configDir, homeDir] = sensitivePaths;
  const replacements: Array<readonly [string, string]> = [];
  if (configDir) replacements.push([configDir, REDACTED_CONFIG]);
  if (homeDir) replacements.push([homeDir, REDACTED_HOME]);
  return replacements.sort((left, right) => right[0].length - left[0].length);
}

export function scrubDiagnosticText(value: string, sensitivePaths: readonly string[] = []): string {
  let scrubbed = value;
  for (const [path, replacement] of pathRedactions(sensitivePaths)) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(path), "gi"), replacement);
  }

  scrubbed = scrubbed
    .replace(/\/(?:Users|home)\/[^/\s"'<>),\]]+/gi, REDACTED_HOME)
    .replace(/[a-z]:\\Users\\[^\\\s"'<>),\]]+/gi, REDACTED_HOME)
    .replace(
      /\b(authorization|proxy-authorization)(["']?)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic)\s+[^\s,;}\]\r\n]+|[^\s,;}\]\r\n]+)/gi,
      `$1$2$3"${REDACTED_SECRET}"`,
    )
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED_SECRET}`)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passphrase|client[_-]?secret|secret|private[_-]?key|credential)(["']?)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi,
      `$1$2$3"${REDACTED_SECRET}"`,
    )
    .replace(
      /\b(?:sk-[a-z0-9_-]{8,}|github_pat_[a-z0-9_]{8,}|gh[pousr]_[a-z0-9_]{8,}|xox[a-z]-[a-z0-9-]{8,})\b/gi,
      REDACTED_SECRET,
    )
    .replace(/https?:\/\/[^@\s/]+@/gi, `https://${REDACTED_SECRET}@`);

  return scrubbed;
}

function scrubValue(
  value: unknown,
  sensitivePaths: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return scrubDiagnosticText(value, sensitivePaths);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, sensitivePaths, seen));
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    scrubbed[key] = isLikelySecretKey(key)
      ? REDACTED_SECRET
      : scrubValue(entry, sensitivePaths, seen);
  }
  return scrubbed;
}

export function scrubDiagnosticValue(
  value: unknown,
  sensitivePaths: readonly string[] = [],
): unknown {
  return scrubValue(value, sensitivePaths, new WeakSet());
}

function defaultSensitivePaths(): readonly string[] {
  let userData = "";
  try {
    userData = app.getPath("userData");
  } catch {
    // Electron may report an error before its user-data path is available.
  }
  return [userData, homedir()];
}

export function scrubSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const sensitivePaths = defaultSensitivePaths();
  for (const [key, value] of Object.entries(event)) {
    Reflect.set(
      event,
      key,
      isLikelySecretKey(key) ? REDACTED_SECRET : scrubValue(value, sensitivePaths, new WeakSet()),
    );
  }
  return event;
}

function decodeTextLog(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27) return null;
    }
    return text;
  } catch {
    return null;
  }
}

export async function prepareDiagnosticLogs(
  options: PrepareDiagnosticsOptions,
): Promise<PreparedDiagnosticsEntry[]> {
  const maxFileBytes = options.maxFileBytes ?? MAX_EXPORT_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_EXPORT_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? MAX_EXPORT_FILES;
  const cutoff = (options.nowMs ?? Date.now()) - (options.maxAgeMs ?? MAX_EXPORT_AGE_MS);
  const candidates = [
    ...collectRecentLogFiles(options.desktopLogDir, "desktop-logs", cutoff, maxFileBytes),
    ...collectRecentLogFiles(options.daemonLogDir, "daemon-logs", cutoff, maxFileBytes),
  ].sort(
    (left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name),
  );
  const { readFile } = await import("node:fs/promises");
  const entries: PreparedDiagnosticsEntry[] = [];
  let totalInputBytes = 0;

  for (const candidate of candidates) {
    if (entries.length >= maxFiles) break;
    if (candidate.size > maxTotalBytes - totalInputBytes) continue;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(candidate.path);
    } catch {
      continue;
    }
    if (bytes.byteLength > maxFileBytes || bytes.byteLength > maxTotalBytes - totalInputBytes) {
      continue;
    }
    const text = decodeTextLog(bytes);
    if (text === null) continue;
    totalInputBytes += bytes.byteLength;
    entries.push({
      name: candidate.name,
      inputBytes: bytes.byteLength,
      text: scrubDiagnosticText(text, [options.configDir, options.homeDir ?? homedir()]),
    });
  }

  return entries;
}

function exportStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function buildDiagnosticsManifest(): Record<string, unknown> {
  return {
    generated_at: new Date().toISOString(),
    run_id: diagnosticsRunId,
    app: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    architecture: process.arch,
    process_versions: process.versions,
    uptime_seconds: Math.round(process.uptime()),
    error_reporting_enabled: errorReportingEnabled,
    native_crash_reporting_enabled: nativeCrashReportingEnabled,
    included_sources: ["desktop text logs", "daemon text logs"],
    excluded_sources: ["native crash dumps", "direct skill files", "direct transcript files"],
    redaction: "Credentials, authorization headers, and local absolute path roots are removed.",
  };
}

export function logRuntimeEvent(
  level: "error" | "info" | "warn",
  message: string,
  details?: unknown,
): void {
  if (details === undefined) {
    log[level](message);
  } else {
    log[level](message, details);
  }
}

export function initializeDiagnostics(): void {
  log.initialize({ preload: true });
  log.transports.file.level = "info";
  const consoleTransport = log.transports.console;
  const writeToConsole = consoleTransport.writeFn;
  consoleTransport.writeFn = (input) => {
    try {
      writeToConsole(input);
    } catch (cause) {
      if (!isUnavailableLogStream(cause)) throw cause;
      consoleTransport.level = false;
    }
  };

  if (errorReportingEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      release: `selftune-desktop@${app.getVersion()}`,
      environment: app.isPackaged ? "production" : "development",
      sendDefaultPii: false,
      beforeSend: scrubSentryEvent,
      integrations: (integrations) =>
        nativeCrashReportingEnabled
          ? integrations
          : integrations.filter((integration) => !NATIVE_CRASH_INTEGRATIONS.has(integration.name)),
      initialScope: {
        tags: {
          platform: process.platform,
          architecture: process.arch,
          run_id: diagnosticsRunId,
        },
      },
    });
  }

  if (!nativeCrashReportingEnabled) {
    crashReporter.start({ uploadToServer: false, compress: true });
  }

  app.on("child-process-gone", (_event, details) => {
    log.error("[crash] child process gone", details);
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    log.error("[crash] renderer process gone", { url: webContents.getURL(), ...details });
  });
  log.errorHandler.startCatching({ showDialog: false });
}

export function reportRuntimeFailure(message: string, details?: unknown): void {
  log.error(message, details);
  if (errorReportingEnabled) {
    Sentry.captureMessage(scrubDiagnosticText(message, defaultSensitivePaths()), {
      level: "error",
      extra: { details: scrubDiagnosticValue(details, defaultSensitivePaths()) },
    });
  }
}

export async function exportDiagnostics(configDir: string): Promise<string> {
  const { TextReader, Uint8ArrayWriter, ZipWriter } = await import("@zip.js/zip.js");
  const { writeFile } = await import("node:fs/promises");

  const entries = await prepareDiagnosticLogs({
    desktopLogDir: dirname(log.transports.file.getFile().path),
    daemonLogDir: join(configDir, "logs"),
    configDir,
  });
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "manifest.json",
    new TextReader(JSON.stringify(buildDiagnosticsManifest(), null, 2)),
  );
  for (const entry of entries) {
    await writer.add(entry.name, new TextReader(entry.text));
  }
  const bytes = await writer.close();
  const outputPath = join(app.getPath("downloads"), `selftune-diagnostics-${exportStamp()}.zip`);
  await writeFile(outputPath, bytes);
  shell.showItemInFolder(outputPath);
  return outputPath;
}

export async function exportDiagnosticsInteractive(configDir: string): Promise<void> {
  try {
    await exportDiagnostics(configDir);
  } catch (cause) {
    reportRuntimeFailure("[diagnostics] export failed", cause);
    await dialog.showMessageBox({
      type: "error",
      title: "Diagnostics export failed",
      message: "SelfTune could not write the diagnostics archive.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
