/* oxlint-disable no-await-in-loop -- device approval polling is intentionally sequential */
/**
 * Device-code authentication flow for CLI -> cloud linking.
 *
 * Flow:
 * 1. CLI requests a device code from the cloud API
 * 2. CLI prints verification URL + user code for the agent to relay
 * 3. CLI attempts to open browser
 * 4. CLI polls until approved, denied, or expired
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const PositiveSeconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
export const DeviceCodeGrant = Schema.Struct({
  device_code: NonEmptyText,
  user_code: NonEmptyText,
  verification_url: NonEmptyText,
  expires_in: PositiveSeconds,
  interval: PositiveSeconds,
});
export type DeviceCodeGrant = typeof DeviceCodeGrant.Type;

export const DeviceCodeResult = Schema.Struct({
  api_key: NonEmptyText,
  cloud_user_id: NonEmptyText,
  org_id: NonEmptyText,
});
export type DeviceCodeResult = typeof DeviceCodeResult.Type;

type DeviceCodeTransport = (url: string, init: RequestInit) => Promise<Response>;
const PollResponse = Schema.StructWithRest(Schema.Struct({ status: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);
const decodePollResponse = Schema.decodeUnknownSync(Schema.fromJsonString(PollResponse));

export const DEFAULT_CLOUD_API_URL = "https://cloud.selftune.dev";

export function tryOpenUrl(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "linux"
        ? ["xdg-open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : null;

  if (!command) return false;
  if (process.platform !== "win32" && !Bun.which(command[0])) return false;

  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function buildVerificationUrl(verificationUrl: string, userCode: string): string {
  try {
    const url = new URL(verificationUrl);
    url.searchParams.set("code", userCode);
    return url.toString();
  } catch {
    const separator = verificationUrl.includes("?") ? "&" : "?";
    return `${verificationUrl}${separator}code=${encodeURIComponent(userCode)}`;
  }
}

/**
 * Derive the cloud API base URL from SELFTUNE_ALPHA_ENDPOINT.
 * The endpoint is the device-link URL (e.g., https://cloud.selftune.dev/api/device).
 * Strip /push to get the base.
 */
export function getBaseUrl(): string {
  const pushEndpoint =
    process.env.SELFTUNE_ALPHA_ENDPOINT ?? `${DEFAULT_CLOUD_API_URL}/api/v1/push`;
  return pushEndpoint.replace(/\/push$/, "");
}

/**
 * Request a new device code from the cloud API.
 */
export async function requestDeviceCode(
  clientId = "selftune-cli",
  request: DeviceCodeTransport = fetch,
): Promise<DeviceCodeGrant> {
  const baseUrl = getBaseUrl();
  const response = await request(`${baseUrl}/device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "push read" }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }

  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceCodeGrant))(
    await response.text(),
  );
  if (Option.isNone(decoded)) throw new Error("Device code request returned an invalid response.");
  return decoded.value;
}

/**
 * Poll for device-code completion. Resolves when approved, rejects on expired/denied/timeout.
 */
export async function pollDeviceCode(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  clientId = "selftune-cli",
  request: DeviceCodeTransport = fetch,
): Promise<DeviceCodeResult> {
  const baseUrl = getBaseUrl();
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const response = await request(`${baseUrl}/device-code/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode, client_id: clientId }),
    });

    // Parse body as JSON; on non-2xx responses the cloud may return
    // JSON with a status field (e.g. 403 → { status: "denied" }) or
    // non-JSON (e.g. 503 gateway error). Handle both gracefully.
    let result: typeof PollResponse.Type;
    try {
      result = decodePollResponse(await response.text());
    } catch {
      // Non-JSON body — fall through to HTTP status check
      if (!response.ok) {
        throw new Error(`Poll failed: ${response.status}`);
      }
      // 2xx with unparseable body is unexpected; treat as pending
      continue;
    }

    if (result.status === "approved") {
      if (!response.ok) throw new Error(`Poll failed: ${response.status}`);
      const decoded = Schema.decodeUnknownOption(DeviceCodeResult)(result);
      if (Option.isNone(decoded))
        throw new Error("Device code approval returned invalid credentials.");
      return decoded.value;
    }

    if (result.status === "expired") throw new Error("Device code expired. Please retry.");
    if (result.status === "denied") throw new Error("Device code denied by user.");

    // Non-2xx without a recognized status in the body is a genuine error
    if (!response.ok) {
      throw new Error(`Poll failed: ${response.status}`);
    }

    // status === "pending" -- continue polling
    process.stderr.write(".");
  }

  throw new Error("Device code polling timed out.");
}
