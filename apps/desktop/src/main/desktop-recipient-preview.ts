/* oxlint-disable no-await-in-loop -- bounded response streams must be consumed sequentially */
import { dirname } from "node:path";

import { loadConfigSync } from "@selftune/config";
import {
  platformCredentialStore,
  type CredentialReference,
} from "@selftune/runtime/credential-store";
import * as Schema from "effect/Schema";

import type {
  DesktopPreviewResolution,
  DesktopRecipientPreview,
} from "./desktop-install-bootstrap";

const MAX_PREVIEW_RESPONSE_BYTES = 64 * 1_024;
const PREVIEW_REQUEST_TIMEOUT_MS = 15_000;

function strictStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const allowed = new Set(Object.keys(fields));
  return Schema.Record(Schema.String, Schema.Unknown)
    .check(
      Schema.makeFilter(
        (value) =>
          Object.keys(value).every((key) => allowed.has(key))
            ? undefined
            : "Unexpected Desktop preview property",
        { identifier: "StrictDesktopPreviewStruct" },
        true,
      ),
    )
    .pipe(Schema.decodeTo(Schema.Struct(fields)));
}

const Uuid = Schema.String.check(Schema.isUUID());
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const UtcTimestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const epochMillis = Date.parse(value);
    return Number.isFinite(epochMillis) && new Date(epochMillis).toISOString() === value
      ? undefined
      : "Expected a canonical UTC timestamp";
  }),
);
const Agent = Schema.Literals(["codex", "claude_code", "opencode", "openclaw", "pi"]);
const SignalField = Schema.Literals(["trigger", "grade", "miss_category"]);

const ContributorSignals = Schema.Union([
  strictStruct({
    _tag: Schema.Literal("signals_unavailable"),
    signalDisclosureSha256: Sha256,
    signalRecipientOrganizationId: Schema.Null,
    allowedFields: Schema.Tuple([]),
    capability: Schema.Literal("not_capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("not_applicable"),
    enabled: Schema.Literal(false),
  }),
  strictStruct({
    _tag: Schema.Literal("capable_default_off"),
    signalDisclosureSha256: Sha256,
    signalRecipientOrganizationId: Uuid,
    allowedFields: Schema.Array(SignalField).check(Schema.isNonEmpty()),
    capability: Schema.Literal("capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("not_granted"),
    enabled: Schema.Literal(false),
  }),
  strictStruct({
    _tag: Schema.Literal("capable_consented"),
    signalDisclosureSha256: Sha256,
    signalRecipientOrganizationId: Uuid,
    allowedFields: Schema.Array(SignalField).check(Schema.isNonEmpty()),
    capability: Schema.Literal("capable"),
    defaultState: Schema.Literal("off"),
    contributorConsent: Schema.Literal("granted"),
    enabled: Schema.Literal(true),
  }),
]);

const DesktopRecipientPreviewSchema = strictStruct({
  invitationId: Uuid,
  shareId: Uuid,
  distributionId: Uuid,
  sealedObjectId: Uuid,
  packagedSha256: Sha256,
  termsDisclosureSha256: Sha256,
  termsAcceptance: Schema.Literal("accepted"),
  contributorSignals: ContributorSignals,
  installLifecycleReporting: Schema.optional(
    strictStruct({
      _tag: Schema.Literal("installed_status"),
      lifecycleDisclosureSha256: Sha256,
      consent: Schema.Literal("not_granted"),
      senderVisibleInstalledStatus: Schema.Literal("disabled"),
    }),
  ),
  status: Schema.Literal("preview"),
  expiresAt: UtcTimestamp,
  supportedTargetAgents: Schema.Array(Agent).check(Schema.isNonEmpty()),
  targetAgentSelectionRequired: Schema.Literal(true),
  scopeChoices: Schema.Tuple([Schema.Literal("project"), Schema.Literal("global")]),
  scopeSelectionRequired: Schema.Literal(true),
  installModeDefault: Schema.Literal("copy"),
  conflictPolicyChoices: Schema.Tuple([
    Schema.Literal("prompt"),
    Schema.Literal("replace"),
    Schema.Literal("keep_both"),
  ]),
  conflictPolicyDefault: Schema.Literal("prompt"),
  customPathPolicy: Schema.Literal("unsupported_v1"),
  automaticDesktopInstall: Schema.Literal("not_authorized"),
  automaticSkillInstall: Schema.Literal("not_authorized"),
});

export interface SecureDesktopCloudSession {
  readonly origin: string;
  readonly accessToken: string;
}

interface DesktopCloudConfigLoaderDependencies {
  readonly loadConfig?: (path: string) => {
    readonly alpha?: {
      readonly enrolled: boolean;
      readonly cloud_api_url?: string;
      readonly credential?: CredentialReference;
    };
  } | null;
  readonly getCredential?: (reference: CredentialReference, configRoot: string) => string | null;
}

function selfTuneHttpsOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    const selfTuneHost = url.hostname === "selftune.dev" || url.hostname.endsWith(".selftune.dev");
    if (
      url.protocol !== "https:" ||
      !selfTuneHost ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Reads only credential metadata from config; secret bytes must come from an OS secure store. */
export function loadSecureDesktopCloudSession(
  configPath: string,
  dependencies: DesktopCloudConfigLoaderDependencies = {},
): SecureDesktopCloudSession | null {
  try {
    const config = (dependencies.loadConfig ?? loadConfigSync)(configPath);
    const alpha = config?.alpha;
    const reference = alpha?.credential;
    if (!alpha?.enrolled || !reference || reference.provider === "file") return null;
    const origin = selfTuneHttpsOrigin(alpha.cloud_api_url ?? "https://cloud.selftune.dev");
    if (!origin) return null;
    const configRoot = dirname(configPath);
    const accessToken = (
      dependencies.getCredential ?? ((next, root) => platformCredentialStore.get(next, root))
    )(reference, configRoot)?.trim();
    return accessToken ? { origin, accessToken } : null;
  } catch {
    return null;
  }
}

export interface DesktopRecipientPreviewResolverDependencies {
  readonly loadSession: () => SecureDesktopCloudSession | null;
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_RESPONSE_BYTES) {
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > MAX_PREVIEW_RESPONSE_BYTES) throw new Error("response_too_large");
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function terminalFailure(status: number, body: string): DesktopPreviewResolution {
  if (status === 410) {
    return { status: "error", code: "expired", message: "This install handoff has expired." };
  }
  if (status === 409) {
    try {
      Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ _tag: Schema.Literal("RecipientActionReplay") })),
      )(body);
      return { status: "error", code: "replay", message: "This install handoff was used." };
    } catch {
      // A malformed failure body remains a terminal, non-secret conflict.
    }
    return { status: "error", code: "forbidden", message: "This install handoff is unavailable." };
  }
  if (status === 400) {
    return { status: "error", code: "invalid", message: "This install handoff is invalid." };
  }
  if (status === 403 || status === 404) {
    return { status: "error", code: "forbidden", message: "This install handoff is unavailable." };
  }
  return { status: "error", code: "unavailable", message: "Install preview is unavailable." };
}

export function createDesktopRecipientPreviewResolver(
  dependencies: DesktopRecipientPreviewResolverDependencies,
): (token: string) => Promise<DesktopPreviewResolution> {
  const request = dependencies.fetch ?? fetch;
  return async (token) => {
    const session = dependencies.loadSession();
    if (!session) return { status: "unauthenticated" };
    const origin = selfTuneHttpsOrigin(session.origin);
    if (!origin) {
      return { status: "error", code: "unavailable", message: "Cloud origin is unavailable." };
    }
    try {
      const response = await request(`${origin}/api/v1/recipient-actions/desktop/preview`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bootstrapToken: token }),
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401) return { status: "unauthenticated" };
      const body = await readBoundedBody(response);
      if (response.status >= 300 && response.status < 400) {
        return { status: "error", code: "unavailable", message: "Cloud redirect was rejected." };
      }
      if (!response.ok) return terminalFailure(response.status, body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { status: "error", code: "invalid", message: "Cloud preview was invalid." };
      }
      try {
        const preview: DesktopRecipientPreview = Schema.decodeUnknownSync(
          DesktopRecipientPreviewSchema,
        )(parsed);
        return { status: "preview", preview };
      } catch {
        return { status: "error", code: "invalid", message: "Cloud preview was invalid." };
      }
    } catch {
      return { status: "error", code: "unavailable", message: "Install preview is unavailable." };
    }
  };
}
