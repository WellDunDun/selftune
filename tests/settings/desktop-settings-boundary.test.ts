import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDesktopSettings,
  updateDesktopSchedule,
} from "../../packages/runtime/desktop-settings";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-schedule-boundary-"));
  roots.push(root);
  const configDir = join(root, "config");
  const path = join(configDir, "schedule", "desktop-settings.json");
  mkdirSync(join(configDir, "schedule"), { recursive: true });
  const commands: string[] = [];
  return {
    path,
    commands,
    options: {
      homeDir: join(root, "home"),
      configDir,
      platform: "darwin" as const,
      binPath: "/fixture/selftune",
      run: (command: string) => {
        commands.push(command);
        return 1;
      },
    },
  };
}

test("saved job decoding preserves valid neighbors without enabling malformed jobs", () => {
  const { path, options, commands } = fixture();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      jobs: {
        "selftune-sync": { enabled: true, schedule: "*/15 * * * *", future_metadata: true },
        "selftune-status": { enabled: "true", schedule: "0 8 * * *" },
        "selftune-orchestrate": null,
        constructor: { enabled: true, schedule: "0 8 * * *" },
      },
    }),
  );
  const jobs = loadDesktopSettings(options).schedule.jobs;
  expect(jobs).toHaveLength(3);
  expect(jobs.find((job) => job.id === "selftune-sync")).toMatchObject({
    enabled: true,
    schedule: "*/15 * * * *",
  });
  expect(jobs.filter((job) => job.id !== "selftune-sync").every((job) => !job.enabled)).toBe(true);
  expect(commands).toEqual([]);
});

test.each(["null", "[]", "{", '{"version":2,"jobs":{}}', '{"version":1,"jobs":[]}'])(
  "malformed saved settings %s load disabled defaults",
  (saved) => {
    const { path, options } = fixture();
    writeFileSync(path, saved);
    const jobs = loadDesktopSettings(options).schedule.jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => !job.enabled)).toBe(true);
  },
);

test.each([
  { payload: "null" },
  { payload: '{"jobs":{}}' },
  { payload: '{"jobs":[{"id":"constructor","enabled":true,"schedule":"0 8 * * *"}]}' },
  { payload: '{"jobs":[{"id":"selftune-sync","enabled":"true","schedule":"0 8 * * *"}]}' },
  { payload: '{"jobs":[{"id":"selftune-sync","enabled":true,"schedule":12}]}' },
])("malformed update $payload cannot invoke the scheduler or persist settings", ({ payload }) => {
  const { path, options, commands } = fixture();
  expect(() => updateDesktopSchedule(JSON.parse(payload), options)).toThrow();
  expect(commands).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test("duplicate jobs are rejected before scheduler side effects", () => {
  const { path, options, commands } = fixture();
  expect(() =>
    updateDesktopSchedule(
      {
        jobs: [
          { id: "selftune-sync", enabled: true, schedule: "*/15 * * * *" },
          { id: "selftune-sync", enabled: true, schedule: "*/30 * * * *" },
          { id: "selftune-status", enabled: false, schedule: "0 8 * * *" },
        ],
      },
      options,
    ),
  ).toThrow("appears more than once");
  expect(commands).toEqual([]);
  expect(existsSync(path)).toBe(false);
});
