/**
 * Typed CLI error with machine-readable code, agent-actionable suggestion, and exit code.
 *
 * Replaces ad-hoc `console.error() + process.exit(1)` patterns across the CLI.
 * When `--json` mode is active, errors serialize to structured JSON on stderr.
 * When text mode is active, errors print human-readable messages with suggestions.
 *
 * @example
 * ```ts
 * throw new CLIError(
 *   "No selftune config found",
 *   "CONFIG_MISSING",
 *   "Run: selftune init",
 *   4,  // exit code for config-missing per agent-cli-contract
 * );
 * ```
 */

export type CLIErrorCode =
  | "INVALID_FLAG"
  | "MISSING_FLAG"
  | "CONFIG_MISSING"
  | "FILE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "UNKNOWN_COMMAND"
  | "GUARD_BLOCKED"
  | "OPERATION_FAILED"
  | "MISSING_DATA"
  | "INTERNAL_ERROR";

export class CLIError extends Error {
  constructor(
    message: string,
    /** Machine-readable error code (SCREAMING_SNAKE_CASE). */
    public readonly code: CLIErrorCode,
    /** Agent-actionable next command or remediation step. */
    public readonly suggestion?: string,
    /** Process exit code. Default 1 (general error). */
    public readonly exitCode: number = 1,
    /** Whether the agent should retry the same command. */
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "CLIError";
  }

  /** Structured JSON representation for `--json` mode. */
  toJSON(): {
    error: {
      code: CLIErrorCode;
      message: string;
      suggestion?: string;
      retryable: boolean;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.suggestion ? { suggestion: this.suggestion } : {}),
        retryable: this.retryable,
      },
    };
  }
}

/**
 * Top-level error handler for CLI entry points.
 *
 * Install at the bottom of any CLI entry point:
 * ```ts
 * cliMain().catch(handleCLIError);
 * ```
 */
/** Detect JSON output mode: explicit --json flag or non-TTY stdout (automation). */
export function isJsonOutputMode(): boolean {
  return process.argv.includes("--json") || process.stdout?.isTTY === false;
}

export function handleCLIError(error: unknown): never {
  const jsonMode = isJsonOutputMode();

  if (error instanceof CLIError) {
    if (jsonMode) {
      console.error(JSON.stringify(error.toJSON()));
      process.exit(error.exitCode);
    }
    console.error(`[ERROR] ${error.message}`);
    if (error.suggestion) {
      console.error(`  → ${error.suggestion}`);
    }
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    console.error(JSON.stringify({ error: { code: "INTERNAL_ERROR", message, retryable: false } }));
    process.exit(1);
  }
  console.error(`[FATAL] ${message}`);
  process.exit(1);
}
