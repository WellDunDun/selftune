import { LibraryError } from "../errors.js";
import type {
  RemoteLibraryConnection,
  WorkspaceSkillSetPoliciesResponse,
  WorkspaceSkillSetPolicy,
  WorkspaceSkillSetPolicyAction,
} from "./types.js";

interface ErrorEnvelope {
  error?: { message?: string } | string;
}

async function request<T>(
  config: RemoteLibraryConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.url}/api/v1/remote-library${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : (payload?.error?.message ?? `Workspace policy request failed (${response.status}).`);
    throw new LibraryError(
      message,
      response.status === 401 || response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED",
      undefined,
      1,
      response.status >= 500,
    );
  }
  if (!payload) throw new LibraryError("Workspace policy response was empty.", "OPERATION_FAILED");
  return payload;
}

export function listWorkspaceSkillSetPolicies(
  config: RemoteLibraryConnection,
): Promise<WorkspaceSkillSetPoliciesResponse> {
  return request(config, "/policies");
}

export async function updateWorkspaceSkillSetPolicy(
  config: RemoteLibraryConnection,
  skillSetId: string,
  input: { action: WorkspaceSkillSetPolicyAction; reason?: string | null },
): Promise<WorkspaceSkillSetPolicy> {
  const result = await request<{ policy: WorkspaceSkillSetPolicy }>(
    config,
    `/policies/${encodeURIComponent(skillSetId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.policy;
}

export function resetWorkspaceSkillSetPolicy(
  config: RemoteLibraryConnection,
  skillSetId: string,
): Promise<{ success: true }> {
  return request(config, `/policies/${encodeURIComponent(skillSetId)}`, { method: "DELETE" });
}
