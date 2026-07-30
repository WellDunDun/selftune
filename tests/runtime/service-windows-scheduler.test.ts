import { describe, expect, it } from "bun:test";

import * as Effect from "effect/Effect";

import {
  makeWindowsTaskScheduler,
  parseSchtasksCsvTaskNames,
  parseSchtasksRunning,
  windowsSystemExecutable,
  type WindowsSchedulerCommandResult,
} from "@selftune/local/service/windows/scheduler";

const TASK = "SelfTuneDaemon";
const PRESENT = '"\\SelfTuneDaemon","N/A","Ready"';
const RUNNING = "Dernier resultat: 267009";
const STOPPED = "Last Result: 267014";

class SchedulerTestFailure extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.operation = operation;
  }
}

function result(code = 0, stdout = "", stderr = ""): WindowsSchedulerCommandResult {
  return { code, stderr, stdout };
}

function schedulerHarness(results: ReadonlyArray<WindowsSchedulerCommandResult>) {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly command: string }> = [];
  let index = 0;
  const scheduler = makeWindowsTaskScheduler({
    execute: (command, args) =>
      Effect.sync(() => {
        calls.push({ args, command });
        const next = results[index];
        index += 1;
        if (!next) throw new Error(`Unexpected scheduler call ${index}.`);
        return next;
      }),
    makeFailure: (operation, cause) => new SchedulerTestFailure(operation, cause),
    systemRoot: "D:\\Windows",
    taskName: TASK,
  });
  return { calls, scheduler };
}

describe("Windows Task Scheduler adapter", () => {
  it("resolves trusted Windows tools from System32 and rejects path traversal", () => {
    expect(windowsSystemExecutable("schtasks.exe", "D:\\Windows")).toBe(
      "D:\\Windows\\System32\\schtasks.exe",
    );
    expect(windowsSystemExecutable("netstat.exe", "relative-root")).toBe(
      "C:\\Windows\\System32\\netstat.exe",
    );
    expect(windowsSystemExecutable("taskkill.exe")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(windowsSystemExecutable("wscript.exe", "D:\\Windows\\")).toBe(
      "D:\\Windows\\System32\\wscript.exe",
    );
    expect(() => windowsSystemExecutable("..\\schtasks.exe", "D:\\Windows")).toThrow(
      "Invalid Windows system command",
    );
  });

  it("parses structured task inventory without depending on localized columns", () => {
    const output = [
      '\ufeff"\\SelfTuneDaemon","Nicht verfugbar","Bereit"',
      '"\\Folder\\SelfTuneDaemon","N/A","Ready"',
      '"\\Name, with comma","N/A","Ready"',
      '"\\Name ""quoted""","N/A","Ready"',
      "INFORMATION: Aucune tache planifiee n'est disponible.",
    ].join("\r\n");

    expect(parseSchtasksCsvTaskNames(output)).toEqual([
      "\\SelfTuneDaemon",
      "\\Folder\\SelfTuneDaemon",
      "\\Name, with comma",
      '\\Name "quoted"',
      "INFORMATION: Aucune tache planifiee n'est disponible.",
    ]);
    expect(() => parseSchtasksCsvTaskNames('"\\SelfTuneDaemon","unterminated')).toThrow(
      "Malformed schtasks CSV inventory row",
    );
  });

  it("lists task names through the locale-independent CSV inventory", async () => {
    const test = schedulerHarness([
      result(0, '"\\SelfTuneDaemon","N/A","Ready"\r\n"\\Other","N/A","Ready"'),
    ]);

    await expect(Effect.runPromise(test.scheduler.listTaskNames())).resolves.toEqual([
      "\\SelfTuneDaemon",
      "\\Other",
    ]);
    expect(test.calls).toEqual([
      {
        args: ["/query", "/fo", "CSV", "/nh"],
        command: "D:\\Windows\\System32\\schtasks.exe",
      },
    ]);
  });

  it("detects running state from locale-invariant scheduler result codes", () => {
    expect(parseSchtasksRunning("Dernier resultat: 267009")).toBe(true);
    expect(parseSchtasksRunning("Letztes Ergebnis: 0x00041301")).toBe(true);
    expect(parseSchtasksRunning("Last Result: 267014")).toBe(false);
    expect(parseSchtasksRunning("Last Result: 12670090")).toBe(false);
  });

  it("returns an absent task from inventory without issuing a targeted query", async () => {
    const test = schedulerHarness([result(0, '"\\OtherTask","N/A","Ready"')]);

    await expect(Effect.runPromise(test.scheduler.query())).resolves.toEqual({
      registered: false,
      running: false,
    });
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.command).toBe("D:\\Windows\\System32\\schtasks.exe");
  });

  it("fails inventory and targeted query errors instead of treating them as absence", async () => {
    const inventory = schedulerHarness([result(1, "", "Zugriff verweigert")]);
    await expect(Effect.runPromise(inventory.scheduler.query())).rejects.toMatchObject({
      operation: "query-task-inventory",
    });

    const malformed = schedulerHarness([result(0, '"\\SelfTuneDaemon","unterminated')]);
    await expect(Effect.runPromise(malformed.scheduler.listTaskNames())).rejects.toMatchObject({
      operation: "parse-task-inventory",
    });

    const detail = schedulerHarness([result(0, PRESENT), result(1, "", "Acces refuse")]);
    await expect(Effect.runPromise(detail.scheduler.query())).rejects.toMatchObject({
      operation: "query-task-detail",
    });
  });

  it("uses locale-invariant detail output for registered running state", async () => {
    const test = schedulerHarness([result(0, PRESENT), result(0, RUNNING)]);
    await expect(Effect.runPromise(test.scheduler.query())).resolves.toEqual({
      registered: true,
      running: true,
    });
  });

  it("reads XML definition only after inventory proves registration", async () => {
    const absent = schedulerHarness([result(0, '"\\OtherTask","N/A","Ready"')]);
    await expect(Effect.runPromise(absent.scheduler.readDefinition())).resolves.toBeNull();
    expect(absent.calls).toHaveLength(1);

    const xml = "<Task><Actions /></Task>";
    const present = schedulerHarness([result(0, PRESENT), result(0, xml)]);
    await expect(Effect.runPromise(present.scheduler.readDefinition())).resolves.toBe(xml);
    expect(present.calls).toHaveLength(2);
    expect(present.calls[1]?.args).toEqual(["/query", "/tn", TASK, "/xml"]);
    expect(
      present.calls.some(({ args }) =>
        args.some((argument) => ["/create", "/delete", "/end", "/run"].includes(argument)),
      ),
    ).toBe(false);
  });

  it("fails when a registered task definition cannot be read", async () => {
    const test = schedulerHarness([result(0, PRESENT), result(5, "", "Access denied")]);
    await expect(Effect.runPromise(test.scheduler.readDefinition())).rejects.toMatchObject({
      operation: "read-task-definition",
    });
  });

  it("skips end when the task is absent or already stopped", async () => {
    const absent = schedulerHarness([result(0, "")]);
    await Effect.runPromise(absent.scheduler.end());
    expect(absent.calls).toHaveLength(1);

    const stopped = schedulerHarness([result(0, PRESENT), result(0, STOPPED)]);
    await Effect.runPromise(stopped.scheduler.end());
    expect(stopped.calls).toHaveLength(2);
  });

  it("accepts a racing end error only when post-state proves the task stopped", async () => {
    const stopped = schedulerHarness([
      result(0, PRESENT),
      result(0, RUNNING),
      result(1, "", "Die Aufgabe wird nicht ausgefuhrt"),
      result(0, PRESENT),
      result(0, STOPPED),
    ]);
    await Effect.runPromise(stopped.scheduler.end());

    const stillRunning = schedulerHarness([
      result(0, PRESENT),
      result(0, RUNNING),
      result(1, "", "Zugriff verweigert"),
      result(0, PRESENT),
      result(0, RUNNING),
    ]);
    await expect(Effect.runPromise(stillRunning.scheduler.end())).rejects.toMatchObject({
      operation: "end-task",
    });
  });

  it("makes delete idempotent only when post-state proves absence", async () => {
    const absent = schedulerHarness([result(0, "")]);
    await Effect.runPromise(absent.scheduler.delete());
    expect(absent.calls).toHaveLength(1);

    const raced = schedulerHarness([
      result(0, PRESENT),
      result(0, STOPPED),
      result(1, "", "Die Datei wurde nicht gefunden"),
      result(0, ""),
    ]);
    await Effect.runPromise(raced.scheduler.delete());

    const denied = schedulerHarness([
      result(0, PRESENT),
      result(0, STOPPED),
      result(1, "", "Zugriff verweigert"),
      result(0, PRESENT),
      result(0, STOPPED),
    ]);
    await expect(Effect.runPromise(denied.scheduler.delete())).rejects.toMatchObject({
      operation: "delete-task",
    });
  });

  it("checks create and start exit codes without parsing messages", async () => {
    const create = schedulerHarness([result(5, "", "Access denied")]);
    await expect(
      Effect.runPromise(create.scheduler.create("C:\\state\\run-daemon.xml")),
    ).rejects.toMatchObject({ operation: "create-task" });

    const exclusive = schedulerHarness([result(0)]);
    await Effect.runPromise(exclusive.scheduler.createExclusive("C:\\state\\run-daemon.xml"));
    expect(exclusive.calls[0]?.args).toEqual([
      "/create",
      "/tn",
      TASK,
      "/xml",
      "C:\\state\\run-daemon.xml",
    ]);

    const start = schedulerHarness([result(0)]);
    await Effect.runPromise(start.scheduler.start());
    expect(start.calls[0]?.args).toEqual(["/run", "/tn", TASK]);
  });
});
