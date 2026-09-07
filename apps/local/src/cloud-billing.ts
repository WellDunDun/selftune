import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import type {
  DesktopBillingCheckoutFinalizeRequest,
  DesktopBillingCheckoutRequest,
  DesktopBillingCheckoutFinalizeResult,
  DesktopBillingSession,
  DesktopBillingStatus,
} from "@selftune/runtime/dashboard-contract";
import { CLIError } from "@selftune/runtime/utils/cli-error";

const HostedState = Schema.Struct({
  workspaceId: Schema.String,
  plan: Schema.Literals(["free", "pro", "team"]),
  status: Schema.Literals(["none", "active", "canceled", "past_due", "trialing", "unpaid"]),
  currentPeriodEnd: Schema.NullOr(Schema.Number),
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
    return hostname === "cloud.selftune.dev";
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
}): Promise<string> {
  const remote = cloudConnection(input.configRoot, input.loadRemoteLibraryConfig);
  let response: Response;
  try {
    response = await input.fetch(new URL(input.path, remote.url), {
      method: "GET",
      headers: { Authorization: `Bearer ${remote.apiKey}` },
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
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(CloudBillingErrorResponse))(
        responseText,
      );
      const error = Predicate.isString(decoded.error) ? { message: decoded.error } : decoded.error;
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
  return responseText;
}

function decodeBillingStatus(body: string): DesktopBillingStatus {
  try {
    const state = Schema.decodeUnknownSync(Schema.fromJsonString(HostedState))(body);
    return {
      plan: state.plan,
      subscriptionStatus: state.status,
      currentPeriodEnd:
        state.currentPeriodEnd === null ? null : new Date(state.currentPeriodEnd).toISOString(),
      trialEnd: null,
      seatCount: 1,
      hasStripeCustomer: state.status !== "none",
      canManageBilling: true,
      availablePlans: [
        {
          id: "free",
          name: "Community",
          price: "$0",
          period: null,
          description: "Find, review, package, and install skills on your machine.",
          features: [
            "Unlimited local skills and Skill Sets",
            "Discovery across supported agents and projects",
            "Local evaluation and reviewable proposals",
          ],
          highlighted: false,
        },
        {
          id: "pro",
          name: "Pro",
          price: "$19",
          period: "/month",
          description: "Publish and manage reviewed Skill Sets as one owner.",
          features: [
            "Explicit skill and Skill Set sharing",
            "Expiring and revocable share links",
            "Linked-device and revision status",
          ],
          highlighted: true,
        },
        {
          id: "team",
          name: "Team",
          price: "$49",
          period: "/month",
          description: "Distribute reviewed Skill Sets across a workspace.",
          features: [
            "Everything in Pro",
            "3 members included",
            "Workspace membership and access roles",
          ],
          highlighted: false,
          seats: { minimum: 3, label: "members" },
        },
      ],
    };
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

/** Keeps the linked device credential in the sidecar process. */
export class CloudBillingService extends Context.Service<
  CloudBillingService,
  ReturnType<typeof makeCloudBillingOperations>
>()("SelfTune/CloudBilling") {}

export function makeCloudBillingLayer(configRoot: string) {
  return Layer.sync(CloudBillingService)(() => makeCloudBillingOperations(configRoot));
}

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
        path: "/api/v1/desktop/state",
      }).then(decodeBillingStatus);
    },
    checkout: async (input: DesktopBillingCheckoutRequest): Promise<DesktopBillingSession> => {
      return { url: `https://cloud.selftune.dev/?billing=${input.plan}` };
    },
    portal: async (): Promise<DesktopBillingSession> => {
      return { url: "https://cloud.selftune.dev/?billing=portal" };
    },
    finalize: async (
      input: DesktopBillingCheckoutFinalizeRequest,
    ): Promise<DesktopBillingCheckoutFinalizeResult> => {
      const billing = await request({
        path: "/api/v1/desktop/state",
      }).then(decodeBillingStatus);
      return {
        finalized:
          billing.subscriptionStatus === "active" || billing.subscriptionStatus === "trialing",
        billing,
        sessionStatus: input.sessionId ? "redirected" : null,
        paymentStatus: null,
      };
    },
  } as const;
}
