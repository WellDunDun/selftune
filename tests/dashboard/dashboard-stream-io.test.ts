import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { startDashboardActionStream } from "../../packages/runtime/dashboard-action-stream.js";
import { decodeDashboardActionLine } from "../../packages/runtime/dashboard-contract/action-events.js";
import { readJsonl } from "../../packages/runtime/utils/jsonl.js";

const roots: string[] = [];
const previousLog = process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousLog === undefined) delete process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG;
  else process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = previousLog;
});

function logPath() {
  const root = mkdtempSync(join(tmpdir(), "selftune-stream-io-"));
  roots.push(root);
  const path = join(root, "events.jsonl");
  process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG = path;
  return path;
}

test("mirrors bytes and text while preserving callback overloads and backpressure", async () => {
  const path = logPath();
  const original = process.stdout.write;
  const output: string[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      output.push(String(chunk));
      queueMicrotask(done);
    },
  });
  process.stdout.write = sink.write.bind(sink);
  const session = startDashboardActionStream(["watch", "--skill", "test"]);
  const accepted: boolean[] = [];
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        accepted.push(
          process.stdout.write(Buffer.from("bytes\n"), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      }),
      new Promise<void>((resolve, reject) => {
        accepted.push(
          process.stdout.write("text\n", "utf8", (error) => (error ? reject(error) : resolve())),
        );
      }),
      new Promise<void>((resolve, reject) => {
        accepted.push(
          process.stdout.write(new TextEncoder().encode("array\n"), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      }),
    ]);
  } finally {
    session?.finish(0);
    process.stdout.write = original;
    sink.destroy();
  }
  expect(accepted).toEqual([false, false, false]);
  expect(output).toEqual(["bytes\n", "text\n", "array\n"]);
  expect(
    readJsonl(path, decodeDashboardActionLine)
      .filter((event) => event.stage === "stdout")
      .map((event) => event.chunk),
  ).toEqual(output);
});

test("captures formatted console messages once and finish remains idempotent", () => {
  const path = logPath();
  const session = startDashboardActionStream(["watch", "--skill", "test"]);
  try {
    console.log("Completed %d of %d", 2, 3);
  } finally {
    session?.finish(0);
    session?.finish(0);
  }
  const events = readJsonl(path, decodeDashboardActionLine);
  expect(events.map((event) => event.stage)).toEqual(["started", "stdout", "finished"]);
  expect(events[1]?.chunk).toBe("Completed 2 of 3\n");
  console.log("Outside the finished action");
  expect(readJsonl(path, decodeDashboardActionLine)).toEqual(events);
});
