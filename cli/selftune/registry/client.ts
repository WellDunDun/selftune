/**
 * Registry HTTP client. Never throws — returns typed results.
 */

import { getSelftuneVersion } from "../utils/selftune-meta.js";

export interface RegistryResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
}

function getConfig(): { apiUrl: string; apiKey: string } | null {
  try {
    const configPath = `${process.env.HOME}/.selftune/config.json`;
    const raw = require("fs").readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const apiUrl = config?.alpha?.cloud_api_url || "https://api.selftune.dev";
    const apiKey = config?.alpha?.api_key;
    if (!apiKey) return null;
    return { apiUrl, apiKey };
  } catch {
    return null;
  }
}

export async function registryRequest<T>(
  method: string,
  path: string,
  opts?: { body?: unknown; formData?: FormData },
): Promise<RegistryResult<T>> {
  const config = getConfig();
  if (!config) {
    return { success: false, error: "Not authenticated. Run 'selftune alpha upload' to set up." };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": `selftune/${getSelftuneVersion()}`,
    };

    let fetchBody: BodyInit | undefined;
    if (opts?.formData) {
      fetchBody = opts.formData;
      // Don't set Content-Type — fetch sets multipart boundary automatically
    } else if (opts?.body) {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(opts.body);
    }

    const response = await fetch(`${config.apiUrl}/api/v1/registry${path}`, {
      method,
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(60_000),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
        status: response.status,
      };
    }

    const data = text ? JSON.parse(text) : {};
    return { success: true, data: data as T, status: response.status };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
