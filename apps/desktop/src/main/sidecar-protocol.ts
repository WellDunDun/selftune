export const READY_SENTINEL = "SELFTUNE_READY:";

export function parseReadyPort(line: string): number | null {
  if (!line.startsWith(READY_SENTINEL)) return null;
  const port = Number.parseInt(line.slice(READY_SENTINEL.length), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function createLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let buffered = "";
  return (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}
import * as Schema from "effect/Schema";

export const SidecarHealth = Schema.Struct({
  pid: Schema.Number,
  runtime_instance_id: Schema.String,
  process_mode: Schema.Literal("standalone"),
  config_dir: Schema.String,
});
