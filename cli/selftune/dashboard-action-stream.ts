import { randomUUID } from "node:crypto";
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

  if (command === "orchestrate") {
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

  return null;
}

function normalizeChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  return String(chunk);
}

export interface DashboardActionStreamSession {
  eventId: string;
  finish: (exitCode?: number | null) => void;
}

export function startDashboardActionStream(argv: string[]): DashboardActionStreamSession | null {
  if (process.env[STREAM_DISABLE_ENV] === "1") return null;

  const detected = detectDashboardAction(argv);
  if (!detected) return null;

  const eventId = randomUUID();
  let finished = false;
  let lastError: string | null = null;
  let suppressChunkCapture = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  appendDashboardActionEvent({
    event_id: eventId,
    action: detected.action,
    stage: "started",
    skill_name: detected.skillName,
    skill_path: detected.skillPath,
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
    action: detected.action,
    skillName: detected.skillName,
    skillPath: detected.skillPath,
  });

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    if (!suppressChunkCapture) {
      stdoutBuffer += normalizeChunk(chunk);
      appendDashboardActionEvent({
        event_id: eventId,
        action: detected.action,
        stage: "stdout",
        skill_name: detected.skillName,
        skill_path: detected.skillPath,
        ts: Date.now(),
        chunk: normalizeChunk(chunk),
      });
    }
    return originalStdoutWrite(chunk as never, ...(args as []));
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const normalized = normalizeChunk(chunk);
    if (!suppressChunkCapture) {
      stderrBuffer += normalized;
      if (normalized.trim()) {
        lastError = normalized.trim();
      }
      appendDashboardActionEvent({
        event_id: eventId,
        action: detected.action,
        stage: "stderr",
        skill_name: detected.skillName,
        skill_path: detected.skillPath,
        ts: Date.now(),
        chunk: normalized,
      });
    }
    return originalStderrWrite(chunk as never, ...(args as []));
  }) as typeof process.stderr.write;

  function wrapConsole(
    stage: "stdout" | "stderr",
    originalMethod: typeof console.log,
  ): typeof console.log {
    return (...args: unknown[]) => {
      const message = args
        .map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg)))
        .join(" ");
      if (message.trim()) {
        if (stage === "stderr") {
          stderrBuffer += `${message}\n`;
          lastError = message.trim();
        } else {
          stdoutBuffer += `${message}\n`;
        }
        appendDashboardActionEvent({
          event_id: eventId,
          action: detected.action,
          stage,
          skill_name: detected.skillName,
          skill_path: detected.skillPath,
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
      action: detected.action,
      stdout: stdoutBuffer,
      stderr: stderrBuffer || lastError,
      exitCode: exitCode ?? 0,
    });
    appendDashboardActionEvent({
      event_id: eventId,
      action: detected.action,
      stage: "finished",
      skill_name: detected.skillName,
      skill_path: detected.skillPath,
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
