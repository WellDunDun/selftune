import * as Schema from "effect/Schema";

export const HookExecutionResult = Schema.Struct({
  exit_code: Schema.mutableKey(Schema.Number.check(Schema.isInt())),
  stdout: Schema.mutableKey(Schema.String),
  stderr: Schema.mutableKey(Schema.String),
});
export type HookExecutionResult = typeof HookExecutionResult.Type;

export const SILENT_HOOK_SUCCESS: HookExecutionResult = {
  exit_code: 0,
  stdout: "",
  stderr: "",
};

export function writeHookExecutionResult(result: HookExecutionResult): number {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exit_code;
}
