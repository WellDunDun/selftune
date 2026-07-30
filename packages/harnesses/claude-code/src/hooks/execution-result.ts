export interface HookExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

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
