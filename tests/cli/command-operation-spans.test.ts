import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  runLibraryActionWithDependencies,
  type LibraryActionDependencies,
} from "../../apps/cli/src/effect-cli/commands/library.js";

test("reused command operations retain per-call arguments, laziness, and trace names", async () => {
  let loads = 0;
  const spans: string[] = [];
  const outputs: string[] = [];
  const exits: number[] = [];
  const dependencies: LibraryActionDependencies = {
    loadModule: async () => {
      loads++;
      return {
        runLibraryProgram: (input) =>
          Effect.currentSpan.pipe(
            Effect.map((span) => {
              spans.push(span.name);
              return {
                text: input.operation,
              };
            }),
            Effect.orDie,
          ),
        formatLibraryResult: (result) => result.text,
      };
    },
    print: (output) => {
      outputs.push(output);
    },
    setExitCode: (code) => {
      exits.push(code);
    },
  };
  const list = runLibraryActionWithDependencies({ operation: "list" }, dependencies);
  const status = runLibraryActionWithDependencies({ operation: "status" }, dependencies);
  expect(loads).toBe(0);
  await Effect.runPromise(list);
  await Effect.runPromise(status);
  expect(loads).toBe(2);
  expect(spans).toEqual(["selftune.cli.library.list", "selftune.cli.library.status"]);
  expect(outputs).toEqual(["list", "status"]);
  expect(exits).toEqual([0, 0]);
});
