/**
 * selftune anonymous usage analytics.
 *
 * Collects anonymous, non-identifying usage data to help prioritize
 * features and understand how selftune is used in the wild.
 *
 * Privacy guarantees:
 *   - No PII: no usernames, emails, IPs, file paths, or repo names
 *   - No session IDs; events are linkable by anonymous_id and sent_at
 *   - Anonymous machine ID: random, persisted locally (not derived from any user data)
 *   - Fire-and-forget: never blocks CLI execution
 *   - Easy opt-out: env var or config flag
 *
 * Opt out:
 *   - Set SELFTUNE_NO_ANALYTICS=1 in your environment
 *   - Run `selftune telemetry disable`
 *   - Set "analytics_disabled": true in ~/.selftune/config.json
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import { SELFTUNE_CONFIG_DIR, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { SelftuneConfig } from "./types.js";
import { CLIError } from "./utils/cli-error.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANALYTICS_ENDPOINT =
  process.env.SELFTUNE_ANALYTICS_ENDPOINT ?? "https://telemetry.selftune.dev/v1/events";

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Cached config — read once per process, shared across all functions
// ---------------------------------------------------------------------------

let cachedConfig: SelftuneConfig | null | undefined;

function loadConfig(): SelftuneConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    if (existsSync(SELFTUNE_CONFIG_PATH)) {
      cachedConfig = JSON.parse(readFileSync(SELFTUNE_CONFIG_PATH, "utf-8")) as SelftuneConfig;
    } else {
      cachedConfig = null;
    }
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

/** Invalidate cached config (used after writes). */
function invalidateConfigCache(): void {
  cachedConfig = undefined;
}

/** Reset all cached state. Exported for test isolation only. */
export function resetAnalyticsState(): void {
  cachedConfig = undefined;
  cachedAnonymousId = undefined;
  cachedOsContext = undefined;
}

// ---------------------------------------------------------------------------
// Persisted anonymous ID — random, non-reversible, stable across runs
// ---------------------------------------------------------------------------

const ANONYMOUS_ID_PATH = join(SELFTUNE_CONFIG_DIR, ".anonymous_id");
let cachedAnonymousId: string | undefined;

/**
 * Get or create a random anonymous machine ID.
 * Generated once via crypto.randomBytes and persisted to disk.
 * Cannot be reversed to recover any user/machine information.
 * Result is memoized for the process lifetime.
 */
export function getAnonymousId(): string {
  if (cachedAnonymousId) return cachedAnonymousId;
  try {
    if (existsSync(ANONYMOUS_ID_PATH)) {
      const stored = readFileSync(ANONYMOUS_ID_PATH, "utf-8").trim();
      if (/^[a-f0-9]{16}$/.test(stored)) {
        cachedAnonymousId = stored;
        return stored;
      }
    }
  } catch {
    // fall through to generate
  }
  const id = randomBytes(8).toString("hex"); // 16 hex chars
  try {
    mkdirSync(SELFTUNE_CONFIG_DIR, { recursive: true });
    writeFileSync(ANONYMOUS_ID_PATH, id, "utf-8");
  } catch {
    // non-fatal — use ephemeral ID for this process
  }
  cachedAnonymousId = id;
  return id;
}

// ---------------------------------------------------------------------------
// Cached OS context — doesn't change within a process
// ---------------------------------------------------------------------------

let cachedOsContext: { os: string; os_release: string; arch: string } | undefined;

function getOsContext(): { os: string; os_release: string; arch: string } {
  if (cachedOsContext) return cachedOsContext;
  cachedOsContext = { os: platform(), os_release: release(), arch: arch() };
  return cachedOsContext;
}

// ---------------------------------------------------------------------------
// Analytics gate
// ---------------------------------------------------------------------------

/**
 * Check whether analytics is enabled.
 * Returns false if:
 *   - SELFTUNE_NO_ANALYTICS env var is set to any truthy value
 *   - Config file has analytics_disabled: true
 *   - CI environment detected (CI=true)
 */
export function isAnalyticsEnabled(): boolean {
  // Env var override (highest priority)
  const envDisabled = process.env.SELFTUNE_NO_ANALYTICS;
  if (envDisabled && envDisabled !== "0" && envDisabled !== "false") {
    return false;
  }

  // CI detection — don't inflate analytics from CI pipelines
  if (process.env.CI === "true" || process.env.CI === "1") {
    return false;
  }

  // Config file check (uses cached read — no redundant I/O)
  const config = loadConfig();
  if (config?.analytics_disabled) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------

export interface AnalyticsEvent {
  event: string;
  properties: Record<string, string | number | boolean>;
  context: {
    anonymous_id: string;
    os: string;
    os_release: string;
    arch: string;
    selftune_version: string;
    node_version: string;
    agent_type: string;
  };
  sent_at: string;
}

/**
 * Build an analytics event payload.
 * Exported for testing — does NOT send the event.
 */
export function buildEvent(
  eventName: string,
  properties: Record<string, string | number | boolean> = {},
): AnalyticsEvent {
  const config = loadConfig();
  const agentType: SelftuneConfig["agent_type"] = config?.agent_type ?? "unknown";
  const osCtx = getOsContext();

  return {
    event: eventName,
    properties,
    context: {
      anonymous_id: getAnonymousId(),
      ...osCtx,
      selftune_version: getVersion(),
      node_version: process.version,
      agent_type: agentType,
    },
    sent_at: new Date().toISOString(),
  };
}

/**
 * Track an analytics event. Fire-and-forget — never blocks, never throws.
 *
 * @param eventName - Event name (e.g., "command_run")
 * @param properties - Event properties (no PII allowed)
 * @param options - Override endpoint or fetch for testing
 */
export function trackEvent(
  eventName: string,
  properties: Record<string, string | number | boolean> = {},
  options?: { endpoint?: string; fetchFn?: typeof fetch },
): void {
  if (!isAnalyticsEnabled()) return;

  const event = buildEvent(eventName, properties);
  const endpoint = options?.endpoint ?? ANALYTICS_ENDPOINT;
  const fetchFn = options?.fetchFn ?? fetch;

  // Fire and forget — intentionally not awaited.
  // Wrapped in try + Promise.resolve to catch both sync throws and async rejections.
  try {
    Promise.resolve(
      fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000), // 3s timeout — don't hang
      }),
    ).catch(() => {
      // Silently ignore — analytics should never break the CLI
    });
  } catch {
    // Silently ignore sync throws from fetchFn
  }
}

// ---------------------------------------------------------------------------
// CLI: selftune telemetry [status|enable|disable]
// ---------------------------------------------------------------------------

function writeConfigField(field: keyof SelftuneConfig, value: unknown): void {
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(SELFTUNE_CONFIG_PATH)) {
      config = JSON.parse(readFileSync(SELFTUNE_CONFIG_PATH, "utf-8"));
    }
  } catch {
    // start fresh
  }
  config[field] = value;
  mkdirSync(SELFTUNE_CONFIG_DIR, { recursive: true });
  writeFileSync(SELFTUNE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  invalidateConfigCache();
}

export async function cliMain(): Promise<void> {
  const sub = process.argv[2];

  if (sub === "--help" || sub === "-h") {
    console.log(`selftune telemetry — Manage anonymous usage analytics

Usage:
  selftune telemetry              Show current telemetry status
  selftune telemetry status       Show current telemetry status
  selftune telemetry enable       Enable anonymous usage analytics
  selftune telemetry disable      Disable anonymous usage analytics

Environment:
  SELFTUNE_NO_ANALYTICS=1         Disable analytics via env var

selftune collects anonymous, non-identifying usage data to help
prioritize features. No PII is ever collected. See:
https://github.com/selftune-dev/selftune#telemetry`);
    process.exit(0);
  }

  switch (sub) {
    case "disable": {
      try {
        writeConfigField("analytics_disabled", true);
      } catch {
        throw new CLIError(
          "Failed to disable telemetry: cannot write ~/.selftune/config.json",
          "OPERATION_FAILED",
          "Check file permissions, or set SELFTUNE_NO_ANALYTICS=1",
        );
      }
      console.log("Telemetry disabled. No anonymous usage data will be sent.");
      console.log("You can re-enable with: selftune telemetry enable");
      break;
    }
    case "enable": {
      try {
        writeConfigField("analytics_disabled", false);
      } catch {
        throw new CLIError(
          "Failed to enable telemetry: cannot write ~/.selftune/config.json",
          "OPERATION_FAILED",
          "Check file permissions",
        );
      }
      console.log("Telemetry enabled. Anonymous usage data will be sent.");
      console.log("Disable anytime with: selftune telemetry disable");
      console.log("Or set SELFTUNE_NO_ANALYTICS=1 in your environment.");
      break;
    }
    case "status":
    case undefined: {
      const enabled = isAnalyticsEnabled();
      const config = loadConfig();
      const envDisabled = process.env.SELFTUNE_NO_ANALYTICS;
      const configDisabled = config?.analytics_disabled ?? false;

      console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
      if (envDisabled && envDisabled !== "0" && envDisabled !== "false") {
        console.log("  Disabled via: SELFTUNE_NO_ANALYTICS environment variable");
      }
      if (configDisabled) {
        console.log("  Disabled via: config file (~/.selftune/config.json)");
      }
      if (process.env.CI === "true" || process.env.CI === "1") {
        console.log("  Disabled via: CI environment detected");
      }
      if (enabled) {
        console.log(`  Anonymous ID: ${getAnonymousId()}`);
        console.log(`  Endpoint: ${ANALYTICS_ENDPOINT}`);
      }
      console.log("\nTo opt out: selftune telemetry disable");
      console.log("Or set SELFTUNE_NO_ANALYTICS=1 in your environment.");
      break;
    }
    default:
      throw new CLIError(
        `Unknown telemetry subcommand: ${sub}`,
        "INVALID_FLAG",
        "selftune telemetry --help",
      );
  }
}

// ---------------------------------------------------------------------------
// Telemetry disclosure notice (for init flow)
// ---------------------------------------------------------------------------

export const TELEMETRY_NOTICE = `
selftune collects anonymous usage analytics to improve the tool.
No personal information is ever collected — only command names,
OS/arch, and selftune version.

To opt out at any time:
  selftune telemetry disable
  # or
  export SELFTUNE_NO_ANALYTICS=1
`;
