import { LibraryError } from "../errors.js";
import type {
  RemoteLibraryConnection,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
} from "./types.js";

interface ErrorEnvelope {
  error?: { message?: string } | string;
}

async function request<T>(
  config: RemoteLibraryConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.url}/api/v1/teams${path}`, {
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
        : (payload?.error?.message ?? `Workspace member request failed (${response.status}).`);
    throw new LibraryError(
      message,
      response.status === 401 || response.status === 403 ? "GUARD_BLOCKED" : "OPERATION_FAILED",
    );
  }
  if (!payload) throw new LibraryError("Workspace member response was empty.", "OPERATION_FAILED");
  return payload;
}

export function listWorkspaceMembers(
  config: RemoteLibraryConnection,
): Promise<WorkspaceMembersResponse> {
  return request(config, "/members");
}

export function inviteWorkspaceMember(
  config: RemoteLibraryConnection,
  input: { email: string; role: WorkspaceMemberRole },
): Promise<{
  status: "invited" | "joined";
  user_id: string | null;
  email: string;
  role: WorkspaceMemberRole;
}> {
  return request(config, "/invite", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkspaceMemberRole(
  config: RemoteLibraryConnection,
  userId: string,
  role: WorkspaceMemberRole,
): Promise<{ success: true }> {
  return request(config, `/members/${encodeURIComponent(userId)}/role`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export function removeWorkspaceMember(
  config: RemoteLibraryConnection,
  userId: string,
): Promise<{ success: true }> {
  return request(config, `/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
