import { getAlphaLinkState } from "./alpha-identity.js";
import type { AgentCommandGuidance, AlphaIdentity, AlphaLinkState } from "./types.js";

function sanitizeAlphaEmail(email?: string): string | null {
  const trimmed = email?.trim();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

function buildAlphaInitCommand(options?: { email?: string; force?: boolean }): string {
  const parts = ["selftune", "init", "--alpha"];
  const email = sanitizeAlphaEmail(options?.email);
  if (email) {
    parts.push("--alpha-email", email);
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
        "Alpha upload is not linked. Run the init command with --alpha to authenticate via browser.",
        buildAlphaInitCommand({ email: options?.email }),
        true,
        ["selftune status", "selftune doctor"],
      );
    case "linked_not_enrolled":
      return buildGuidance(
        "alpha_enrollment_incomplete",
        "Cloud account is linked but alpha enrollment is incomplete. Re-run init with --alpha to complete enrollment via browser.",
        buildAlphaInitCommand({ email: options?.email, force: true }),
        true,
        ["selftune status", "selftune doctor"],
      );
    case "enrolled_no_credential":
      return buildGuidance(
        "alpha_credential_required",
        "Alpha enrollment exists, but the local upload credential is missing or invalid. Re-run init with --alpha to re-authenticate via browser.",
        buildAlphaInitCommand({ email: options?.email, force: true }),
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
