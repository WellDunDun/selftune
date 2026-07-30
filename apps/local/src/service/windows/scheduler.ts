import { win32 } from "node:path";

import * as Effect from "effect/Effect";

const DEFAULT_WINDOWS_ROOT = "C:\\Windows";
const SCHED_S_TASK_RUNNING = 267_009;

export interface WindowsSchedulerCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface WindowsScheduledTaskState {
  readonly registered: boolean;
  readonly running: boolean;
}

export interface WindowsTaskScheduler<E> {
  readonly create: (xmlPath: string) => Effect.Effect<void, E>;
  readonly createExclusive: (xmlPath: string) => Effect.Effect<void, E>;
  readonly delete: () => Effect.Effect<void, E>;
  readonly end: () => Effect.Effect<void, E>;
  readonly listTaskNames: () => Effect.Effect<ReadonlyArray<string>, E>;
  readonly query: () => Effect.Effect<WindowsScheduledTaskState, E>;
  readonly readDefinition: () => Effect.Effect<string | null, E>;
  readonly start: () => Effect.Effect<void, E>;
}

export interface WindowsTaskSchedulerOptions<E> {
  readonly execute: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<WindowsSchedulerCommandResult, E>;
  readonly makeFailure: (operation: string, cause: unknown) => E;
  readonly systemRoot?: string;
  readonly taskName: string;
}

function validSystemCommand(command: string): boolean {
  return (
    command.length > 0 &&
    command !== "." &&
    command !== ".." &&
    win32.basename(command) === command &&
    /^[A-Za-z0-9_.-]+$/.test(command)
  );
}

export function windowsSystemExecutable(command: string, systemRoot?: string): string {
  if (!validSystemCommand(command)) {
    throw new TypeError(`Invalid Windows system command: ${command}`);
  }
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : DEFAULT_WINDOWS_ROOT;
  return win32.join(win32.normalize(root), "System32", command);
}

function parseCsvRow(line: string): ReadonlyArray<string> | null {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') {
        current += character;
        continue;
      }
      if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"' && current.length === 0) {
      quoted = true;
    } else if (character === ",") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) return null;
  fields.push(current);
  return fields;
}

export function parseSchtasksCsvTaskNames(output: string): ReadonlyArray<string> {
  const names: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/^\ufeff/, "").trim();
    if (line.length === 0) continue;
    const fields = parseCsvRow(line);
    if (fields === null) throw new TypeError("Malformed schtasks CSV inventory row.");
    const name = fields?.[0]?.trim();
    if (name) names.push(name);
  }
  return names;
}

export function parseSchtasksRunning(output: string): boolean {
  return new RegExp(`\\b(?:${SCHED_S_TASK_RUNNING}|0x0*41301)\\b`, "i").test(output);
}

function canonicalTaskName(taskName: string): string {
  const normalized = taskName.trim().replaceAll("/", "\\").replace(/^\\+/, "");
  return `\\${normalized}`.toLocaleLowerCase("en-US");
}

function commandFailureMessage(action: string, result: WindowsSchedulerCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail
    ? `schtasks ${action} failed (exit ${result.code}): ${detail}`
    : `schtasks ${action} failed (exit ${result.code}).`;
}

export function makeWindowsTaskScheduler<E>(
  options: WindowsTaskSchedulerOptions<E>,
): WindowsTaskScheduler<E> {
  const executable = windowsSystemExecutable("schtasks.exe", options.systemRoot);
  const taskPath = canonicalTaskName(options.taskName);
  const run = (args: ReadonlyArray<string>) => options.execute(executable, args);
  const failCommand = (operation: string, action: string, result: WindowsSchedulerCommandResult) =>
    Effect.fail(options.makeFailure(operation, commandFailureMessage(action, result)));

  const listTaskNames = Effect.fn("SelfTuneService.windowsScheduler.listTaskNames")(function* () {
    const inventory = yield* run(["/query", "/fo", "CSV", "/nh"]);
    if (inventory.code !== 0) {
      return yield* failCommand("query-task-inventory", "/query", inventory);
    }
    return yield* Effect.try({
      try: () => parseSchtasksCsvTaskNames(inventory.stdout),
      catch: (cause) => options.makeFailure("parse-task-inventory", cause),
    });
  });

  const isRegistered = Effect.fn("SelfTuneService.windowsScheduler.isRegistered")(function* () {
    return (yield* listTaskNames()).some((name) => canonicalTaskName(name) === taskPath);
  });

  const query = Effect.fn("SelfTuneService.windowsScheduler.query")(function* () {
    const registered = yield* isRegistered();
    if (!registered) return { registered: false, running: false };

    const detail = yield* run(["/query", "/tn", options.taskName, "/fo", "LIST", "/v"]);
    if (detail.code !== 0) {
      return yield* failCommand("query-task-detail", "/query /tn", detail);
    }
    return { registered: true, running: parseSchtasksRunning(detail.stdout) };
  });

  const checked = Effect.fn("SelfTuneService.windowsScheduler.checked")(function* (
    operation: string,
    action: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* run(args);
    if (result.code !== 0) return yield* failCommand(operation, action, result);
  });

  return {
    create: (xmlPath) =>
      checked("create-task", "/create", [
        "/create",
        "/tn",
        options.taskName,
        "/xml",
        xmlPath,
        "/f",
      ]),
    createExclusive: (xmlPath) =>
      checked("create-task-exclusive", "/create", [
        "/create",
        "/tn",
        options.taskName,
        "/xml",
        xmlPath,
      ]),
    delete: () =>
      Effect.gen(function* () {
        const before = yield* query();
        if (!before.registered) return;
        const result = yield* run(["/delete", "/tn", options.taskName, "/f"]);
        const after = yield* query();
        if (!after.registered) return;
        return yield* failCommand("delete-task", "/delete", result);
      }),
    end: () =>
      Effect.gen(function* () {
        const before = yield* query();
        if (!before.registered || !before.running) return;
        const result = yield* run(["/end", "/tn", options.taskName]);
        const after = yield* query();
        if (!after.registered || !after.running) return;
        return yield* failCommand("end-task", "/end", result);
      }),
    listTaskNames,
    query,
    readDefinition: () =>
      Effect.gen(function* () {
        if (!(yield* isRegistered())) return null;
        const definition = yield* run(["/query", "/tn", options.taskName, "/xml"]);
        if (definition.code !== 0) {
          return yield* failCommand("read-task-definition", "/query /tn /xml", definition);
        }
        return definition.stdout;
      }),
    start: () => checked("start-task", "/run", ["/run", "/tn", options.taskName]),
  };
}
