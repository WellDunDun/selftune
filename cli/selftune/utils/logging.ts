/**
 * Structured JSON logging to stderr.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/**
 * Create a structured JSON logger for a selftune module.
 * Output goes to stderr as one JSON line per log call.
 */
export function createLogger(module: string): Logger {
  function emit(level: string, message: string, exception?: string): void {
    const entry: Record<string, string> = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
    };
    if (exception) entry.exception = exception;
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    info(message: string) {
      emit("INFO", message);
    },
    warn(message: string) {
      emit("WARN", message);
    },
    error(message: string, err?: unknown) {
      const exception =
        err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : undefined;
      emit("ERROR", message, exception);
    },
  };
}
