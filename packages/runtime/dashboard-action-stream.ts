import { randomUUID } from "node:crypto";
import { formatWithOptions } from "node:util";
import { isFunction } from "effect/Predicate";
import {
  appendDashboardActionEvent,
  setCurrentDashboardActionContext,
} from "./dashboard-action-events.js";
import { resolveDashboardActionOutcome } from "./dashboard-action-result.js";
import type { DashboardActionName } from "./dashboard-contract.js";

const STREAM_DISABLE_ENV = "SELFTUNE_DASHBOARD_STREAM_DISABLE";

function readFlagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function detectDashboardAction(argv: string[]): {
  action: DashboardActionName;
  skillName: string | null;
  skillPath: string | null;
} | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    return null;
  }

  const [command, subcommand] = argv;

  if (command === "eval" && subcommand === "generate") {
    return {
      action: "generate-evals",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "eval" && subcommand === "unit-test" && hasFlag(argv, "--generate")) {
    return {
      action: "generate-unit-tests",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "grade" && subcommand === "baseline") {
    return {
      action: "measure-baseline",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "watch") {
    return {
      action: "watch",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "create" && subcommand === "replay") {
    return {
      action: "replay-dry-run",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "create" && subcommand === "check") {
    return {
      action: "create-check",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "create" && subcommand === "baseline") {
    return {
      action: "measure-baseline",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "create" && subcommand === "report") {
    return {
      action: "report-package",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "create" && subcommand === "publish") {
    return {
      action: hasFlag(argv, "--watch") ? "watch" : "deploy-candidate",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "verify") {
    return {
      action: "report-package",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "publish") {
    return {
      action: hasFlag(argv, "--no-watch") ? "deploy-candidate" : "watch",
      skillName: null,
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "search-run") {
    return {
      action: "search-run",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "orchestrate") {
    return {
      action: "orchestrate",
      skillName: null,
      skillPath: null,
    };
  }

  if (command === "run") {
    return {
      action: "orchestrate",
      skillName: null,
      skillPath: null,
    };
  }

  if (command === "evolve" && subcommand === "rollback") {
    return {
      action: "rollback",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "evolve" && (!subcommand || subcommand.startsWith("--"))) {
    return {
      action: hasFlag(argv, "--dry-run") ? "replay-dry-run" : "deploy-candidate",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  if (command === "improve") {
    return {
      action: hasFlag(argv, "--dry-run") ? "replay-dry-run" : "deploy-candidate",
      skillName: readFlagValue(argv, "--skill"),
      skillPath: readFlagValue(argv, "--skill-path"),
    };
  }

  return null;
}

function normalizeChunk(chunk: string | Uint8Array): string {
  return chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf-8") : chunk;
}

type WriteCallback = Parameters<typeof process.stdout.write>[2];

function mirrorWrite(
  write: typeof process.stdout.write,
  capture: (chunk: string) => void,
): typeof process.stdout.write {
  return (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ) => {
    capture(normalizeChunk(chunk));
    if (isFunction(encodingOrCallback)) return write(chunk, encodingOrCallback);
    if (encodingOrCallback === undefined) return write(chunk, callback);
    return write(chunk, encodingOrCallback, callback);
  };
}

export interface DashboardActionStreamSession {
  eventId: string;
  finish: (exitCode?: number | null) => void;
}

export function startDashboardActionStream(argv: string[]): DashboardActionStreamSession | null {
  if (process.env[STREAM_DISABLE_ENV] === "1") return null;

  const detected = detectDashboardAction(argv);
  if (!detected) return null;
  const { action, skillName, skillPath } = detected;

  const eventId = randomUUID();
  let finished = false;
  let lastError: string | null = null;
  let suppressChunkCapture = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  appendDashboardActionEvent({
    event_id: eventId,
    action,
    stage: "started",
    skill_name: skillName,
    skill_path: skillPath,
    ts: Date.now(),
  });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log.bind(console);
  const originalConsoleInfo = console.info.bind(console);
  const originalConsoleWarn = console.warn.bind(console);
  const originalConsoleError = console.error.bind(console);
  setCurrentDashboardActionContext({
    eventId,
    action,
    skillName,
    skillPath,
  });

  process.stdout.write = mirrorWrite(originalStdoutWrite, (chunk) => {
    if (!suppressChunkCapture) {
      stdoutBuffer += chunk;
      appendDashboardActionEvent({
        event_id: eventId,
        action,
        stage: "stdout",
        skill_name: skillName,
        skill_path: skillPath,
        ts: Date.now(),
        chunk,
      });
    }
  });

  process.stderr.write = mirrorWrite(originalStderrWrite, (normalized) => {
    if (!suppressChunkCapture) {
      stderrBuffer += normalized;
      if (normalized.trim()) {
        lastError = normalized.trim();
      }
      appendDashboardActionEvent({
        event_id: eventId,
        action,
        stage: "stderr",
        skill_name: skillName,
        skill_path: skillPath,
        ts: Date.now(),
        chunk: normalized,
      });
    }
  });

  function wrapConsole(
    stage: "stdout" | "stderr",
    originalMethod: typeof console.log,
  ): typeof console.log {
    return (...args: Parameters<typeof console.log>) => {
      const message = formatWithOptions({ colors: false }, ...args);
      if (message.trim()) {
        if (stage === "stderr") {
          stderrBuffer += `${message}\n`;
          lastError = message.trim();
        } else {
          stdoutBuffer += `${message}\n`;
        }
        appendDashboardActionEvent({
          event_id: eventId,
          action,
          stage,
          skill_name: skillName,
          skill_path: skillPath,
          ts: Date.now(),
          chunk: `${message}\n`,
        });
      }
      suppressChunkCapture = true;
      try {
        originalMethod(...args);
      } finally {
        suppressChunkCapture = false;
      }
    };
  }

  console.log = wrapConsole("stdout", originalConsoleLog);
  console.info = wrapConsole("stdout", originalConsoleInfo);
  console.warn = wrapConsole("stderr", originalConsoleWarn);
  console.error = wrapConsole("stderr", originalConsoleError);

  const exitListener = (code: number) => {
    finish(code);
  };

  function finish(exitCode?: number | null): void {
    if (finished) return;
    finished = true;
    process.removeListener("exit", exitListener);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    setCurrentDashboardActionContext(null);
    const outcome = resolveDashboardActionOutcome({
      action,
      stdout: stdoutBuffer,
      stderr: stderrBuffer || lastError,
      exitCode: exitCode ?? 0,
    });
    appendDashboardActionEvent({
      event_id: eventId,
      action,
      stage: "finished",
      skill_name: skillName,
      skill_path: skillPath,
      ts: Date.now(),
      success: outcome.success,
      exit_code: exitCode ?? 0,
      error: outcome.error,
      summary: outcome.summary,
    });
  }

  process.once("exit", exitListener);

  return { eventId, finish };
}
