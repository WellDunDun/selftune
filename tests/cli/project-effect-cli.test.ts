import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";

import type { ProjectAction } from "../../apps/cli/src/effect-cli/commands/project.js";
import { makeEffectCliTestProgram } from "../../apps/cli/src/effect-cli/program.js";

test("plans and configures multiple Skill Sets for an existing project", async () => {
  const calls: unknown[] = [];
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
