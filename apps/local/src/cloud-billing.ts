import * as Schema from "effect/Schema";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import type {
  DesktopBillingCheckoutFinalizeRequest,
  DesktopBillingCheckoutRequest,
  DesktopBillingCheckoutFinalizeResult,
  DesktopBillingSession,
  DesktopBillingStatus,
} from "@selftune/runtime/dashboard-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

const PlanId = Schema.Literals(["free", "pro", "team", "enterprise"]);
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const SubscriptionStatus = Schema.Literals([
  "none",
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);
const BillingPlan = Schema.Struct({
  id: PlanId,
  name: Schema.String,
  price: Schema.NullOr(Schema.String),
  period: Schema.NullOr(Schema.String),
  description: Schema.String,
  features: Schema.Array(Schema.String),
  highlighted: Schema.Boolean,
  seats: Schema.optional(
    Schema.NullOr(Schema.Struct({ minimum: PositiveInt, label: Schema.NullOr(Schema.String) })),
  ),
});
const BillingStatus = Schema.Struct({
  plan: PlanId,
  subscriptionStatus: SubscriptionStatus,
  currentPeriodEnd: Schema.NullOr(Schema.String),
  trialEnd: Schema.NullOr(Schema.String),
  seatCount: PositiveInt,
  hasStripeCustomer: Schema.Boolean,
  canManageBilling: Schema.Boolean,
  availablePlans: Schema.Array(BillingPlan),
});
const BillingSession = Schema.Struct({ url: Schema.NonEmptyString });
const BillingCheckoutFinalizeResult = Schema.Struct({
  finalized: Schema.Boolean,
  billing: Schema.NullOr(BillingStatus),
  sessionStatus: Schema.NullOr(Schema.String),
  paymentStatus: Schema.NullOr(Schema.String),
});
const CloudBillingErrorResponse = Schema.Struct({
  error: Schema.Union([
    Schema.String,
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      suggestion: Schema.optionalKey(Schema.String),
      retryable: Schema.optionalKey(Schema.Boolean),
    }),
  ]),
});

function isCloudRemote(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "api.selftune.dev" || hostname.endsWith("-api.selftune.dev");
  } catch {
    return false;
  }
}

export interface CloudBillingTransportOptions {
  readonly fetch?: typeof fetch;
  readonly loadRemoteLibraryConfig?: typeof loadRemoteLibraryConfig;
}

function cloudConnection(configRoot: string, loadConfig: typeof loadRemoteLibraryConfig) {
  const remote = loadConfig(configRoot);
  if (!isCloudRemote(remote.url)) {
    throw new CLIError(
      "Connect this Desktop app to SelfTune Cloud before managing billing.",
      "CONFIG_MISSING",
      "Open Settings > Billing and connect your Cloud account.",
    );
  }
  return remote;
}

async function billingRequest(input: {
  readonly configRoot: string;
  readonly fetch: typeof fetch;
  readonly loadRemoteLibraryConfig: typeof loadRemoteLibraryConfig;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
}): Promise<unknown> {
  const remote = cloudConnection(input.configRoot, input.loadRemoteLibraryConfig);
  let response: Response;
  try {
    response = await input.fetch(new URL(input.path, remote.url), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${remote.apiKey}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch (cause) {
    throw new CLIError(
      cause instanceof Error ? cause.message : "Unable to reach SelfTune Cloud.",
      "API_ERROR",
      "Check your connection and retry.",
      1,
      true,
    );
  }
  const responseText = await response.text();
  if (!response.ok) {
    if (response.status === 404 && responseText.trim() === "404 Not Found") {
      throw new CLIError(
        "The connected SelfTune Cloud deployment does not expose billing yet.",
        "API_ERROR",
        "Deploy the current Cloud API, then retry.",
      );
    }
    try {
      const decoded = Schema.decodeUnknownSync(CloudBillingErrorResponse)(JSON.parse(responseText));
      const error = typeof decoded.error === "string" ? { message: decoded.error } : decoded.error;
      throw new CLIError(
        error.message ?? `SelfTune Cloud billing request failed (${response.status}).`,
        "API_ERROR",
        error.suggestion ?? (response.status >= 500 ? "Retry in a moment." : undefined),
        1,
        error.retryable ?? response.status >= 500,
      );
    } catch (cause) {
      if (cause instanceof CLIError) throw cause;
    }
    throw new CLIError(
      `SelfTune Cloud billing request failed (${response.status}).`,
      "API_ERROR",
      response.status >= 500 ? "Retry in a moment." : undefined,
      1,
      response.status >= 500,
    );
  }
  try {
    return JSON.parse(responseText);
  } catch {
    throw new CLIError(
      "SelfTune Cloud returned an invalid billing response.",
      "API_ERROR",
      "Retry in a moment.",
      1,
      true,
    );
  }
}

function decodeBillingStatus(body: unknown): DesktopBillingStatus {
  try {
    return Schema.decodeUnknownSync(BillingStatus)(body);
  } catch {
    throw new CLIError(
      "SelfTune Cloud returned an invalid billing response.",
      "API_ERROR",
      "Retry in a moment.",
      1,
      true,
    );
  }
}

function decodeBillingSession(body: unknown): DesktopBillingSession {
  try {
    return Schema.decodeUnknownSync(BillingSession)(body);
  } catch {
    throw new CLIError(
      "SelfTune Cloud returned an invalid billing response.",
      "API_ERROR",
      "Retry in a moment.",
      1,
      true,
    );
  }
}

function decodeBillingCheckoutFinalizeResult(body: unknown): DesktopBillingCheckoutFinalizeResult {
  try {
    return Schema.decodeUnknownSync(BillingCheckoutFinalizeResult)(body);
  } catch {
    throw new CLIError(
      "SelfTune Cloud returned an invalid billing response.",
      "API_ERROR",
      "Retry in a moment.",
      1,
      true,
    );
  }
}

/** Keeps the stored Remote Library credential in the sidecar process. */
export function makeCloudBillingOperations(
  configRoot: string,
  options: CloudBillingTransportOptions = {},
) {
  const fetchImplementation = options.fetch ?? fetch;
  const loadConfig = options.loadRemoteLibraryConfig ?? loadRemoteLibraryConfig;
  const request = (
    input: Omit<
      Parameters<typeof billingRequest>[0],
      "configRoot" | "fetch" | "loadRemoteLibraryConfig"
    >,
  ) =>
    billingRequest({
      ...input,
      configRoot,
      fetch: fetchImplementation,
      loadRemoteLibraryConfig: loadConfig,
    });
  return {
    status: async (): Promise<DesktopBillingStatus> => {
      return request({
        path: "/api/v1/cloud/billing/status",
        method: "GET",
      }).then(decodeBillingStatus);
    },
    checkout: async (input: DesktopBillingCheckoutRequest): Promise<DesktopBillingSession> => {
      return request({
        path: "/api/v1/cloud/billing/checkout",
        method: "POST",
        body: input,
      }).then(decodeBillingSession);
    },
    portal: async (): Promise<DesktopBillingSession> => {
      return request({
        path: "/api/v1/cloud/billing/portal",
        method: "POST",
      }).then(decodeBillingSession);
    },
    finalize: async (
      input: DesktopBillingCheckoutFinalizeRequest,
    ): Promise<DesktopBillingCheckoutFinalizeResult> => {
      return request({
        path: "/api/v1/cloud/billing/checkout/finalize",
        method: "POST",
        body: { sessionId: input.sessionId },
      }).then(decodeBillingCheckoutFinalizeResult);
    },
  } as const;
}
