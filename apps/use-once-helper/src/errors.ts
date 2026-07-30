export type UseOnceHelperErrorCode =
  | "AUTHORITY_SEAM_UNAVAILABLE"
  | "AUTHORITY_REQUEST_FAILED"
  | "AUTHORITY_REPLAY"
  | "AUTHORITY_EXPIRED"
  | "AUTHORITY_DENIED"
  | "INVALID_ARGUMENTS"
  | "INVALID_AUTHORITY_RESPONSE"
  | "EXPIRED"
  | "TERMS_REFUSED"
  | "PACKAGE_HASH_MISMATCH"
  | "PACKAGE_INVALID"
  | "WORKSPACE_UNSAFE"
  | "AGENT_EXECUTION_FAILED";

export class UseOnceHelperError extends Error {
  readonly name = "UseOnceHelperError";

  constructor(
    readonly code: UseOnceHelperErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
