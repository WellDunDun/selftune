import { getAlphaLinkState } from "./alpha-identity.js";
import type { AgentCommandGuidance, AlphaIdentity, AlphaLinkState } from "./types.js";

function emailArg(email?: string): string {
  return email?.trim() ? email : "<email>";
}

function buildAlphaInitCommand(options?: {
  email?: string;
  includeKey?: boolean;
  force?: boolean;
}): string {
  const parts = ["selftune", "init", "--alpha", "--alpha-email", emailArg(options?.email)];
  if (options?.includeKey) {
    parts.push("--alpha-key", "<st_live_key>");
  }
  if (options?.force) {
    parts.push("--force");
  }
  return parts.join(" ");
}

function buildGuidance(
  code: string,
  message: string,
  nextCommand: string,
  blocking: boolean,
  suggestedCommands: string[],
): AgentCommandGuidance {
  return {
    code,
    message,
    next_command: nextCommand,
    suggested_commands: suggestedCommands,
    blocking,
  };
}

export function getAlphaGuidanceForState(
  state: AlphaLinkState,
  options?: { email?: string },
): AgentCommandGuidance {
  switch (state) {
    case "not_linked":
      return buildGuidance(
        "alpha_cloud_link_required",
        "Alpha upload is not linked. Sign in to app.selftune.dev, enroll in alpha, mint an st_live_* credential, then store it locally.",
        buildAlphaInitCommand({ email: options?.email, includeKey: true }),
        true,
        ["selftune status", "selftune doctor"],
      );
    case "linked_not_enrolled":
      return buildGuidance(
        "alpha_enrollment_incomplete",
        "Cloud account is linked but alpha enrollment is incomplete. Finish enrollment in app.selftune.dev, then refresh the local credential.",
        buildAlphaInitCommand({ email: options?.email, includeKey: true, force: true }),
        true,
        ["selftune status", "selftune doctor"],
      );
    case "enrolled_no_credential":
      return buildGuidance(
        "alpha_credential_required",
        "Alpha enrollment exists, but the local upload credential is missing or invalid.",
        buildAlphaInitCommand({ email: options?.email, includeKey: true, force: true }),
        true,
        ["selftune status", "selftune doctor"],
      );
    case "ready":
      return buildGuidance(
        "alpha_upload_ready",
        "Alpha upload is configured and ready.",
        "selftune alpha upload",
        false,
        ["selftune status", "selftune doctor"],
      );
  }
}

export function getAlphaGuidance(identity: AlphaIdentity | null): AgentCommandGuidance {
  if (!identity) {
    return getAlphaGuidanceForState("not_linked");
  }
  return getAlphaGuidanceForState(getAlphaLinkState(identity), { email: identity.email });
}

export function formatGuidanceLines(
  guidance: AgentCommandGuidance,
  options?: { indent?: string },
): string[] {
  const indent = options?.indent ?? "  ";
  const lines = [`${indent}Next command:       ${guidance.next_command}`];
  if (guidance.suggested_commands.length > 0) {
    lines.push(`${indent}Suggested commands: ${guidance.suggested_commands.join(", ")}`);
  }
  return lines;
}
