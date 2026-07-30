export const FULLY_EFFECT_OWNED_COMMANDS: ReadonlyArray<string> = [
  "doctor",
  "status",
  "last",
  "quickstart",
  "telemetry",
  "recover",
  "badge",
  "export",
  "dashboard",
  "daemon",
  "service",
  "alpha",
  "eval",
  "uninstall",
  "verify",
  "create",
  "publish",
  "contribute",
  "contributions",
  "creator-contributions",
  "skills",
  "sets",
  "library",
  "workflows",
  "registry",
  "sync",
  "watch",
];
const FULLY_EFFECT_OWNED_COMMAND_SET: ReadonlySet<string> = new Set(FULLY_EFFECT_OWNED_COMMANDS);

export function isEffectCliInvocation(command: string, _args: ReadonlyArray<string>): boolean {
  return FULLY_EFFECT_OWNED_COMMAND_SET.has(command);
}
