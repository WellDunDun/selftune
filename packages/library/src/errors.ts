export type LibraryErrorCode =
  | "INVALID_FLAG"
  | "MISSING_FLAG"
  | "FILE_NOT_FOUND"
  | "GUARD_BLOCKED"
  | "OPERATION_FAILED";

export class LibraryError extends Error {
  readonly name = "LibraryError";

  constructor(
    message: string,
    readonly code: LibraryErrorCode,
    readonly suggestion?: string,
    readonly exitCode: number = 1,
    readonly retryable: boolean = false,
  ) {
    super(message);
  }

  toJSON() {
    const error = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    return { error: this.suggestion ? { ...error, suggestion: this.suggestion } : error };
  }
}
