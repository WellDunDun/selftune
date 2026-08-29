import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PLUGIN_CAPABILITY_BUNDLE_FORMAT = "selftune-plugin-capability-bundle-v1" as const;
export const PLUGIN_CAPABILITY_BUNDLE_VERSION = 1 as const;
export const AGENT_PLUGINS_V1_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Identifier = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  Schema.isMaxLength(64),
);
const StringRecord = Schema.Record(Schema.String, Schema.String);

export class PluginStdioMcpServer extends Schema.TaggedClass<PluginStdioMcpServer>()("stdio", {
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(StringRecord),
  cwd: Schema.optionalKey(Schema.String),
}) {}

export class PluginStreamableHttpMcpServer extends Schema.TaggedClass<PluginStreamableHttpMcpServer>()(
  "streamable-http",
  {
    url: Schema.String.check(Schema.isMinLength(1)),
    headers: Schema.optionalKey(StringRecord),
  },
) {}

export class PluginSseMcpServer extends Schema.TaggedClass<PluginSseMcpServer>()("sse", {
  url: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.optionalKey(StringRecord),
}) {}

export const PluginMcpServer = Schema.Union([
  PluginStdioMcpServer,
  PluginStreamableHttpMcpServer,
  PluginSseMcpServer,
]);
export type PluginMcpServer = typeof PluginMcpServer.Type;

export const PluginCapabilityRisk = Schema.Literals([
  "executable_commands",
  "remote_network",
  "credentials",
  "persistent_plugin_data",
]);
export type PluginCapabilityRisk = typeof PluginCapabilityRisk.Type;

export class PluginCapabilityReview extends Schema.Class<PluginCapabilityReview>(
  "PluginCapabilityReview",
)({
  reviewedAt: Schema.DateTimeUtcFromString,
  reviewedBy: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  acceptedRisks: Schema.Array(PluginCapabilityRisk),
}) {}

const PluginCapabilityBundleInput = Schema.Struct({
  bundleId: Identifier,
  skillSetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  skillSetRevisionSha256: Sha256,
  mcpServers: Schema.Record(Identifier, PluginMcpServer),
  review: PluginCapabilityReview,
});

export class PluginCapabilityBundle extends Schema.Class<PluginCapabilityBundle>(
  "PluginCapabilityBundle",
)({
  format: Schema.Literal(PLUGIN_CAPABILITY_BUNDLE_FORMAT),
  version: Schema.Literal(PLUGIN_CAPABILITY_BUNDLE_VERSION),
  bundleId: Identifier,
  skillSetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  skillSetRevisionSha256: Sha256,
  mcpServers: Schema.Record(Identifier, PluginMcpServer),
  review: PluginCapabilityReview,
}) {}

export const PluginCapabilityBundleErrorReason = Schema.Literals([
  "invalid_bundle",
  "reserved_environment_variable",
  "invalid_working_directory",
  "insecure_remote_url",
  "missing_risk_acceptance",
]);

export class PluginCapabilityBundleError extends Schema.TaggedErrorClass<PluginCapabilityBundleError>()(
  "PluginCapabilityBundleError",
  {
    reason: PluginCapabilityBundleErrorReason,
    message: Schema.String.check(Schema.isMaxLength(320)),
  },
) {}

function invalid(
  reason: typeof PluginCapabilityBundleErrorReason.Type,
  message: string,
): PluginCapabilityBundleError {
  return PluginCapabilityBundleError.make({ reason, message: message.slice(0, 320) });
}

function values(server: PluginMcpServer): ReadonlyArray<string> {
  if (server._tag === "stdio") {
    return [...(server.args ?? []), ...Object.values(server.env ?? {}), server.cwd ?? ""];
  }
  return [server.url, ...Object.values(server.headers ?? {})];
}

function usesCredentialPlaceholder(server: PluginMcpServer): boolean {
  return values(server).some((value) =>
    [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].some(
      (match) => match[1] !== "PLUGIN_ROOT" && match[1] !== "PLUGIN_DATA",
    ),
  );
}

function requiredRisks(servers: ReadonlyArray<PluginMcpServer>): Set<PluginCapabilityRisk> {
  const risks = new Set<PluginCapabilityRisk>();
  for (const server of servers) {
    if (server._tag === "stdio") risks.add("executable_commands");
    else risks.add("remote_network");
    if (usesCredentialPlaceholder(server)) risks.add("credentials");
    if (values(server).some((value) => value.includes("${PLUGIN_DATA}"))) {
      risks.add("persistent_plugin_data");
    }
  }
  return risks;
}

function validateServer(server: PluginMcpServer): Effect.Effect<void, PluginCapabilityBundleError> {
  if (server._tag === "stdio") {
    if (server.env && ("PLUGIN_ROOT" in server.env || "PLUGIN_DATA" in server.env)) {
      return Effect.fail(
        invalid(
          "reserved_environment_variable",
          "MCP servers cannot override PLUGIN_ROOT or PLUGIN_DATA",
        ),
      );
    }
    if (server.cwd) {
      const segments = server.cwd
        .replace(/^\.\//, "")
        .replace(/^\$\{PLUGIN_(?:ROOT|DATA)\}\/?/, "")
        .split("/");
      const hasSafeRoot =
        server.cwd.startsWith("./") || /^\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$)/.test(server.cwd);
      const escapesRoot =
        server.cwd.includes("\\") ||
        segments.some((segment) => segment === ".." || segment === ".");
      if (hasSafeRoot && !escapesRoot) return Effect.void;
      return Effect.fail(
        invalid(
          "invalid_working_directory",
          "MCP cwd must be plugin-relative or rooted at PLUGIN_ROOT or PLUGIN_DATA",
        ),
      );
    }
    return Effect.void;
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return Effect.fail(invalid("insecure_remote_url", "MCP remote URL is invalid"));
  }
  const localHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return url.protocol === "https:" || localHttp
    ? Effect.void
    : Effect.fail(
        invalid("insecure_remote_url", "Remote MCP servers must use HTTPS unless they are local"),
      );
}

export const makePluginCapabilityBundleUnknown = Effect.fn("PluginCapabilityBundle.make")(
  function* <Input>(input: Input) {
    const decoded = yield* Schema.decodeUnknownEffect(PluginCapabilityBundleInput)(input, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) =>
        invalid("invalid_bundle", `Invalid plugin capability bundle input: ${cause.message}`),
      ),
    );
    const servers = Object.values(decoded.mcpServers);
    if (servers.length === 0) {
      return yield* invalid("invalid_bundle", "A capability bundle requires at least one server");
    }
    yield* Effect.forEach(servers, validateServer, { concurrency: 1, discard: true });
    const accepted = new Set(decoded.review.acceptedRisks);
    const missing = [...requiredRisks(servers)].filter((risk) => !accepted.has(risk));
    if (missing.length > 0) {
      return yield* invalid(
        "missing_risk_acceptance",
        `Capability review must accept: ${missing.join(", ")}`,
      );
    }
    return PluginCapabilityBundle.make({
      format: PLUGIN_CAPABILITY_BUNDLE_FORMAT,
      version: PLUGIN_CAPABILITY_BUNDLE_VERSION,
      ...decoded,
    });
  },
);

export type PluginCapabilityBundleInput = typeof PluginCapabilityBundleInput.Encoded;
export const makePluginCapabilityBundle: (
  input: PluginCapabilityBundleInput,
) => Effect.Effect<PluginCapabilityBundle, PluginCapabilityBundleError> =
  makePluginCapabilityBundleUnknown;

export function projectPluginCapabilityFiles(
  bundle: PluginCapabilityBundle,
  target: "claude" | "openai" | "agent-plugins-v1",
): ReadonlyArray<{ readonly relativePath: string; readonly content: Uint8Array }> {
  const content =
    target === "agent-plugins-v1"
      ? {
          $schema: AGENT_PLUGINS_V1_MCP_SCHEMA,
          mcpServers: Object.fromEntries(
            Object.entries(bundle.mcpServers).map(([name, server]) => {
              const { _tag, ...configuration } = server;
              return [name, { type: _tag, ...configuration }];
            }),
          ),
        }
      : {
          mcpServers: Object.fromEntries(
            Object.entries(bundle.mcpServers).map(([name, server]) => {
              const { _tag, ...configuration } = server;
              return [name, { type: _tag === "streamable-http" ? "http" : _tag, ...configuration }];
            }),
          ),
        };
  return [
    {
      relativePath: target === "agent-plugins-v1" ? "mcp.json" : ".mcp.json",
      content: new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`),
    },
  ];
}
