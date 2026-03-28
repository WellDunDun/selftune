#!/usr/bin/env bun
/**
 * selftune init — Bootstrap agent identity and write config.
 *
 * Detects the coding agent environment, resolves the CLI path,
 * determines LLM mode, checks hook installation, and writes
 * the result to ~/.selftune/config.json.
 *
 * Usage:
 *   selftune init [--agent <type>] [--cli-path <path>] [--force]
 *   selftune init [--no-sync] [--no-autonomy] [--schedule-format cron|launchd|systemd]
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getAlphaGuidance } from "./agent-guidance.js";
import {
  ALPHA_CONSENT_NOTICE,
  generateUserId,
  isValidApiKeyFormat,
  readAlphaIdentity,
} from "./alpha-identity.js";
import { TELEMETRY_NOTICE } from "./analytics.js";
import {
  buildVerificationUrl,
  pollDeviceCode,
  requestDeviceCode,
  tryOpenUrl,
} from "./auth/device-code.js";
import { installAgentFiles } from "./claude-agents.js";
import { CLAUDE_CODE_HOOK_KEYS, SELFTUNE_CONFIG_DIR, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { AgentCommandGuidance, AlphaIdentity, SelftuneConfig } from "./types.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";
import { hookKeyHasSelftuneEntry } from "./utils/hooks.js";
import { detectAgent } from "./utils/llm-call.js";

export { installAgentFiles } from "./claude-agents.js";

interface InitCliErrorPayload extends AgentCommandGuidance {
  error: string;
}

class InitCliError extends Error {
  payload: InitCliErrorPayload;

  constructor(payload: InitCliErrorPayload) {
    super(payload.message);
    this.name = "InitCliError";
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Agent type detection
// ---------------------------------------------------------------------------

/**
 * Detect which coding agent environment we are running inside.
 *
 * Detection order:
 *   1. Claude Code — ~/.claude/ directory exists AND (`which claude` OR env signals)
 *   2. Codex — $CODEX_HOME set OR `which codex`
 *   3. OpenCode — ~/.local/share/opencode/opencode.db exists OR `which opencode`
 *   4. "unknown" fallback
 */
const VALID_AGENT_TYPES: SelftuneConfig["agent_type"][] = [
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "unknown",
];

const AGENT_TYPE_CLI_MAP: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  openclaw: "openclaw",
};

function agentTypeToCli(agentType: string): string | null {
  return AGENT_TYPE_CLI_MAP[agentType] ?? null;
}

export function detectAgentType(
  override?: string,
  homeOverride?: string,
): SelftuneConfig["agent_type"] {
  if (override) {
    if (VALID_AGENT_TYPES.includes(override as SelftuneConfig["agent_type"])) {
      return override as SelftuneConfig["agent_type"];
    }
    console.error(`[WARN] Unknown agent type "${override}", falling back to detection`);
  }

  const home = homeOverride ?? homedir();

  // Claude Code: .claude directory + claude binary
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    if (Bun.which("claude") || process.env.CLAUDE_CODE_ENTRYPOINT) {
      return "claude_code";
    }
  }

  // Codex: env var or binary
  if (process.env.CODEX_HOME || Bun.which("codex")) {
    return "codex";
  }

  // OpenCode: db file or binary
  const opencodeDb = join(home, ".local", "share", "opencode", "opencode.db");
  if (existsSync(opencodeDb) || Bun.which("opencode")) {
    return "opencode";
  }

  // OpenClaw: agents directory or binary
  const openclawDir = join(home, ".openclaw", "agents");
  if (existsSync(openclawDir) || Bun.which("openclaw")) {
    return "openclaw";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to cli/selftune/index.ts.
 * Uses the directory of this file (init.ts lives alongside index.ts).
 */
export function determineCliPath(override?: string): string {
  if (override) return override;
  return resolve(dirname(import.meta.path), "index.ts");
}

function writeSelftuneConfig(configPath: string, config: SelftuneConfig): void {
  const serialized = JSON.stringify(config, null, 2);
  if (!config.alpha?.api_key?.trim()) {
    writeFileSync(configPath, serialized, "utf-8");
    return;
  }

  const tempPath = `${configPath}.tmp`;
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeFileSync(fd, serialized, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, configPath);
}

// ---------------------------------------------------------------------------
// LLM mode determination
// ---------------------------------------------------------------------------

/**
 * Determine LLM mode and agent CLI based on available signals.
 */
export function determineLlmMode(agentCli: string | null): {
  llm_mode: "agent";
  agent_cli: string | null;
} {
  return { llm_mode: "agent", agent_cli: agentCli };
}

// ---------------------------------------------------------------------------
// Hook detection (Claude Code only)
// ---------------------------------------------------------------------------

/**
 * Check if the selftune hooks are configured in Claude Code settings.
 */
export function checkClaudeCodeHooks(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    for (const key of CLAUDE_CODE_HOOK_KEYS) {
      if (!hookKeyHasSelftuneEntry(hooks, key)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook installation (Claude Code only)
// ---------------------------------------------------------------------------

/** Bundled settings snippet (ships with the npm package). */
const SETTINGS_SNIPPET_PATH = resolve(
  dirname(import.meta.path),
  "..",
  "..",
  "skill",
  "settings_snippet.json",
);

/**
 * Install selftune hooks into ~/.claude/settings.json by merging entries
 * from the bundled settings_snippet.json.
 *
 * - Creates settings.json if it does not exist
 * - Creates the hooks section if it does not exist
 * - Only adds hook entries for keys that don't already have a selftune entry
 * - Never overwrites existing user hooks
 *
 * Returns the list of hook keys that were added.
 */
export function installClaudeCodeHooks(options?: {
  settingsPath?: string;
  snippetPath?: string;
  cliPath?: string;
}): string[] {
  const settingsPath = options?.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const snippetPath = options?.snippetPath ?? SETTINGS_SNIPPET_PATH;

  // Read the snippet
  if (!existsSync(snippetPath)) {
    console.error(`[WARN] Hook snippet not found at ${snippetPath}, skipping hook installation`);
    return [];
  }

  let snippet: Record<string, unknown>;
  try {
    snippet = JSON.parse(readFileSync(snippetPath, "utf-8"));
  } catch {
    console.error(`[WARN] Failed to parse hook snippet at ${snippetPath}`);
    return [];
  }

  const snippetHooks = snippet.hooks as Record<string, unknown[]> | undefined;
  if (!snippetHooks || typeof snippetHooks !== "object") {
    console.error("[WARN] Hook snippet has no 'hooks' section");
    return [];
  }

  // Read existing settings (or start with empty object)
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error(`[WARN] Failed to parse ${settingsPath}, starting with empty settings`);
      settings = {};
    }
  }

  // Ensure hooks section exists
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const existingHooks = settings.hooks as Record<string, unknown[]>;

  // Resolve the CLI hooks directory for path substitution
  const cliPath = options?.cliPath;
  const hooksDir = cliPath ? `${dirname(cliPath)}/hooks` : null;

  const addedKeys: string[] = [];

  for (const key of Object.keys(snippetHooks)) {
    // Skip if this key already has a selftune entry
    if (hookKeyHasSelftuneEntry(existingHooks, key)) {
      continue;
    }

    // Get the snippet entries for this key, replacing /PATH/TO/ with actual path
    let entries = snippetHooks[key];
    if (hooksDir) {
      // Deep clone and substitute paths
      const raw = JSON.stringify(entries).replace(/\/PATH\/TO\/cli\/selftune\/hooks/g, hooksDir);
      entries = JSON.parse(raw);
    }

    // Merge: append to existing array or create new one
    if (Array.isArray(existingHooks[key])) {
      existingHooks[key] = [...existingHooks[key], ...entries];
    } else {
      existingHooks[key] = entries;
    }

    addedKeys.push(key);
  }

  if (addedKeys.length > 0) {
    // Ensure ~/.claude/ directory exists
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  return addedKeys;
}

// ---------------------------------------------------------------------------
// Workspace type detection
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set(["node_modules", ".git", ".hg", "dist", "build", ".next", ".cache"]);

export interface WorkspaceInfo {
  type: "single-skill" | "multi-skill" | "monorepo" | "unknown";
  skillCount: number;
  skillPaths: string[];
  isMonorepo: boolean;
  hasExistingHooks: boolean;
  suggestedTemplate: "single-skill" | "multi-skill" | null;
}

/**
 * Recursively find SKILL.md files under a root directory,
 * skipping ignored directories (node_modules, .git, etc.).
 */
function findSkillFiles(dir: string, maxDepth = 8, depth = 0): string[] {
  if (depth > maxDepth) return [];
  if (!existsSync(dir)) return [];

  const results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        results.push(...findSkillFiles(join(dir, entry.name), maxDepth, depth + 1));
      } else if (entry.name === "SKILL.md") {
        results.push(join(dir, entry.name));
      }
    }
  } catch {
    // Permission errors, etc. — skip
  }

  return results;
}

/**
 * Detect whether the root directory is a monorepo by checking for
 * package.json workspaces or pnpm-workspace.yaml.
 */
function detectMonorepo(rootDir: string): boolean {
  // Check package.json workspaces field
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.workspaces) return true;
    } catch {
      // invalid JSON — skip
    }
  }

  // Check pnpm-workspace.yaml
  if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) return true;

  // Check lerna.json
  if (existsSync(join(rootDir, "lerna.json"))) return true;

  return false;
}

/**
 * Detect whether the project has existing selftune hooks configured.
 */
function detectExistingHooks(rootDir: string): boolean {
  const hooksDir = join(rootDir, "cli", "selftune", "hooks");
  if (!existsSync(hooksDir)) return false;

  try {
    const entries = readdirSync(hooksDir);
    return entries.some((e) => e.endsWith(".ts") || e.endsWith(".js"));
  } catch {
    return false;
  }
}

/**
 * Scan a project root and detect the workspace type, skill layout,
 * and suggest an appropriate template.
 */
export function detectWorkspaceType(rootDir: string): WorkspaceInfo {
  const skillPaths = findSkillFiles(rootDir);
  const isMonorepo = detectMonorepo(rootDir);
  const hasExistingHooks = detectExistingHooks(rootDir);
  const skillCount = skillPaths.length;

  let type: WorkspaceInfo["type"];
  let suggestedTemplate: WorkspaceInfo["suggestedTemplate"];

  if (isMonorepo) {
    type = "monorepo";
    suggestedTemplate = "multi-skill";
  } else if (skillCount === 0) {
    type = "unknown";
    suggestedTemplate = null;
  } else if (skillCount === 1) {
    type = "single-skill";
    suggestedTemplate = "single-skill";
  } else {
    type = "multi-skill";
    suggestedTemplate = "multi-skill";
  }

  return {
    type,
    skillCount,
    skillPaths,
    isMonorepo,
    hasExistingHooks,
    suggestedTemplate,
  };
}

// ---------------------------------------------------------------------------
// Init options (for testability)
// ---------------------------------------------------------------------------

export interface InitOptions {
  configDir: string;
  configPath: string;
  force: boolean;
  agentOverride?: string;
  cliPathOverride?: string;
  homeDir?: string;
  alpha?: boolean;
  noAlpha?: boolean;
  alphaEmail?: string;
  alphaName?: string;
}

function validateAlphaMetadataFlags(
  alpha: boolean | undefined,
  email?: string,
  name?: string,
): void {
  if ((email !== undefined || name !== undefined) && !alpha) {
    throw new Error("--alpha-email and --alpha-name require --alpha");
  }
}

function assertValidApprovedAlphaCredential(result: {
  api_key: string;
  cloud_user_id: string;
  org_id: string;
}): void {
  if (!isValidApiKeyFormat(result.api_key)) {
    throw new Error(
      "Device-code approval returned an invalid alpha credential. Re-run `selftune init --alpha`.",
    );
  }
  if (!result.cloud_user_id?.trim()) {
    throw new Error(
      "Device-code approval did not include a cloud user id. Re-run `selftune init --alpha`.",
    );
  }
  if (!result.org_id?.trim()) {
    throw new Error(
      "Device-code approval did not include an alpha org id. Re-run `selftune init --alpha`.",
    );
  }
}

// ---------------------------------------------------------------------------
// Core init logic
// ---------------------------------------------------------------------------

/**
 * Run the init flow. Returns the written (or existing) config.
 * Extracted as a pure function for testability.
 */
export async function runInit(opts: InitOptions): Promise<SelftuneConfig> {
  const { configDir, configPath, force } = opts;
  validateAlphaMetadataFlags(opts.alpha, opts.alphaEmail, opts.alphaName);

  // If config exists and no --force (and no alpha mutation), return existing
  const hasAlphaMutation =
    opts.alpha || opts.noAlpha || opts.alphaEmail !== undefined || opts.alphaName !== undefined;
  if (!force && !hasAlphaMutation && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    try {
      const existingConfig = JSON.parse(raw) as SelftuneConfig;
      if (existingConfig.agent_type === "claude_code") {
        installAgentFiles({ homeDir: opts.homeDir });
      }
      return existingConfig;
    } catch (err) {
      throw new Error(
        `Config file at ${configPath} contains invalid JSON. Delete it or use --force to reinitialize. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Capture existing alpha identity before overwriting config (for user_id preservation)
  const existingAlphaBeforeOverwrite = readAlphaIdentity(configPath);

  // Detect agent type
  const agentType = detectAgentType(opts.agentOverride, opts.homeDir);

  // Resolve CLI path
  const cliPath = determineCliPath(opts.cliPathOverride);

  // Detect agent CLI — when an override is provided, fall back to mapped CLI
  // name so init works in test/CI environments without agent binaries in PATH
  const agentCli = detectAgent() ?? (opts.agentOverride ? agentTypeToCli(agentType) : null);
  if (!agentCli) {
    throw new Error(
      "No supported agent CLI detected (claude, codex, opencode). Install one, then rerun `selftune init`.",
    );
  }

  // Determine LLM mode
  const { llm_mode, agent_cli } = determineLlmMode(agentCli);

  // Check hooks (Claude Code only)
  const home = opts.homeDir ?? homedir();
  const settingsPath = join(home, ".claude", "settings.json");
  const hooksInstalled = agentType === "claude_code" ? checkClaudeCodeHooks(settingsPath) : false;

  let validatedAlphaIdentity: AlphaIdentity | null = null;
  if (opts.alpha) {
    // Device-code flow — authenticate via browser approval
    process.stderr.write("[alpha] Starting device-code authentication flow...\n");

    const grant = await requestDeviceCode();
    const verificationUrlWithCode = buildVerificationUrl(grant.verification_url, grant.user_code);

    // Emit structured JSON for the agent to parse
    console.log(
      JSON.stringify({
        level: "info",
        code: "device_code_issued",
        verification_url: grant.verification_url,
        verification_url_with_code: verificationUrlWithCode,
        user_code: grant.user_code,
        expires_in: grant.expires_in,
        message: `Open ${verificationUrlWithCode} to approve.`,
      }),
    );

    // Try to open browser (skip in test environments)
    if (!process.env.BUN_ENV?.includes("test") && !process.env.SELFTUNE_NO_BROWSER) {
      if (tryOpenUrl(verificationUrlWithCode)) {
        process.stderr.write(`[alpha] Browser opened. Waiting for approval...\n`);
      } else {
        process.stderr.write(
          `[alpha] Could not open browser. Visit ${verificationUrlWithCode} manually.\n`,
        );
      }
    } else {
      process.stderr.write(`[alpha] Visit ${verificationUrlWithCode} to approve.\n`);
    }

    process.stderr.write("[alpha] Polling");
    const result = await pollDeviceCode(grant.device_code, grant.interval, grant.expires_in);
    assertValidApprovedAlphaCredential(result);
    process.stderr.write("\n[alpha] Approved!\n");

    validatedAlphaIdentity = {
      enrolled: true,
      user_id: existingAlphaBeforeOverwrite?.user_id ?? generateUserId(),
      cloud_user_id: result.cloud_user_id,
      cloud_org_id: result.org_id,
      email: opts.alphaEmail ?? existingAlphaBeforeOverwrite?.email,
      display_name: opts.alphaName ?? existingAlphaBeforeOverwrite?.display_name,
      consent_timestamp: new Date().toISOString(),
      api_key: result.api_key,
    };
  }

  const config: SelftuneConfig = {
    agent_type: agentType,
    cli_path: cliPath,
    llm_mode,
    agent_cli,
    hooks_installed: hooksInstalled,
    initialized_at: new Date().toISOString(),
  };

  // Write config
  mkdirSync(configDir, { recursive: true });
  writeSelftuneConfig(configPath, config);

  // Auto-install hooks into ~/.claude/settings.json (Claude Code only)
  if (agentType === "claude_code") {
    const syncedAgentFiles = installAgentFiles({ homeDir: home });
    if (syncedAgentFiles.length > 0) {
      console.error(
        `[INFO] Synced ${syncedAgentFiles.length} selftune agent file(s) into ${join(home, ".claude", "agents")}: ${syncedAgentFiles.join(", ")}`,
      );
    }

    const addedHookKeys = installClaudeCodeHooks({
      settingsPath,
      cliPath,
    });
    if (addedHookKeys.length > 0) {
      config.hooks_installed = true;
      // Re-write config with updated hooks_installed flag
      writeSelftuneConfig(configPath, config);
      console.error(
        `[INFO] Installed ${addedHookKeys.length} selftune hook(s) into ${settingsPath}: ${addedHookKeys.join(", ")}`,
      );
    } else if (!config.hooks_installed) {
      // Re-check in case hooks were already present
      config.hooks_installed = checkClaudeCodeHooks(settingsPath);
      if (config.hooks_installed) {
        writeSelftuneConfig(configPath, config);
      }
    }
  }

  if (existingAlphaBeforeOverwrite && !opts.alpha && !opts.noAlpha) {
    config.alpha = existingAlphaBeforeOverwrite;
    writeSelftuneConfig(configPath, config);
  }

  // Handle alpha enrollment
  if (validatedAlphaIdentity) {
    config.alpha = validatedAlphaIdentity;
    writeSelftuneConfig(configPath, config);

    const readiness = checkAlphaReadiness(configPath);
    console.error(JSON.stringify({ alpha_readiness: readiness }));
  } else if (opts.noAlpha) {
    if (existingAlphaBeforeOverwrite) {
      const identity: AlphaIdentity = {
        ...existingAlphaBeforeOverwrite,
        enrolled: false,
      };
      config.alpha = identity;
      writeSelftuneConfig(configPath, config);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      "cli-path": { type: "string" },
      force: { type: "boolean", default: false },
      "enable-autonomy": { type: "boolean", default: false },
      "no-sync": { type: "boolean", default: false },
      "no-autonomy": { type: "boolean", default: false },
      "schedule-format": { type: "string" },
      alpha: { type: "boolean", default: false },
      "no-alpha": { type: "boolean", default: false },
      "alpha-email": { type: "string" },
      "alpha-name": { type: "string" },
    },
    strict: true,
  });

  const configDir = SELFTUNE_CONFIG_DIR;
  const configPath = SELFTUNE_CONFIG_PATH;
  const force = values.force ?? false;
  // Sync and autonomy are on by default; opt out with --no-sync / --no-autonomy
  const enableSync = !(values["no-sync"] ?? false);
  // --enable-autonomy is a backward-compatible alias (now default behavior)
  const enableAutonomy = !values["no-autonomy"];
  try {
    validateAlphaMetadataFlags(values.alpha, values["alpha-email"], values["alpha-name"]);
  } catch (error) {
    throw new CLIError(
      error instanceof Error ? error.message : String(error),
      "INVALID_FLAG",
      "Pass --alpha along with --alpha-email and --alpha-name.",
    );
  }

  // Check for existing config without force
  const hasAlphaMutation = !!(
    values.alpha ||
    values["no-alpha"] ||
    values["alpha-email"] ||
    values["alpha-name"]
  );
  let existingConfigDetected = false;
  if (!force && !enableAutonomy && !hasAlphaMutation && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const existing = JSON.parse(raw) as SelftuneConfig;
      console.log(JSON.stringify(existing, null, 2));
      console.error("Already initialized. Use --force to reinitialize.");
      process.exit(0);
    } catch (err) {
      console.error(
        `[WARN] Config at ${configPath} is corrupted: ${err instanceof Error ? err.message : String(err)}. Reinitializing...`,
      );
    }
  }
  if (!force && !hasAlphaMutation && existsSync(configPath)) {
    try {
      JSON.parse(readFileSync(configPath, "utf-8")) as SelftuneConfig;
      existingConfigDetected = true;
    } catch {
      existingConfigDetected = false;
    }
  }

  const config = await runInit({
    configDir,
    configPath,
    force,
    agentOverride: values.agent,
    cliPathOverride: values["cli-path"],
    alpha: values.alpha ?? false,
    noAlpha: values["no-alpha"] ?? false,
    alphaEmail: values["alpha-email"],
    alphaName: values["alpha-name"],
  });

  // Redact api_key before printing to stdout
  const safeConfig = structuredClone(config);
  if (safeConfig.alpha?.api_key) {
    safeConfig.alpha.api_key = "<redacted>";
  }
  console.log(JSON.stringify(safeConfig, null, 2));
  if (existingConfigDetected) {
    console.error("Already initialized. Use --force to reinitialize.");
  }

  // Alpha enrollment output
  if (values.alpha) {
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_enrolled",
        user_id: config.alpha?.user_id,
        email: config.alpha?.email,
        enrolled: true,
      }),
    );
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_upload_ready",
        message:
          "Alpha enrollment complete. Uploads will run automatically during 'selftune orchestrate'. To enable scheduled background sync (includes evolve + watch + upload), run: selftune cron setup",
        next_command: "selftune alpha upload",
        optional_autonomy: "selftune cron setup",
      }),
    );
    console.error(ALPHA_CONSENT_NOTICE);
  } else if (values["no-alpha"]) {
    console.log(
      JSON.stringify({
        level: "info",
        code: "alpha_unenrolled",
        enrolled: false,
      }),
    );
  }

  // Detect workspace type and report
  const workspace = detectWorkspaceType(process.cwd());
  console.log(
    JSON.stringify({
      level: "info",
      code: "workspace_detected",
      type: workspace.type,
      skills: workspace.skillCount,
      monorepo: workspace.isMonorepo,
      suggestedTemplate: workspace.suggestedTemplate
        ? `templates/${workspace.suggestedTemplate}-settings.json`
        : null,
    }),
  );

  // Print telemetry disclosure
  console.error(TELEMETRY_NOTICE);

  // Run doctor as post-check
  const { doctor } = await import("./observability.js");
  const doctorResult = await doctor();
  console.log(
    JSON.stringify({
      level: "info",
      code: "doctor_result",
      pass: doctorResult.summary.pass,
      total: doctorResult.summary.total,
    }),
  );

  // Backfill historical transcripts into SQLite
  if (enableSync) {
    try {
      const { syncSources } = await import("./sync.js");
      const syncResult = syncSources({
        syncClaude: true,
        syncCodex: true,
        syncOpenCode: true,
        syncOpenClaw: true,
        rebuildSkillUsage: true,
        dryRun: false,
      });

      const totalSynced =
        (syncResult.sources.claude?.synced ?? 0) +
        (syncResult.sources.codex?.synced ?? 0) +
        (syncResult.sources.opencode?.synced ?? 0) +
        (syncResult.sources.openclaw?.synced ?? 0);

      console.log(
        JSON.stringify({
          level: "info",
          code: "sync_complete",
          sessions_synced: totalSynced,
          repaired_records: syncResult.repair.repaired_records,
          elapsed_ms: syncResult.total_elapsed_ms,
        }),
      );
    } catch (err) {
      // Fail-open: sync failure should not block init completion
      console.log(
        JSON.stringify({
          level: "warn",
          code: "sync_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Trigger initial alpha upload if enrolled — push synced data immediately
  if (config.alpha?.enrolled && config.alpha?.api_key) {
    try {
      const { runUploadCycle } = await import("./alpha-upload/index.js");
      const { getDb } = await import("./localdb/db.js");
      const db = getDb();
      const uploadSummary = await runUploadCycle(db, {
        enrolled: true,
        userId: config.alpha.user_id,
        apiKey: config.alpha.api_key,
      });
      console.log(
        JSON.stringify({
          level: "info",
          code: "init_upload_complete",
          prepared: uploadSummary.prepared,
          sent: uploadSummary.sent,
          failed: uploadSummary.failed,
        }),
      );
    } catch (err) {
      // Fail-open: upload failure should not block init
      console.log(
        JSON.stringify({
          level: "warn",
          code: "init_upload_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  if (enableAutonomy) {
    try {
      const { installSchedule } = await import("./schedule.js");
      const scheduleResult = installSchedule({
        format: values["schedule-format"],
      });

      if (!scheduleResult.activated) {
        throw new CLIError(
          "Failed to activate the autonomous scheduler.",
          "OPERATION_FAILED",
          "Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect the generated artifacts first.",
        );
      }

      console.log(
        JSON.stringify({
          level: "info",
          code: "autonomy_enabled",
          format: scheduleResult.format,
          activated: scheduleResult.activated,
          files: scheduleResult.artifacts.map((artifact) => artifact.path),
        }),
      );
    } catch (err) {
      throw new CLIError(
        `Failed to enable autonomy: ${err instanceof Error ? err.message : String(err)}`,
        "OPERATION_FAILED",
        "Re-run with --schedule-format or use `selftune schedule --install --dry-run` to inspect artifacts.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Alpha readiness check
// ---------------------------------------------------------------------------

export function checkAlphaReadiness(configPath: string): {
  ready: boolean;
  missing: string[];
  guidance: AgentCommandGuidance;
} {
  const identity = readAlphaIdentity(configPath);
  const missing: string[] = [];
  if (!identity) {
    missing.push("alpha identity not configured");
    return { ready: false, missing, guidance: getAlphaGuidance(identity) };
  }
  if (!identity.enrolled) missing.push("not enrolled");
  if (!identity.api_key) missing.push("api_key not set");
  else if (!isValidApiKeyFormat(identity.api_key))
    missing.push("api_key has invalid format (expected st_live_* or st_test_*)");
  return { ready: missing.length === 0, missing, guidance: getAlphaGuidance(identity) };
}

// Guard: only run when invoked directly
const isMain =
  (import.meta as Record<string, unknown>).main === true ||
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  cliMain().catch((err) => {
    if (err instanceof InitCliError) {
      console.error(JSON.stringify(err.payload));
      process.exit(1);
    }
    handleCLIError(err);
  });
}
