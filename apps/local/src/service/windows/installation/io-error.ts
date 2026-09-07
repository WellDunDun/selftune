import * as Schema from "effect/Schema";

export class WindowsInstallationIOError extends Schema.TaggedErrorClass<WindowsInstallationIOError>()(
  "WindowsInstallationIOError",
  {
    operation: Schema.Literals([
      "read",
      "removeMatching",
      "openExclusive",
      "writeAndSync",
      "close",
      "makeDirectory",
      "readUtf8File",
      "removeFile",
      "rename",
      "randomBytes",
    ]),
    message: Schema.String,
    cause: Schema.Defect,
  },
) {
  static fromCause(operation: WindowsInstallationIOError["operation"], cause: unknown) {
    return new WindowsInstallationIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}
