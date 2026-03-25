/**
 * Device-code authentication flow for CLI -> cloud linking.
 *
 * Flow:
 * 1. CLI requests a device code from the cloud API
 * 2. CLI prints verification URL + user code for the agent to relay
 * 3. CLI attempts to open browser
 * 4. CLI polls until approved, denied, or expired
 */

export interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface DeviceCodeResult {
  api_key: string;
  cloud_user_id: string;
  org_id: string;
}

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
 * The endpoint is the push URL (e.g., https://api.selftune.dev/api/v1/push).
 * Strip /push to get the base.
 */
export function getBaseUrl(): string {
  const pushEndpoint =
    process.env.SELFTUNE_ALPHA_ENDPOINT ?? "https://api.selftune.dev/api/v1/push";
  return pushEndpoint.replace(/\/push$/, "");
}

/**
 * Request a new device code from the cloud API.
 */
export async function requestDeviceCode(): Promise<DeviceCodeGrant> {
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "selftune-cli", scope: "push read" }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DeviceCodeGrant>;
}

/**
 * Poll for device-code completion. Resolves when approved, rejects on expired/denied/timeout.
 */
export async function pollDeviceCode(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<DeviceCodeResult> {
  const baseUrl = getBaseUrl();
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const response = await fetch(`${baseUrl}/device-code/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode, client_id: "selftune-cli" }),
    });

    // Parse body as JSON; on non-2xx responses the cloud may return
    // JSON with a status field (e.g. 403 → { status: "denied" }) or
    // non-JSON (e.g. 503 gateway error). Handle both gracefully.
    let result: Record<string, string>;
    try {
      result = (await response.json()) as Record<string, string>;
    } catch {
      // Non-JSON body — fall through to HTTP status check
      if (!response.ok) {
        throw new Error(`Poll failed: ${response.status}`);
      }
      // 2xx with unparseable body is unexpected; treat as pending
      continue;
    }

    if (result.status === "approved") {
      return {
        api_key: result.api_key,
        cloud_user_id: result.cloud_user_id,
        org_id: result.org_id,
      };
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
