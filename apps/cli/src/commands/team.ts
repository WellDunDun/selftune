import { CLIError } from "@selftune/runtime/utils/cli-error";
import {
  HostedSkillSetPublishIntentReceipt,
  HostedSkillSetPublishUploadReceipt,
  HostedSkillSetContributionUploadIntentReceipt,
  HostedSkillSetContributionUploadReceipt,
} from "@selftune/control-plane";
import { Option, Schema } from "effect";

const ApiPayload = Schema.Record(Schema.String, Schema.Json);
const ApiError = Schema.Struct({ error: Schema.optionalKey(Schema.String) });

function receipt<A>(schema: Schema.Codec<A>, payload: typeof Schema.Json.Type): A {
  try {
    return Schema.decodeUnknownSync(schema)(payload);
  } catch {
    throw new CLIError("Team API returned an invalid receipt.", "OPERATION_FAILED");
  }
}

async function readPayload(response: Response) {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(ApiPayload))(
    await response.text(),
  );
  if (!response.ok) {
    const detail = Option.isSome(result)
      ? Schema.decodeUnknownOption(ApiError)(result.value)
      : Option.none();
    const message = Option.isSome(result)
      ? Option.isSome(detail)
        ? (detail.value.error ?? "unknown")
        : "unknown"
      : "invalid_response";
    throw new CLIError(
      `Team API failed (${response.status}): ${message}`,
      response.status === 401 || response.status === 403 ? "AUTH_MISSING" : "OPERATION_FAILED",
    );
  }
  if (Option.isNone(result)) {
    throw new CLIError("Team API returned an invalid response.", "OPERATION_FAILED");
  }
  return result.value;
}

type Flags = Readonly<Record<string, string | boolean>>;
export type TeamCommandDependencies = {
  readonly env: Record<string, string | undefined>;
  readonly stdin: () => Promise<string>;
  readonly fetch: typeof fetch;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};
const live: TeamCommandDependencies = {
  env: process.env,
  stdin: () => Bun.stdin.text(),
  fetch,
  readFile: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function parse(args: readonly string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--"))
      throw new CLIError(`Unexpected argument: ${value}`, "INVALID_ARGUMENT");
    const [rawName, inline] = value.slice(2).split("=", 2);
    if (rawName === "token")
      throw new CLIError(
        "Tokens are accepted only through the environment or --token-stdin.",
        "INVALID_ARGUMENT",
      );
    if (inline !== undefined) flags[rawName!] = inline;
    else if (args[index + 1] && !args[index + 1]!.startsWith("--"))
      flags[rawName!] = args[++index]!;
    else flags[rawName!] = true;
  }
  return flags;
}
function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (!Schema.is(Schema.String)(value) || value.length === 0)
    throw new CLIError(`Missing --${name}.`, "MISSING_FLAG");
  return value;
}
async function token(
  flags: Flags,
  dependencies: TeamCommandDependencies,
  device = false,
): Promise<string> {
  const value = flags["token-stdin"]
    ? (await dependencies.stdin()).trim()
    : dependencies.env[device ? "SELFTUNE_DEVICE_TOKEN" : "SELFTUNE_SERVICE_TOKEN"];
  if (!value)
    throw new CLIError(
      `Set ${device ? "SELFTUNE_DEVICE_TOKEN" : "SELFTUNE_SERVICE_TOKEN"} or pipe it with --token-stdin.`,
      "MISSING_FLAG",
    );
  return value;
}
function endpoint(dependencies: TeamCommandDependencies, path: string): string {
  const base = dependencies.env.SELFTUNE_CLOUD_URL?.replace(/\/$/, "");
  if (!base) throw new CLIError("Set SELFTUNE_CLOUD_URL.", "MISSING_FLAG");
  return `${base}${path}`;
}
async function request(
  dependencies: TeamCommandDependencies,
  path: string,
  bearer: string,
  body: typeof Schema.Json.Type,
) {
  const response = await dependencies.fetch(endpoint(dependencies, path), {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readPayload(response);
}
function mutationConfirmed(flags: Flags): void {
  if (flags.yes !== true)
    throw new CLIError(
      "This changes authoritative team state. Review the command, then rerun with --yes.",
      "GUARD_BLOCKED",
    );
}
function output(
  dependencies: TeamCommandDependencies,
  flags: Flags,
  result: typeof Schema.Json.Type,
) {
  dependencies.stdout(flags.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

function uploadBody(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

export async function runTeamCommand(
  argv: readonly string[],
  dependencies: TeamCommandDependencies = live,
): Promise<number> {
  try {
    const [operation, ...rawFlags] = argv;
    if (!operation || operation === "help" || operation === "--help") {
      dependencies.stdout(
        "Usage: selftune team <publish|assign|status|contribute|promote|deprecate|rollback> [options]",
      );
      return 0;
    }
    const flags = parse(rawFlags);
    const device = operation === "contribute";
    const bearer = await token(flags, dependencies, device);
    if (operation === "status") {
      output(
        dependencies,
        flags,
        await request(dependencies, "/api/v1/service/skill-sets/status", bearer, {
          release_id: required(flags, "release-id"),
        }),
      );
      return 0;
    }
    mutationConfirmed(flags);
    if (operation === "publish") {
      const bytes = await dependencies.readFile(required(flags, "envelope"));
      const intent = receipt(
        HostedSkillSetPublishIntentReceipt,
        await request(dependencies, "/api/v1/service/skill-sets/publish-intent", bearer, {
          skill_set_id: required(flags, "skill-set-id"),
          skill_set_revision_sha256: required(flags, "revision-sha256"),
          envelope_sha256: required(flags, "envelope-sha256"),
          byte_length: bytes.byteLength,
        }),
      );
      const upload = await dependencies.fetch(intent.upload_url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: uploadBody(bytes),
      });
      if (!upload.ok) throw new CLIError(`Upload failed (${upload.status}).`, "OPERATION_FAILED");
      const stored = receipt(HostedSkillSetPublishUploadReceipt, await readPayload(upload));
      output(
        dependencies,
        flags,
        await request(dependencies, "/api/v1/service/skill-sets/finalize", bearer, {
          publish_intent_id: intent.publish_intent_id,
          storage_id: stored.storageId,
        }),
      );
      return 0;
    }
    if (operation === "assign" || operation === "rollback") {
      const assignment = {
        request_id: required(flags, "request-id"),
        release_id: required(flags, "release-id"),
        target_member_id: required(flags, "member-id"),
        target_device_id: required(flags, "device-id"),
        update_policy: Schema.is(Schema.String)(flags["update-policy"])
          ? flags["update-policy"]
          : "ask_before_updating",
      };
      const body =
        operation === "rollback"
          ? { ...assignment, reason: required(flags, "reason") }
          : assignment;
      output(
        dependencies,
        flags,
        await request(dependencies, `/api/v1/service/skill-sets/${operation}`, bearer, body),
      );
      return 0;
    }
    if (operation === "contribute") {
      const bytes = await dependencies.readFile(required(flags, "envelope"));
      const declaration = {
        request_id: required(flags, "request-id"),
        skill_set_id: required(flags, "skill-set-id"),
        base_release_id: required(flags, "base-release-id"),
        proposed_skill_set_revision_sha256: required(flags, "revision-sha256"),
        proposed_envelope_sha256: required(flags, "envelope-sha256"),
        proposed_byte_length: bytes.byteLength,
        title: required(flags, "title"),
        message: Schema.is(Schema.String)(flags.message) ? flags.message : "",
      };
      const intent = receipt(
        HostedSkillSetContributionUploadIntentReceipt,
        await request(
          dependencies,
          "/api/v1/desktop/contributions/upload-intent",
          bearer,
          declaration,
        ),
      );
      const upload = await dependencies.fetch(intent.upload_url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: uploadBody(bytes),
      });
      if (!upload.ok) throw new CLIError(`Upload failed (${upload.status}).`, "OPERATION_FAILED");
      const stored = receipt(HostedSkillSetContributionUploadReceipt, await readPayload(upload));
      output(
        dependencies,
        flags,
        await request(dependencies, "/api/v1/desktop/contributions/finalize", bearer, {
          ...declaration,
          storage_id: stored.storageId,
        }),
      );
      return 0;
    }
    if (operation === "promote" || operation === "deprecate") {
      output(
        dependencies,
        flags,
        await request(dependencies, `/api/v1/service/skill-sets/${operation}`, bearer, {
          release_id: required(flags, "release-id"),
          ...(operation === "promote"
            ? {
                expected_skill_set_revision_sha256: required(flags, "revision-sha256"),
                expected_envelope_sha256: required(flags, "envelope-sha256"),
              }
            : { reason: required(flags, "reason") }),
        }),
      );
      return 0;
    }
    throw new CLIError(`Unknown team operation: ${operation}`, "INVALID_ARGUMENT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message);
    if (
      error instanceof CLIError &&
      (error.code === "MISSING_FLAG" ||
        error.code === "INVALID_ARGUMENT" ||
        error.code === "GUARD_BLOCKED")
    )
      return 2;
    if (error instanceof CLIError && error.code === "AUTH_MISSING") return 3;
    return 1;
  }
}
