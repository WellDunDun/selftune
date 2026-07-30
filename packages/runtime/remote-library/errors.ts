import { CLIError } from "../utils/cli-error.js";

function remoteFailure(operation: string, cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : null;
  const message =
    cause !== null &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : "";
  if (tag === "RemoteLibraryUnavailable" && /HTTP (?:401|403)\b/.test(message)) {
    return new CLIError(
      `Sync & Backup credentials were rejected while ${operation}.`,
      "AUTH_MISSING",
      "Reconnect SelfTune Cloud or the self-hosted server, then apply the Skill Set again.",
    );
  }
  if (tag === "RemoteObjectMissing") {
    return new CLIError(
      `A pinned skill revision is no longer available from Sync & Backup while ${operation}.`,
      "FILE_NOT_FOUND",
      "Sync the Skill Set again from a machine that still has the pinned revision.",
    );
  }
  if (tag === "RemoteIntegrityFailure") {
    return new CLIError(
      `Sync & Backup rejected a skill revision during ${operation} because it failed integrity checks.`,
      "OPERATION_FAILED",
      "Retry the sync from a trusted machine before applying this Skill Set.",
    );
  }
  return new CLIError(
    `Sync & Backup could not be reached while ${operation}.`,
    "API_ERROR",
    "Check the connection and credentials, then apply the Skill Set again.",
    1,
    true,
  );
}

export async function fromRemote<A>(operation: string, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw remoteFailure(operation, cause);
  }
}
