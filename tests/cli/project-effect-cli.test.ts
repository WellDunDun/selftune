import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";

import {
  type ProjectAction,
  type ProjectConfigurationInput,
  formatProjectResult,
} from "../../apps/cli/src/effect-cli/commands/project.js";
import type { ProjectConfigurationPlan } from "@selftune/runtime/project-provisioning";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";

test("plans and configures multiple Skill Sets for an existing project", async () => {
  const calls: Array<{
    operation: Parameters<ProjectAction>[0];
    input: ProjectConfigurationInput;
    json: boolean;
  }> = [];
  const action: ProjectAction = (operation, input, json) =>
    Effect.sync(() => calls.push({ operation, input, json }));

  await Effect.runPromise(
    makeEffectCliTestProgram(
      [
        "project",
        "plan",
        "--project",
        "/projects/react-app",
        "--set",
        "react",
        "--set",
        "testing",
        "--json",
      ],
      { projectAction: action },
    ).pipe(Effect.provide(BunServices.layer)),
  );
  await Effect.runPromise(
    makeEffectCliTestProgram(
      ["project", "init", "--project", "/projects/new-react-app", "--set", "react", "--yes"],
      { projectAction: action },
    ).pipe(Effect.provide(BunServices.layer)),
  );
  await Effect.runPromise(
    makeEffectCliTestProgram(
      ["project", "configure", "--project=/projects/react-app", "--set=react", "--set=testing"],
      { projectAction: action },
    ).pipe(Effect.provide(BunServices.layer)),
  );

  expect(calls).toEqual([
    {
      operation: "plan",
      input: { projectRoot: "/projects/react-app", skillSetIds: ["react", "testing"] },
      json: true,
    },
    {
      operation: "init",
      input: { projectRoot: "/projects/new-react-app", skillSetIds: ["react"] },
      json: false,
    },
    {
      operation: "configure",
      input: { projectRoot: "/projects/react-app", skillSetIds: ["react", "testing"] },
      json: false,
    },
  ]);
});

test("formats owned project plans and applied results without dropping JSON fields", () => {
  const plan: ProjectConfigurationPlan = {
    projectRoot: "/projects/react-app",
    skillSetPlans: [],
    creates: 3,
    unchanged: 2,
    conflicts: 0,
    missingDependencies: 1,
  };
  expect(formatProjectResult(plan, false)).toBe("3 create, 2 unchanged, 0 conflicts, 1 download.");
  expect(formatProjectResult({ ...plan, missingDependencies: 2 }, false)).toBe(
    "3 create, 2 unchanged, 0 conflicts, 2 downloads.",
  );
  expect(formatProjectResult(plan, true)).toBe(JSON.stringify(plan, null, 2));
  const configured = { plan, receipts: [] };
  expect(formatProjectResult(configured, false)).toBe(
    "Configured project: 3 create, 2 unchanged, 0 conflicts.",
  );
  expect(formatProjectResult(configured, true)).toBe(JSON.stringify(configured, null, 2));
});

test.each([
  {
    name: "project path",
    args: ["project", "plan", "--set", "react"],
    message: "--project is required",
  },
  {
    name: "initialization approval",
    args: ["project", "init", "--project", "/projects/new-app", "--set", "react"],
    message: "requires --yes",
  },
])("rejects missing $name before invoking project operations", async ({ args, message }) => {
  let calls = 0;
  const action: ProjectAction = () =>
    Effect.sync(() => {
      calls += 1;
    });
  await expect(
    Effect.runPromise(
      makeEffectCliTestProgram([...args], { projectAction: action }).pipe(
        Effect.provide(BunServices.layer),
      ),
    ),
  ).rejects.toThrow(message);
  expect(calls).toBe(0);
});
